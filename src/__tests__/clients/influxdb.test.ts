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
    const csvResponse = '#group,false\n,result,table,_time,_value\n,,0,2024-01-01T00:00:00Z,42\n';

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      text: async () => csvResponse,
    });

    const result = await client.query('from(bucket: "test")');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://influx:8086/api/v2/query?org=test-org',
      expect.objectContaining({
        method: 'POST',
        body: 'from(bucket: "test")',
        headers: expect.objectContaining({
          Authorization: 'Token test-token',
          'Content-Type': 'application/vnd.flux',
          Accept: 'application/csv',
        }),
      }),
    );
    expect(result).toEqual([{ _time: '2024-01-01T00:00:00Z', _value: '42' }]);
  });

  it('should throw on error response', async () => {
    const client = new InfluxDBClient(mockConfig);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'unauthorized',
    });

    await expect(client.query('from(bucket: "test")')).rejects.toThrow(
      'InfluxDB query failed: 401 Unauthorized',
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
      text: async () => '',
    });

    await client.listMeasurements();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callBody = (global.fetch as jest.Mock).mock.calls[0][1].body;
    expect(callBody).toContain('test-bucket');
  });
});
