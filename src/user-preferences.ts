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

  // Partial upsert: only the supplied columns are written, so a failed or
  // fail-closed read can never clobber unrelated stored preferences.
  // Column names come from this fixed list, never from user input.
  const updates: Array<[string, unknown]> = [];
  if (prefs.memoryEnabled !== undefined) updates.push(['memory_enabled', prefs.memoryEnabled]);
  if (prefs.personalMemoryEnabled !== undefined) {
    updates.push(['personal_memory_enabled', prefs.personalMemoryEnabled]);
  }
  if (prefs.defaultCalendarId !== undefined) updates.push(['default_calendar_id', prefs.defaultCalendarId]);
  if (updates.length === 0) return getUserPreferences(userSub);

  const columns = updates.map(([column]) => column);
  const result = await pool.query(
    `INSERT INTO user_preferences (user_sub, ${columns.join(', ')})
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (user_sub)
     DO UPDATE SET
       ${columns.map((column) => `${column} = EXCLUDED.${column}`).join(',\n       ')},
       updated_at = NOW()
     RETURNING memory_enabled, personal_memory_enabled, default_calendar_id`,
    [userSub, ...updates.map(([, value]) => value)],
  );

  const row = result.rows?.[0];
  if (!row) throw new Error('Failed to save preferences');
  const saved: UserPreferences = {
    memoryEnabled: row.memory_enabled !== false,
    personalMemoryEnabled: row.personal_memory_enabled !== false,
    defaultCalendarId: row.default_calendar_id ?? null,
  };

  prefLogger.info({
    userSub,
    memoryEnabled: saved.memoryEnabled,
    personalMemoryEnabled: saved.personalMemoryEnabled,
    defaultCalendarId: saved.defaultCalendarId,
  }, 'User preferences updated');
  return saved;
}
