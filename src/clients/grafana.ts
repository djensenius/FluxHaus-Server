import logger from '../logger';

const grafanaLogger = logger.child({ subsystem: 'grafana' });

export interface GrafanaConfig {
  url: string;
  user: string;
  password: string;
}

export class GrafanaClient {
  private config: GrafanaConfig;

  constructor(config: GrafanaConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.user && this.config.password);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    grafanaLogger.debug(
      { url, method: options.method || 'GET' },
      'Making Grafana request',
    );

    const credentials = Buffer.from(
      `${this.config.user}:${this.config.password}`,
    ).toString('base64');

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'Grafana request failed: '
        + `${response.status} ${response.statusText}`;
      grafanaLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listDashboards(): Promise<any> {
    return this.request('/api/search?type=dash-db');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDashboard(uid: string): Promise<any> {
    return this.request(
      `/api/dashboards/uid/${encodeURIComponent(uid)}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listDatasources(): Promise<any> {
    return this.request('/api/datasources');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async queryDatasource(
    datasourceId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request('/api/ds/query', {
      method: 'POST',
      body: JSON.stringify({
        queries: [{ ...query, datasourceId }],
      }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAnnotations(
    from?: string,
    to?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const params = new URLSearchParams();
    if (from) params.set('from', String(new Date(from).getTime()));
    if (to) params.set('to', String(new Date(to).getTime()));
    const qs = params.toString();
    return this.request(`/api/annotations${qs ? `?${qs}` : ''}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAlerts(): Promise<any> {
    return this.request('/api/alerts');
  }
}
