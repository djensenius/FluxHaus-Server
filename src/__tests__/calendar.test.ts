import CalendarService from '../calendar';
import {
  CalendarDescriptor,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdateInput,
  CalendarProvider,
} from '../calendar-types';
import { getUserPreferences } from '../user-preferences';

vi.mock('../user-preferences', () => ({
  getUserPreferences: vi.fn(),
}));

function makeProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  const calendars: CalendarDescriptor[] = [{
    id: 'm365:primary',
    provider: 'm365',
    sourceId: 'm365',
    name: 'Primary',
    writable: true,
    externalId: 'primary',
  }];

  return {
    provider: 'm365',
    sourceId: 'm365',
    configured: true,
    listCalendars: vi.fn().mockResolvedValue(calendars),
    listEvents: vi.fn().mockResolvedValue([] as CalendarEvent[]),
    createEvent: vi.fn().mockImplementation(async (_calendarId: string, input: CalendarEventInput) => ({
      id: 'm365:primary:event-1',
      provider: 'm365',
      sourceId: 'm365',
      calendarId: 'm365:primary',
      title: input.title,
      start: input.start,
      end: input.end,
      allDay: input.allDay || false,
      isReadOnly: false,
    })),
    updateEvent: vi.fn().mockImplementation(async (eventId: string, input: CalendarEventUpdateInput) => ({
      id: eventId,
      provider: 'm365',
      sourceId: 'm365',
      calendarId: 'm365:primary',
      title: input.title || 'Updated',
      start: input.start || '2026-04-07T12:00:00.000Z',
      end: input.end || '2026-04-07T13:00:00.000Z',
      allDay: input.allDay || false,
      isReadOnly: false,
    })),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('CalendarService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPreferences.mockResolvedValue({ memoryEnabled: true, defaultCalendarId: 'm365:primary' });
  });

  it('uses the user default calendar when creating an event', async () => {
    const provider = makeProvider();
    const service = new CalendarService([provider]);

    await service.createEvent({
      title: 'Lunch',
      start: '2026-04-07T16:00:00.000Z',
      end: '2026-04-07T17:00:00.000Z',
    }, 'user-1');

    expect(provider.createEvent).toHaveBeenCalledWith('m365:primary', expect.objectContaining({
      title: 'Lunch',
    }));
  });

  it('throws when no writable default can be resolved', async () => {
    getUserPreferences.mockResolvedValue({ memoryEnabled: true, defaultCalendarId: null });
    const readOnlyProvider = makeProvider({
      listCalendars: vi.fn().mockResolvedValue([{
        id: 'ics:subscription',
        provider: 'ics',
        sourceId: 'ics:subscription',
        name: 'Subscription',
        writable: false,
        externalId: 'subscription',
      }]),
      createEvent: undefined,
    });
    const service = new CalendarService([readOnlyProvider]);

    await expect(service.createEvent({
      title: 'Lunch',
      start: '2026-04-07T16:00:00.000Z',
      end: '2026-04-07T17:00:00.000Z',
    }, 'user-1')).rejects.toThrow('No default writable calendar is set');
  });

  it('rejects a read-only default calendar', async () => {
    getUserPreferences.mockResolvedValue({ memoryEnabled: true, defaultCalendarId: 'ics:subscription' });
    const writableProvider = makeProvider();
    const readOnlyProvider = makeProvider({
      provider: 'ics',
      sourceId: 'ics',
      listCalendars: vi.fn().mockResolvedValue([{
        id: 'ics:subscription',
        provider: 'ics',
        sourceId: 'ics',
        name: 'Subscription',
        writable: false,
        externalId: 'subscription',
      }]),
      createEvent: undefined,
      updateEvent: undefined,
      deleteEvent: undefined,
    });
    const service = new CalendarService([writableProvider, readOnlyProvider]);

    await expect(service.createEvent({
      title: 'Lunch',
      start: '2026-04-07T16:00:00.000Z',
      end: '2026-04-07T17:00:00.000Z',
    }, 'user-1')).rejects.toThrow('Default calendar is read-only; choose a writable calendar');
  });

  it('lists calendars once per provider when aggregating events', async () => {
    getUserPreferences.mockResolvedValue({ memoryEnabled: true, defaultCalendarId: null });
    const provider = makeProvider({
      listCalendars: vi.fn().mockResolvedValue([
        {
          id: 'm365:primary',
          provider: 'm365',
          sourceId: 'm365',
          name: 'Primary',
          writable: true,
          externalId: 'primary',
        },
        {
          id: 'm365:secondary',
          provider: 'm365',
          sourceId: 'm365',
          name: 'Secondary',
          writable: true,
          externalId: 'secondary',
        },
      ]),
    });
    const service = new CalendarService([provider]);

    await service.listEvents('2026-04-07T00:00:00.000Z', '2026-04-08T00:00:00.000Z', undefined, 'user-1');

    expect(provider.listCalendars).toHaveBeenCalledTimes(1);
    expect(provider.listEvents).toHaveBeenCalledTimes(2);
  });
});
