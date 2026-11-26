import { HomeAssistantClient } from '../homeassistant-client';

// Mock global fetch
global.fetch = vi.fn();

describe('HomeAssistantClient', () => {
  const mockConfig = {
    url: 'http://homeassistant.local:8123',
    token: 'test-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should make requests with correct headers', async () => {
    const client = new HomeAssistantClient(mockConfig);

    // Mock response
    (global.fetch as vi.Mock).mockResolvedValueOnce({
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

    (global.fetch as vi.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(client.getState('vacuum.robot')).rejects.toThrow('Home Assistant request failed: 401 Unauthorized for URL: http://homeassistant.local:8123/api/states/vacuum.robot');
  });

  it('forwards an abort signal to fetch only when one is given', async () => {
    const client = new HomeAssistantClient(mockConfig);
    const { signal } = new AbortController();
    (global.fetch as vi.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'on' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ([]) })
      .mockResolvedValueOnce({ ok: true, text: async () => '[]' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'on' }) });

    await client.getState('climate.home', { signal });
    await client.callService('climate', 'set_hvac_mode', { hvac_mode: 'heat' }, { signal });
    await client.renderTemplate('{{ 1 }}', { signal });
    await client.getState('climate.home');

    const inits = (global.fetch as vi.Mock).mock.calls.map(([, init]) => init);
    expect(inits[0].signal).toBe(signal);
    expect(inits[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ hvac_mode: 'heat' }) });
    expect(inits[1].signal).toBe(signal);
    expect(inits[2]).toMatchObject({ method: 'POST', body: JSON.stringify({ template: '{{ 1 }}' }) });
    expect(inits[2].signal).toBe(signal);
    expect(inits[3]).not.toHaveProperty('signal');
  });

  it('rejects path/query injection in entity IDs, timestamps, and calendar IDs before fetching', async () => {
    const client = new HomeAssistantClient(mockConfig);
    await expect(client.getState('../error_log')).rejects.toThrow('Invalid entity_id');
    await expect(client.getState('camera.x/../../camera_proxy/camera.x')).rejects.toThrow('Invalid entity_id');
    await expect(client.getHistory('sensor.x', '2026-01-01/../../config')).rejects.toThrow('Invalid start');
    await expect(client.getLogbook('../../states')).rejects.toThrow('Invalid start');
    await expect(client.getCalendarEvents('homeassistant:../../error_log', '2026-01-01', '2026-01-02'))
      .rejects.toThrow('Invalid calendar ID');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('encodes valid timestamps in history paths', async () => {
    (global.fetch as vi.Mock).mockResolvedValueOnce({ ok: true, json: async () => [] });
    const client = new HomeAssistantClient(mockConfig);
    await client.getHistory('sensor.x', '2026-01-01T00:00:00Z');
    expect((global.fetch as vi.Mock).mock.calls[0][0])
      .toBe('http://homeassistant.local:8123/api/history/period/2026-01-01T00%3A00%3A00Z?filter_entity_id=sensor.x');
  });
});
