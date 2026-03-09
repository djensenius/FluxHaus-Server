import { DishWasher, MieleDevice } from './types/types';
import { LiveActivityContentState, pushLiveActivityToAll, pushToStartAll } from './apns';
import { getAllDeviceTokens, getPushTokensByActivityType } from './push-token-store';
import logger from './logger';

const laLogger = logger.child({ subsystem: 'live-activity-hooks' });

// Track previous running state to detect start transitions
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
 * If the device just started running and no per-activity push tokens exist yet,
 * send a push-to-start notification to all registered device tokens so iOS can
 * create the Live Activity even when the app is not running.
 */
async function maybePushToStart(
  activityType: string,
  running: boolean,
  contentState: LiveActivityContentState,
): Promise<void> {
  const wasRunning = previousRunningState.get(activityType) ?? false;
  previousRunningState.set(activityType, running);

  if (!running || wasRunning) return;

  // Device just started — check if per-activity tokens already exist
  const activityTokens = await getPushTokensByActivityType(activityType);
  if (activityTokens.length > 0) return;

  const deviceTokens = await getAllDeviceTokens();
  if (deviceTokens.length === 0) return;

  laLogger.info({ activityType }, 'Sending push-to-start for new activity');
  await pushToStartAll(deviceTokens, contentState);
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

  await maybePushToStart(activityType, running, contentState);

  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const event = running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing Miele Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}

export async function onDishwasherStatusChange(dishwasher: DishWasher): Promise<void> {
  const activityType = 'dishwasher';
  const contentState = buildDishwasherContentState(dishwasher);
  const running = (dishwasher.programProgress ?? 0) > 0;

  await maybePushToStart(activityType, running, contentState);

  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const event = running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing dishwasher Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}

export async function onRobotStatusChange(
  name: string,
  status: { running?: boolean; batteryLevel?: number; timeStarted?: Date },
): Promise<void> {
  const activityType = name.toLowerCase().replace(/\s+/g, '');
  const contentState = buildRobotContentState(name, status);
  const running = status.running ?? false;

  await maybePushToStart(activityType, running, contentState);

  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const event = running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing robot Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}
