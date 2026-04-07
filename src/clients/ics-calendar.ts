import * as ical from 'node-ical';
import logger from '../logger';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarProvider,
} from '../calendar-types';

const icsLogger = logger.child({ subsystem: 'ics-calendar' });

function extractSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary;
  if (summary && typeof summary === 'object' && 'val' in summary && typeof summary.val === 'string') {
    return summary.val;
  }
  return 'Untitled event';
}

function extractText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'val' in value && typeof value.val === 'string') return value.val;
  icsLogger.debug({ value }, 'Unsupported ICS property shape');
  return undefined;
}

export interface ICSCalendarFeedConfig {
  id: string;
  name: string;
  url: string;
}

export class ICSCalendarClient implements CalendarProvider {
  public readonly provider = 'ics' as const;

  public readonly sourceId: string;

  private feed: ICSCalendarFeedConfig;

  constructor(feed: ICSCalendarFeedConfig) {
    this.feed = feed;
    this.sourceId = `ics:${feed.id}`;
  }

  get configured(): boolean {
    return !!this.feed.url;
  }

  async listCalendars(): Promise<CalendarDescriptor[]> {
    if (!this.configured) return [];
    return [{
      id: this.sourceId,
      provider: this.provider,
      sourceId: this.sourceId,
      name: this.feed.name,
      writable: false,
      externalId: this.feed.id,
      description: this.feed.url,
    }];
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<CalendarEvent[]> {
    if (calendarId !== this.sourceId) return [];

    const rangeStart = new Date(start);
    const rangeEnd = new Date(end);
    const data = await ical.async.fromURL(this.feed.url);
    const events = Object.values(data)
      .filter((item): item is ical.VEvent => !!item && item.type === 'VEVENT');

    const expanded = events.flatMap((event) => this.expandEvent(event, rangeStart, rangeEnd));
    expanded.sort((a, b) => a.start.localeCompare(b.start));
    return expanded;
  }

  private expandEvent(event: ical.VEvent, from: Date, to: Date): CalendarEvent[] {
    const instances = event.rrule
      ? ical.expandRecurringEvent(event, {
        from,
        to,
        includeOverrides: true,
        excludeExdates: true,
      })
      : [{
        start: event.start,
        end: event.end,
        summary: event.summary,
        isFullDay: event.datetype === 'date',
        isRecurring: false,
        isOverride: false,
        event,
      }];

    return instances
      .filter((instance) => (instance.end || instance.start) >= from && instance.start <= to)
      .map((instance) => {
        const baseId = event.uid || `${instance.start.toISOString()}-${instance.summary}`;
        const end = instance.end || instance.start;
        return {
          id: `${this.sourceId}:${baseId}:${instance.start.toISOString()}`,
          provider: this.provider,
          sourceId: this.sourceId,
          calendarId: this.sourceId,
          title: extractSummary(instance.summary),
          start: instance.start.toISOString(),
          end: end.toISOString(),
          allDay: instance.isFullDay,
          isReadOnly: true,
          description: extractText(instance.event.description),
          location: extractText(instance.event.location),
          timezone: instance.event.start.tz || undefined,
          url: extractText(instance.event.url),
          recurrence: instance.isRecurring && instance.event.rrule
            ? instance.event.rrule.toString()
            : undefined,
        };
      });
  }
}
