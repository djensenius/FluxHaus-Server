import logger from '../logger';

const kagiLogger = logger.child({ subsystem: 'kagi' });

export interface KagiConfig {
  apiKey: string;
}

export interface KagiSearchResult {
  rank: number;
  url: string;
  title: string;
  snippet?: string;
  published?: string;
}

export class KagiClient {
  private config: KagiConfig;

  constructor(config: KagiConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!this.config.apiKey;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(`https://kagi.com/api/v0${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    kagiLogger.debug({ path, params }, 'Making Kagi request');

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bot ${this.config.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `Kagi API error: ${response.status} ${response.statusText}`;
      kagiLogger.error({ status: response.status, path }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  async search(query: string, limit?: number): Promise<KagiSearchResult[]> {
    const params: Record<string, string> = { q: query };
    if (limit) params.limit = String(limit);

    const data = await this.request('/search', params);

    // Filter to search results (t=0), skip related searches (t=1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.data || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((item: any) => item.t === 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((item: any, i: number) => ({
        rank: i + 1,
        url: item.url,
        title: item.title,
        snippet: item.snippet || undefined,
        published: item.published || undefined,
      }));
  }

  async summarize(
    url: string,
    engine: 'agnes' | 'cecil' | 'muriel' = 'cecil',
  ): Promise<{ summary: string; tokens: number }> {
    const data = await this.request('/summarize', { url, engine });
    return {
      summary: data.data?.output || '',
      tokens: data.data?.tokens || 0,
    };
  }
}
