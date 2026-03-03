import { UniFiClient } from '../../clients/unifi';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('UniFiClient', () => {
  const config = {
    url: 'https://unifi:8443',
    user: 'admin',
    password: 'pass',
    site: 'default',
    isUdm: false,
  };
  let client: UniFiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new UniFiClient(config);
  });

  describe('configured', () => {
    it('returns true when all fields are set', () => {
      expect(client.configured).toBe(true);
    });

    it('returns false when site is missing', () => {
      const c = new UniFiClient({ ...config, site: '' });
      expect(c.configured).toBe(false);
    });

    it('returns false when user is missing', () => {
      const c = new UniFiClient({ ...config, user: '' });
      expect(c.configured).toBe(false);
    });
  });

  describe('login + request flow', () => {
    it('logs in then makes the actual request with cookie', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => (h === 'set-cookie' ? 'unifises=abc123; path=/' : null) },
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ health: 'ok' }] }),
        });

      const result = await client.getHealth();

      // First call: login
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'https://unifi:8443/api/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'admin', password: 'pass' }),
        }),
      );

      // Second call: actual request with cookie
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'https://unifi:8443/api/s/default/stat/health',
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: 'unifises=abc123',
          }),
        }),
      );

      expect(result).toEqual({ data: [{ health: 'ok' }] });
    });
  });

  describe('UDM path prefix', () => {
    it('uses /api/auth/login and /proxy/network prefix for UDM', async () => {
      const udmClient = new UniFiClient({ ...config, isUdm: true });

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => (h === 'set-cookie' ? 'TOKEN=xyz; path=/' : null) },
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ health: 'ok' }] }),
        });

      await udmClient.getHealth();

      // UDM login path
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        'https://unifi:8443/api/auth/login',
        expect.objectContaining({
          method: 'POST',
        }),
      );

      // UDM request path with /proxy/network prefix
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        'https://unifi:8443/proxy/network/api/s/default/stat/health',
        expect.any(Object),
      );
    });
  });

  describe('401 retry', () => {
    it('re-authenticates and retries on 401', async () => {
      (global.fetch as jest.Mock)
        // First: initial login succeeds
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => (h === 'set-cookie' ? 'unifises=first; path=/' : null) },
          json: async () => ({}),
        })
        // Second: request returns 401
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        })
        // Third: re-login succeeds
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: (h: string) => (h === 'set-cookie' ? 'unifises=second; path=/' : null) },
          json: async () => ({}),
        })
        // Fourth: retry succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: [{ name: 'device1' }] }),
        });

      const result = await client.listDevices();

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(result).toEqual({ data: [{ name: 'device1' }] });
    });
  });

  describe('login failure', () => {
    it('throws on failed login', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(client.getHealth()).rejects.toThrow(
        'UniFi login failed: 403 Forbidden',
      );
    });
  });
});
