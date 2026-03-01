import fs from 'fs';
import { pool } from '../db';
import { getToken, saveToken } from '../token-store';

jest.mock('../db', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('fs');

const mockQuery = pool.query as jest.Mock;

describe('getToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return data from DB when row exists', async () => {
    const tokenData = { access_token: 'abc123', expires_in: 3600 };
    mockQuery.mockResolvedValue({ rows: [{ data: tokenData }] });

    const result = await getToken('miele');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SELECT data FROM oauth_tokens'),
      ['miele'],
    );
    expect(result).toEqual(tokenData);
  });

  it('should fall back to file when DB returns no rows', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const fileData = { access_token: 'file-token', expires_in: 7200 };
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(fileData));

    const result = await getToken('miele');

    expect(result).toEqual(fileData);
  });

  it('should return null when DB returns null and file does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const result = await getToken('miele');

    expect(result).toBeNull();
  });

  it('should fall back to file when DB query throws', async () => {
    mockQuery.mockRejectedValue(new Error('DB connection error'));
    const fileData = { access_token: 'fallback-token' };
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(fileData));

    const result = await getToken('homeconnect');

    expect(result).toEqual(fileData);
  });

  it('should return null when file read fails', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error('read error'); });

    const result = await getToken('miele');

    expect(result).toBeNull();
  });
});

describe('saveToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('should upsert token data into the database', async () => {
    const tokenData = { access_token: 'new-token', expires_in: 3600 };

    await saveToken('miele', tokenData);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oauth_tokens'),
      ['miele', JSON.stringify(tokenData)],
    );
  });

  it('should use ON CONFLICT for upsert', async () => {
    const tokenData = { access_token: 'updated-token' };

    await saveToken('homeconnect', tokenData);

    const queryStr = mockQuery.mock.calls[0][0] as string;
    expect(queryStr).toContain('ON CONFLICT');
  });
});
