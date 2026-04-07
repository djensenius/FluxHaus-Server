export type CalendarProviderName = 'homeassistant' | 'icloud' | 'm365' | 'ics';

export interface CalendarDescriptor {
  id: string;
  provider: CalendarProviderName;
  sourceId: string;
  name: string;
  writable: boolean;
  externalId: string;
  description?: string;
  color?: string;
  isDefault?: boolean;
}

export interface CalendarEvent {
  id: string;
  provider: CalendarProviderName;
  sourceId: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  isReadOnly: boolean;
  description?: string;
  location?: string;
  timezone?: string;
  url?: string;
  recurrence?: string;
}

export interface CalendarEventInput {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  timezone?: string;
  url?: string;
}

export interface CalendarEventUpdateInput {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  timezone?: string;
  url?: string;
}

export interface CalendarProvider {
  provider: CalendarProviderName;
  sourceId: string;
  configured: boolean;
  listCalendars(): Promise<CalendarDescriptor[]>;
  listEvents(calendarId: string, start: string, end: string): Promise<CalendarEvent[]>;
  createEvent?(calendarId: string, input: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent?(eventId: string, input: CalendarEventUpdateInput): Promise<CalendarEvent>;
  deleteEvent?(eventId: string): Promise<void>;
}
