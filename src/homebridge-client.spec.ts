import { HomebridgeClient } from './homebridge-client';

// Mock global fetch
global.fetch = jest.fn();

describe('HomebridgeClient', () => {
  const mockConfig = {
    url: 'http://localhost:8581',
    username: 'admin',
    password: 'password',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should authenticate and get token on first request', async () => {
    const client = new HomebridgeClient(mockConfig);

    // Mock login response
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fake-token' }),
      })
      // Mock accessories response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([]),
      });

    await client.getAccessories();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenNthCalledWith(1, 'http://localhost:8581/api/auth/login', expect.any(Object));
    expect(global.fetch).toHaveBeenNthCalledWith(2, 'http://localhost:8581/api/accessories', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer fake-token',
      }),
    }));
  });

  it('should use provided token if available', async () => {
    const client = new HomebridgeClient({
      ...mockConfig,
      token: 'provided-token',
    });

    // Mock accessories response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ([]),
    });

    await client.getAccessories();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('http://localhost:8581/api/accessories', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer provided-token',
      }),
    }));
  });
});
