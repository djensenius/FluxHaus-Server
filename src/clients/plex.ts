import logger from '../logger';

const plexLogger = logger.child({ subsystem: 'plex' });

export interface PlexConfig {
  url: string;
  token: string;
}

export class PlexClient {
  private config: PlexConfig;

  constructor(config: PlexConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.token);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(path: string): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.config.url}${path}${sep}X-Plex-Token=${this.config.token}`;
    plexLogger.debug({ url }, 'Plex request');

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const msg = `Plex request failed: ${response.status} ${response.statusText}`;
      plexLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSessions(): Promise<any> {
    return this.request('/status/sessions');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getLibraries(): Promise<any> {
    return this.request('/library/sections');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRecentlyAdded(): Promise<any> {
    return this.request('/library/recentlyAdded');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOnDeck(): Promise<any> {
    return this.request('/library/onDeck');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(`/hubs/search?query=${encoded}&limit=20`);
  }
}
