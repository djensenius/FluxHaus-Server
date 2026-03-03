import { PrometheusClient } from '../../clients/prometheus';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('PrometheusClient', () => {
  const mockConfig = {
    url: 'http://prometheus:9090',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('should return true when url is set', () => {
      const client = new PrometheusClient({ url: 'http://x' });
      expect(client.configured).toBe(true);
    });

    it('should return false when url is empty', () => {
      const client = new PrometheusClient({ url: '' });
      expect(client.configured).toBe(false);
    });
  });

  it('should make requests without Authorization header', async () => {
    const client = new PrometheusClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { result: [] } }),
    });

    await client.query('up');

    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).toHaveProperty('Content-Type', 'application/json');
  });

  it('should call query with correct URL and return data', async () => {
    const client = new PrometheusClient(mockConfig);
    const mockData = { status: 'success', data: { result: [{ value: 1 }] } };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    const result = await client.query('up');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://prometheus:9090/api/v1/query?query=up',
      expect.any(Object),
    );
    expect(result).toEqual(mockData);
  });

  it('should throw on error response', async () => {
    const client = new PrometheusClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(client.query('up')).rejects.toThrow(
      'Prometheus request failed: 500 Internal Server Error',
    );
  });

  it('should call queryRange with correct params', async () => {
    const client = new PrometheusClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { result: [] } }),
    });

    await client.queryRange('up', '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '60s');

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/v1/query_range');
    expect(calledUrl).toContain('query=up');
    expect(calledUrl).toContain('start=2024-01-01');
    expect(calledUrl).toContain('end=2024-01-02');
    expect(calledUrl).toContain('step=60s');
  });
});
