import { OverseerrClient } from '../../clients/overseerr';

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

describe('OverseerrClient', () => {
  const mockConfig = { url: 'http://overseerr:5055', apiKey: 'test-key' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('returns true when url and apiKey are provided', () => {
      const client = new OverseerrClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('returns false when url is empty', () => {
      const client = new OverseerrClient({ url: '', apiKey: 'test-key' });
      expect(client.configured).toBe(false);
    });

    it('returns false when apiKey is empty', () => {
      const client = new OverseerrClient({ url: 'http://overseerr:5055', apiKey: '' });
      expect(client.configured).toBe(false);
    });
  });

  describe('search', () => {
    it('calls correct URL with auth header', async () => {
      const client = new OverseerrClient(mockConfig);
      const mockData = { results: [] };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await client.search('test movie');

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://overseerr:5055/api/v1/search?query=test%20movie&page=1&language=en',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Api-Key': 'test-key',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });
  });

  describe('requestMedia', () => {
    it('sends POST with correct JSON body', async () => {
      const client = new OverseerrClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1 }),
      });

      await client.requestMedia('movie', 123, true);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://overseerr:5055/api/v1/request',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mediaType: 'movie', mediaId: 123, is4k: true }),
          headers: expect.objectContaining({
            'X-Api-Key': 'test-key',
          }),
        }),
      );
    });
  });

  describe('getRequests', () => {
    it('appends filter query param when status provided', async () => {
      const client = new OverseerrClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      });

      await client.getRequests('approved');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://overseerr:5055/api/v1/request?filter=approved',
        expect.any(Object),
      );
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      const client = new OverseerrClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.search('test')).rejects.toThrow(
        'Overseerr request failed: 500 Internal Server Error',
      );
    });
  });
});
