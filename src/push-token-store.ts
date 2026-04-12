import { getPool } from './db';
import logger from './logger';

const pushLogger = logger.child({ subsystem: 'push-token-store' });

export interface PushTokenData {
  userSub: string;
  deviceName?: string;
  pushToken: string;
  activityType: string;
  bundleId?: string;
}

export async function savePushToken(data: PushTokenData): Promise<void> {
  const pool = getPool();
  if (!pool) {
    pushLogger.warn('PostgreSQL not available — cannot save push token');
    return;
  }

  try {
    await pool.query(
      `INSERT INTO push_tokens (user_sub, device_name, push_token, activity_type, bundle_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (push_token) DO UPDATE SET
         user_sub = EXCLUDED.user_sub,
         device_name = EXCLUDED.device_name,
         activity_type = EXCLUDED.activity_type,
         bundle_id = EXCLUDED.bundle_id,
         updated_at = NOW()`,
      [data.userSub, data.deviceName, data.pushToken, data.activityType, data.bundleId],
    );
  } catch (err) {
    pushLogger.error({ err, userSub: data.userSub }, 'Failed to save push token');
    throw err;
  }
}

export async function getPushTokensByActivityType(activityType: string): Promise<PushTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              push_token AS "pushToken", activity_type AS "activityType",
              bundle_id AS "bundleId"
       FROM push_tokens
       WHERE activity_type = $1`,
      [activityType],
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err, activityType }, 'Failed to get push tokens by activity type');
    return [];
  }
}

export async function getAllActivePushTokens(): Promise<PushTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              push_token AS "pushToken", activity_type AS "activityType",
              bundle_id AS "bundleId"
       FROM push_tokens`,
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err }, 'Failed to get all push tokens');
    return [];
  }
}

export async function deletePushToken(pushToken: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM push_tokens WHERE push_token = $1', [pushToken]);
  } catch (err) {
    pushLogger.error({ err, pushToken: pushToken.substring(0, 8) }, 'Failed to delete push token');
  }
}

// --- Device-level push-to-start tokens ---

export interface DeviceTokenData {
  userSub: string;
  deviceName?: string;
  pushToStartToken: string;
  bundleId?: string;
}

export async function saveDeviceToken(data: DeviceTokenData): Promise<void> {
  const pool = getPool();
  if (!pool) {
    pushLogger.warn('PostgreSQL not available — cannot save device token');
    return;
  }

  try {
    await pool.query(
      `INSERT INTO device_tokens (user_sub, device_name, push_to_start_token, bundle_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (push_to_start_token) DO UPDATE SET
         user_sub = EXCLUDED.user_sub,
         device_name = EXCLUDED.device_name,
         bundle_id = EXCLUDED.bundle_id,
         updated_at = NOW()`,
      [data.userSub, data.deviceName, data.pushToStartToken, data.bundleId],
    );
  } catch (err) {
    pushLogger.error({ err, userSub: data.userSub }, 'Failed to save device token');
    throw err;
  }
}

export async function getAllDeviceTokens(): Promise<DeviceTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              push_to_start_token AS "pushToStartToken",
              bundle_id AS "bundleId"
       FROM device_tokens`,
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err }, 'Failed to get device tokens');
    return [];
  }
}

export async function getDeviceTokensByUserAndBundle(
  userSub: string,
  bundleId: string,
): Promise<DeviceTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              push_to_start_token AS "pushToStartToken",
              bundle_id AS "bundleId"
       FROM device_tokens
       WHERE user_sub = $1 AND bundle_id = $2`,
      [userSub, bundleId],
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err, userSub, bundleId }, 'Failed to get device tokens by user/bundle');
    return [];
  }
}

export async function deleteDeviceToken(pushToStartToken: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM device_tokens WHERE push_to_start_token = $1', [pushToStartToken]);
  } catch (err) {
    pushLogger.error(
      { err, token: pushToStartToken.substring(0, 8) },
      'Failed to delete device token',
    );
  }
}

// --- Regular APNs tokens for alert notifications ---

export interface ApnsTokenData {
  userSub: string;
  deviceName?: string;
  token: string;
  bundleId?: string;
}

export async function saveApnsToken(data: ApnsTokenData): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO apns_tokens (user_sub, device_name, token, bundle_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET
         user_sub = EXCLUDED.user_sub,
         device_name = EXCLUDED.device_name,
         bundle_id = EXCLUDED.bundle_id,
         updated_at = NOW()`,
      [data.userSub, data.deviceName, data.token, data.bundleId],
    );
  } catch (err) {
    pushLogger.error({ err, userSub: data.userSub }, 'Failed to save APNs token');
    throw err;
  }
}

export async function getAllApnsTokens(): Promise<ApnsTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              token, bundle_id AS "bundleId"
       FROM apns_tokens`,
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err }, 'Failed to get APNs tokens');
    return [];
  }
}

export async function deleteApnsToken(token: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM apns_tokens WHERE token = $1', [token]);
  } catch (err) {
    pushLogger.error({ err }, 'Failed to delete APNs token');
  }
}

export async function getApnsTokensByUser(userSub: string): Promise<ApnsTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              token, bundle_id AS "bundleId"
       FROM apns_tokens WHERE user_sub = $1`,
      [userSub],
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to get APNs tokens by user');
    return [];
  }
}

export async function getDeviceTokensByUser(userSub: string): Promise<DeviceTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              push_to_start_token AS "pushToStartToken",
              bundle_id AS "bundleId"
       FROM device_tokens WHERE user_sub = $1`,
      [userSub],
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to get device tokens by user');
    return [];
  }
}

// --- Per-activity Live Activity push tokens (for direct token-based updates) ---

export interface ActivityTokenData {
  userSub: string;
  deviceName?: string;
  activityToken: string;
  bundleId?: string;
}

export async function saveActivityToken(data: ActivityTokenData): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO activity_tokens (user_sub, device_name, activity_token, bundle_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (activity_token) DO UPDATE SET
         user_sub = EXCLUDED.user_sub,
         device_name = EXCLUDED.device_name,
         bundle_id = EXCLUDED.bundle_id,
         updated_at = NOW()`,
      [data.userSub, data.deviceName, data.activityToken, data.bundleId],
    );
  } catch (err) {
    pushLogger.error({ err, userSub: data.userSub }, 'Failed to save activity token');
    throw err;
  }
}

export async function getAllActivityTokens(): Promise<ActivityTokenData[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT user_sub AS "userSub", device_name AS "deviceName",
              activity_token AS "activityToken",
              bundle_id AS "bundleId"
       FROM activity_tokens`,
    );
    return result.rows;
  } catch (err) {
    pushLogger.error({ err }, 'Failed to get activity tokens');
    return [];
  }
}

export async function deleteActivityToken(activityToken: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM activity_tokens WHERE activity_token = $1', [activityToken]);
  } catch (err) {
    pushLogger.error({ err }, 'Failed to delete activity token');
  }
}
