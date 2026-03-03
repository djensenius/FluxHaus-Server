import logger from '../logger';

const influxdbLogger = logger.child({ subsystem: 'influxdb' });

export interface InfluxDBClientConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
}

export class InfluxDBClient {
  private config: InfluxDBClientConfig;

  constructor(config: InfluxDBClientConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.token
      && this.config.org && this.config.bucket);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    influxdbLogger.debug(
      { url, method: options.method || 'GET' },
      'Making InfluxDB request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Token ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'InfluxDB request failed: '
        + `${response.status} ${response.statusText}`;
      influxdbLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(flux: string): Promise<any> {
    return this.request('/api/v2/query', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: flux, type: 'flux' }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listBuckets(): Promise<any> {
    return this.request('/api/v2/buckets');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listMeasurements(): Promise<any> {
    const flux = 'import "influxdata/influxdb/schema" '
      + `schema.measurements(bucket: "${this.config.bucket}")`;
    return this.query(flux);
  }
}
