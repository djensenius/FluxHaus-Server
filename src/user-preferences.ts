import { getPool } from './db';
import logger from './logger';

const prefLogger = logger.child({ subsystem: 'preferences' });

export interface UserPreferences {
  memoryEnabled: boolean;
}

const DEFAULTS: UserPreferences = { memoryEnabled: true };

export async function getUserPreferences(userSub: string): Promise<UserPreferences> {
  const pool = getPool();
  if (!pool) return { ...DEFAULTS };

  try {
    const result = await pool.query(
      'SELECT memory_enabled FROM user_preferences WHERE user_sub = $1',
      [userSub],
    );
    if (result.rows.length === 0) return { ...DEFAULTS };
    return { memoryEnabled: result.rows[0].memory_enabled };
  } catch (err) {
    prefLogger.error({ err, userSub }, 'Failed to load user preferences');
    return { ...DEFAULTS };
  }
}

export async function setUserPreferences(
  userSub: string,
  prefs: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const current = await getUserPreferences(userSub);
  const merged = { ...current, ...prefs };

  await pool.query(
    `INSERT INTO user_preferences (user_sub, memory_enabled)
     VALUES ($1, $2)
     ON CONFLICT (user_sub)
     DO UPDATE SET memory_enabled = EXCLUDED.memory_enabled, updated_at = NOW()`,
    [userSub, merged.memoryEnabled],
  );

  prefLogger.info({ userSub, memoryEnabled: merged.memoryEnabled }, 'User preferences updated');
  return merged;
}
