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
