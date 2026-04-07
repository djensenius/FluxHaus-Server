import {
  createCalendarSource,
  listCalendarSources,
  sanitizeCalendarSource,
  updateCalendarSource,
} from '../calendar-sources';

jest.mock('../db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../encryption', () => ({
  encrypt: jest.fn((value) => `enc:${value}`),
  decrypt: jest.fn((value) => String(value).replace(/^enc:/, '')),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPool } = require('../db');

describe('calendar-sources', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  it('lists and decrypts calendar sources', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        id: 'source-1',
        user_sub: 'user-1',
        provider: 'ics',
        display_name: 'School',
        enabled: true,
        config_encrypted: 'enc:{"url":"https://example.com/calendar.ics"}',
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      }],
    });

    const sources = await listCalendarSources('user-1');

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: 'source-1',
      provider: 'ics',
      displayName: 'School',
      config: { url: 'https://example.com/calendar.ics' },
    });
  });

  it('creates encrypted calendar sources', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        id: 'source-1',
        user_sub: 'user-1',
        provider: 'icloud',
        display_name: 'iCloud',
        enabled: true,
        created_at: '2026-04-07T00:00:00.000Z',
        updated_at: '2026-04-07T00:00:00.000Z',
      }],
    });

    const result = await createCalendarSource('user-1', {
      provider: 'icloud',
      displayName: 'iCloud',
      config: {
        serverUrl: 'https://caldav.icloud.com',
        username: 'me@example.com',
        password: 'secret',
      },
    });

    expect(result.displayName).toBe('iCloud');
    expect(mockPool.query.mock.calls[0][1][4]).toContain('"password":"secret"');
  });

  it('updates a calendar source without exposing secrets in summary', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'source-1',
          user_sub: 'user-1',
          provider: 'm365',
          display_name: 'Work',
          enabled: true,
          config_encrypted: `enc:${JSON.stringify({
            tenantId: 'tenant',
            clientId: 'client',
            clientSecret: 'secret',
            refreshToken: 'refresh',
          })}`,
          created_at: '2026-04-07T00:00:00.000Z',
          updated_at: '2026-04-07T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'source-1',
          user_sub: 'user-1',
          provider: 'm365',
          display_name: 'Work Updated',
          enabled: false,
          created_at: '2026-04-07T00:00:00.000Z',
          updated_at: '2026-04-07T01:00:00.000Z',
        }],
      });

    const result = await updateCalendarSource('user-1', 'source-1', {
      displayName: 'Work Updated',
      enabled: false,
    });

    expect(result.displayName).toBe('Work Updated');
    expect(sanitizeCalendarSource(result)).toMatchObject({
      displayName: 'Work Updated',
      enabled: false,
      config: {
        tenantId: 'tenant',
        clientId: 'client',
        userId: 'me',
        clientSecretConfigured: true,
        refreshTokenConfigured: true,
      },
    });
  });

  it('rejects ICS URLs on localhost or private networks', async () => {
    await expect(createCalendarSource('user-1', {
      provider: 'ics',
      displayName: 'Local Feed',
      config: {
        url: 'http://127.0.0.1/calendar.ics',
      },
    })).rejects.toThrow('ICS source URL must not target a private or loopback address');

    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('rejects ICS URLs on IPv4-mapped loopback IPv6 addresses', async () => {
    await expect(createCalendarSource('user-1', {
      provider: 'ics',
      displayName: 'Mapped Loopback Feed',
      config: {
        url: 'http://[::ffff:127.0.0.1]/calendar.ics',
      },
    })).rejects.toThrow('ICS source URL must not target a private or loopback address');

    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
