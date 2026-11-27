import { safeEntityId, safeTimestamp } from './clients/safe-params';

export interface HomeAssistantConfig {
  url: string;
  token: string;
}

export interface HomeAssistantRequestOptions {
  // Aborts the underlying fetch, e.g. when the caller's deadline passes.
  signal?: AbortSignal;
}

// Only adds `signal` when one is given, so callers without options send
// exactly the same request as before.
function signalInit(options: HomeAssistantRequestOptions): RequestInit {
  return options.signal ? { signal: options.signal } : {};
}

// Home Assistant answered with an error status, so the request was handled
// (and, for a service call, refused) rather than lost in transit.
export class HomeAssistantRequestError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HomeAssistantRequestError';
    this.status = status;
  }
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
      throw new HomeAssistantRequestError(
        response.status,
        `Home Assistant request failed: ${response.status} ${response.statusText} for URL: ${this.config.url}${path}`,
      );
    }

    return response.json();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getState(entityId: string, options: HomeAssistantRequestOptions = {}): Promise<any> {
    const path = entityId ? `/api/states/${safeEntityId(entityId)}` : '/api/states';
    return this.request(path, signalInit(options));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getConfig(options: HomeAssistantRequestOptions = {}): Promise<any> {
    return this.request('/api/config', signalInit(options));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async callService(domain: string, service: string, serviceData: any = {}, options: HomeAssistantRequestOptions = {}): Promise<any> {
    return this.request(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(serviceData),
      ...signalInit(options),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getHistory(
    entityId: string,
    start: string,
    end?: string,
    options: HomeAssistantRequestOptions = {},
  ): Promise<any> {
    const params = new URLSearchParams({ filter_entity_id: entityId });
    if (end) params.set('end_time', end);
    return this.request(`/api/history/period/${safeTimestamp(start, 'start')}?${params}`, signalInit(options));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getLogbook(start: string, end?: string, entityId?: string): Promise<any> {
    const params = new URLSearchParams();
    if (end) params.set('end_time', end);
    if (entityId) params.set('entity', entityId);
    const qs = params.toString();
    return this.request(`/api/logbook/${safeTimestamp(start, 'start')}${qs ? `?${qs}` : ''}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getCalendars(): Promise<any> {
    return this.request('/api/calendars');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getCalendarEvents(calendarId: string, start: string, end: string): Promise<any> {
    const params = new URLSearchParams({ start, end });
    return this.request(`/api/calendars/${safeEntityId(calendarId, 'calendar ID')}?${params}`);
  }

  public async renderTemplate(template: string, options: HomeAssistantRequestOptions = {}): Promise<string> {
    const response = await fetch(`${this.config.url}/api/template`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ template }),
      ...signalInit(options),
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
