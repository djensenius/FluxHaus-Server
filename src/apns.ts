import * as http2 from 'http2';
import * as fs from 'fs';
import { SignJWT, importPKCS8 } from 'jose';
import logger from './logger';
import {
  deleteActivityToken, deleteApnsToken, deleteDeviceToken, deletePushToken,
  getAllActivityTokens,
} from './push-token-store';

const apnsLogger = logger.child({ subsystem: 'apns' });

let apnsConfigured = false;
const APNS_REQUEST_TIMEOUT_MS = 10_000;
const apnsSessions = new Map<string, http2.ClientHttp2Session>();

// Throttle tracking: activityType → last push timestamp
const lastPushTimestamps = new Map<string, number>();
const THROTTLE_INTERVAL_MS = 15_000;

// Seconds between Unix epoch (1970) and Apple/Swift reference date (Jan 1, 2001).
// Swift's default Date Codable encoding uses timeIntervalSinceReferenceDate.
const APPLE_REFERENCE_DATE_OFFSET = 978_307_200;

export function initApns(): void {
  const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID } = process.env;

  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) {
    apnsConfigured = false;
    apnsLogger.warn('APNs not configured — Live Activity push updates disabled');
    return;
  }

  apnsConfigured = true;
  apnsLogger.info('APNs HTTP/2 provider initialized');
}

export interface WidgetDevicePayload {
  name: string;
  progress: number;
  icon: string;
  trailingText: string;
  shortText: string;
  running: boolean;
  programName?: string;
}

export interface LiveActivityContentState {
  device: WidgetDevicePayload;
}

export interface MultiDeviceContentState {
  devices: WidgetDevicePayload[];
}

type ApnsPushType = 'alert' | 'background' | 'liveactivity';

type ApnsPushRequest = {
  token: string;
  topic: string;
  payload: Record<string, unknown>;
  pushType?: ApnsPushType;
  priority?: 5 | 10;
  expiration?: number;
  channelId?: string;
};

type ApnsPushResult = {
  ok: boolean;
  status: number;
  reason: string;
};

function isInvalidTokenReason(reason: string): boolean {
  return reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken';
}

async function generateApnsJwt(): Promise<string | null> {
  const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) return null;

  const keyPem = fs.readFileSync(APNS_KEY_PATH, 'utf8');
  const key = await importPKCS8(keyPem, 'ES256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APNS_KEY_ID })
    .setIssuer(APNS_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

function getApnsHost(): string {
  const env = process.env.APNS_ENVIRONMENT;
  return env === 'development'
    ? 'https://api.sandbox.push.apple.com:443'
    : 'https://api.push.apple.com:443';
}

function getApnsSession(host: string): http2.ClientHttp2Session {
  const existing = apnsSessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const client = http2.connect(host);
  apnsSessions.set(host, client);

  const dropSession = (): void => {
    if (apnsSessions.get(host) === client) apnsSessions.delete(host);
  };
  client.on('close', dropSession);
  client.on('goaway', dropSession);
  client.on('error', (err) => {
    apnsLogger.error({ err }, 'APNs HTTP/2 connection error');
    dropSession();
  });

  return client;
}

async function sendApnsPush(req: ApnsPushRequest): Promise<ApnsPushResult> {
  if (!apnsConfigured) return { ok: false, status: 0, reason: 'not_configured' };

  const jwt = await generateApnsJwt();
  if (!jwt) return { ok: false, status: 0, reason: 'not_configured' };

  return new Promise((resolve) => {
    const client = getApnsSession(getApnsHost());
    let request: http2.ClientHttp2Stream | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout;
    const finish = (result: ApnsPushResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    timeout = setTimeout(() => {
      request?.close(http2.constants.NGHTTP2_CANCEL);
      finish({ ok: false, status: 0, reason: 'timeout' });
    }, APNS_REQUEST_TIMEOUT_MS);

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${req.token}`,
      'apns-topic': req.topic,
      authorization: `bearer ${jwt}`,
      'content-type': 'application/json',
    };
    if (req.pushType) headers['apns-push-type'] = req.pushType;
    if (req.priority) headers['apns-priority'] = String(req.priority);
    if (req.expiration !== undefined) headers['apns-expiration'] = String(req.expiration);
    if (req.channelId) headers['apns-channel-id'] = req.channelId;

    request = client.request(headers);
    let responseData = '';
    let status = 0;

    request.on('response', (hdrs) => {
      status = Number(hdrs[':status'] || 0);
    });
    request.on('data', (chunk: Buffer) => {
      responseData += chunk.toString();
    });
    request.on('end', () => {
      if (status >= 200 && status < 300) {
        finish({ ok: true, status, reason: 'ok' });
        return;
      }
      let reason = responseData || `status ${status}`;
      try {
        const parsed = JSON.parse(responseData) as { reason?: string };
        reason = parsed.reason || reason;
      } catch {
        // Keep the raw response body as the reason.
      }
      finish({ ok: false, status, reason });
    });
    request.on('error', (err: Error) => {
      apnsLogger.error({ err }, 'APNs HTTP/2 request error');
      finish({ ok: false, status, reason: 'request_error' });
    });
    request.on('close', () => {
      if (!settled) finish({ ok: false, status, reason: 'closed' });
    });

    request.write(JSON.stringify(req.payload));
    request.end();
  });
}

export async function sendLiveActivityUpdate(
  pushToken: string,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
  activityType: string,
): Promise<boolean> {
  if (!apnsConfigured) {
    apnsLogger.debug('APNs not initialized — skipping push');
    return false;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event,
      'content-state': contentState,
      ...(event === 'end' ? { 'dismissal-date': now } : {}),
      'stale-date': now + 900,
    },
  };

  try {
    const result = await sendApnsPush({
      token: pushToken,
      topic: `${bundleId}.push-type.liveactivity`,
      pushType: 'liveactivity',
      priority: 10,
      expiration: now + 3600,
      payload,
    });
    if (!result.ok) {
      apnsLogger.warn(
        { status: result.status || 'unknown', reason: result.reason, activityType },
        'APNs push failed',
      );
      if (isInvalidTokenReason(result.reason)) {
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

/**
 * @deprecated Use sendMultiDevicePushToStart for the consolidated activity.
 * Kept for backward compatibility — starts a LEGACY single-device activity (FluxWidgetAttributes).
 */
export async function sendPushToStart(
  deviceToken: string,
  contentState: LiveActivityContentState,
  channelId?: string,
): Promise<boolean> {
  if (!apnsConfigured) {
    apnsLogger.debug('APNs not initialized — skipping push-to-start');
    return false;
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: 'start',
      'content-state': contentState,
      'stale-date': now + 900,
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
    const result = await sendApnsPush({
      token: deviceToken,
      topic: `${bundleId}.push-type.liveactivity`,
      pushType: 'liveactivity',
      priority: 10,
      expiration: now + 3600,
      channelId,
      payload,
    });
    apnsLogger.info(
      {
        device: contentState.device.name,
        sent: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        failureReasons: result.ok ? [] : [result.reason],
      },
      'Push-to-start result',
    );
    if (!result.ok) {
      apnsLogger.warn({ status: result.status || 'unknown', reason: result.reason }, 'Push-to-start failed');

      if (isInvalidTokenReason(result.reason)) {
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

/**
 * Send a push-to-start notification to create a GT3 Companion Live Activity.
 * Uses the GT3 bundle ID and GT3RideAttributes type.
 */
export async function sendGT3PushToStart(
  deviceToken: string,
  contentState: Record<string, unknown>,
): Promise<boolean> {
  if (!apnsConfigured) {
    apnsLogger.debug('APNs not initialized — skipping GT3 push-to-start');
    return false;
  }

  const bundleId = 'org.davidjensenius.GT3Companion';
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: 'start',
      'content-state': contentState,
      'stale-date': now + 300,
      'attributes-type': 'GT3RideAttributes',
      attributes: {
        scooterName: 'GT3 Pro',
        startTime: (Date.now() / 1000) - APPLE_REFERENCE_DATE_OFFSET,
      },
      alert: {
        title: 'GT3 Pro Connected',
        body: 'Ride tracking active',
      },
    },
  };

  try {
    const result = await sendApnsPush({
      token: deviceToken,
      topic: `${bundleId}.push-type.liveactivity`,
      pushType: 'liveactivity',
      priority: 10,
      expiration: now + 3600,
      payload,
    });
    apnsLogger.info(
      {
        sent: result.ok ? 1 : 0,
        failed: result.ok ? 0 : 1,
        failureReasons: result.ok ? [] : [result.reason],
      },
      'GT3 push-to-start result',
    );
    if (!result.ok) {
      apnsLogger.warn({ reason: result.reason, tokenPrefix: deviceToken.substring(0, 8) }, 'GT3 push-to-start failed');

      // Only delete on definitive token invalidity — NOT on transient errors.
      // Push-to-start tokens can appear "bad" temporarily if iOS hasn't finished
      // processing the previous push, so we log but preserve the token.
      if (result.reason === 'BadDeviceToken') {
        await deleteDeviceToken(deviceToken);
        apnsLogger.info({ tokenPrefix: deviceToken.substring(0, 8) }, 'Removed invalid GT3 push-to-start token');
      }
      return false;
    }
    apnsLogger.info('GT3 push-to-start sent successfully');
    return true;
  } catch (err) {
    apnsLogger.error({ err }, 'GT3 push-to-start send error');
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

// --- Raw HTTP/2 broadcast for Live Activities ---

async function sendRawBroadcast(
  channelId: string,
  payload: Record<string, unknown>,
  activityType: string,
): Promise<boolean> {
  const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID } = process.env;
  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) {
    apnsLogger.debug('APNs not configured — skipping broadcast');
    return false;
  }

  const jwt = await generateApnsJwt();
  if (!jwt) return false;

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const host = getApnsHost();
  const path = `/4/broadcasts/apps/${bundleId}`;

  return new Promise((resolve) => {
    const client = http2.connect(host);
    client.on('error', (err) => {
      apnsLogger.error({ err, activityType }, 'Broadcast HTTP/2 connection error');
      client.close();
      resolve(false);
    });

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': path,
      'apns-topic': `${bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': '0',
      'apns-channel-id': channelId,
      authorization: `bearer ${jwt}`,
      'content-type': 'application/json',
    };

    const req = client.request(headers);
    let responseData = '';
    let status = 0;

    req.on('response', (hdrs) => {
      status = hdrs[':status'] as number || 0;
    });

    req.on('data', (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on('end', () => {
      client.close();
      if (status === 200 || status === 201 || status === 204) {
        apnsLogger.info({ activityType, status }, 'Broadcast sent successfully');
        resolve(true);
      } else {
        let reason = 'unknown';
        try {
          const parsed = JSON.parse(responseData);
          reason = parsed.reason || JSON.stringify(parsed);
        } catch {
          reason = responseData || `status ${status}`;
        }
        apnsLogger.warn({ activityType, status, reason }, 'Broadcast failed');
        resolve(false);
      }
    });

    req.on('error', (err: Error) => {
      apnsLogger.error({ err, activityType }, 'Broadcast request error');
      client.close();
      resolve(false);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

// --- Per-activity token Live Activity updates (fallback to broadcast) ---

async function sendLiveActivityUpdateToTokens(
  tokens: Array<{ activityToken: string }>,
  contentState: MultiDeviceContentState,
  event: 'update' | 'end',
): Promise<void> {
  if (!apnsConfigured) return;

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  await Promise.allSettled(
    tokens.map(async (t) => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aps: {
          timestamp: now,
          event,
          'content-state': contentState,
          ...(event === 'end' ? { 'dismissal-date': now } : {}),
          'stale-date': now + 900,
        },
      };

      try {
        const result = await sendApnsPush({
          token: t.activityToken,
          topic: `${bundleId}.push-type.liveactivity`,
          pushType: 'liveactivity',
          priority: 10,
          expiration: now + 3600,
          payload,
        });
        if (!result.ok && isInvalidTokenReason(result.reason)) {
          await deleteActivityToken(t.activityToken);
        }
      } catch (err) {
        apnsLogger.error({ err }, 'Activity token push error');
      }
    }),
  );
}

// --- Broadcast update functions ---

export async function sendBroadcastUpdate(
  channelId: string,
  contentState: LiveActivityContentState,
  event: 'update' | 'end',
  activityType: string,
): Promise<boolean> {
  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
      ...(event === 'end' ? { 'dismissal-date': Math.floor(Date.now() / 1000) } : {}),
      'stale-date': Math.floor(Date.now() / 1000) + 900,
    },
  };
  return sendRawBroadcast(channelId, payload, activityType);
}

// --- Multi-device consolidated Live Activity ---

export async function sendMultiDevicePushToStart(
  deviceToken: string,
  contentState: MultiDeviceContentState,
  channelId?: string,
): Promise<boolean> {
  if (!apnsConfigured) return false;

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const now = Math.floor(Date.now() / 1000);
  const names = contentState.devices.map((d) => d.name).join(', ');
  const payload = {
    aps: {
      timestamp: now,
      event: 'start',
      'content-state': contentState,
      'stale-date': now + 900,
      'attributes-type': 'FluxWidgetMultiAttributes',
      attributes: { name: 'Appliances' },
      alert: {
        title: 'Appliances Running',
        body: names,
      },
    },
  };

  try {
    const result = await sendApnsPush({
      token: deviceToken,
      topic: `${bundleId}.push-type.liveactivity`,
      pushType: 'liveactivity',
      priority: 10,
      expiration: now + 3600,
      channelId,
      payload,
    });
    if (!result.ok) {
      apnsLogger.warn({ reason: result.reason }, 'Multi-device push-to-start failed');
      if (isInvalidTokenReason(result.reason)) {
        await deleteDeviceToken(deviceToken);
      }
      return false;
    }
    apnsLogger.info({ count: contentState.devices.length }, 'Multi-device push-to-start sent');
    return true;
  } catch (err) {
    apnsLogger.error({ err }, 'Multi-device push-to-start error');
    return false;
  }
}

export async function multiDevicePushToStartAll(
  deviceTokens: Array<{ pushToStartToken: string }>,
  contentState: MultiDeviceContentState,
  channelId?: string,
): Promise<void> {
  await Promise.allSettled(
    deviceTokens.map((t) => sendMultiDevicePushToStart(t.pushToStartToken, contentState, channelId)),
  );
}

export async function sendMultiDeviceBroadcast(
  channelId: string,
  contentState: MultiDeviceContentState,
  event: 'update' | 'end',
): Promise<boolean> {
  const payload = {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
      ...(event === 'end' ? { 'dismissal-date': Math.floor(Date.now() / 1000) } : {}),
      'stale-date': Math.floor(Date.now() / 1000) + 900,
    },
  };

  const broadcastOk = await sendRawBroadcast(channelId, payload, 'consolidated');

  // Fallback: also send via per-activity push tokens for devices that may not
  // have received the broadcast (e.g., activity started with pushType: .token)
  const activityTokens = await getAllActivityTokens();
  if (activityTokens.length > 0) {
    await sendLiveActivityUpdateToTokens(activityTokens, contentState, event);
  }

  return broadcastOk;
}

// --- Direct per-activity token updates (fallback when channels unavailable) ---

export async function sendMultiDeviceDirectUpdate(
  tokens: Array<{ activityToken: string }>,
  contentState: MultiDeviceContentState,
  event: 'update' | 'end',
): Promise<void> {
  if (!apnsConfigured || tokens.length === 0) return;

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  await Promise.allSettled(
    tokens.map(async (t) => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aps: {
          timestamp: now,
          event,
          'content-state': contentState,
          ...(event === 'end' ? { 'dismissal-date': now } : {}),
          'stale-date': now + 900,
        },
      };

      try {
        const result = await sendApnsPush({
          token: t.activityToken,
          topic: `${bundleId}.push-type.liveactivity`,
          pushType: 'liveactivity',
          priority: 10,
          expiration: now + 3600,
          payload,
        });
        if (!result.ok && isInvalidTokenReason(result.reason)) {
          await deleteActivityToken(t.activityToken);
        }
      } catch (err) {
        apnsLogger.error({ err }, 'Activity token push error');
      }
    }),
  );
}

// --- Regular alert push notifications ---

export async function sendAlertNotification(
  token: string,
  title: string,
  body: string,
  category?: string,
  topic?: string,
): Promise<boolean> {
  if (!apnsConfigured) return false;

  const bundleId = topic || process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const payload = {
    aps: {
      sound: 'default',
      alert: { title, body },
    },
    category: category || 'appliance_done',
  };

  try {
    const result = await sendApnsPush({
      token,
      topic: bundleId,
      pushType: 'alert',
      priority: 10,
      payload,
    });
    if (!result.ok) {
      apnsLogger.warn({ reason: result.reason }, 'Alert push failed');
      if (isInvalidTokenReason(result.reason)) {
        await deleteApnsToken(token);
      }
      return false;
    }
    return true;
  } catch (err) {
    apnsLogger.error({ err }, 'Alert push error');
    return false;
  }
}

export async function sendAlertToAll(
  tokens: Array<{ token: string }>,
  title: string,
  body: string,
  category?: string,
): Promise<void> {
  await Promise.allSettled(
    tokens.map((t) => sendAlertNotification(t.token, title, body, category)),
  );
}

// --- Silent content-available push to wake app in background ---

export async function sendSilentPushToAll(
  tokens: Array<{ token: string }>,
): Promise<void> {
  if (!apnsConfigured) return;

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';

  await Promise.allSettled(
    tokens.map(async (t) => {
      const payload = {
        aps: {
          'content-available': 1,
        },
        type: 'live-activity-refresh',
      };

      try {
        const result = await sendApnsPush({
          token: t.token,
          topic: bundleId,
          pushType: 'background',
          priority: 5,
          payload,
        });
        if (!result.ok && isInvalidTokenReason(result.reason)) {
          await deleteApnsToken(t.token);
        }
      } catch {
        // Silent push failures are expected sometimes; don't log as errors
      }
    }),
  );
}

export function closeApns(): void {
  for (const session of apnsSessions.values()) {
    session.close();
  }
  apnsSessions.clear();
  if (apnsConfigured) {
    apnsConfigured = false;
    apnsLogger.info('APNs provider shut down');
  }
}
