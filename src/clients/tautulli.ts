import logger from '../logger';

const tautulliLogger = logger.child({ subsystem: 'tautulli' });

export interface TautulliConfig {
  url: string;
  apiKey: string;
}

export class TautulliClient {
  private config: TautulliConfig;

  constructor(config: TautulliConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.apiKey);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async command(
    cmd: string,
    params: Record<string, string> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const searchParams = new URLSearchParams({
      apikey: this.config.apiKey,
      cmd,
      ...params,
    });
    const url = `${this.config.url}/api/v2?${searchParams}`;
    tautulliLogger.debug({ cmd, params }, 'Tautulli request');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        'Tautulli request failed: '
        + `${response.status} ${response.statusText}`,
      );
    }
    const data = await response.json();
    return data.response?.data;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getActivity(): Promise<any> {
    return this.command('get_activity');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHistory(length?: number): Promise<any> {
    return this.command('get_history', {
      length: String(length || 25),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getLibraries(): Promise<any> {
    return this.command('get_libraries');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRecentlyAdded(count?: number): Promise<any> {
    return this.command('get_recently_added', {
      count: String(count || 25),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHomeStats(): Promise<any> {
    return this.command('get_home_stats');
  }
}
