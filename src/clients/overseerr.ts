import logger from '../logger';

const overseerrLogger = logger.child({ subsystem: 'overseerr' });

export interface OverseerrConfig {
  url: string;
  apiKey: string;
}

export class OverseerrClient {
  private config: OverseerrConfig;

  constructor(config: OverseerrConfig) {
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
    overseerrLogger.debug(
      { url, method: options.method || 'GET' },
      'Making Overseerr request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-Api-Key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `Overseerr request failed: ${response.status} ${response.statusText}`;
      overseerrLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(
      `/api/v1/search?query=${encoded}&page=1&language=en`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRequests(status?: string): Promise<any> {
    const filter = status ? `?filter=${encodeURIComponent(status)}` : '';
    return this.request(`/api/v1/request${filter}`);
  }

  async requestMedia(
    mediaType: string,
    mediaId: number,
    is4k = false,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request('/api/v1/request', {
      method: 'POST',
      body: JSON.stringify({ mediaType, mediaId, is4k }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async approveRequest(requestId: number): Promise<any> {
    return this.request(`/api/v1/request/${requestId}/approve`, {
      method: 'POST',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getStatus(): Promise<any> {
    return this.request('/api/v1/status');
  }
}
