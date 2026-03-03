import logger from '../logger';

const piholeLogger = logger.child({ subsystem: 'pihole' });

export interface PiHoleConfig {
  url: string;
  password: string;
}

export class PiHoleClient {
  private config: PiHoleConfig;

  private sid: string | null = null;

  constructor(config: PiHoleConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.password);
  }

  private async login(): Promise<void> {
    const url = `${this.config.url}/api/auth`;
    piholeLogger.debug('Logging in to Pi-hole');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.config.password }),
    });

    if (!response.ok) {
      const msg = `Pi-hole login failed: ${response.status} ${response.statusText}`;
      piholeLogger.error({ status: response.status }, msg);
      throw new Error(msg);
    }

    const data = await response.json();
    if (data.session?.sid) {
      this.sid = data.session.sid;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    retry = true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (!this.sid) await this.login();

    const url = `${this.config.url}/api${path}`;
    piholeLogger.debug({ path }, 'Making Pi-hole request');

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        sid: this.sid || '',
      },
    });

    if (response.status === 401 && retry) {
      piholeLogger.debug('Got 401, re-authenticating');
      this.sid = null;
      return this.request(path, false);
    }

    if (!response.ok) {
      const msg = `Pi-hole request failed: ${response.status} ${response.statusText}`;
      piholeLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSummary(): Promise<any> {
    return this.request('/stats/summary');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTopDomains(count?: number): Promise<any> {
    const qs = count ? `?count=${count}` : '';
    return this.request(`/stats/top_domains${qs}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTopBlocked(count?: number): Promise<any> {
    const qs = count ? `?count=${count}` : '';
    return this.request(`/stats/top_blocked${qs}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTopClients(count?: number): Promise<any> {
    const qs = count ? `?count=${count}` : '';
    return this.request(`/stats/top_clients${qs}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getQueryTypes(): Promise<any> {
    return this.request('/stats/query_types');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHistory(): Promise<any> {
    return this.request('/history');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHistoryClients(): Promise<any> {
    return this.request('/history/clients');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBlockingStatus(): Promise<any> {
    return this.request('/dns/blocking');
  }
}
