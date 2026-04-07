import ical from 'ical-generator';
import * as nodeIcal from 'node-ical';
import {
  DAVCalendar,
  DAVCalendarObject,
  createDAVClient,
} from 'tsdav';
import logger from '../logger';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdateInput,
  CalendarProvider,
} from '../calendar-types';

const icloudLogger = logger.child({ subsystem: 'icloud-calendar' });

function buildICalendar(calendar: DAVCalendar, objectId: string, input: CalendarEventInput): string {
  const cal = ical({
    name: typeof calendar.displayName === 'string' ? calendar.displayName : 'FluxHaus',
    timezone: input.timezone || calendar.timezone || null,
  });
  cal.createEvent({
    id: objectId.replace(/\.ics$/i, ''),
    start: new Date(input.start),
    end: new Date(input.end),
    allDay: input.allDay || false,
    summary: input.title,
    description: input.description,
    location: input.location,
    timezone: input.timezone || calendar.timezone || null,
    url: input.url || null,
  });
  return cal.toString();
}

function extractNodeIcalSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary;
  if (summary && typeof summary === 'object' && 'val' in summary && typeof summary.val === 'string') {
    return summary.val;
  }
  return 'Untitled event';
}

function extractNodeIcalText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'val' in value && typeof value.val === 'string') return value.val;
  icloudLogger.debug({ value }, 'Unsupported iCloud calendar property shape');
  return undefined;
}

export interface ICloudCalendarConfig {
  serverUrl: string;
  username: string;
  password: string;
  sourceId?: string;
}

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;

export class ICloudCalendarClient implements CalendarProvider {
  public readonly provider = 'icloud' as const;

  public readonly sourceId: string;

  private config: ICloudCalendarConfig;

  private clientPromise: Promise<DAVClient> | null = null;

  private accountPromise: Promise<{ calendars?: DAVCalendar[] }> | null = null;

  constructor(config: ICloudCalendarConfig) {
    this.config = config;
    this.sourceId = config.sourceId || 'icloud';
  }

  get configured(): boolean {
    return !!(this.config.serverUrl && this.config.username && this.config.password);
  }

  async listCalendars(): Promise<CalendarDescriptor[]> {
    if (!this.configured) return [];
    const calendars = await this.getCalendars();
    return calendars.map((calendar) => ({
      id: this.qualifyCalendarId(calendar.url),
      provider: this.provider,
      sourceId: this.sourceId,
      name: typeof calendar.displayName === 'string' ? calendar.displayName : calendar.url,
      writable: true,
      externalId: calendar.url,
      color: calendar.calendarColor,
      description: calendar.description,
    }));
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<CalendarEvent[]> {
    const client = await this.getClient();
    const calendar = await this.getCalendarById(calendarId);
    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start, end },
      expand: true,
    });

    return objects.flatMap((object) => this.normalizeCalendarObject(calendar, object));
  }

  async createEvent(calendarId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    const client = await this.getClient();
    const calendar = await this.getCalendarById(calendarId);
    const objectId = `${crypto.randomUUID()}.ics`;
    const iCalString = buildICalendar(calendar, objectId, input);
    await client.createCalendarObject({
      calendar,
      filename: objectId,
      iCalString,
    });

    const objectUrl = `${calendar.url.replace(/\/$/, '')}/${objectId}`;
    return {
      id: this.qualifyEventId(calendar.url, objectUrl),
      provider: this.provider,
      sourceId: this.sourceId,
      calendarId: this.qualifyCalendarId(calendar.url),
      title: input.title,
      start: input.start,
      end: input.end,
      allDay: input.allDay || false,
      isReadOnly: false,
      description: input.description,
      location: input.location,
      timezone: input.timezone,
      url: input.url,
    };
  }

  async updateEvent(eventId: string, input: CalendarEventUpdateInput): Promise<CalendarEvent> {
    const client = await this.getClient();
    const { calendarUrl, objectUrl } = this.parseEventId(eventId);
    const calendar = await this.getCalendarById(this.qualifyCalendarId(calendarUrl));
    const calendarObject = await this.getCalendarObject(calendar, objectUrl);
    const existing = this.normalizeCalendarObject(calendar, calendarObject)[0];

    const merged: CalendarEventInput = {
      calendarId: existing.calendarId,
      title: input.title ?? existing.title,
      start: input.start ?? existing.start,
      end: input.end ?? existing.end,
      allDay: input.allDay ?? existing.allDay,
      description: input.description ?? existing.description,
      location: input.location ?? existing.location,
      timezone: input.timezone ?? existing.timezone,
      url: input.url ?? existing.url,
    };

    calendarObject.data = buildICalendar(calendar, objectUrl.split('/').pop() || `${crypto.randomUUID()}.ics`, merged);
    await client.updateCalendarObject({ calendarObject });
    return {
      ...existing,
      ...merged,
      id: this.qualifyEventId(calendar.url, objectUrl),
      provider: this.provider,
      sourceId: this.sourceId,
      calendarId: this.qualifyCalendarId(calendar.url),
      isReadOnly: false,
    };
  }

  async deleteEvent(eventId: string): Promise<void> {
    const client = await this.getClient();
    const { calendarUrl, objectUrl } = this.parseEventId(eventId);
    const calendar = await this.getCalendarById(this.qualifyCalendarId(calendarUrl));
    const calendarObject = await this.getCalendarObject(calendar, objectUrl);
    await client.deleteCalendarObject({ calendarObject });
  }

  private async getClient(): Promise<DAVClient> {
    if (!this.clientPromise) {
      this.clientPromise = createDAVClient({
        serverUrl: this.config.serverUrl,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
    }
    return this.clientPromise;
  }

  private async getAccount(): Promise<{ calendars?: DAVCalendar[] }> {
    if (!this.accountPromise) {
      this.accountPromise = this.getClient().then((client) => client.createAccount({
        account: {
          serverUrl: this.config.serverUrl,
          accountType: 'caldav',
        },
        loadCollections: true,
        loadObjects: false,
      }));
    }
    return this.accountPromise;
  }

  private async getCalendars(): Promise<DAVCalendar[]> {
    const account = await this.getAccount();
    return account.calendars || [];
  }

  private async getCalendarById(calendarId: string): Promise<DAVCalendar> {
    const rawCalendarUrl = this.extractCalendarUrl(calendarId);
    const calendars = await this.getCalendars();
    const calendar = calendars.find((item) => item.url === rawCalendarUrl);
    if (!calendar) {
      throw new Error(`iCloud calendar not found: ${calendarId}`);
    }
    return calendar;
  }

  private async getCalendarObject(calendar: DAVCalendar, objectUrl: string): Promise<DAVCalendarObject> {
    const client = await this.getClient();
    const objects = await client.fetchCalendarObjects({
      calendar,
      objectUrls: [objectUrl],
      useMultiGet: true,
    });
    if (objects.length === 0) {
      throw new Error(`iCloud event not found: ${objectUrl}`);
    }
    return objects[0] as DAVCalendarObject;
  }

  private normalizeCalendarObject(calendar: DAVCalendar, object: DAVCalendarObject): CalendarEvent[] {
    const raw = typeof object.data === 'string' ? object.data : '';
    if (!raw) return [];

    const parsed = nodeIcal.parseICS(raw);
    return Object.values(parsed)
      .filter((item): item is nodeIcal.VEvent => !!item && item.type === 'VEVENT')
      .map((event) => ({
        id: this.qualifyEventId(calendar.url, object.url),
        provider: this.provider,
        sourceId: this.sourceId,
        calendarId: this.qualifyCalendarId(calendar.url),
        title: extractNodeIcalSummary(event.summary),
        start: event.start.toISOString(),
        end: (event.end || event.start).toISOString(),
        allDay: event.datetype === 'date',
        isReadOnly: false,
        description: extractNodeIcalText(event.description),
        location: extractNodeIcalText(event.location),
        timezone: event.start.tz || calendar.timezone,
        url: extractNodeIcalText(event.url),
        recurrence: event.rrule ? event.rrule.toString() : undefined,
      }));
  }

  private qualifyCalendarId(calendarUrl: string): string {
    return `${this.sourceId}:${encodeURIComponent(calendarUrl)}`;
  }

  private qualifyEventId(calendarUrl: string, objectUrl: string): string {
    return `${this.sourceId}:${encodeURIComponent(calendarUrl)}:${encodeURIComponent(objectUrl)}`;
  }

  private extractCalendarUrl(calendarId: string): string {
    const prefix = `${this.sourceId}:`;
    if (!calendarId.startsWith(prefix)) return calendarId;
    return decodeURIComponent(calendarId.slice(prefix.length));
  }

  private parseEventId(eventId: string): { calendarUrl: string; objectUrl: string } {
    const match = eventId.match(new RegExp(`^${this.sourceId}:(.+?):(.+)$`));
    if (!match) throw new Error('Invalid iCloud event ID');
    return {
      calendarUrl: decodeURIComponent(match[1]),
      objectUrl: decodeURIComponent(match[2]),
    };
  }
}
