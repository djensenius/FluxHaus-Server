import { ImmichClient } from '../../clients/immich';

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

describe('ImmichClient', () => {
  const config = { url: 'http://immich:2283', apiKey: 'test-key' };
  let client: ImmichClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new ImmichClient(config);
  });

  describe('configured', () => {
    it('returns true when url and apiKey are set', () => {
      expect(client.configured).toBe(true);
    });

    it('returns false when apiKey is missing', () => {
      const c = new ImmichClient({ url: 'http://immich:2283', apiKey: '' });
      expect(c.configured).toBe(false);
    });

    it('returns false when url is missing', () => {
      const c = new ImmichClient({ url: '', apiKey: 'test-key' });
      expect(c.configured).toBe(false);
    });
  });

  describe('listAlbums', () => {
    it('calls /api/albums with correct headers', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: '1', albumName: 'Vacation' }],
      });

      const result = await client.listAlbums();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://immich:2283/api/albums',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'test-key',
          }),
        }),
      );
      expect(result).toEqual([{ id: '1', albumName: 'Vacation' }]);
    });

    it('throws on error response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listAlbums()).rejects.toThrow(
        'Immich request failed: 500 Internal Server Error',
      );
    });
  });

  describe('search', () => {
    it('POSTs to /api/search/smart with query body', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ assets: { items: [] } }),
      });

      await client.search('cats');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://immich:2283/api/search/smart',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ query: 'cats' }),
        }),
      );
    });
  });

  describe('getRecentAssets', () => {
    it('POSTs to /api/search/metadata with default take 25', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ assets: { items: [] } }),
      });

      await client.getRecentAssets();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://immich:2283/api/search/metadata',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ order: 'desc', take: 25 }),
        }),
      );
    });

    it('passes custom count as take', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ assets: { items: [] } }),
      });

      await client.getRecentAssets(10);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://immich:2283/api/search/metadata',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ order: 'desc', take: 10 }),
        }),
      );
    });
  });
});
