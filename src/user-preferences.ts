import { getPool } from './db';
import logger from './logger';

const prefLogger = logger.child({ subsystem: 'preferences' });

export interface UserPreferences {
  memoryEnabled: boolean;
  defaultCalendarId: string | null;
}

const DEFAULTS: UserPreferences = { memoryEnabled: true, defaultCalendarId: null };

export async function getUserPreferences(userSub: string): Promise<UserPreferences> {
  const pool = getPool();
  if (!pool) return { ...DEFAULTS };

  try {
    const result = await pool.query(
      'SELECT memory_enabled, default_calendar_id FROM user_preferences WHERE user_sub = $1',
      [userSub],
    );
    if (result.rows.length === 0) return { ...DEFAULTS };
    return {
      memoryEnabled: result.rows[0].memory_enabled,
      defaultCalendarId: result.rows[0].default_calendar_id,
    };
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
  const merged: UserPreferences = {
    memoryEnabled: prefs.memoryEnabled ?? current.memoryEnabled,
    defaultCalendarId: prefs.defaultCalendarId === undefined
      ? current.defaultCalendarId
      : prefs.defaultCalendarId,
  };

  await pool.query(
    `INSERT INTO user_preferences (user_sub, memory_enabled, default_calendar_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_sub)
     DO UPDATE SET
       memory_enabled = EXCLUDED.memory_enabled,
       default_calendar_id = EXCLUDED.default_calendar_id,
       updated_at = NOW()`,
    [userSub, merged.memoryEnabled, merged.defaultCalendarId],
  );

  prefLogger.info({
    userSub,
    memoryEnabled: merged.memoryEnabled,
    defaultCalendarId: merged.defaultCalendarId,
  }, 'User preferences updated');
  return merged;
}
