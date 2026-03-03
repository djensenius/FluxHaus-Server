import logger from '../logger';

const rommLogger = logger.child({ subsystem: 'romm' });

export interface RommConfig {
  url: string;
  user: string;
  password: string;
}

export class RommClient {
  private config: RommConfig;

  constructor(config: RommConfig) {
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
    rommLogger.debug(
      { path, method: options.method || 'GET' },
      'Making ROMm request',
    );

    const basic = Buffer.from(
      `${this.config.user}:${this.config.password}`,
    ).toString('base64');

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `ROMm request failed: ${response.status} ${response.statusText}`;
      rommLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listPlatforms(): Promise<any> {
    return this.request('/api/platforms');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listRoms(platformId?: number, page?: number): Promise<any> {
    const params = new URLSearchParams({ size: '25' });
    if (platformId !== undefined) {
      params.set('platform_id', String(platformId));
    }
    if (page !== undefined) params.set('page', String(page));
    return this.request(`/api/roms?${params}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRom(romId: number): Promise<any> {
    return this.request(`/api/roms/${romId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(`/api/roms?search=${encoded}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRecentlyAdded(): Promise<any> {
    return this.request(
      '/api/roms?order_by=created_at&order_dir=desc&size=25',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listCollections(): Promise<any> {
    return this.request('/api/collections');
  }
}
