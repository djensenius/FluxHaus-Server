import logger from '../logger';

const immichLogger = logger.child({ subsystem: 'immich' });

export interface ImmichConfig {
  url: string;
  apiKey: string;
}

export class ImmichClient {
  private config: ImmichConfig;

  constructor(config: ImmichConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.apiKey);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    immichLogger.debug(
      { path, method: options.method || 'GET' },
      'Making Immich request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'x-api-key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `Immich request failed: ${response.status} ${response.statusText}`;
      immichLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listAlbums(): Promise<any> {
    return this.request('/api/albums');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAlbum(albumId: string): Promise<any> {
    return this.request(`/api/albums/${albumId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getStatistics(): Promise<any> {
    return this.request('/api/server/statistics');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    return this.request('/api/search/smart', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listPeople(): Promise<any> {
    return this.request('/api/people');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getPersonAssets(personId: string): Promise<any> {
    return this.request(`/api/people/${personId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRecentAssets(count?: number): Promise<any> {
    return this.request('/api/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ order: 'desc', take: count || 25 }),
    });
  }
}
