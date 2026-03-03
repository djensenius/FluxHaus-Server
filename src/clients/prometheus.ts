import logger from '../logger';

const prometheusLogger = logger.child({ subsystem: 'prometheus' });

export interface PrometheusConfig {
  url: string;
}

export class PrometheusClient {
  private config: PrometheusConfig;

  constructor(config: PrometheusConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!this.config.url;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    prometheusLogger.debug(
      { url, method: options.method || 'GET' },
      'Making Prometheus request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'Prometheus request failed: '
        + `${response.status} ${response.statusText}`;
      prometheusLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(promql: string): Promise<any> {
    const params = new URLSearchParams({ query: promql });
    return this.request(`/api/v1/query?${params}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async queryRange(
    promql: string,
    start: string,
    end: string,
    step?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const params = new URLSearchParams({
      query: promql,
      start,
      end,
    });
    if (step) params.set('step', step);
    return this.request(`/api/v1/query_range?${params}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTargets(): Promise<any> {
    return this.request('/api/v1/targets');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAlerts(): Promise<any> {
    return this.request('/api/v1/alerts');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRules(): Promise<any> {
    return this.request('/api/v1/rules');
  }
}
