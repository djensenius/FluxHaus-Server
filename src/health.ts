import { Client } from 'pg';

const TIMEOUT_MS = 3000;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

type ServiceStatus = 'up' | 'down' | 'not_configured';

interface ServiceResult {
  status: ServiceStatus;
  latencyMs?: number;
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  timestamp: string;
  services: {
    postgres: ServiceResult;
    influxdb: ServiceResult;
    oidc: ServiceResult;
  };
}

async function checkPostgres(): Promise<ServiceResult> {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    return { status: 'not_configured' };
  }

  const start = Date.now();
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: TIMEOUT_MS,
    statement_timeout: TIMEOUT_MS,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return { status: 'up', latencyMs: Date.now() - start };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  } finally {
    try {
      await client.end();
    } catch {
      // ignore disconnect errors
    }
  }
}

async function checkInfluxDB(): Promise<ServiceResult> {
  const url = process.env.INFLUXDB_URL;
  if (!url) {
    return { status: 'not_configured' };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    return { status: response.ok ? 'up' : 'down', latencyMs };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOIDC(): Promise<ServiceResult> {
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) {
    return { status: 'not_configured' };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(
      `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      { signal: controller.signal },
    );
    return { status: response.ok ? 'up' : 'down', latencyMs: Date.now() - start };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function healthCheck(): Promise<{ body: HealthResponse; httpStatus: number }> {
  const [postgres, influxdb, oidc] = await Promise.all([
    checkPostgres(),
    checkInfluxDB(),
    checkOIDC(),
  ]);

  let overallStatus: HealthResponse['status'] = 'healthy';
  if (postgres.status === 'down') {
    overallStatus = 'unhealthy';
  } else if (influxdb.status === 'down' || oidc.status === 'down') {
    overallStatus = 'degraded';
  }

  const body: HealthResponse = {
    status: overallStatus,
    version,
    timestamp: new Date().toISOString(),
    services: { postgres, influxdb, oidc },
  };

  const httpStatus = overallStatus === 'unhealthy' ? 503 : 200;
  return { body, httpStatus };
}

export { healthCheck };
export default healthCheck;
