import { getUserPreferences, setUserPreferences } from '../user-preferences';

jest.mock('../db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPool } = require('../db');

describe('user-preferences', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('getUserPreferences', () => {
    it('returns defaults when pool is null', async () => {
      getPool.mockReturnValue(null);
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, defaultCalendarId: null });
    });

    it('returns defaults when no row found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, defaultCalendarId: null });
    });

    it('returns stored preferences', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ memory_enabled: false, default_calendar_id: 'm365:default' }],
      });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: false, defaultCalendarId: 'm365:default' });
    });

    it('returns defaults on DB error', async () => {
      mockPool.query.mockRejectedValue(new Error('DB down'));
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true, defaultCalendarId: null });
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
      expect(result).toEqual({ memoryEnabled: false, defaultCalendarId: null });
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const upsertCall = mockPool.query.mock.calls[1];
      expect(upsertCall[0]).toContain('ON CONFLICT');
      expect(upsertCall[1]).toEqual(['user-1', false, null]);
    });

    it('updates default calendar without clobbering memoryEnabled', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ memory_enabled: true, default_calendar_id: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await setUserPreferences('user-1', { defaultCalendarId: 'icloud:primary' });

      expect(result).toEqual({ memoryEnabled: true, defaultCalendarId: 'icloud:primary' });
      expect(mockPool.query.mock.calls[1][1]).toEqual(['user-1', true, 'icloud:primary']);
    });
  });
});
