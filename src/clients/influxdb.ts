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
      { path, method: options.method || 'GET' },
      'Making InfluxDB request',
    );

    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      headers: {
        ...options.headers,
        Authorization: `Token ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'InfluxDB request failed: '
        + `${response.status} ${response.statusText}`;
      influxdbLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(flux: string): Promise<any> {
    const url = `${this.config.url}/api/v2/query?org=${encodeURIComponent(this.config.org)}`;
    influxdbLogger.debug({ method: 'POST' }, 'Querying InfluxDB');

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Token ${this.config.token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
    });

    if (!response.ok) {
      const body = await response.text();
      const msg = `InfluxDB query failed: ${response.status} ${response.statusText} — ${body.substring(0, 200)}`;
      influxdbLogger.error({ status: response.status }, msg);
      throw new Error(msg);
    }

    const csv = await response.text();
    return this.parseCSV(csv);
  }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-explicit-any
  private parseCSV(csv: string): any[] {
    const results: Record<string, string>[] = [];
    const tables = csv.split(/\r?\n\r?\n/);
    tables.forEach((table) => {
      const lines = table.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
      if (lines.length < 2) return;
      const headers = lines[0].split(',');
      lines.slice(1).forEach((line) => {
        const values = line.split(',');
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => {
          if (h && h !== '' && h !== 'result' && h !== 'table') {
            row[h] = values[idx] ?? '';
          }
        });
        if (Object.keys(row).length > 0) results.push(row);
      });
    });
    return results;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listBuckets(): Promise<any> {
    return this.request('/api/v2/buckets');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listMeasurements(bucket?: string): Promise<any> {
    const targetBucket = bucket || this.config.bucket;
    const flux = 'import "influxdata/influxdb/schema" '
      + `schema.measurements(bucket: "${targetBucket}")`;
    return this.query(flux);
  }
}
