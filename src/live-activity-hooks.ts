import { DishWasher, MieleDevice } from './types/types';
import {
  LiveActivityContentState, MultiDeviceContentState, WidgetDevicePayload,
  multiDevicePushToStartAll,
  sendAlertToAll,
  sendMultiDeviceBroadcast,
  sendMultiDeviceDirectUpdate,
  sendSilentPushToAll,
} from './apns';
import { getChannelId } from './apns-channels';
import { getApnsTokensForDeviceType, getSubscribedDeviceTokens } from './la-subscriptions';
import { getAllActivityTokens, getAllApnsTokens } from './push-token-store';
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

// Timestamp of the last push-to-start sent (for catch-up gating)
const PUSH_TO_START_COOLDOWN_MS = 30_000;

// Per-token cooldown tracking for catch-up push-to-start
const lastPushToStartByToken = new Map<string, number>();

// Serialize broadcastConsolidated to prevent overlapping calls
let broadcastQueue: Promise<void> = Promise.resolve();

// Timestamp when the module was loaded — used as fallback for allInitialized
const moduleLoadedAt = Date.now();
const INITIALIZATION_TIMEOUT_MS = 60_000;

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
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
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

  // Treat delayed/programmed states as not running — the Live Activity
  // should only appear once the appliance actually starts its cycle.
  const isDelayed = device.status === 'Programmed' || device.status === 'Waiting to start';
  const running = !isDelayed && (device.timeRemaining ?? 0) > 0;

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

  // Treat delayed start as not running — the Live Activity
  // should only appear once the appliance actually starts its cycle.
  const running = dishwasher.operationState !== 'DelayedStart'
    && (dishwasher.programProgress ?? 0) > 0;

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
 * Serialized via promise chain to prevent overlapping calls.
 */
async function broadcastConsolidated(force = false): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  broadcastQueue = broadcastQueue.then(() => broadcastConsolidatedImpl(force)).catch((err) => {
    laLogger.error({ err }, 'broadcastConsolidated failed');
  });
  await broadcastQueue;
}

async function broadcastConsolidatedImpl(force = false): Promise<void> {
  // Don't send push-to-start until all device types have been initialized
  // (or timeout elapsed), to prevent false starts on server restart.
  const allTypesInitialized = ['washer', 'dryer', 'dishwasher', 'broombot', 'mopbot']
    .every((dt) => initializedDeviceTypes.has(dt));
  const initTimedOut = Date.now() - moduleLoadedAt > INITIALIZATION_TIMEOUT_MS;
  const allInitialized = allTypesInitialized || initTimedOut;

  const runningDevices = Array.from(cachedDeviceStates.values()).filter((d) => d.running);
  const hasRunning = runningDevices.length > 0;
  const wasAnyRunning = previousRunningState.get('consolidated') ?? false;

  const contentState: MultiDeviceContentState = { devices: runningDevices };

  // Try to get channel, but don't block on it — push-to-start works without channels
  const channelId = await getChannelId('consolidated');

  // Update state after attempting channel (don't lose edge if channel fails)
  previousRunningState.set('consolidated', hasRunning);

  if (hasRunning) {
    // Push-to-start if transitioning from no devices to at least one
    if (!wasAnyRunning && allInitialized) {
      const subscribedTokens = await getSubscribedDeviceTokens();
      if (subscribedTokens.length > 0) {
        laLogger.info(
          { count: runningDevices.length, hasChannel: !!channelId },
          'Sending consolidated push-to-start',
        );
        // channelId is optional — push-to-start works without it
        await multiDevicePushToStartAll(subscribedTokens, contentState, channelId ?? undefined);
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

    // Send via broadcast channel if available
    if (channelId) {
      await sendMultiDeviceBroadcast(channelId, contentState, 'update');
    }

    // Also send via per-activity push tokens (works without channels)
    const activityTokens = await getAllActivityTokens();
    if (activityTokens.length > 0) {
      await sendMultiDeviceDirectUpdate(activityTokens, contentState, 'update');
    }
  } else if (wasAnyRunning) {
    // All devices stopped — end the consolidated activity
    stopKeepAlive();

    if (channelId) {
      await sendMultiDeviceBroadcast(channelId, { devices: [] }, 'end');
    }

    const activityTokens = await getAllActivityTokens();
    if (activityTokens.length > 0) {
      await sendMultiDeviceDirectUpdate(activityTokens, { devices: [] }, 'end');
    }

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
  const { running } = contentState.device;

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
  const { running } = contentState.device;

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

/**
 * Called when a new push-to-start token is registered.
 * If devices are currently running and no push-to-start was sent recently,
 * send one to the new token so the user doesn't have to wait for the next transition.
 */
export async function onPushToStartTokenRegistered(
  pushToStartToken: string,
): Promise<void> {
  const runningDevices = Array.from(cachedDeviceStates.values()).filter((d) => d.running);
  if (runningDevices.length === 0) return;

  // Per-token cooldown to avoid duplicate sends without blocking other tokens
  const lastSentForToken = lastPushToStartByToken.get(pushToStartToken) ?? 0;
  if (Date.now() - lastSentForToken < PUSH_TO_START_COOLDOWN_MS) {
    laLogger.debug('Skipping catch-up push-to-start — one was sent recently for this token');
    return;
  }

  const channelId = await getChannelId('consolidated');

  const contentState: MultiDeviceContentState = { devices: runningDevices };
  laLogger.info(
    { count: runningDevices.length },
    'Sending catch-up push-to-start for newly registered token',
  );
  await multiDevicePushToStartAll([{ pushToStartToken }], contentState, channelId ?? undefined);
  lastPushToStartByToken.set(pushToStartToken, Date.now());
}
