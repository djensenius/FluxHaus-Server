import { AudiobookshelfClient } from '../../clients/audiobookshelf';

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

const mockConfig = {
  url: 'http://abs:13378',
  apiKey: 'test-key',
};

function mockFetchOk(data: unknown) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  });
}

function mockFetchError(status: number, statusText: string) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: false,
    status,
    statusText,
  });
}

describe('AudiobookshelfClient', () => {
  let client: AudiobookshelfClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new AudiobookshelfClient(mockConfig);
  });

  it('configured returns true with all fields', () => {
    expect(client.configured).toBe(true);
  });

  it('configured returns false with missing field', () => {
    const incomplete = new AudiobookshelfClient({ url: '', apiKey: 'test-key' });
    expect(incomplete.configured).toBe(false);
  });

  it('listLibraries calls correct URL with bearer auth', async () => {
    const data = { libraries: [{ id: 'lib-1' }] };
    mockFetchOk(data);

    const result = await client.listLibraries();

    expect(result).toEqual(data);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://abs:13378/api/libraries',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('throws on error response', async () => {
    mockFetchError(500, 'Internal Server Error');

    await expect(client.listLibraries()).rejects.toThrow(
      'Audiobookshelf request failed: 500 Internal Server Error',
    );
  });

  it('getItem calls /api/items/{id}?expanded=1', async () => {
    mockFetchOk({ id: 'item-1', title: 'Test Book' });

    await client.getItem('item-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://abs:13378/api/items/item-1?expanded=1',
      expect.any(Object),
    );
  });

  it('search passes libraryId in path and query in q param', async () => {
    mockFetchOk({ results: [] });

    await client.search('lib-1', 'harry potter');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://abs:13378/api/libraries/lib-1/search?q=harry%20potter',
      expect.any(Object),
    );
  });
});
