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
      expect(prefs).toEqual({ memoryEnabled: true });
    });

    it('returns defaults when no row found', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true });
    });

    it('returns stored preferences', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ memory_enabled: false }] });
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: false });
    });

    it('returns defaults on DB error', async () => {
      mockPool.query.mockRejectedValue(new Error('DB down'));
      const prefs = await getUserPreferences('user-1');
      expect(prefs).toEqual({ memoryEnabled: true });
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
        .mockResolvedValueOnce({ rows: [{ memory_enabled: true }] }) // getUserPreferences
        .mockResolvedValueOnce({ rows: [] }); // INSERT ... ON CONFLICT
      const result = await setUserPreferences('user-1', { memoryEnabled: false });
      expect(result).toEqual({ memoryEnabled: false });
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      const upsertCall = mockPool.query.mock.calls[1];
      expect(upsertCall[0]).toContain('ON CONFLICT');
      expect(upsertCall[1]).toEqual(['user-1', false]);
    });
  });
});
