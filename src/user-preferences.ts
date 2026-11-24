import { getPool } from './db';
import logger from './logger';

const prefLogger = logger.child({ subsystem: 'preferences' });

export interface UserPreferences {
  memoryEnabled: boolean;
  /** Hindsight-backed personal memory shared with the user's other assistants. */
  personalMemoryEnabled: boolean;
  defaultCalendarId: string | null;
}

const DEFAULTS: UserPreferences = {
  memoryEnabled: true,
  personalMemoryEnabled: true,
  defaultCalendarId: null,
};

// When stored preferences can't be read, fail closed for personal memory so a
// user's opt-out is never ignored because of a database problem.
const UNAVAILABLE: UserPreferences = { ...DEFAULTS, personalMemoryEnabled: false };

export async function getUserPreferences(userSub: string): Promise<UserPreferences> {
  const pool = getPool();
  if (!pool) return { ...UNAVAILABLE };

  try {
    const result = await pool.query(
      'SELECT memory_enabled, personal_memory_enabled, default_calendar_id '
        + 'FROM user_preferences WHERE user_sub = $1',
      [userSub],
    );
    if (result.rows.length === 0) return { ...DEFAULTS };
    return {
      memoryEnabled: result.rows[0].memory_enabled,
      personalMemoryEnabled: result.rows[0].personal_memory_enabled !== false,
      defaultCalendarId: result.rows[0].default_calendar_id,
    };
  } catch (err) {
    prefLogger.error({ err, userSub }, 'Failed to load user preferences');
    return { ...UNAVAILABLE };
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
    personalMemoryEnabled: prefs.personalMemoryEnabled ?? current.personalMemoryEnabled,
    defaultCalendarId: prefs.defaultCalendarId === undefined
      ? current.defaultCalendarId
      : prefs.defaultCalendarId,
  };

  await pool.query(
    `INSERT INTO user_preferences
       (user_sub, memory_enabled, default_calendar_id, personal_memory_enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_sub)
     DO UPDATE SET
       memory_enabled = EXCLUDED.memory_enabled,
       default_calendar_id = EXCLUDED.default_calendar_id,
       personal_memory_enabled = EXCLUDED.personal_memory_enabled,
       updated_at = NOW()`,
    [userSub, merged.memoryEnabled, merged.defaultCalendarId, merged.personalMemoryEnabled],
  );

  prefLogger.info({
    userSub,
    memoryEnabled: merged.memoryEnabled,
    personalMemoryEnabled: merged.personalMemoryEnabled,
    defaultCalendarId: merged.defaultCalendarId,
  }, 'User preferences updated');
  return merged;
}
