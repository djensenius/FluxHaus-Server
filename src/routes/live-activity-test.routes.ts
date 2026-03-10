import { Request, Response, Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import { generateCsrfToken } from '../middleware/csrf.middleware';
import {
  LiveActivityContentState,
  pushToStartAll,
  sendBroadcastUpdate,
} from '../apns';
import { getAllDeviceTokens } from '../push-token-store';
import { getAllChannels, getChannelId } from '../apns-channels';
import logger from '../logger';

const testLogger = logger.child({ subsystem: 'live-activity-test' });

const router = Router();

interface SimulationState {
  timer: ReturnType<typeof setInterval> | null;
  activityType: string;
  deviceName: string;
  icon: string;
  progress: number;
  totalSeconds: number;
  elapsedSeconds: number;
  program: string;
}

const activeSimulations = new Map<string, SimulationState>();

const DEVICE_CONFIGS: Record<string, { name: string; icon: string; programs: string[] }> = {
  dishwasher: { name: 'Dishwasher', icon: 'dishwasher', programs: ['Auto2', 'Intensive', 'Eco 50', 'Quick 45'] },
  washer: { name: 'Washer', icon: 'washer', programs: ['Cottons', 'Darks', 'Delicates', 'Quick Wash'] },
  dryer: { name: 'Dryer', icon: 'dryer', programs: ['Cottons', 'Synthetics', 'Express', 'Shirts'] },
  broombot: { name: 'BroomBot', icon: 'fan', programs: ['Clean'] },
  mopbot: { name: 'MopBot', icon: 'humidifier.and.droplets', programs: ['Clean'] },
};

function formatTimeRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function buildContentState(sim: SimulationState): LiveActivityContentState {
  const remainingSeconds = Math.max(0, sim.totalSeconds - sim.elapsedSeconds);
  const isRobot = sim.activityType === 'broombot' || sim.activityType === 'mopbot';

  return {
    device: {
      name: sim.deviceName,
      progress: isRobot
        ? Math.max(0, 100 - Math.floor((sim.elapsedSeconds / sim.totalSeconds) * 30))
        : sim.progress,
      icon: sim.icon,
      trailingText: isRobot ? 'Cleaning' : `${sim.program} · ${formatTimeRemaining(remainingSeconds)}`,
      shortText: isRobot ? 'Cleaning' : formatTimeRemaining(remainingSeconds),
      running: true,
    },
  };
}

async function tickSimulation(activityType: string): Promise<void> {
  const sim = activeSimulations.get(activityType);
  if (!sim) return;

  sim.elapsedSeconds += 15;
  sim.progress = Math.min(100, Math.floor((sim.elapsedSeconds / sim.totalSeconds) * 100));

  const channelId = await getChannelId(activityType);

  if (sim.elapsedSeconds >= sim.totalSeconds) {
    const endState: LiveActivityContentState = {
      device: {
        name: sim.deviceName,
        progress: 100,
        icon: sim.icon,
        trailingText: 'Done',
        shortText: 'Done',
        running: false,
      },
    };
    if (channelId) {
      await sendBroadcastUpdate(channelId, endState, 'end', activityType);
    }
    if (sim.timer) clearInterval(sim.timer);
    activeSimulations.delete(activityType);
    testLogger.info({ activityType }, 'Simulation ended');
    return;
  }

  const contentState = buildContentState(sim);
  if (channelId) {
    await sendBroadcastUpdate(channelId, contentState, 'update', activityType);
  } else {
    testLogger.debug({ activityType, progress: sim.progress }, 'No channel — skipping tick');
  }
}

// --- API endpoints ---

router.post('/admin/live-activity-test/simulate', requireRole('admin'), async (req: Request, res: Response) => {
  const { activityType, durationMinutes = 5, program } = req.body;

  if (!activityType || !DEVICE_CONFIGS[activityType]) {
    res.status(400).json({ error: 'Invalid activityType', valid: Object.keys(DEVICE_CONFIGS) });
    return;
  }

  // Stop existing simulation for this type
  const existing = activeSimulations.get(activityType);
  if (existing?.timer) clearInterval(existing.timer);

  const config = DEVICE_CONFIGS[activityType];
  const totalSeconds = durationMinutes * 60;

  const sim: SimulationState = {
    timer: null,
    activityType,
    deviceName: config.name,
    icon: config.icon,
    progress: 0,
    totalSeconds,
    elapsedSeconds: 0,
    program: program || config.programs[0],
  };

  activeSimulations.set(activityType, sim);

  // Send push-to-start with channel ID so activity is channel-subscribed
  const deviceTokens = await getAllDeviceTokens();
  if (deviceTokens.length > 0) {
    const contentState = buildContentState(sim);
    const channelId = await getChannelId(activityType);
    await pushToStartAll(deviceTokens, contentState, channelId ?? undefined);
    testLogger.info({ activityType, hasChannel: !!channelId }, 'Push-to-start sent');
  }

  // Start ticking every 15 seconds
  sim.timer = setInterval(() => {
    tickSimulation(activityType).catch((err) => {
      testLogger.error({ err, activityType }, 'Simulation tick error');
    });
  }, 15_000);

  testLogger.info({ activityType, durationMinutes, program: sim.program }, 'Simulation started');
  res.json({
    success: true, activityType, durationMinutes, program: sim.program,
  });
});

router.post('/admin/live-activity-test/stop', requireRole('admin'), async (req: Request, res: Response) => {
  const { activityType } = req.body;

  const sim = activeSimulations.get(activityType);
  if (!sim) {
    res.status(404).json({ error: 'No active simulation for this type' });
    return;
  }

  // Send end event via broadcast
  const channelId = await getChannelId(activityType);
  const endState: LiveActivityContentState = {
    device: {
      name: sim.deviceName,
      progress: 100,
      icon: sim.icon,
      trailingText: 'Done',
      shortText: 'Done',
      running: false,
    },
  };
  if (channelId) {
    await sendBroadcastUpdate(channelId, endState, 'end', activityType);
  }

  if (sim.timer) clearInterval(sim.timer);
  activeSimulations.delete(activityType);
  testLogger.info({ activityType }, 'Simulation stopped');
  res.json({ success: true });
});

router.get('/admin/live-activity-test/status', requireRole('admin'), async (_req: Request, res: Response) => {
  const channels = await getAllChannels();
  const deviceTokens = await getAllDeviceTokens();

  const simulations: Record<string, {
    progress: number; elapsed: string; remaining: string; program: string;
  }> = {};
  Array.from(activeSimulations.entries()).forEach(([key, sim]) => {
    const remainingSec = Math.max(0, sim.totalSeconds - sim.elapsedSeconds);
    simulations[key] = {
      progress: sim.progress,
      elapsed: formatTimeRemaining(sim.elapsedSeconds),
      remaining: formatTimeRemaining(remainingSec),
      program: sim.program,
    };
  });

  res.json({
    channels: Object.entries(channels).map(([type, id]) => ({
      activityType: type,
      channelId: String(id).substring(0, 16),
    })),
    deviceTokens: deviceTokens.map((t) => ({
      deviceName: t.deviceName,
      token: `${t.pushToStartToken.substring(0, 8)}...`,
    })),
    activeSimulations: simulations,
    devices: DEVICE_CONFIGS,
  });
});

// --- HTML test page ---

// eslint-disable-next-line max-len
const TEST_PAGE_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live Activity Test — FluxHaus</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif;
      background: #0a0a0a; color: #e5e5e5;
      padding: 24px; max-width: 800px; margin: 0 auto;
    }
    h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .status-bar {
      background: #1a1a1a; border-radius: 12px;
      padding: 16px; margin-bottom: 24px; border: 1px solid #333;
    }
    .status-bar h2 {
      font-size: 14px; color: #888; text-transform: uppercase;
      letter-spacing: 0.5px; margin-bottom: 12px;
    }
    .token-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .token-badge {
      background: #222; border-radius: 8px; padding: 6px 12px;
      font-size: 12px; border: 1px solid #333;
    }
    .token-badge .type { color: #888; }
    .token-badge .device { color: #aaa; }
    .empty { color: #555; font-size: 13px; font-style: italic; }
    .device-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 16px; margin-bottom: 24px;
    }
    .device-card {
      background: #1a1a1a; border-radius: 12px; padding: 20px;
      border: 1px solid #333; transition: border-color 0.2s;
    }
    .device-card.active { border-color: #0a84ff; }
    .device-header {
      display: flex; align-items: center; gap: 12px; margin-bottom: 16px;
    }
    .device-icon { font-size: 24px; width: 40px; text-align: center; }
    .device-name { font-size: 18px; font-weight: 600; }
    .device-color {
      display: inline-block; width: 8px; height: 8px;
      border-radius: 50%; margin-left: 8px;
    }
    .form-row {
      display: flex; gap: 12px; margin-bottom: 12px; align-items: center;
    }
    .form-row label { font-size: 13px; color: #888; min-width: 70px; }
    select, input[type=number] {
      background: #222; border: 1px solid #444; border-radius: 6px;
      padding: 6px 10px; color: #e5e5e5; font-size: 14px;
      flex: 1; min-width: 0;
    }
    select:focus, input:focus {
      outline: none; border-color: #0a84ff;
    }
    .btn-row {
      display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;
    }
    button {
      border: none; border-radius: 8px; padding: 8px 16px;
      font-size: 13px; font-weight: 600;
      cursor: pointer; transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-start { background: #30d158; color: #000; }
    .btn-stop { background: #ff453a; color: #fff; }
    .sim-status {
      background: #0a84ff22; border: 1px solid #0a84ff44;
      border-radius: 8px; padding: 10px 14px;
      margin-top: 12px; font-size: 13px;
    }
    .sim-status .progress-bar {
      background: #333; border-radius: 4px; height: 6px;
      margin-top: 8px; overflow: hidden;
    }
    .sim-status .progress-fill {
      background: #0a84ff; height: 100%;
      transition: width 0.5s; border-radius: 4px;
    }
    .log {
      background: #111; border-radius: 8px; padding: 12px;
      font-family: 'SF Mono', monospace; font-size: 12px;
      max-height: 200px; overflow-y: auto; border: 1px solid #222;
    }
    .log-entry { padding: 2px 0; color: #888; }
    .log-entry.success { color: #30d158; }
    .log-entry.error { color: #ff453a; }
    .log-entry .time { color: #555; }
    @media (max-width: 600px) {
      .device-cards { grid-template-columns: 1fr; }
      .form-row { flex-direction: column; align-items: stretch; }
      .form-row label { min-width: auto; }
    }
  </style>
</head>
<body>
  <h1>\\u{1F514} Live Activity Test</h1>
  <p class="subtitle">
    Send push notifications and simulate appliance cycles. Admin only.
  </p>
  <div class="status-bar" id="tokenStatus">
    <h2>Registered Tokens</h2>
    <div id="tokenList"><span class="empty">Loading…</span></div>
  </div>
  <div class="device-cards" id="deviceCards"></div>
  <h2 style="font-size:14px;color:#888;text-transform:uppercase;
    letter-spacing:0.5px;margin-bottom:12px">Event Log</h2>
  <div class="log" id="log"></div>
<script>
var COLORS = {
  Dishwasher:'#0a84ff', Washer:'#32d2ff', Dryer:'#ff9f0a',
  BroomBot:'#30d158', MopBot:'#64d2b1'
};
var ICONS = {
  dishwasher:'\\u{1F37D}\\u{FE0F}', washer:'\\u{1F455}',
  dryer:'\\u{1F300}', broombot:'\\u{1F916}', mopbot:'\\u{1F9F9}'
};
var csrfToken = '%%CSRF_TOKEN%%';
var statusData = null;

function log(msg, type) {
  var el = document.getElementById('log');
  var time = new Date().toLocaleTimeString();
  el.innerHTML = '<div class="log-entry ' + (type||'') + '">'
    + '<span class="time">' + time + '</span> '
    + msg + '</div>' + el.innerHTML;
}

function getCsrf() {
  return Promise.resolve(csrfToken);
}

function api(method, path, body) {
  return getCsrf().then(function(csrf) {
    var opts = {
      method: method, credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf
      }
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch('/admin/live-activity-test' + path, opts);
  }).then(function(res) {
    return res.json().then(function(data) {
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
  });
}

function refreshStatus() {
  fetch('/admin/live-activity-test/status', {credentials:'include'})
    .then(function(r){return r.json()})
    .then(function(data) {
      statusData = data;
      renderTokens();
      renderCards();
    })
    .catch(function(e) {
      log('Failed to fetch status: ' + e.message, 'error');
    });
}

function renderTokens() {
  var el = document.getElementById('tokenList');
  var items = [];
  statusData.deviceTokens.forEach(function(t) {
    items.push('<span class="token-badge">'
      + '<span class="type">push-to-start</span> '
      + '<span class="device">' + t.deviceName
      + '</span></span>');
  });
  statusData.channels.forEach(function(c) {
    items.push('<span class="token-badge">'
      + '<span class="type">' + c.activityType + '</span> '
      + '<span class="device">channel</span></span>');
  });
  el.innerHTML = items.length ? items.join('')
    : '<span class="empty">'
    + 'No tokens registered. Open the iOS app to register.'
    + '</span>';
}

function renderCards() {
  var el = document.getElementById('deviceCards');
  el.innerHTML = '';
  Object.keys(statusData.devices).forEach(function(type) {
    var config = statusData.devices[type];
    var sim = statusData.activeSimulations[type];
    var isActive = !!sim;
    var icon = ICONS[type] || '\\u{1F4F1}';
    var color = COLORS[config.name] || '#888';
    var opts = config.programs.map(function(p) {
      return '<option>' + p + '</option>';
    }).join('');
    var simHtml = '';
    if (isActive) {
      simHtml = '<div class="sim-status">'
        + '\\u{23F1}\\u{FE0F} ' + sim.program
        + ' — ' + sim.progress + '% · '
        + sim.remaining + ' remaining'
        + '<div class="progress-bar">'
        + '<div class="progress-fill" style="width:'
        + sim.progress + '%"></div></div></div>';
    }
    var btnLabel = isActive ? '\\u{267B}\\u{FE0F} Restart'
      : '\\u{25B6}\\u{FE0F} Simulate';
    var card = '<div class="device-card'
      + (isActive ? ' active' : '') + '">'
      + '<div class="device-header">'
      + '<span class="device-icon">' + icon + '</span>'
      + '<span class="device-name">' + config.name
      + '<span class="device-color" style="background:'
      + color + '"></span></span></div>'
      + '<div class="form-row"><label>Program</label>'
      + '<select id="program-' + type + '">'
      + opts + '</select></div>'
      + '<div class="form-row"><label>Duration</label>'
      + '<input type="number" id="duration-' + type
      + '" value="2" min="1" max="120" style="max-width:80px">'
      + ' <span style="color:#888;font-size:13px">'
      + 'minutes</span></div>'
      + simHtml
      + '<div class="btn-row">'
      + '<button class="btn-start" onclick="simulate(\\''
      + type + '\\')">' + btnLabel + '</button>'
      + '<button class="btn-stop" onclick="stopSim(\\''
      + type + '\\')"'
      + (isActive ? '' : ' disabled')
      + '>\\u{23F9} Stop</button>'
      
      + '</div></div>';
    el.innerHTML += card;
  });
}

function simulate(type) {
  var program = document.getElementById('program-' + type).value;
  var dur = parseInt(
    document.getElementById('duration-' + type).value
  );
  api('POST', '/simulate', {
    activityType: type, durationMinutes: dur, program: program
  }).then(function(d) {
    log('\\u{2705} Simulation started: ' + d.activityType
      + ' (' + d.program + ', ' + d.durationMinutes
      + 'min)', 'success');
    refreshStatus();
  }).catch(function(e) {
    log('\\u{274C} ' + e.message, 'error');
  });
}

function stopSim(type) {
  api('POST', '/stop', {activityType: type})
    .then(function() {
      log('\\u{23F9} Simulation stopped: ' + type, 'success');
      refreshStatus();
    }).catch(function(e) {
      log('\\u{274C} ' + e.message, 'error');
    });
}

refreshStatus();
setInterval(refreshStatus, 10000);
</script>
</body>
</html>`;

router.get(
  '/admin/live-activity-test',
  requireRole('admin'),
  (req: Request, res: Response) => {
    // Ensure session has a CSRF token and embed it in the page
    // so the browser doesn't need a separate fetch.
    if (!req.session.csrfToken) {
      req.session.csrfToken = generateCsrfToken();
    }
    const html = TEST_PAGE_HTML.replace(
      '%%CSRF_TOKEN%%',
      req.session.csrfToken,
    );
    res.type('html').send(html);
  },
);

export default router;
