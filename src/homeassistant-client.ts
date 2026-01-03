export interface HomeAssistantConfig {
  url: string;
  token: string;
}

export class HomeAssistantClient {
  private config: HomeAssistantConfig;

  constructor(config: HomeAssistantConfig) {
    this.config = config;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const headers = {
      ...options.headers,
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(`${this.config.url}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new Error(`Home Assistant request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getState(entityId: string): Promise<any> {
    return this.request(`/api/states/${entityId}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async callService(domain: string, service: string, serviceData: any = {}): Promise<any> {
    return this.request(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(serviceData),
    });
  }
}
