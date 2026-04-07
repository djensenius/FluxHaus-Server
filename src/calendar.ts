import {
  CalendarSourceRecord,
  listEnabledCalendarSources,
} from './calendar-sources';
import { HomeAssistantClient } from './homeassistant-client';
import logger from './logger';
import { getUserPreferences } from './user-preferences';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdateInput,
  CalendarProvider,
} from './calendar-types';
import HomeAssistantCalendarProvider from './clients/homeassistant-calendar';
import { ICloudCalendarClient, ICloudCalendarConfig } from './clients/icloud-calendar';
import { ICSCalendarClient, ICSCalendarFeedConfig } from './clients/ics-calendar';
import { M365CalendarClient, M365CalendarConfig } from './clients/m365-calendar';

const calendarLogger = logger.child({ subsystem: 'calendar' });

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => a.start.localeCompare(b.start));
}

interface ProviderCalendars {
  provider: CalendarProvider;
  calendars: CalendarDescriptor[];
}

function findProviderByCalendarId(
  calendarId: string,
  providers: CalendarProvider[],
): CalendarProvider | undefined {
  return providers.find((provider) => (
    calendarId === provider.sourceId || calendarId.startsWith(`${provider.sourceId}:`)
  ));
}

function parseSubscribedCalendars(): ICSCalendarFeedConfig[] {
  const json = (process.env.SUBSCRIBED_CALENDARS_JSON || '').trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as ICSCalendarFeedConfig[];
      return parsed.filter((item) => item && item.id && item.name && item.url);
    } catch (err) {
      calendarLogger.error({ err }, 'Failed to parse SUBSCRIBED_CALENDARS_JSON');
      return [];
    }
  }

  const url = (process.env.SUBSCRIBED_CALENDAR_URL || '').trim();
  if (!url) return [];
  return [{
    id: 'subscription',
    name: (process.env.SUBSCRIBED_CALENDAR_NAME || 'Subscribed Calendar').trim(),
    url,
  }];
}

async function resolvePreferredCalendarId(userSub?: string): Promise<string | null> {
  if (!userSub) return null;
  const prefs = await getUserPreferences(userSub);
  return prefs.defaultCalendarId;
}

async function resolveAgendaCalendarId(userSub?: string): Promise<string | undefined> {
  return (await resolvePreferredCalendarId(userSub)) || undefined;
}

function createProviderFromSource(source: CalendarSourceRecord): CalendarProvider {
  const sourceId = `${source.provider}-${source.id}`;

  switch (source.provider) {
  case 'icloud':
    return new ICloudCalendarClient({
      ...(source.config as ICloudCalendarConfig),
      sourceId,
    });
  case 'm365':
    return new M365CalendarClient({
      ...(source.config as M365CalendarConfig),
      sourceId,
    });
  case 'ics':
    return new ICSCalendarClient({
      id: sourceId,
      name: source.displayName,
      url: (source.config as { url: string }).url,
    });
  default:
    throw new Error(`Unsupported calendar source provider: ${source.provider satisfies never}`);
  }
}

export default class CalendarService {
  private staticProviders: CalendarProvider[];

  constructor(providers: CalendarProvider[]) {
    this.staticProviders = providers.filter((provider) => provider.configured);
  }

  get configured(): boolean {
    return this.staticProviders.length > 0;
  }

  async listCalendars(userSub?: string): Promise<CalendarDescriptor[]> {
    const providerCalendars = await this.getProvidersWithCalendars(userSub);
    const defaultCalendarId = await resolvePreferredCalendarId(userSub);
    return providerCalendars.flatMap(({ calendars }) => calendars.map((calendar) => ({
      ...calendar,
      isDefault: defaultCalendarId ? calendar.id === defaultCalendarId : calendar.isDefault,
    })));
  }

  async listEvents(
    start: string,
    end: string,
    calendarId?: string,
    userSub?: string,
  ): Promise<CalendarEvent[]> {
    if (calendarId) {
      const provider = await this.findProviderForCalendar(calendarId, userSub);
      const events = await provider.listEvents(calendarId, start, end);
      return sortEvents(events);
    }

    const events = (
      await Promise.all((await this.getProvidersWithCalendars(userSub)).flatMap(({ provider, calendars }) => (
        calendars.map((calendar) => provider.listEvents(calendar.id, start, end))
      )))
    ).flat();
    return sortEvents(events);
  }

  async getTodayAgenda(userSub?: string): Promise<CalendarEvent[]> {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return this.listEvents(
      start.toISOString(),
      end.toISOString(),
      await resolveAgendaCalendarId(userSub),
      userSub,
    );
  }

  async createEvent(input: CalendarEventInput, userSub?: string): Promise<CalendarEvent> {
    const calendarId = await this.resolveWritableCalendarId(input.calendarId, userSub);
    const provider = await this.findProviderForCalendar(calendarId, userSub);
    if (!provider.createEvent) {
      throw new Error(`Calendar ${calendarId} is read-only`);
    }
    return provider.createEvent(calendarId, input);
  }

  async updateEvent(
    eventId: string,
    input: CalendarEventUpdateInput,
    userSub?: string,
  ): Promise<CalendarEvent> {
    const provider = await this.findProviderForEvent(eventId, userSub);
    if (!provider.updateEvent) {
      throw new Error(`Event ${eventId} belongs to a read-only calendar`);
    }
    return provider.updateEvent(eventId, input);
  }

  async deleteEvent(eventId: string, userSub?: string): Promise<void> {
    const provider = await this.findProviderForEvent(eventId, userSub);
    if (!provider.deleteEvent) {
      throw new Error(`Event ${eventId} belongs to a read-only calendar`);
    }
    await provider.deleteEvent(eventId);
  }

  private async findProviderForCalendar(
    calendarId: string,
    userSub?: string,
  ): Promise<CalendarProvider> {
    const providers = await this.getProviders(userSub);
    const directMatch = findProviderByCalendarId(calendarId, providers);
    if (directMatch) return directMatch;

    const match = (await this.getProvidersWithCalendars(userSub, providers))
      .find(({ calendars }) => calendars.some((calendar) => calendar.id === calendarId));
    if (!match) {
      throw new Error(`Calendar not found: ${calendarId}`);
    }
    return match.provider;
  }

  private async findProviderForEvent(eventId: string, userSub?: string): Promise<CalendarProvider> {
    const provider = (await this.getProviders(userSub)).find((item) => eventId.startsWith(`${item.sourceId}:`));
    if (!provider) {
      throw new Error(`Calendar provider not found for event: ${eventId}`);
    }
    return provider;
  }

  private async resolveWritableCalendarId(
    explicitCalendarId?: string,
    userSub?: string,
  ): Promise<string> {
    if (explicitCalendarId) return explicitCalendarId;

    const calendars = await this.listCalendars(userSub);
    const preferred = await resolvePreferredCalendarId(userSub);
    if (preferred) {
      const preferredCalendar = calendars.find((calendar) => calendar.id === preferred);
      if (preferredCalendar?.writable) {
        return preferredCalendar.id;
      }
      if (preferredCalendar) {
        throw new Error('Default calendar is read-only; choose a writable calendar');
      }
    }

    const writableCalendars = calendars.filter((calendar) => calendar.writable);
    if (writableCalendars.length === 1) {
      return writableCalendars[0].id;
    }
    throw new Error('No default writable calendar is set');
  }

  private async getProvidersWithCalendars(
    userSub?: string,
    providers?: CalendarProvider[],
  ): Promise<ProviderCalendars[]> {
    const availableProviders = providers ?? await this.getProviders(userSub);
    return Promise.all(availableProviders.map(async (provider) => ({
      provider,
      calendars: await provider.listCalendars(),
    })));
  }

  private async getProviders(userSub?: string): Promise<CalendarProvider[]> {
    const dynamicSources = await listEnabledCalendarSources(userSub);
    return [
      ...this.staticProviders,
      ...dynamicSources.map((source) => createProviderFromSource(source)),
    ];
  }
}

export function createCalendarService(homeAssistantClient: HomeAssistantClient): CalendarService {
  const providers: CalendarProvider[] = [
    new HomeAssistantCalendarProvider(homeAssistantClient),
  ];

  const icloud = new ICloudCalendarClient({
    serverUrl: (process.env.ICLOUD_CALDAV_URL || 'https://caldav.icloud.com').trim(),
    username: (process.env.ICLOUD_APPLE_ID || '').trim(),
    password: (process.env.ICLOUD_APP_SPECIFIC_PASSWORD || '').trim(),
  });
  if (icloud.configured) providers.push(icloud);

  const m365 = new M365CalendarClient({
    tenantId: (process.env.M365_TENANT_ID || '').trim(),
    clientId: (process.env.M365_CLIENT_ID || '').trim(),
    clientSecret: (process.env.M365_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.M365_REFRESH_TOKEN || '').trim(),
    userId: (process.env.M365_USER_ID || 'me').trim(),
  });
  if (m365.configured) providers.push(m365);

  const subscribedFeeds = parseSubscribedCalendars();
  subscribedFeeds.forEach((feed) => providers.push(new ICSCalendarClient(feed)));

  calendarLogger.info(
    { providers: providers.map((provider) => provider.sourceId) },
    'Calendar providers initialized',
  );
  return new CalendarService(providers);
}
