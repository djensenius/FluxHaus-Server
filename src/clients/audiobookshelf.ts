import logger from '../logger';

const absLogger = logger.child({ subsystem: 'audiobookshelf' });

export interface AudiobookshelfConfig {
  url: string;
  apiKey: string;
}

export class AudiobookshelfClient {
  private config: AudiobookshelfConfig;

  constructor(config: AudiobookshelfConfig) {
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
    absLogger.debug(
      { path, method: options.method || 'GET' },
      'Making Audiobookshelf request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'Audiobookshelf request failed: '
        + `${response.status} ${response.statusText}`;
      absLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listLibraries(): Promise<any> {
    return this.request('/api/libraries');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listItems(libraryId: string): Promise<any> {
    return this.request(`/api/libraries/${libraryId}/items`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getItem(itemId: string): Promise<any> {
    return this.request(`/api/items/${itemId}?expanded=1`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getInProgress(): Promise<any> {
    return this.request('/api/me/items-in-progress');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getListeningStats(): Promise<any> {
    return this.request('/api/me/listening-stats');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(libraryId: string, query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(
      `/api/libraries/${libraryId}/search?q=${encoded}`,
    );
  }
}
