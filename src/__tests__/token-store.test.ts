import fs from 'fs';
import { pool } from '../db';
import { TokenData, getToken, saveToken } from '../token-store';

jest.mock('fs');
jest.mock('../db', () => ({
  pool: {
    query: jest.fn(),
  },
}));

describe('token-store', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getToken', () => {
    it('should return token from database if found', async () => {
      const mockDate = new Date('2024-01-01T00:00:00Z');
      (pool.query as jest.Mock).mockResolvedValue({
        rows: [{
          access_token: 'db-access-token',
          refresh_token: 'db-refresh-token',
          id_token: 'db-id-token',
          expires_in: 3600,
          updated_at: mockDate,
        }],
      });

      const result = await getToken('miele');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['miele'],
      );
      expect(result).toEqual({
        access_token: 'db-access-token',
        refresh_token: 'db-refresh-token',
        id_token: 'db-id-token',
        expires_in: 3600,
        timestamp: mockDate,
      });
    });

    it('should return null if not found in database and no cache file', async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await getToken('miele');

      expect(result).toBeNull();
    });

    it('should migrate from cache file if not found in database', async () => {
      (pool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // getToken SELECT returns empty
        .mockResolvedValue({ rows: [] }); // saveToken INSERT
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      const mockTimestamp = new Date('2024-01-01T00:00:00Z');
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
        access_token: 'file-access-token',
        refresh_token: 'file-refresh-token',
        expires_in: 3600,
        timestamp: mockTimestamp.toISOString(),
      }));

      const result = await getToken('miele');

      expect(pool.query).toHaveBeenCalledTimes(2); // SELECT + INSERT
      expect(result).toEqual(expect.objectContaining({
        access_token: 'file-access-token',
        refresh_token: 'file-refresh-token',
        expires_in: 3600,
      }));
    });

    it('should return null if cache file contains malformed JSON', async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('not-valid-json{');
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await getToken('miele');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('could not migrate'));
      consoleSpy.mockRestore();
    });

    it('should handle null db fields as undefined', async () => {
      const mockDate = new Date('2024-01-01T00:00:00Z');
      (pool.query as jest.Mock).mockResolvedValue({
        rows: [{
          access_token: 'db-access-token',
          refresh_token: null,
          id_token: null,
          expires_in: null,
          updated_at: mockDate,
        }],
      });

      const result = await getToken('homeconnect');

      expect(result).toEqual({
        access_token: 'db-access-token',
        refresh_token: undefined,
        id_token: undefined,
        expires_in: undefined,
        timestamp: mockDate,
      });
    });
  });

  describe('saveToken', () => {
    it('should upsert token in database', async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const tokenData: TokenData = {
        access_token: 'new-token',
        refresh_token: 'new-refresh',
        id_token: 'new-id-token',
        expires_in: 3600,
        timestamp: new Date('2024-01-01T00:00:00Z'),
      };

      await saveToken('miele', tokenData);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        ['miele', 'new-token', 'new-refresh', 'new-id-token', 3600, tokenData.timestamp],
      );
    });

    it('should use null for optional fields when not provided', async () => {
      (pool.query as jest.Mock).mockResolvedValue({ rows: [] });

      const tokenData: TokenData = {
        access_token: 'new-token',
        timestamp: new Date(),
      };

      await saveToken('homeconnect', tokenData);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
        ['homeconnect', 'new-token', null, null, null, tokenData.timestamp],
      );
    });
  });
});
