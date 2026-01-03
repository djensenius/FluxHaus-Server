import { HomeAssistantClient } from '../homeassistant-client';

// Mock global fetch
global.fetch = jest.fn();

describe('HomeAssistantClient', () => {
  const mockConfig = {
    url: 'http://homeassistant.local:8123',
    token: 'test-token',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should make requests with correct headers', async () => {
    const client = new HomeAssistantClient(mockConfig);

    // Mock response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: 'on' }),
    });

    await client.getState('vacuum.robot');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://homeassistant.local:8123/api/states/vacuum.robot',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('should handle request errors', async () => {
    const client = new HomeAssistantClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(client.getState('vacuum.robot')).rejects.toThrow('Home Assistant request failed: 401 Unauthorized for URL: http://homeassistant.local:8123/api/states/vacuum.robot');
  });
});
