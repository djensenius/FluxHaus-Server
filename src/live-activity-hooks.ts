import { DishWasher, MieleDevice } from './types/types';
import { LiveActivityContentState, pushToStartAll, sendBroadcastUpdate } from './apns';
import { getChannelId } from './apns-channels';
import { getAllDeviceTokens } from './push-token-store';
import logger from './logger';

const laLogger = logger.child({ subsystem: 'live-activity-hooks' });

// Track previous running state to detect start transitions for push-to-start
const previousRunningState = new Map<string, boolean>();

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
    },
  };
}

function buildDishwasherContentState(dishwasher: DishWasher): LiveActivityContentState {
  const remainingText = formatTimeRemaining(dishwasher.remainingTime ?? 0);
  let trailingText = remainingText;
  if (dishwasher.activeProgram) {
    trailingText = `${dishwasher.activeProgram} · ${trailingText}`;
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
      shortText: `${dishwasher.remainingTime ?? 0}m`,
      running,
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
 * Send a broadcast update for the given activity type via its channel.
 */
async function broadcastUpdate(
  activityType: string,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
): Promise<void> {
  const channelId = await getChannelId(activityType);
  if (!channelId) {
    laLogger.warn({ activityType }, 'No channel ID — skipping broadcast');
    return;
  }
  await sendBroadcastUpdate(channelId, contentState, event, activityType);
}

/**
 * When a device first starts running, send push-to-start so iOS creates
 * the Live Activity (and subscribes to the broadcast channel) even if
 * the app hasn't been opened recently.
 */
async function maybePushToStart(
  activityType: string,
  running: boolean,
  contentState: LiveActivityContentState,
): Promise<void> {
  const wasRunning = previousRunningState.get(activityType) ?? false;
  previousRunningState.set(activityType, running);

  if (!running || wasRunning) return;

  const deviceTokens = await getAllDeviceTokens();
  if (deviceTokens.length === 0) return;

  // Include channel ID so the activity is created already subscribed
  const channelId = await getChannelId(activityType);

  laLogger.info({ activityType, hasChannel: !!channelId }, 'Sending push-to-start');
  await pushToStartAll(deviceTokens, contentState, channelId ?? undefined);
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
  const event = running ? 'update' : 'end';

  await maybePushToStart(activityType, running, contentState);
  laLogger.debug({ activityType, event }, 'Broadcasting Miele Live Activity update');
  await broadcastUpdate(activityType, contentState, event);
}

export async function onDishwasherStatusChange(dishwasher: DishWasher): Promise<void> {
  const activityType = 'dishwasher';
  const contentState = buildDishwasherContentState(dishwasher);
  const running = (dishwasher.programProgress ?? 0) > 0;
  const event = running ? 'update' : 'end';

  await maybePushToStart(activityType, running, contentState);
  laLogger.debug({ activityType, event }, 'Broadcasting dishwasher Live Activity update');
  await broadcastUpdate(activityType, contentState, event);
}

export async function onRobotStatusChange(
  name: string,
  status: { running?: boolean; batteryLevel?: number; timeStarted?: Date },
): Promise<void> {
  const activityType = name.toLowerCase().replace(/\s+/g, '');
  const contentState = buildRobotContentState(name, status);
  const running = status.running ?? false;
  const event = running ? 'update' : 'end';

  await maybePushToStart(activityType, running, contentState);
  laLogger.debug({ activityType, event }, 'Broadcasting robot Live Activity update');
  await broadcastUpdate(activityType, contentState, event);
}
