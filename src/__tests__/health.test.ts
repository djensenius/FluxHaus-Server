import { healthCheck } from '../health';

// Mock pg Client
jest.mock('pg', () => ({
  Client: jest.fn(),
}));

describe('healthCheck', () => {
  const originalEnv = process.env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MockClient: jest.MockedClass<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.POSTGRES_URL;
    delete process.env.INFLUXDB_URL;
    delete process.env.OIDC_ISSUER;

    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    MockClient = require('pg').Client;
    MockClient.mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({}),
    }) as jest.Mock;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns not_configured for postgres when POSTGRES_URL is unset', async () => {
    const result = await healthCheck();
    expect(result.body.services.postgres.status).toBe('not_configured');
    expect(result.body.services.postgres.latencyMs).toBeUndefined();
  });

  it('returns not_configured for influxdb when INFLUXDB_URL is unset', async () => {
    const result = await healthCheck();
    expect(result.body.services.influxdb.status).toBe('not_configured');
  });

  it('returns not_configured for oidc when OIDC_ISSUER is unset', async () => {
    const result = await healthCheck();
    expect(result.body.services.oidc.status).toBe('not_configured');
  });

  it('returns healthy and 200 when all services are not_configured', async () => {
    const result = await healthCheck();
    expect(result.body.status).toBe('healthy');
    expect(result.httpStatus).toBe(200);
  });

  it('returns up for postgres when POSTGRES_URL is set and connection succeeds', async () => {
    process.env.POSTGRES_URL = 'postgresql://localhost:5432/test';
    const result = await healthCheck();
    expect(result.body.services.postgres.status).toBe('up');
    expect(result.body.services.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns down for postgres when connection fails', async () => {
    process.env.POSTGRES_URL = 'postgresql://localhost:5432/test';
    MockClient.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
      query: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await healthCheck();
    expect(result.body.services.postgres.status).toBe('down');
    expect(result.body.status).toBe('unhealthy');
    expect(result.httpStatus).toBe(503);
  });

  it('returns up for influxdb when fetch succeeds', async () => {
    process.env.INFLUXDB_URL = 'http://influx.example.com:8086';
    const result = await healthCheck();
    expect(result.body.services.influxdb.status).toBe('up');
    expect(result.body.services.influxdb.latencyMs).toBeGreaterThanOrEqual(0);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://influx.example.com:8086/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns down for influxdb when fetch fails', async () => {
    process.env.INFLUXDB_URL = 'http://influx.example.com:8086';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Connection refused'));

    const result = await healthCheck();
    expect(result.body.services.influxdb.status).toBe('down');
    expect(result.body.status).toBe('degraded');
    expect(result.httpStatus).toBe(200);
  });

  it('returns down for influxdb when fetch returns non-ok', async () => {
    process.env.INFLUXDB_URL = 'http://influx.example.com:8086';
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false });

    const result = await healthCheck();
    expect(result.body.services.influxdb.status).toBe('down');
    expect(result.body.status).toBe('degraded');
  });

  it('returns up for oidc when fetch succeeds', async () => {
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    const result = await healthCheck();
    expect(result.body.services.oidc.status).toBe('up');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('strips trailing slash from OIDC_ISSUER when building discovery URL', async () => {
    process.env.OIDC_ISSUER = 'https://auth.example.com/';
    const result = await healthCheck();
    expect(result.body.services.oidc.status).toBe('up');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration',
      expect.anything(),
    );
  });

  it('returns down for oidc when fetch fails', async () => {
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await healthCheck();
    expect(result.body.services.oidc.status).toBe('down');
    expect(result.body.status).toBe('degraded');
    expect(result.httpStatus).toBe(200);
  });

  it('includes version string in response', async () => {
    const result = await healthCheck();
    expect(result.body.version).toBeDefined();
    expect(typeof result.body.version).toBe('string');
  });

  it('includes ISO timestamp in response', async () => {
    const result = await healthCheck();
    expect(result.body.timestamp).toBeDefined();
    expect(new Date(result.body.timestamp).toISOString()).toBe(result.body.timestamp);
  });

  it('returns degraded when both influxdb and oidc are down', async () => {
    process.env.INFLUXDB_URL = 'http://influx.example.com:8086';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await healthCheck();
    expect(result.body.status).toBe('degraded');
    expect(result.httpStatus).toBe(200);
  });

  it('returns unhealthy when postgres is down even if others are up', async () => {
    process.env.POSTGRES_URL = 'postgresql://localhost:5432/test';
    process.env.INFLUXDB_URL = 'http://influx.example.com:8086';
    MockClient.mockImplementation(() => ({
      connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
      query: jest.fn(),
      end: jest.fn().mockResolvedValue(undefined),
    }));

    const result = await healthCheck();
    expect(result.body.status).toBe('unhealthy');
    expect(result.httpStatus).toBe(503);
  });
});
