import { InfluxDBClient } from '../../clients/influxdb';

jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(),
    }),
  },
}));

global.fetch = jest.fn();

describe('InfluxDBClient', () => {
  const mockConfig = {
    url: 'http://influx:8086',
    token: 'test-token',
    org: 'test-org',
    bucket: 'test-bucket',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configured', () => {
    it('should return true when all fields are set', () => {
      const client = new InfluxDBClient(mockConfig);
      expect(client.configured).toBe(true);
    });

    it('should return false when token is missing', () => {
      const client = new InfluxDBClient({ ...mockConfig, token: '' });
      expect(client.configured).toBe(false);
    });

    it('should return false when org is missing', () => {
      const client = new InfluxDBClient({ ...mockConfig, org: '' });
      expect(client.configured).toBe(false);
    });

    it('should return false when bucket is missing', () => {
      const client = new InfluxDBClient({ ...mockConfig, bucket: '' });
      expect(client.configured).toBe(false);
    });
  });

  it('should make query requests with correct URL, headers, and body', async () => {
    const client = new InfluxDBClient(mockConfig);
    const mockData = { results: [{ value: 42 }] };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    const result = await client.query('from(bucket: "test")');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://influx:8086/api/v2/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'from(bucket: "test")', type: 'flux' }),
        headers: expect.objectContaining({
          Authorization: 'Token test-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual(mockData);
  });

  it('should throw on error response', async () => {
    const client = new InfluxDBClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(client.query('from(bucket: "test")')).rejects.toThrow(
      'InfluxDB request failed: 401 Unauthorized',
    );
  });

  it('should call listBuckets with correct URL', async () => {
    const client = new InfluxDBClient(mockConfig);
    const mockBuckets = { buckets: [{ name: 'test-bucket' }] };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockBuckets,
    });

    const result = await client.listBuckets();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://influx:8086/api/v2/buckets',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Token test-token',
        }),
      }),
    );
    expect(result).toEqual(mockBuckets);
  });

  it('should listMeasurements using a flux query containing the bucket name', async () => {
    const client = new InfluxDBClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await client.listMeasurements();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body,
    );
    expect(callBody.query).toContain('test-bucket');
    expect(callBody.type).toBe('flux');
  });
});
