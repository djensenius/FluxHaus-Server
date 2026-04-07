import { HomeAssistantClient } from '../homeassistant-client';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarProvider,
} from '../calendar-types';

export default class HomeAssistantCalendarProvider implements CalendarProvider {
  public readonly provider = 'homeassistant' as const;

  public readonly sourceId = 'homeassistant';

  public readonly configured = true;

  private client: HomeAssistantClient;

  constructor(client: HomeAssistantClient) {
    this.client = client;
  }

  async listCalendars(): Promise<CalendarDescriptor[]> {
    const calendars = await this.client.getCalendars();
    return (Array.isArray(calendars) ? calendars : []).map((calendar) => ({
      id: calendar.entity_id,
      provider: this.provider,
      sourceId: this.sourceId,
      name: calendar.name || calendar.entity_id,
      writable: false,
      externalId: calendar.entity_id,
    }));
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<CalendarEvent[]> {
    const events = await this.client.getCalendarEvents(calendarId, start, end);
    return (Array.isArray(events) ? events : []).map((event, index) => ({
      id: `homeassistant:${calendarId}:${event.uid || index}:${event.start || start}`,
      provider: this.provider,
      sourceId: this.sourceId,
      calendarId,
      title: event.summary || event.message || 'Untitled event',
      start: event.start,
      end: event.end,
      allDay: Boolean(event.all_day),
      isReadOnly: true,
      description: event.description,
      location: event.location,
      url: event.url,
    }));
  }
}
