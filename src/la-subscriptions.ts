import { getPool } from './db';
import logger from './logger';

const subLogger = logger.child({ subsystem: 'la-subscriptions' });

const ALL_DEVICE_TYPES = ['dishwasher', 'washer', 'dryer', 'broombot', 'mopbot'];

export interface SubscriptionPreferences {
  deviceTypes: string[];
}

/**
 * Save which device types a user wants Live Activities for.
 */
export async function saveSubscriptions(
  userSub: string,
  deviceTypes: string[],
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  // Validate device types
  const valid = deviceTypes.filter((dt) => ALL_DEVICE_TYPES.includes(dt));

  try {
    await pool.query(
      `INSERT INTO la_subscriptions (user_sub, device_types)
       VALUES ($1, $2)
       ON CONFLICT (user_sub) DO UPDATE SET
         device_types = EXCLUDED.device_types,
         updated_at = NOW()`,
      [userSub, JSON.stringify(valid)],
    );
  } catch (err) {
    subLogger.error({ err, userSub }, 'Failed to save subscriptions');
    throw err;
  }
}

/**
 * Get a user's subscribed device types. Defaults to all if not set.
 */
export async function getSubscriptions(userSub: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) return ALL_DEVICE_TYPES;

  try {
    const result = await pool.query(
      'SELECT device_types FROM la_subscriptions WHERE user_sub = $1',
      [userSub],
    );
    if (result.rows.length === 0) return ALL_DEVICE_TYPES;
    return JSON.parse(result.rows[0].device_types);
  } catch {
    return ALL_DEVICE_TYPES;
  }
}

/**
 * Get all device tokens that have at least one subscription (for consolidated push-to-start).
 * Returns tokens for all users since consolidated activity covers all devices.
 */
export async function getSubscribedDeviceTokens(): Promise<Array<{ pushToStartToken: string }>> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query(
      `SELECT push_to_start_token AS "pushToStartToken"
       FROM device_tokens`,
    );
    return result.rows;
  } catch (err) {
    subLogger.error({ err }, 'Failed to get subscribed device tokens');
    return [];
  }
}
