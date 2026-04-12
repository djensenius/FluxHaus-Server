/* Push Notification Tester — FluxHaus */
/* global fetch, document */

let csrfToken = null;

// ── Helpers ───────────────────────────────────────────────

function log(msg, type) {
  const el = document.getElementById('log');
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + (type || '');
  entry.innerHTML = '<span class="log-time">' + time + '</span> ' + msg;
  el.prepend(entry);
}

async function getCsrf() {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch('/auth/csrf-token', { credentials: 'include' });
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  } catch {
    log('Failed to fetch CSRF token', 'error');
    return '';
  }
}

async function api(method, path, body) {
  const csrf = await getCsrf();
  const opts = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

function showResult(elementId, data, isError) {
  const el = document.getElementById(elementId);
  const cls = isError ? 'result-error' : 'result-success';
  el.innerHTML = '<div class="result-box ' + cls + '">' +
    JSON.stringify(data, null, 2) + '</div>';
}

function appBadge(bundleId) {
  if (bundleId && bundleId.includes('GT3')) {
    return '<span class="badge badge-gt3">GT3</span>';
  }
  return '<span class="badge badge-fluxhaus">FluxHaus</span>';
}

// ── Token Loading ─────────────────────────────────────────

async function loadTokens() {
  const el = document.getElementById('tokenList');
  try {
    const data = await api('GET', '/push-test/tokens');
    if (data.alert.length === 0 && data.pushToStart.length === 0) {
      el.innerHTML = '<div class="empty-state">No tokens registered. ' +
        'Open an app on your phone to register push tokens.</div>';
      return;
    }

    let html = '<div class="token-grid">';

    data.alert.forEach(function(t) {
      html += '<div class="token-card">' +
        '<div class="device-name">' + (t.deviceName || 'Unknown Device') + '</div>' +
        '<div class="token-meta">' +
          '<span class="badge badge-alert">Alert</span> ' +
          appBadge(t.bundleId) +
          ' <span style="color:var(--overlay0)">' + t.token + '</span>' +
        '</div></div>';
    });

    data.pushToStart.forEach(function(t) {
      html += '<div class="token-card">' +
        '<div class="device-name">' + (t.deviceName || 'Unknown Device') + '</div>' +
        '<div class="token-meta">' +
          '<span class="badge badge-pts">Push-to-Start</span> ' +
          appBadge(t.bundleId) +
          ' <span style="color:var(--overlay0)">' + t.token + '</span>' +
        '</div></div>';
    });

    html += '</div>';
    el.innerHTML = html;
  } catch (err) {
    el.innerHTML = '<div class="error">' + err.message + '</div>';
    log('Failed to load tokens: ' + err.message, 'error');
  }
}

// ── Tab Switching ─────────────────────────────────────────

document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t) {
      t.classList.remove('active');
    });
    document.querySelectorAll('.tab-panel').forEach(function(p) {
      p.classList.remove('active');
    });
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── GT3 Preview ───────────────────────────────────────────

function updateGT3Preview() {
  const speed = document.getElementById('gt3-speed').value;
  const battery = document.getElementById('gt3-battery').value;
  const range = document.getElementById('gt3-range').value;
  const temp = document.getElementById('gt3-temp').value;

  document.getElementById('pv-speed').textContent = speed;
  document.getElementById('sv-speed').textContent = speed;
  document.getElementById('pv-battery').textContent = battery;
  document.getElementById('sv-battery').textContent = battery;
  document.getElementById('pv-range').textContent = range;
  document.getElementById('pv-temp').textContent = temp;
}

// expose to inline handlers
window.updateGT3Preview = updateGT3Preview;

// ── Send Alert ────────────────────────────────────────────

async function sendAlert() {
  const title = document.getElementById('alert-title').value;
  const body = document.getElementById('alert-body').value;
  const bundleId = document.getElementById('alert-bundle').value;

  log('Sending alert: "' + title + '"…');
  try {
    const payload = { title, body };
    if (bundleId) payload.bundleId = bundleId;
    const result = await api('POST', '/push-test/alert', payload);
    showResult('alert-result', result, false);
    log('✅ Alert sent: ' + result.sent + '/' + result.total + ' delivered', 'success');
  } catch (err) {
    showResult('alert-result', { error: err.message }, true);
    log('❌ Alert failed: ' + err.message, 'error');
  }
}
window.sendAlert = sendAlert;

// ── Send GT3 Push-to-Start ────────────────────────────────

async function sendGT3PushToStart() {
  const state = document.getElementById('gt3-state').value;
  const contentState = {
    speed: parseFloat(document.getElementById('gt3-speed').value),
    battery: parseInt(document.getElementById('gt3-battery').value, 10),
    tripDistance: parseFloat(document.getElementById('gt3-trip').value),
    estimatedRange: parseFloat(document.getElementById('gt3-range').value),
    gearMode: parseInt(document.getElementById('gt3-gear').value, 10),
    bmsTemp: parseFloat(document.getElementById('gt3-temp').value),
    isCharging: state === 'charging',
    isAwake: state === 'connected' || state === 'charging',
    isConnected: true,
  };

  log('Sending GT3 push-to-start…');
  try {
    const result = await api('POST', '/push-test/push-to-start', {
      app: 'gt3',
    });
    showResult('gt3-result', result, false);
    log('✅ GT3 push-to-start: ' + result.sent + '/' + result.total + ' delivered', 'success');
  } catch (err) {
    showResult('gt3-result', { error: err.message }, true);
    log('❌ GT3 push-to-start failed: ' + err.message, 'error');
  }
}
window.sendGT3PushToStart = sendGT3PushToStart;

// ── Send FluxHaus Push-to-Start ───────────────────────────

async function sendFluxPushToStart() {
  log('Sending FluxHaus push-to-start…');
  try {
    const result = await api('POST', '/push-test/push-to-start', {
      app: 'fluxhaus',
    });
    showResult('flux-result', result, false);
    log('✅ FluxHaus push-to-start: ' + result.sent + '/' + result.total + ' delivered', 'success');
  } catch (err) {
    showResult('flux-result', { error: err.message }, true);
    log('❌ FluxHaus push-to-start failed: ' + err.message, 'error');
  }
}
window.sendFluxPushToStart = sendFluxPushToStart;

// ── Init ──────────────────────────────────────────────────

loadTokens();
