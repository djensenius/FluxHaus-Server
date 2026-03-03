import { PiHoleClient } from '../../clients/pihole';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('PiHoleClient', () => {
  const mockConfig = {
    url: 'http://pihole:80',
    password: 'test-password',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configured returns true when url and password are set', () => {
    const client = new PiHoleClient(mockConfig);
    expect(client.configured).toBe(true);
  });

  it('configured returns false when password is empty', () => {
    const client = new PiHoleClient({ url: 'http://pihole', password: '' });
    expect(client.configured).toBe(false);
  });

  it('configured returns false when url is empty', () => {
    const client = new PiHoleClient({ url: '', password: 'pass' });
    expect(client.configured).toBe(false);
  });

  it('logs in before first request and uses session id', async () => {
    const client = new PiHoleClient(mockConfig);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { sid: 'test-sid-123' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ queries: 12345, blocked: 1234 }),
      });

    const result = await client.getSummary();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Login call
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'http://pihole:80/api/auth',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ password: 'test-password' }),
      }),
    );
    // Data call with sid header
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://pihole:80/api/stats/summary',
      expect.objectContaining({
        headers: expect.objectContaining({ sid: 'test-sid-123' }),
      }),
    );
    expect(result).toEqual({ queries: 12345, blocked: 1234 });
  });

  it('retries on 401 with re-authentication', async () => {
    const client = new PiHoleClient(mockConfig);

    (global.fetch as jest.Mock)
      // Initial login
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { sid: 'old-sid' } }),
      })
      // First request returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      })
      // Re-login
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { sid: 'new-sid' } }),
      })
      // Retry succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ blocking: true }),
      });

    const result = await client.getBlockingStatus();
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ blocking: true });
  });

  it('throws on login failure', async () => {
    const client = new PiHoleClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(client.getSummary()).rejects.toThrow(
      'Pi-hole login failed: 403 Forbidden',
    );
  });

  it('throws on request failure', async () => {
    const client = new PiHoleClient(mockConfig);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { sid: 'sid' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

    await expect(client.getTopDomains()).rejects.toThrow(
      'Pi-hole request failed: 500 Internal Server Error',
    );
  });

  it('getTopDomains passes count query param', async () => {
    const client = new PiHoleClient(mockConfig);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { sid: 'sid' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ top_domains: [] }),
      });

    await client.getTopDomains(5);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'http://pihole:80/api/stats/top_domains?count=5',
      expect.any(Object),
    );
  });
});
