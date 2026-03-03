import { PortainerClient } from '../../clients/portainer';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('PortainerClient', () => {
  const mockConfig = {
    url: 'http://portainer:9000',
    apiKey: 'test-key',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('should return true when url and apiKey are set', () => {
      const client = new PortainerClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('should return false when apiKey is missing', () => {
      const client = new PortainerClient({ ...mockConfig, apiKey: '' });
      expect(client.configured).toBe(false);
    });

    it('should return false when url is missing', () => {
      const client = new PortainerClient({ ...mockConfig, url: '' });
      expect(client.configured).toBe(false);
    });
  });

  it('should call listEndpoints with correct URL and headers', async () => {
    const client = new PortainerClient(mockConfig);
    const mockEndpoints = [{ Id: 1, Name: 'local' }];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockEndpoints,
    });

    const result = await client.listEndpoints();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://portainer:9000/api/endpoints',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual(mockEndpoints);
  });

  it('should throw on error response', async () => {
    const client = new PortainerClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(client.listEndpoints()).rejects.toThrow(
      'Portainer request failed: 403 Forbidden',
    );
  });

  it('should call listContainers with correct URL', async () => {
    const client = new PortainerClient(mockConfig);
    const mockContainers = [{ Id: 'abc', Names: ['/test'] }];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockContainers,
    });

    const result = await client.listContainers(1);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://portainer:9000/api/endpoints/1/docker/containers/json?all=true',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-key',
        }),
      }),
    );
    expect(result).toEqual(mockContainers);
  });

  it('should call containerAction with POST method and correct path', async () => {
    const client = new PortainerClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    await client.containerAction(1, 'abc123', 'start');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://portainer:9000/api/endpoints/1/docker/containers/abc123/start',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-API-Key': 'test-key',
        }),
      }),
    );
  });
});
