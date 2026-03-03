import logger from '../logger';

const komgaLogger = logger.child({ subsystem: 'komga' });

export interface KomgaConfig {
  url: string;
  user: string;
  password: string;
  apiKey?: string;
}

export class KomgaClient {
  private config: KomgaConfig;

  constructor(config: KomgaConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url
      && (this.config.apiKey || (this.config.user && this.config.password)));
  }

  private get authHeader(): string {
    if (this.config.apiKey) {
      return `Bearer ${this.config.apiKey}`;
    }
    const credentials = Buffer.from(
      `${this.config.user}:${this.config.password}`,
    ).toString('base64');
    return `Basic ${credentials}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    komgaLogger.debug(
      { url, method: options.method || 'GET' },
      'Making Komga request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `Komga request failed: ${response.status} ${response.statusText}`;
      komgaLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listLibraries(): Promise<any> {
    return this.request('/api/v1/libraries');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listSeries(libraryId?: string, page?: number): Promise<any> {
    const params = new URLSearchParams();
    if (libraryId) params.set('library_id', libraryId);
    if (page !== undefined) params.set('page', String(page));
    params.set('size', '20');
    const qs = params.toString();
    return this.request(`/api/v1/series?${qs}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSeries(seriesId: string): Promise<any> {
    return this.request(`/api/v1/series/${seriesId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listBooks(seriesId: string): Promise<any> {
    return this.request(`/api/v1/series/${seriesId}/books`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getReadProgress(seriesId: string): Promise<any> {
    return this.getSeries(seriesId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(`/api/v1/series?search=${encoded}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRecentlyAdded(): Promise<any> {
    return this.request('/api/v1/series/latest');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getOnDeck(): Promise<any> {
    return this.request(
      '/api/v1/books?sort=readProgress.readDate,desc'
      + '&read_status=IN_PROGRESS',
    );
  }
}
