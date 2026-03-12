import { KagiClient } from '../../clients/kagi';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('KagiClient', () => {
  const mockConfig = { apiKey: 'test-kagi-key' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configured returns true when apiKey is set', () => {
    const client = new KagiClient(mockConfig);
    expect(client.configured).toBe(true);
  });

  it('configured returns false when apiKey is empty', () => {
    const client = new KagiClient({ apiKey: '' });
    expect(client.configured).toBe(false);
  });

  it('search sends correct request and parses results', async () => {
    const client = new KagiClient(mockConfig);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            t: 0, url: 'https://example.com', title: 'Example', snippet: 'A snippet',
          },
          { t: 1, list: ['related query'] },
          {
            t: 0, url: 'https://other.com', title: 'Other', published: '2025-01-01',
          },
        ],
      }),
    });

    const results = await client.search('test query', 5);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://kagi.com/api/v0/search'),
      expect.objectContaining({
        headers: {
          Authorization: 'Bot test-kagi-key',
          Accept: 'application/json',
        },
      }),
    );

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('q=test+query');
    expect(calledUrl).toContain('limit=5');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      rank: 1,
      url: 'https://example.com',
      title: 'Example',
      snippet: 'A snippet',
      published: undefined,
    });
    expect(results[1]).toEqual({
      rank: 2,
      url: 'https://other.com',
      title: 'Other',
      snippet: undefined,
      published: '2025-01-01',
    });
  });

  it('search without limit omits limit param', async () => {
    const client = new KagiClient(mockConfig);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    await client.search('hello');

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).not.toContain('limit=');
  });

  it('throws on API error', async () => {
    const client = new KagiClient(mockConfig);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(client.search('test')).rejects.toThrow('Kagi API error: 401 Unauthorized');
  });

  it('summarize sends correct request and returns summary', async () => {
    const client = new KagiClient(mockConfig);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          output: 'This is the summary of the article.',
          tokens: 250,
        },
      }),
    });

    const result = await client.summarize('https://example.com/article');

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('https://kagi.com/api/v0/summarize');
    expect(calledUrl).toContain('url=');
    expect(calledUrl).toContain('engine=cecil');

    expect(result).toEqual({
      summary: 'This is the summary of the article.',
      tokens: 250,
    });
  });

  it('summarize uses specified engine', async () => {
    const client = new KagiClient(mockConfig);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { output: 'Summary', tokens: 100 } }),
    });

    await client.summarize('https://example.com', 'muriel');

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('engine=muriel');
  });
});
