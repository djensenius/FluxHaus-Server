import logger from '../logger';

const portainerLogger = logger.child({ subsystem: 'portainer' });

export interface PortainerConfig {
  url: string;
  apiKey: string;
}

export class PortainerClient {
  private config: PortainerConfig;

  constructor(config: PortainerConfig) {
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
    portainerLogger.debug(
      { path, method: options.method || 'GET' },
      'Making Portainer request',
    );

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-API-Key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const msg = 'Portainer request failed: '
        + `${response.status} ${response.statusText}`;
      portainerLogger.error({ path, status: response.status }, msg);
      throw new Error(msg);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listEndpoints(): Promise<any> {
    return this.request('/api/endpoints');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listContainers(endpointId: number): Promise<any> {
    return this.request(
      `/api/endpoints/${endpointId}/docker/containers/json`
      + '?all=true',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listStacks(): Promise<any> {
    return this.request('/api/stacks');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getContainer(
    endpointId: number,
    containerId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request(
      `/api/endpoints/${endpointId}/docker/containers`
      + `/${containerId}/json`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async containerAction(
    endpointId: number,
    containerId: string,
    action: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    return this.request(
      `/api/endpoints/${endpointId}/docker/containers`
      + `/${containerId}/${action}`,
      { method: 'POST' },
    );
  }
}
