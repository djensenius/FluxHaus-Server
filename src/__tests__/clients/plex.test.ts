import { PlexClient } from '../../clients/plex';

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

describe('PlexClient', () => {
  const mockConfig = { url: 'http://plex:32400', token: 'test-token' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('returns true when url and token are provided', () => {
      const client = new PlexClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('returns false when url is empty', () => {
      const client = new PlexClient({ url: '', token: 'test-token' });
      expect(client.configured).toBe(false);
    });

    it('returns false when token is empty', () => {
      const client = new PlexClient({ url: 'http://plex:32400', token: '' });
      expect(client.configured).toBe(false);
    });
  });

  describe('getSessions', () => {
    it('calls correct URL with auth token and headers', async () => {
      const client = new PlexClient(mockConfig);
      const mockData = { MediaContainer: { size: 0 } };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await client.getSessions();

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://plex:32400/status/sessions?X-Plex-Token=test-token',
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        }),
      );
    });
  });

  describe('search', () => {
    it('encodes query and appends token with &', async () => {
      const client = new PlexClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: {} }),
      });

      await client.search('test query');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://plex:32400/hubs/search?query=test%20query&limit=20&X-Plex-Token=test-token',
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        }),
      );
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      const client = new PlexClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getSessions()).rejects.toThrow(
        'Plex request failed: 500 Internal Server Error',
      );
    });
  });
});
