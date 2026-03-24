import { DishWasher, MieleDevice } from './types/types';
import {
  LiveActivityContentState, MultiDeviceContentState, WidgetDevicePayload,
  multiDevicePushToStartAll,
  sendAlertToAll,
  sendMultiDeviceBroadcast,
  sendSilentPushToAll,
} from './apns';
import { getChannelId } from './apns-channels';
import { getApnsTokensForDeviceType, getSubscribedDeviceTokens } from './la-subscriptions';
import { getAllApnsTokens } from './push-token-store';
import logger from './logger';

const laLogger = logger.child({ subsystem: 'live-activity-hooks' });

// Track previous running state to detect start transitions for push-to-start
const previousRunningState = new Map<string, boolean>();
// Track whether each device type has been initialized to avoid false alerts on startup
const initializedDeviceTypes = new Set<string>();

// Cached device states for building consolidated activity
const cachedDeviceStates = new Map<string, WidgetDevicePayload>();

// Throttle consolidated broadcasts to once per minute
let lastConsolidatedBroadcast = 0;
const CONSOLIDATED_THROTTLE_MS = 60_000;

// Periodic keep-alive interval to prevent stale activities
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

function stopKeepAlive(): void {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function formatTimeRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const finishTime = new Date(Date.now() + seconds * 1000);
  return finishTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function buildMieleContentState(
  deviceName: string,
  icon: string,
  device: MieleDevice,
): LiveActivityContentState {
  const timeRunning = device.timeRunning ?? 0;
  const timeRemaining = device.timeRemaining ?? 0;
  let progress = 0;
  if (timeRunning > 0) {
    progress = Math.round((timeRunning / (timeRemaining + timeRunning)) * 100);
  }

  const remainingText = formatTimeRemaining((device.timeRemaining ?? 0) * 60);
  let trailingText = `${device.programName ?? ''} · ${remainingText}`;
  if (device.status && device.status !== 'In use') {
    trailingText = `${device.status} · ${trailingText}`;
  }

  const running = (device.timeRemaining ?? 0) > 0;

  return {
    device: {
      name: deviceName,
      progress,
      icon,
      trailingText,
      shortText: `${device.timeRemaining ?? 0}m`,
      running,
      programName: device.programName,
    },
  };
}

const PROGRAM_DISPLAY_NAMES: Record<string, string> = {
  PreRinse: 'Pre-Rinse',
  Auto1: 'Auto 1',
  Auto2: 'Auto 2',
  Auto3: 'Auto 3',
  Eco50: 'Eco 50°',
  Quick45: 'Quick 45\'',
  Intensiv70: 'Intensive 70°',
  Normal65: 'Normal 65°',
  Glas40: 'Glass 40°',
  GlassCare: 'Glass Care',
  NightWash: 'Night Wash',
  Quick65: 'Quick 65\'',
  Normal45: 'Normal 45°',
  Intensiv45: 'Intensive 45°',
  AutoHalfLoad: 'Auto Half Load',
  IntensivPower: 'Intensive Power',
  MagicDaily: 'Magic Daily',
  Super60: 'Super 60°',
  Kurz60: 'Short 60\'',
  ExpressSparkle65: 'Express Sparkle 65°',
  MachineCare: 'Machine Care',
  SteamFresh: 'Steam Fresh',
  MaximumCleaning: 'Maximum Cleaning',
  MixedLoad: 'Mixed Load',
};

function buildDishwasherContentState(dishwasher: DishWasher): LiveActivityContentState {
  const remainingText = formatTimeRemaining(dishwasher.remainingTime ?? 0);
  const programDisplay = dishwasher.activeProgram
    ? (PROGRAM_DISPLAY_NAMES[dishwasher.activeProgram] || dishwasher.activeProgram)
    : undefined;
  let trailingText = remainingText;
  if (programDisplay) {
    trailingText = `${programDisplay} · ${trailingText}`;
  }
  if (dishwasher.operationState !== 'Run') {
    trailingText = `${dishwasher.operationState} · ${trailingText}`;
  }

  const running = (dishwasher.programProgress ?? 0) > 0;

  return {
    device: {
      name: 'Dishwasher',
      progress: dishwasher.programProgress ?? 0,
      icon: 'dishwasher',
      trailingText,
      shortText: formatTimeRemaining(dishwasher.remainingTime ?? 0),
      running,
      programName: programDisplay,
    },
  };
}

function buildRobotContentState(
  name: string,
  status: { running?: boolean; batteryLevel?: number; timeStarted?: Date },
): LiveActivityContentState {
  const running = status.running ?? false;
  const icon = name.toLowerCase().includes('mop') ? 'humidifier.and.droplets' : 'fan';
  const statusText = running ? 'Cleaning' : 'Off';

  return {
    device: {
      name,
      progress: status.batteryLevel ?? 0,
      icon,
      trailingText: statusText,
      shortText: statusText,
      running,
    },
  };
}

/**
 * Start a periodic keep-alive that re-broadcasts the consolidated state
 * to prevent activities from going stale (stale-date is 15 min).
 * Runs every 5 minutes while any device is running.
 */
function startKeepAlive(): void {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    const runningDevices = Array.from(cachedDeviceStates.values()).filter((d) => d.running);
    if (runningDevices.length === 0) {
      stopKeepAlive();
      return;
    }
    laLogger.debug({ count: runningDevices.length }, 'Keep-alive broadcast');
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    broadcastConsolidated(true).catch(() => {});
  }, 60 * 1000);
}

/**
 * Build and broadcast the consolidated multi-device Live Activity.
 * Called after every individual device state change.
 * Throttled to avoid flooding Apple's servers.
 */
async function broadcastConsolidated(force = false): Promise<void> {
  const runningDevices = Array.from(cachedDeviceStates.values()).filter((d) => d.running);
  const hasRunning = runningDevices.length > 0;
  const wasAnyRunning = previousRunningState.get('consolidated') ?? false;
  previousRunningState.set('consolidated', hasRunning);

  const contentState: MultiDeviceContentState = { devices: runningDevices };

  const channelId = await getChannelId('consolidated');
  if (!channelId) return;

  if (hasRunning) {
    // Push-to-start if transitioning from no devices to at least one
    if (!wasAnyRunning) {
      const subscribedTokens = await getSubscribedDeviceTokens();
      if (subscribedTokens.length > 0) {
        laLogger.info({ count: runningDevices.length }, 'Sending consolidated push-to-start');
        await multiDevicePushToStartAll(subscribedTokens, contentState, channelId);
        // Retry push-to-start after 5s in case the first attempt was rejected
        // (e.g., stale activity was still on device and got cleaned up by silent push)
        setTimeout(async () => {
          try {
            const retryTokens = await getSubscribedDeviceTokens();
            if (retryTokens.length > 0) {
              laLogger.debug('Retrying push-to-start');
              await multiDevicePushToStartAll(retryTokens, contentState, channelId);
            }
          } catch {
            // Retry failures are non-critical
          }
        }, 5000);
      }
      // Also send silent push to wake the app for local reconcile
      const apnsTokens = await getAllApnsTokens();
      if (apnsTokens.length > 0) {
        await sendSilentPushToAll(apnsTokens);
      }
      startKeepAlive();
    }

    // Throttle regular updates (but always send transitions)
    const now = Date.now();
    if (!force && wasAnyRunning && now - lastConsolidatedBroadcast < CONSOLIDATED_THROTTLE_MS) {
      return;
    }
    lastConsolidatedBroadcast = now;

    await sendMultiDeviceBroadcast(channelId, contentState, 'update');
  } else if (wasAnyRunning) {
    // All devices stopped — end the consolidated activity immediately
    stopKeepAlive();
    await sendMultiDeviceBroadcast(channelId, { devices: [] }, 'end');
    // Silent push to wake the app so it can clean up the local activity
    const apnsTokens = await getAllApnsTokens();
    if (apnsTokens.length > 0) {
      await sendSilentPushToAll(apnsTokens);
    }
  }
}

const DISPLAY_NAMES: Record<string, string> = {
  washer: 'Washer',
  dryer: 'Dryer',
  dishwasher: 'Dishwasher',
  broombot: 'BroomBot',
  mopbot: 'MopBot',
};

/**
 * Send a regular push notification when a device finishes.
 * Only sends to users subscribed to this device type.
 * Callers must ensure this is only invoked on running → stopped transitions.
 */
async function sendCompletionAlert(activityType: string): Promise<void> {
  const tokens = await getApnsTokensForDeviceType(activityType);
  if (tokens.length === 0) return;

  const name = DISPLAY_NAMES[activityType] || activityType;
  await sendAlertToAll(tokens, `${name} Done`, `Your ${name.toLowerCase()} has finished.`, 'appliance_done');
  laLogger.info({ activityType, recipients: tokens.length }, 'Sent completion alert notification');
}

export async function onMieleStatusChange(
  deviceType: 'washer' | 'dryer',
  device: MieleDevice,
): Promise<void> {
  const activityType = deviceType;
  const name = deviceType === 'washer' ? 'Washer' : 'Dryer';
  const icon = deviceType === 'washer' ? 'washer' : 'dryer';
  const contentState = buildMieleContentState(name, icon, device);
  const running = (device.timeRemaining ?? 0) > 0;

  // Cache for consolidated activity
  cachedDeviceStates.set(activityType, contentState.device);

  // On first poll after startup, just record state — don't send alerts
  if (!initializedDeviceTypes.has(activityType)) {
    initializedDeviceTypes.add(activityType);
    previousRunningState.set(activityType, running);
    laLogger.debug({ activityType, running }, 'Miele initial state recorded');
    await broadcastConsolidated();
    return;
  }

  // Track state BEFORE sending alert to prevent race-condition duplicates
  const wasRunning = previousRunningState.get(activityType) ?? false;
  previousRunningState.set(activityType, running);

  // Send completion alert only on running → stopped transition
  if (!running && wasRunning) {
    await sendCompletionAlert(activityType);
  }

  laLogger.debug({ activityType, running }, 'Miele status change');
  await broadcastConsolidated();
}

export async function onDishwasherStatusChange(dishwasher: DishWasher): Promise<void> {
  const activityType = 'dishwasher';
  const contentState = buildDishwasherContentState(dishwasher);
  const running = (dishwasher.programProgress ?? 0) > 0;

  // Cache for consolidated activity
  cachedDeviceStates.set(activityType, contentState.device);

  // On first poll after startup, just record state — don't send alerts
  if (!initializedDeviceTypes.has(activityType)) {
    initializedDeviceTypes.add(activityType);
    previousRunningState.set(activityType, running);
    laLogger.debug({ activityType, running }, 'Dishwasher initial state recorded');
    await broadcastConsolidated();
    return;
  }

  // Track state BEFORE sending alert to prevent race-condition duplicates
  const wasRunning = previousRunningState.get(activityType) ?? false;
  previousRunningState.set(activityType, running);

  // Send completion alert only on running → stopped transition
  if (!running && wasRunning) {
    await sendCompletionAlert(activityType);
  }

  laLogger.debug({ activityType, running }, 'Dishwasher status change');
  await broadcastConsolidated();
}

export async function onRobotStatusChange(
  name: string,
  status: { running?: boolean; batteryLevel?: number; timeStarted?: Date },
): Promise<void> {
  const activityType = name.toLowerCase().replace(/\s+/g, '');
  const contentState = buildRobotContentState(name, status);
  const running = status.running ?? false;

  // Cache for consolidated activity
  cachedDeviceStates.set(activityType, contentState.device);

  // On first poll after startup, just record state — don't send alerts
  if (!initializedDeviceTypes.has(activityType)) {
    initializedDeviceTypes.add(activityType);
    previousRunningState.set(activityType, running);
    laLogger.debug({ activityType, running }, 'Robot initial state recorded');
    await broadcastConsolidated();
    return;
  }

  // Track state BEFORE sending alert to prevent race-condition duplicates
  const wasRunning = previousRunningState.get(activityType) ?? false;
  previousRunningState.set(activityType, running);

  // Send completion alert only on running → stopped transition
  if (!running && wasRunning) {
    await sendCompletionAlert(activityType);
  }

  laLogger.debug({ activityType, running }, 'Robot status change');
  await broadcastConsolidated();
}
