import { getPool } from '../db';
import { getUserPreferences, setUserPreferences } from '../user-preferences';

vi.mock('../db', () => ({
  getPool: vi.fn(),
}));

vi.mock('../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

describe('user-preferences', () => {
  let mockPool: { query: vi.Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = { query: vi.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('getUserPreferences', () => {
    it('returns defaults (personal memory off) when pool is null', async () => {
      getPool.mockReturnValue(null);
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, personalMemoryEnabled: false, defaultCalendarId: null });
    });

    it('returns defaults (personal memory on) when no row found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, personalMemoryEnabled: true, defaultCalendarId: null });
    });

    it('returns stored preferences', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ memory_enabled: false, personal_memory_enabled: false, default_calendar_id: 'm365:default' }],
      });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: false, personalMemoryEnabled: false, defaultCalendarId: 'm365:default' });
      expect(mockPool.query.mock.calls[0][0]).toContain('personal_memory_enabled');
    });

    it('treats a NULL personal_memory_enabled column as on', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ memory_enabled: true, personal_memory_enabled: null, default_calendar_id: null }],
      });
      const prefs = await getUserPreferences('user-1');
      expect(prefs.personalMemoryEnabled).toBe(true);
    });

    it('fails closed for personal memory on DB error', async () => {
      mockPool.query.mockRejectedValue(new Error('DB down'));
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, personalMemoryEnabled: false, defaultCalendarId: null });
    });
  });

  describe('setUserPreferences', () => {
    it('throws when pool is null', async () => {
      getPool.mockReturnValue(null);
      await expect(setUserPreferences('user-1', { memoryEnabled: false }))
        .rejects.toThrow('Database not available');
    });

    const returned = (memory: boolean, personal: boolean, calendar: string | null) => ({
      rows: [{ memory_enabled: memory, personal_memory_enabled: personal, default_calendar_id: calendar }],
    });

    it('upserts only the supplied column and returns stored values', async () => {
      mockPool.query.mockResolvedValueOnce(returned(false, true, null));
      const result = await setUserPreferences('user-1', { memoryEnabled: false });
      expect(result).toEqual({ memoryEnabled: false, personalMemoryEnabled: true, defaultCalendarId: null });
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('memory_enabled = EXCLUDED.memory_enabled');
      expect(sql).not.toContain('personal_memory_enabled = EXCLUDED');
      expect(sql).not.toContain('default_calendar_id = EXCLUDED');
      expect(params).toEqual(['user-1', false]);
    });

    it('updates default calendar without clobbering memoryEnabled', async () => {
      mockPool.query.mockResolvedValueOnce(returned(true, true, 'icloud:primary'));

      const result = await setUserPreferences('user-1', { defaultCalendarId: 'icloud:primary' });

      expect(result).toEqual({ memoryEnabled: true, personalMemoryEnabled: true, defaultCalendarId: 'icloud:primary' });
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).not.toContain('memory_enabled = EXCLUDED');
      expect(params).toEqual(['user-1', 'icloud:primary']);
    });

    it('turns personal memory off independently of memoryEnabled', async () => {
      mockPool.query.mockResolvedValueOnce(returned(true, false, null));

      const result = await setUserPreferences('user-1', { personalMemoryEnabled: false });

      expect(result).toEqual({ memoryEnabled: true, personalMemoryEnabled: false, defaultCalendarId: null });
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('personal_memory_enabled = EXCLUDED.personal_memory_enabled');
      expect(sql).not.toMatch(/\bmemory_enabled = EXCLUDED\.memory_enabled/);
      expect(params).toEqual(['user-1', false]);
    });

    it('never rewrites personal_memory_enabled because of a failed read', async () => {
      // Even if a read would fail (fail-closed), an unrelated update must not
      // persist personal_memory_enabled=false.
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.startsWith('SELECT')) throw new Error('DB blip');
        return returned(false, true, null);
      });
      const result = await setUserPreferences('user-1', { memoryEnabled: false });
      expect(result.personalMemoryEnabled).toBe(true);
      const writes = mockPool.query.mock.calls.filter(([sql]) => !sql.startsWith('SELECT'));
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).not.toContain('personal_memory_enabled =');
      expect(writes[0][1]).toEqual(['user-1', false]);
    });

    it('updates multiple supplied columns together', async () => {
      mockPool.query.mockResolvedValueOnce(returned(false, false, 'm365:default'));
      await setUserPreferences('user-1', {
        memoryEnabled: false, personalMemoryEnabled: false, defaultCalendarId: 'm365:default',
      });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', false, false, 'm365:default']);
    });
  });
});
