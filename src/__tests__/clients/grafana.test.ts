import { GrafanaClient } from '../../clients/grafana';

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

describe('GrafanaClient', () => {
  const mockConfig = { url: 'http://grafana:3000', apiKey: 'test-key' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('returns true when url and apiKey are provided', () => {
      const client = new GrafanaClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('returns false when url is empty', () => {
      const client = new GrafanaClient({ url: '', apiKey: 'test-key' });
      expect(client.configured).toBe(false);
    });

    it('returns false when apiKey is empty', () => {
      const client = new GrafanaClient({ url: 'http://grafana:3000', apiKey: '' });
      expect(client.configured).toBe(false);
    });
  });

  describe('listDashboards', () => {
    it('calls correct URL with Bearer auth header', async () => {
      const client = new GrafanaClient(mockConfig);
      const mockData = [{ uid: 'abc', title: 'Dashboard 1' }];

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await client.listDashboards();

      expect(result).toEqual(mockData);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://grafana:3000/api/search?type=dash-db',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });
  });

  describe('queryDatasource', () => {
    it('sends POST with correct body structure', async () => {
      const client = new GrafanaClient(mockConfig);
      const query = { refId: 'A', expr: 'up' };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: {} }),
      });

      await client.queryDatasource(1, query);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://grafana:3000/api/ds/query',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            queries: [{ refId: 'A', expr: 'up', datasourceId: 1 }],
          }),
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        }),
      );
    });
  });

  describe('getAnnotations', () => {
    it('converts from/to strings to timestamps in query params', async () => {
      const client = new GrafanaClient(mockConfig);
      const fromDate = '2024-01-01T00:00:00Z';
      const toDate = '2024-01-02T00:00:00Z';

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ([]),
      });

      await client.getAnnotations(fromDate, toDate);

      const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain(`from=${new Date(fromDate).getTime()}`);
      expect(calledUrl).toContain(`to=${new Date(toDate).getTime()}`);
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      const client = new GrafanaClient(mockConfig);

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listDashboards()).rejects.toThrow(
        'Grafana request failed: 500 Internal Server Error',
      );
    });
  });
});
