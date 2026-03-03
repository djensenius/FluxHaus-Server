import logger from '../logger';

const bookloreLogger = logger.child({ subsystem: 'booklore' });

export interface BookloreConfig {
  url: string;
  user: string;
  password: string;
}

export class BookloreClient {
  private config: BookloreConfig;

  constructor(config: BookloreConfig) {
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
    bookloreLogger.debug(
      { path, method: options.method || 'GET' },
      'Making Booklore request',
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
      const msg = `Booklore request failed: ${response.status} ${response.statusText}`;
      bookloreLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listShelves(): Promise<any> {
    return this.request('/api/shelves');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listBooks(shelfId?: string): Promise<any> {
    if (shelfId) {
      return this.request(`/api/shelves/${shelfId}/books`);
    }
    return this.request('/api/books');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBook(bookId: string): Promise<any> {
    return this.request(`/api/books/${bookId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async search(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(`/api/books?search=${encoded}`);
  }
}
