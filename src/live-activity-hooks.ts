import { DishWasher, MieleDevice } from './types/types';
import { LiveActivityContentState, pushLiveActivityToAll } from './apns';
import { getPushTokensByActivityType } from './push-token-store';
import logger from './logger';

const laLogger = logger.child({ subsystem: 'live-activity-hooks' });

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

export async function onMieleStatusChange(
  deviceType: 'washer' | 'dryer',
  device: MieleDevice,
): Promise<void> {
  const activityType = deviceType;
  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const name = deviceType === 'washer' ? 'Washer' : 'Dryer';
  const icon = deviceType === 'washer' ? 'washer' : 'dryer';
  const contentState = buildMieleContentState(name, icon, device);

  const running = (device.timeRemaining ?? 0) > 0;
  const event = running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing Miele Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}

export async function onDishwasherStatusChange(dishwasher: DishWasher): Promise<void> {
  const activityType = 'dishwasher';
  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const contentState = buildDishwasherContentState(dishwasher);
  const running = (dishwasher.programProgress ?? 0) > 0;
  const event = running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing dishwasher Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}

export async function onRobotStatusChange(
  name: string,
  status: { running?: boolean; batteryLevel?: number; timeStarted?: Date },
): Promise<void> {
  const activityType = name.toLowerCase().replace(/\s+/g, '');
  const tokens = await getPushTokensByActivityType(activityType);
  if (tokens.length === 0) return;

  const contentState = buildRobotContentState(name, status);
  const event = status.running ? 'update' : 'end';

  laLogger.debug({ activityType, event }, 'Pushing robot Live Activity update');
  await pushLiveActivityToAll(tokens, contentState, event, activityType);
}
