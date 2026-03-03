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
      throw new Error(
        `Home Assistant request failed: ${response.status} ${response.statusText} for URL: ${this.config.url}${path}`,
      );
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getState(entityId: string): Promise<any> {
    const path = entityId ? `/api/states/${entityId}` : '/api/states';
    return this.request(path);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async callService(domain: string, service: string, serviceData: any = {}): Promise<any> {
    return this.request(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(serviceData),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getHistory(entityId: string, start: string, end?: string): Promise<any> {
    const params = new URLSearchParams({ filter_entity_id: entityId });
    if (end) params.set('end_time', end);
    return this.request(`/api/history/period/${start}?${params}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getLogbook(start: string, end?: string, entityId?: string): Promise<any> {
    const params = new URLSearchParams();
    if (end) params.set('end_time', end);
    if (entityId) params.set('entity', entityId);
    const qs = params.toString();
    return this.request(`/api/logbook/${start}${qs ? `?${qs}` : ''}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getCalendars(): Promise<any> {
    return this.request('/api/calendars');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getCalendarEvents(calendarId: string, start: string, end: string): Promise<any> {
    const params = new URLSearchParams({ start, end });
    return this.request(`/api/calendars/${calendarId}?${params}`);
  }

  public async renderTemplate(template: string): Promise<string> {
    const response = await fetch(`${this.config.url}/api/template`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ template }),
    });
    if (!response.ok) {
      throw new Error(
        'Home Assistant request failed: '
        + `${response.status} ${response.statusText} for URL: ${this.config.url}/api/template`,
      );
    }
    return response.text();
  }
}
