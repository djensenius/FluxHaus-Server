import logger from '../logger';

const unifiLogger = logger.child({ subsystem: 'unifi' });

export interface UniFiConfig {
  url: string;
  user: string;
  password: string;
  site: string;
  isUdm?: boolean;
  apiKey?: string;
}

export class UniFiClient {
  private config: UniFiConfig;

  private cookie: string | null = null;

  constructor(config: UniFiConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(
      this.config.url
      && this.config.site
      && (this.config.apiKey || (this.config.user && this.config.password))
    );
  }

  private get useApiKey(): boolean {
    return !!this.config.apiKey;
  }

  private get pathPrefix(): string {
    return this.config.isUdm ? '/proxy/network' : '';
  }

  private async login(): Promise<void> {
    const loginPath = this.config.isUdm
      ? '/api/auth/login'
      : `${this.pathPrefix}/api/login`;

    unifiLogger.debug('Logging in to UniFi controller');

    const response = await fetch(`${this.config.url}${loginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.config.user,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      const msg = `UniFi login failed: ${response.status} ${response.statusText}`;
      unifiLogger.error({ status: response.status }, msg);
      throw new Error(msg);
    }

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      [this.cookie] = setCookie.split(';');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    retry = true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (this.useApiKey) {
      unifiLogger.debug({ path }, 'Making UniFi request (API key)');

      const response = await fetch(
        `${this.config.url}${this.pathPrefix}/api/s/${this.config.site}${path}`,
        {
          headers: {
            'X-API-Key': this.config.apiKey!,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        const msg = `UniFi request failed: ${response.status} ${response.statusText}`;
        unifiLogger.error({ status: response.status }, msg);
        throw new Error(msg);
      }

      return response.json();
    }

    if (!this.cookie) await this.login();

    unifiLogger.debug({ path }, 'Making UniFi request');

    const response = await fetch(
      `${this.config.url}${this.pathPrefix}/api/s/${this.config.site}${path}`,
      {
        headers: {
          Cookie: this.cookie || '',
          'Content-Type': 'application/json',
        },
      },
    );

    if (response.status === 401 && retry) {
      unifiLogger.debug('Got 401, re-authenticating');
      this.cookie = null;
      return this.request(path, false);
    }

    if (!response.ok) {
      const msg = `UniFi request failed: ${response.status} ${response.statusText}`;
      unifiLogger.error({ status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHealth(): Promise<any> {
    return this.request('/stat/health');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listClients(): Promise<any> {
    return this.request('/stat/sta');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listDevices(): Promise<any> {
    return this.request('/stat/device');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDevice(mac: string): Promise<any> {
    return this.request(`/stat/device/${mac}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getClientStats(): Promise<any> {
    return this.request('/stat/sta');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSysinfo(): Promise<any> {
    return this.request('/stat/sysinfo');
  }
}
