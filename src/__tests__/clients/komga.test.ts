import { KomgaClient } from '../../clients/komga';

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
  url: 'http://komga:25600',
  user: 'test-user',
  password: 'test-pass',
};

const credentials = Buffer.from(
  `${mockConfig.user}:${mockConfig.password}`,
).toString('base64');

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

describe('KomgaClient', () => {
  let client: KomgaClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new KomgaClient(mockConfig);
  });

  it('configured returns true with all fields', () => {
    expect(client.configured).toBe(true);
  });

  it('configured returns false with missing field', () => {
    const incomplete = new KomgaClient({ url: '', user: 'u', password: 'p' });
    expect(incomplete.configured).toBe(false);
  });

  it('configured returns true with apiKey only (no user/pass)', () => {
    const tokenClient = new KomgaClient({
      url: 'http://komga:25600', user: '', password: '', apiKey: 'my-token',
    });
    expect(tokenClient.configured).toBe(true);
  });

  it('uses Bearer auth when apiKey is set', async () => {
    const tokenClient = new KomgaClient({
      url: 'http://komga:25600', user: '', password: '', apiKey: 'my-token',
    });
    mockFetchOk([{ id: '1' }]);

    await tokenClient.listLibraries();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://komga:25600/api/v1/libraries',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer my-token',
        }),
      }),
    );
  });

  it('listLibraries calls correct URL with auth header', async () => {
    const data = [{ id: '1', name: 'Comics' }];
    mockFetchOk(data);

    const result = await client.listLibraries();

    expect(result).toEqual(data);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://komga:25600/api/v1/libraries',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${credentials}`,
        }),
      }),
    );
  });

  it('throws on error response', async () => {
    mockFetchError(500, 'Internal Server Error');

    await expect(client.listLibraries()).rejects.toThrow(
      'Komga request failed: 500 Internal Server Error',
    );
  });

  it('listSeries passes library_id and size params', async () => {
    mockFetchOk({ content: [] });

    await client.listSeries('lib-1');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('library_id=lib-1'),
      expect.any(Object),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('size=20'),
      expect.any(Object),
    );
  });

  it('search encodes query parameter', async () => {
    mockFetchOk({ content: [] });

    await client.search('batman');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://komga:25600/api/v1/series?search=batman',
      expect.any(Object),
    );
  });
});
