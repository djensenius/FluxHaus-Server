import logger from '../logger';

const forgejoLogger = logger.child({ subsystem: 'forgejo' });

export interface ForgejoConfig {
  url: string;
  token: string;
}

export class ForgejoClient {
  private config: ForgejoConfig;

  constructor(config: ForgejoConfig) {
    this.config = config;
  }

  get configured(): boolean {
    return !!(this.config.url && this.config.token);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    path: string,
    options: RequestInit = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const url = `${this.config.url}${path}`;
    forgejoLogger.debug(
      { url, method: options.method || 'GET' },
      'Making Forgejo request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `token ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = `Forgejo request failed: ${response.status} ${response.statusText}`;
      forgejoLogger.error({ url, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listRepos(owner?: string): Promise<any> {
    if (owner) {
      return this.request(`/api/v1/users/${owner}/repos`);
    }
    return this.request('/api/v1/repos/search');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getRepo(owner: string, repo: string): Promise<any> {
    return this.request(`/api/v1/repos/${owner}/${repo}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listIssues(
    owner: string,
    repo: string,
    state?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const s = state || 'open';
    return this.request(
      `/api/v1/repos/${owner}/${repo}/issues?state=${s}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getIssue(
    owner: string,
    repo: string,
    index: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request(
      `/api/v1/repos/${owner}/${repo}/issues/${index}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listPullRequests(
    owner: string,
    repo: string,
    state?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const s = state || 'open';
    return this.request(
      `/api/v1/repos/${owner}/${repo}/pulls?state=${s}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getPullRequest(
    owner: string,
    repo: string,
    index: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request(
      `/api/v1/repos/${owner}/${repo}/pulls/${index}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listOrgs(): Promise<any> {
    return this.request('/api/v1/user/orgs');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async searchRepos(query: string): Promise<any> {
    const encoded = encodeURIComponent(query);
    return this.request(`/api/v1/repos/search?q=${encoded}`);
  }
}
