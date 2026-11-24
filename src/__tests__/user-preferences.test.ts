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

    it('upserts preferences', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ memory_enabled: true, default_calendar_id: null }] }) // getUserPreferences
        .mockResolvedValueOnce({ rows: [] }); // INSERT ... ON CONFLICT
      const result = await setUserPreferences('user-1', { memoryEnabled: false });
      expect(result).toEqual({ memoryEnabled: false, personalMemoryEnabled: true, defaultCalendarId: null });
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const upsertCall = mockPool.query.mock.calls[1];
      expect(upsertCall[0]).toContain('ON CONFLICT');
      expect(upsertCall[1]).toEqual(['user-1', false, null, true]);
    });

    it('updates default calendar without clobbering memoryEnabled', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ memory_enabled: true, default_calendar_id: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await setUserPreferences('user-1', { defaultCalendarId: 'icloud:primary' });

      expect(result).toEqual({ memoryEnabled: true, personalMemoryEnabled: true, defaultCalendarId: 'icloud:primary' });
      expect(mockPool.query.mock.calls[1][1]).toEqual(['user-1', true, 'icloud:primary', true]);
    });

    it('turns personal memory off independently of memoryEnabled', async () => {
      mockPool.query
        .mockResolvedValueOnce({
          rows: [{ memory_enabled: true, personal_memory_enabled: true, default_calendar_id: null }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await setUserPreferences('user-1', { personalMemoryEnabled: false });

      expect(result).toEqual({ memoryEnabled: true, personalMemoryEnabled: false, defaultCalendarId: null });
      expect(mockPool.query.mock.calls[1][0]).toContain('personal_memory_enabled = EXCLUDED.personal_memory_enabled');
      expect(mockPool.query.mock.calls[1][1]).toEqual(['user-1', true, null, false]);
    });
  });
});
