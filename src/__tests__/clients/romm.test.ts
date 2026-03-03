import { RommClient } from '../../clients/romm';

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
  url: 'http://romm:3000',
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

describe('RommClient', () => {
  let client: RommClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new RommClient(mockConfig);
  });

  it('configured returns true with all fields', () => {
    expect(client.configured).toBe(true);
  });

  it('configured returns false with missing field', () => {
    const incomplete = new RommClient({ url: 'http://romm:3000', user: '', password: 'p' });
    expect(incomplete.configured).toBe(false);
  });

  it('listPlatforms calls correct URL with auth header', async () => {
    const data = [{ id: 1, name: 'SNES' }];
    mockFetchOk(data);

    const result = await client.listPlatforms();

    expect(result).toEqual(data);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://romm:3000/api/platforms',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${credentials}`,
        }),
      }),
    );
  });

  it('throws on error response', async () => {
    mockFetchError(403, 'Forbidden');

    await expect(client.listPlatforms()).rejects.toThrow(
      'ROMm request failed: 403 Forbidden',
    );
  });

  it('listRoms passes platformId and page params', async () => {
    mockFetchOk([]);

    await client.listRoms(42, 2);

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('platform_id=42');
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('size=25');
  });

  it('search encodes query parameter', async () => {
    mockFetchOk([]);

    await client.search('zelda');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://romm:3000/api/roms?search=zelda',
      expect.any(Object),
    );
  });
});
