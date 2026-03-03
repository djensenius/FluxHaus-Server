import { BookloreClient } from '../../clients/booklore';

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
  url: 'http://booklore:8080',
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

describe('BookloreClient', () => {
  let client: BookloreClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new BookloreClient(mockConfig);
  });

  it('configured returns true with all fields', () => {
    expect(client.configured).toBe(true);
  });

  it('configured returns false with missing field', () => {
    const incomplete = new BookloreClient({ url: 'http://booklore:8080', apiKey: '' });
    expect(incomplete.configured).toBe(false);
  });

  it('listShelves calls correct URL with bearer auth', async () => {
    const data = [{ id: '1', name: 'Fiction' }];
    mockFetchOk(data);

    const result = await client.listShelves();

    expect(result).toEqual(data);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://booklore:8080/api/shelves',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      }),
    );
  });

  it('throws on error response', async () => {
    mockFetchError(401, 'Unauthorized');

    await expect(client.listShelves()).rejects.toThrow(
      'Booklore request failed: 401 Unauthorized',
    );
  });

  it('listBooks without shelfId calls /api/books', async () => {
    mockFetchOk([]);

    await client.listBooks();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://booklore:8080/api/books',
      expect.any(Object),
    );
  });

  it('listBooks with shelfId calls /api/shelves/{id}/books', async () => {
    mockFetchOk([]);

    await client.listBooks('shelf-1');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://booklore:8080/api/shelves/shelf-1/books',
      expect.any(Object),
    );
  });

  it('search encodes query parameter', async () => {
    mockFetchOk([]);

    await client.search('dune');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://booklore:8080/api/books?search=dune',
      expect.any(Object),
    );
  });
});
