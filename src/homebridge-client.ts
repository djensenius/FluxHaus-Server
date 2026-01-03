import fs from 'fs';

export interface HomebridgeConfig {
  url: string;
  username?: string;
  password?: string;
  token?: string;
}

export class HomebridgeClient {
  private token: string | null = null;
  private config: HomebridgeConfig;

  constructor(config: HomebridgeConfig) {
    this.config = config;
    if (config.token) {
      this.token = config.token;
    }
  }

  private async login(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      throw new Error('Cannot login: username and password not provided');
    }

    const response = await fetch(`${this.config.url}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to login to Homebridge: ${response.statusText}`);
    }

    const data = await response.json();
    this.token = data.access_token;
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    if (!this.token) {
      await this.login();
    }

    const headers = {
      ...options.headers,
      Authorization: `Bearer ${this.token}`,
    };

    let response = await fetch(`${this.config.url}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      // Token might be expired
      await this.login();
      const newHeaders = {
        ...options.headers,
        Authorization: `Bearer ${this.token}`,
      };
      response = await fetch(`${this.config.url}${path}`, {
        ...options,
        headers: newHeaders,
      });
    }

    if (!response.ok) {
      throw new Error(`Homebridge request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  public async getAccessories(): Promise<any[]> {
    return this.request('/api/accessories');
  }

  public async getAccessory(uniqueId: string): Promise<any> {
    return this.request(`/api/accessories/${uniqueId}`);
  }

  public async setCharacteristic(uniqueId: string, characteristicType: string, value: any): Promise<void> {
    await this.request(`/api/accessories/${uniqueId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        characteristicType,
        value,
      }),
    });
  }
}
