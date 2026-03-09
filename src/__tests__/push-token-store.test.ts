import {
  savePushToken,
  getPushTokensByActivityType,
  getAllActivePushTokens,
  deletePushToken,
  PushTokenData,
} from '../push-token-store';
import { getPool } from '../db';

jest.mock('../db');
jest.mock('../logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockQuery = jest.fn();
(getPool as jest.Mock).mockReturnValue({ query: mockQuery });

beforeEach(() => {
  mockQuery.mockReset();
});

describe('push-token-store', () => {
  const sampleToken: PushTokenData = {
    userSub: 'user-123',
    pushToken: 'abc-token-xyz',
    activityType: 'dishwasher',
    deviceName: 'iPhone 15',
    bundleId: 'org.davidjensenius.FluxHaus',
  };

  describe('savePushToken', () => {
    it('upserts token into push_tokens table', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await savePushToken(sampleToken);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO push_tokens');
      expect(sql).toContain('ON CONFLICT');
      expect(params).toEqual([
        'user-123', 'iPhone 15', 'abc-token-xyz', 'dishwasher', 'org.davidjensenius.FluxHaus',
      ]);
    });

    it('skips when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      await savePushToken(sampleToken);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws on query error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));
      await expect(savePushToken(sampleToken)).rejects.toThrow('DB error');
    });
  });

  describe('getPushTokensByActivityType', () => {
    it('returns tokens filtered by activity type', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ userSub: 'user-123', pushToken: 'tok1', activityType: 'dishwasher' }],
      });
      const result = await getPushTokensByActivityType('dishwasher');
      expect(result).toHaveLength(1);
      expect(result[0].pushToken).toBe('tok1');
      expect(mockQuery.mock.calls[0][1]).toEqual(['dishwasher']);
    });

    it('returns empty array when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      const result = await getPushTokensByActivityType('dishwasher');
      expect(result).toEqual([]);
    });
  });

  describe('getAllActivePushTokens', () => {
    it('returns all tokens', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { userSub: 'user-123', pushToken: 'tok1', activityType: 'dishwasher' },
          { userSub: 'user-123', pushToken: 'tok2', activityType: 'washer' },
        ],
      });
      const result = await getAllActivePushTokens();
      expect(result).toHaveLength(2);
    });
  });

  describe('deletePushToken', () => {
    it('deletes by push token', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await deletePushToken('abc-token-xyz');
      expect(mockQuery.mock.calls[0][1]).toEqual(['abc-token-xyz']);
    });

    it('skips when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      await deletePushToken('abc-token-xyz');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });
});
