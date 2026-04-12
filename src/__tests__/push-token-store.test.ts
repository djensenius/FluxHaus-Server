import {
  deleteDeviceToken,
  deletePushToken,
  getAllActivePushTokens,
  getAllDeviceTokens,
  getApnsTokensByUser,
  getDeviceTokensByUser,
  getDeviceTokensByUserAndBundle,
  getPushTokensByActivityType,
  saveDeviceToken,
  savePushToken,
} from '../push-token-store';
import type { DeviceTokenData, PushTokenData } from '../push-token-store';
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

  describe('saveDeviceToken', () => {
    const sampleDeviceToken: DeviceTokenData = {
      userSub: 'user-123',
      pushToStartToken: 'device-tok-xyz',
      deviceName: 'iPhone 15',
      bundleId: 'org.davidjensenius.FluxHaus',
    };

    it('upserts token into device_tokens table', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await saveDeviceToken(sampleDeviceToken);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO device_tokens');
      expect(sql).toContain('ON CONFLICT');
      expect(params).toEqual([
        'user-123', 'iPhone 15', 'device-tok-xyz', 'org.davidjensenius.FluxHaus',
      ]);
    });

    it('skips when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      await saveDeviceToken(sampleDeviceToken);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('throws on query error', async () => {
      mockQuery.mockRejectedValue(new Error('DB error'));
      await expect(saveDeviceToken(sampleDeviceToken)).rejects.toThrow('DB error');
    });
  });

  describe('getAllDeviceTokens', () => {
    it('returns all device tokens', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { userSub: 'user-123', pushToStartToken: 'dev-tok-1', deviceName: 'iPhone 15' },
        ],
      });
      const result = await getAllDeviceTokens();
      expect(result).toHaveLength(1);
      expect(result[0].pushToStartToken).toBe('dev-tok-1');
    });

    it('returns empty array when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      const result = await getAllDeviceTokens();
      expect(result).toEqual([]);
    });
  });

  describe('deleteDeviceToken', () => {
    it('deletes by push-to-start token', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await deleteDeviceToken('device-tok-xyz');
      expect(mockQuery.mock.calls[0][1]).toEqual(['device-tok-xyz']);
    });

    it('skips when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      await deleteDeviceToken('device-tok-xyz');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('getDeviceTokensByUserAndBundle', () => {
    it('returns device tokens filtered by user and bundle', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            userSub: 'user-123',
            deviceName: 'iPhone 15',
            pushToStartToken: 'tok-1',
            bundleId: 'org.davidjensenius.GT3Companion',
          },
        ],
      });
      const result = await getDeviceTokensByUserAndBundle(
        'user-123',
        'org.davidjensenius.GT3Companion',
      );
      expect(result).toHaveLength(1);
      expect(result[0].pushToStartToken).toBe('tok-1');
      expect(mockQuery.mock.calls[0][1]).toEqual([
        'user-123',
        'org.davidjensenius.GT3Companion',
      ]);
    });

    it('returns empty array when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      const result = await getDeviceTokensByUserAndBundle('user-123', 'bundle');
      expect(result).toEqual([]);
    });
  });

  describe('getApnsTokensByUser', () => {
    it('returns APNs tokens for a user', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            userSub: 'user-123',
            deviceName: 'iPhone 15',
            token: 'apns-tok-1',
            bundleId: 'org.davidjensenius.FluxHaus',
          },
        ],
      });
      const result = await getApnsTokensByUser('user-123');
      expect(result).toHaveLength(1);
      expect(result[0].token).toBe('apns-tok-1');
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-123']);
    });

    it('returns empty array when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      const result = await getApnsTokensByUser('user-123');
      expect(result).toEqual([]);
    });
  });

  describe('getDeviceTokensByUser', () => {
    it('returns all device tokens for a user', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            userSub: 'user-123',
            deviceName: 'iPhone 15',
            pushToStartToken: 'dev-tok-1',
            bundleId: 'org.davidjensenius.FluxHaus',
          },
        ],
      });
      const result = await getDeviceTokensByUser('user-123');
      expect(result).toHaveLength(1);
      expect(result[0].pushToStartToken).toBe('dev-tok-1');
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-123']);
    });

    it('returns empty array when pool is null', async () => {
      (getPool as jest.Mock).mockReturnValueOnce(null);
      const result = await getDeviceTokensByUser('user-123');
      expect(result).toEqual([]);
    });
  });
});
