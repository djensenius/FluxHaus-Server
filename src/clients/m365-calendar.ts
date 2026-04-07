import logger from '../logger';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdateInput,
  CalendarProvider,
} from '../calendar-types';

const m365Logger = logger.child({ subsystem: 'm365-calendar' });

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

function toGraphEvent(input: CalendarEventInput | CalendarEventUpdateInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (input.title !== undefined) payload.subject = input.title;
  if (input.description !== undefined) {
    payload.body = { contentType: 'text', content: input.description };
  }
  if (input.location !== undefined) payload.location = { displayName: input.location };
  if (input.allDay !== undefined) payload.isAllDay = input.allDay;
  if (input.start !== undefined) {
    payload.start = { dateTime: input.start, timeZone: input.timezone || 'UTC' };
  }
  if (input.end !== undefined) {
    payload.end = { dateTime: input.end, timeZone: input.timezone || 'UTC' };
  }
  return payload;
}

interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface GraphCalendar {
  id: string;
  name: string;
  canEdit?: boolean;
  color?: string;
  isDefaultCalendar?: boolean;
}

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  webLink?: string;
  isAllDay?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
}

export interface M365CalendarConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userId?: string;
  sourceId?: string;
}

export class M365CalendarClient implements CalendarProvider {
  public readonly provider = 'm365' as const;

  public readonly sourceId: string;

  private config: M365CalendarConfig;

  private token: { accessToken: string; expiresAt: number } | null = null;

  constructor(config: M365CalendarConfig) {
    this.config = config;
    this.sourceId = config.sourceId || 'm365';
  }

  get configured(): boolean {
    return !!(
      this.config.tenantId
      && this.config.clientId
      && this.config.clientSecret
      && this.config.refreshToken
    );
  }

  async listCalendars(): Promise<CalendarDescriptor[]> {
    if (!this.configured) return [];
    const calendars = await this.request<{ value: GraphCalendar[] }>(
      '/calendars?$select=id,name,color,canEdit,isDefaultCalendar',
    );
    return (calendars.value || []).map((calendar) => ({
      id: this.qualifyCalendarId(calendar.id),
      provider: this.provider,
      sourceId: this.sourceId,
      name: calendar.name,
      writable: calendar.canEdit !== false,
      externalId: calendar.id,
      color: calendar.color,
      isDefault: calendar.isDefaultCalendar,
    }));
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<CalendarEvent[]> {
    const rawCalendarId = this.extractCalendarId(calendarId);
    const params = new URLSearchParams({
      startDateTime: start,
      endDateTime: end,
      $top: '100',
      $orderby: 'start/dateTime',
    });
    const response = await this.request<{ value: GraphEvent[] }>(
      `/calendars/${encodeURIComponent(rawCalendarId)}/calendarView?${params.toString()}`,
    );
    return (response.value || []).map((event) => this.normalizeEvent(rawCalendarId, event));
  }

  async createEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const rawCalendarId = this.extractCalendarId(calendarId);
    const event = await this.request<GraphEvent>(`/calendars/${encodeURIComponent(rawCalendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(toGraphEvent(input)),
    });
    return this.normalizeEvent(rawCalendarId, event);
  }

  async updateEvent(eventId: string, input: CalendarEventUpdateInput): Promise<CalendarEvent> {
    const { calendarId, rawEventId } = this.parseEventId(eventId);
    const rawCalendarId = this.extractCalendarId(calendarId);
    const event = await this.request<GraphEvent>(
      `/calendars/${encodeURIComponent(rawCalendarId)}/events/${encodeURIComponent(rawEventId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(toGraphEvent(input)),
      },
    );
    return this.normalizeEvent(rawCalendarId, event);
  }

  async deleteEvent(eventId: string): Promise<void> {
    const { calendarId, rawEventId } = this.parseEventId(eventId);
    const rawCalendarId = this.extractCalendarId(calendarId);
    await this.request(
      `/calendars/${encodeURIComponent(rawCalendarId)}/events/${encodeURIComponent(rawEventId)}`,
      { method: 'DELETE' },
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${GRAPH_ROOT}${this.resourcePrefix()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Microsoft Graph error: ${response.status} ${response.statusText} ${body}`.trim());
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 30_000) {
      return this.token.accessToken;
    }

    const form = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.config.refreshToken,
      scope: 'offline_access User.Read Calendars.Read Calendars.ReadWrite',
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Microsoft token exchange failed: ${response.status} ${response.statusText} ${body}`.trim());
    }

    const data = await response.json() as GraphTokenResponse;
    this.token = {
      accessToken: data.access_token,
      expiresAt: now + (data.expires_in * 1000),
    };
    if (data.refresh_token && data.refresh_token !== this.config.refreshToken) {
      this.config.refreshToken = data.refresh_token;
      m365Logger.warn(
        'Microsoft 365 refresh token rotated in memory; persisted sources still need an update',
      );
    }
    return data.access_token;
  }

  private resourcePrefix(): string {
    const userId = this.config.userId || 'me';
    return userId === 'me' ? '/me' : `/users/${encodeURIComponent(userId)}`;
  }

  private qualifyCalendarId(rawCalendarId: string): string {
    return `${this.sourceId}:${rawCalendarId}`;
  }

  private extractCalendarId(calendarId: string): string {
    if (calendarId.startsWith(`${this.sourceId}:`)) {
      return calendarId.slice(this.sourceId.length + 1);
    }
    return calendarId;
  }

  private parseEventId(eventId: string): { calendarId: string; rawEventId: string } {
    const parts = eventId.split(':');
    if (parts.length < 3 || parts[0] !== this.sourceId) {
      throw new Error('Invalid Microsoft 365 event ID');
    }
    const [, rawCalendarId, ...eventParts] = parts;
    return {
      calendarId: `${this.sourceId}:${rawCalendarId}`,
      rawEventId: eventParts.join(':'),
    };
  }

  private normalizeEvent(rawCalendarId: string, event: GraphEvent): CalendarEvent {
    return {
      id: `${this.sourceId}:${rawCalendarId}:${event.id}`,
      provider: this.provider,
      sourceId: this.sourceId,
      calendarId: this.qualifyCalendarId(rawCalendarId),
      title: event.subject || 'Untitled event',
      start: event.start?.dateTime || '',
      end: event.end?.dateTime || '',
      allDay: event.isAllDay || false,
      isReadOnly: false,
      description: event.bodyPreview || event.body?.content,
      location: event.location?.displayName,
      timezone: event.start?.timeZone,
      url: event.webLink,
    };
  }
}
