import apn from '@parse/node-apn';
import logger from './logger';
import { deleteDeviceToken, deletePushToken } from './push-token-store';

const apnsLogger = logger.child({ subsystem: 'apns' });

let provider: apn.Provider | null = null;

// Throttle tracking: activityType → last push timestamp
const lastPushTimestamps = new Map<string, number>();
const THROTTLE_INTERVAL_MS = 15_000;

export function initApns(): void {
  const {
    APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_ENVIRONMENT,
  } = process.env;

  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) {
    apnsLogger.warn('APNs not configured — Live Activity push updates disabled');
    return;
  }

  provider = new apn.Provider({
    token: {
      key: APNS_KEY_PATH,
      keyId: APNS_KEY_ID,
      teamId: APNS_TEAM_ID,
    },
    production: APNS_ENVIRONMENT !== 'development',
  });

  apnsLogger.info('APNs provider initialized');
}

export interface LiveActivityContentState {
  device: {
    name: string;
    progress: number;
    icon: string;
    trailingText: string;
    shortText: string;
    running: boolean;
  };
}

export async function sendLiveActivityUpdate(
  pushToken: string,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
  activityType: string,
): Promise<boolean> {
  if (!provider) {
    apnsLogger.debug('APNs not initialized — skipping push');
    return false;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  const notification = new apn.Notification();
  notification.topic = `${bundleId}.push-type.liveactivity`;
  notification.pushType = 'liveactivity';
  notification.priority = 10;
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;

  notification.rawPayload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
      ...(event === 'end' ? { 'dismissal-date': Math.floor(Date.now() / 1000) + 300 } : {}),
      'stale-date': Math.floor(Date.now() / 1000) + 900,
    },
  };

  try {
    const result = await provider.send(notification, pushToken);
    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const status = failure.status || 'unknown';
      const reason = failure.response?.reason || 'unknown';
      apnsLogger.warn({ status, reason, activityType }, 'APNs push failed');

      // Remove invalid tokens
      if (reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken') {
        await deletePushToken(pushToken);
        apnsLogger.info({ activityType }, 'Removed invalid push token');
      }
      return false;
    }
    return true;
  } catch (err) {
    apnsLogger.error({ err, activityType }, 'APNs send error');
    return false;
  }
}

export async function pushLiveActivityToAll(
  tokens: Array<{ pushToken: string }>,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
  activityType: string,
): Promise<void> {
  // Throttle: skip if we pushed this activity type recently
  const lastPush = lastPushTimestamps.get(activityType) || 0;
  if (Date.now() - lastPush < THROTTLE_INTERVAL_MS) {
    return;
  }
  lastPushTimestamps.set(activityType, Date.now());

  await Promise.allSettled(
    tokens.map((t) => sendLiveActivityUpdate(t.pushToken, contentState, event, activityType)),
  );
}

export async function sendPushToStart(
  deviceToken: string,
  contentState: LiveActivityContentState,
  channelId?: string,
): Promise<boolean> {
  if (!provider) {
    apnsLogger.debug('APNs not initialized — skipping push-to-start');
    return false;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  const notification = new apn.Notification();
  notification.topic = `${bundleId}.push-type.liveactivity`;
  notification.pushType = 'liveactivity';
  notification.priority = 10;
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  if (channelId) {
    notification.channelId = channelId;
  }

  notification.rawPayload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: 'start',
      'content-state': contentState,
      'stale-date': Math.floor(Date.now() / 1000) + 900,
      'attributes-type': 'FluxWidgetAttributes',
      attributes: {
        name: contentState.device.name,
      },
      alert: {
        title: `${contentState.device.name}`,
        body: `${contentState.device.trailingText}`,
      },
    },
  };

  try {
    const result = await provider.send(notification, deviceToken);
    apnsLogger.info(
      {
        device: contentState.device.name,
        sent: result.sent?.length || 0,
        failed: result.failed?.length || 0,
        failureReasons: result.failed?.map((f: { response?: { reason?: string } }) => f.response?.reason),
      },
      'Push-to-start result',
    );
    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const status = failure.status || 'unknown';
      const reason = failure.response?.reason || 'unknown';
      apnsLogger.warn({ status, reason }, 'Push-to-start failed');

      if (reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken') {
        await deleteDeviceToken(deviceToken);
        apnsLogger.info('Removed invalid push-to-start token');
      }
      return false;
    }
    apnsLogger.info({ device: contentState.device.name }, 'Push-to-start sent');
    return true;
  } catch (err) {
    apnsLogger.error({ err }, 'Push-to-start send error');
    return false;
  }
}

export async function pushToStartAll(
  deviceTokens: Array<{ pushToStartToken: string }>,
  contentState: LiveActivityContentState,
  channelId?: string,
): Promise<void> {
  await Promise.allSettled(
    deviceTokens.map((t) => sendPushToStart(t.pushToStartToken, contentState, channelId)),
  );
}

export async function sendBroadcastUpdate(
  channelId: string,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
  activityType: string,
): Promise<boolean> {
  if (!provider) {
    apnsLogger.debug('APNs not initialized — skipping broadcast');
    return false;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  const notification = new apn.Notification();
  notification.topic = `${bundleId}.push-type.liveactivity`;
  notification.pushType = 'liveactivity';
  notification.priority = 10;
  notification.expiry = Math.floor(Date.now() / 1000) + 3600;
  notification.channelId = channelId;

  notification.rawPayload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
      ...(event === 'end' ? { 'dismissal-date': Math.floor(Date.now() / 1000) + 300 } : {}),
      'stale-date': Math.floor(Date.now() / 1000) + 900,
    },
  };

  try {
    const result = await (provider as unknown as {
      broadcast: (n: apn.Notification, b: string) => Promise<{
        sent: unknown[]; failed: Array<{ response?: { reason?: string } }>;
      }>;
    }).broadcast(notification, bundleId);

    if (result.failed.length > 0) {
      const failure = result.failed[0];
      const reason = failure.response?.reason || 'unknown';
      apnsLogger.warn({ reason, activityType }, 'Broadcast update failed');
      return false;
    }
    apnsLogger.debug({ activityType, event }, 'Broadcast update sent');
    return true;
  } catch (err) {
    apnsLogger.error({ err, activityType }, 'Broadcast send error');
    return false;
  }
}

export function closeApns(): void {
  if (provider) {
    provider.shutdown();
    provider = null;
    apnsLogger.info('APNs provider shut down');
  }
}
