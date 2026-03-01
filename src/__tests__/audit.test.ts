import { getAuditLog, logEvent } from '../audit';

const mockQuery = jest.fn();

jest.mock('../db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('audit service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logEvent', () => {
    it('inserts a row into audit_logs', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await logEvent({
        username: 'admin',
        role: 'admin',
        action: 'view:dashboard',
        route: '/',
        method: 'GET',
        ip: '127.0.0.1',
        details: { status: 200 },
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_logs'),
        expect.arrayContaining(['admin', 'view:dashboard', '/']),
      );
    });

    it('uses null for optional userSub and ip', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await logEvent({
        username: 'demo',
        role: 'demo',
        action: 'view:dashboard',
        route: '/',
        method: 'GET',
      });
      const callArgs = mockQuery.mock.calls[0][1];
      expect(callArgs[0]).toBeNull(); // userSub
      expect(callArgs[6]).toBeNull(); // ip
    });
  });

  describe('getAuditLog', () => {
    const mockRows = [
      {
        id: 1,
        user_sub: 'sub-1',
        username: 'admin',
        role: 'admin',
        action: 'view:dashboard',
        route: '/',
        method: 'GET',
        ip: '127.0.0.1',
        details: { status: 200 },
        created_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    it('returns mapped audit log entries', async () => {
      mockQuery.mockResolvedValue({ rows: mockRows });
      const entries = await getAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 1,
        userSub: 'sub-1',
        username: 'admin',
        role: 'admin',
        action: 'view:dashboard',
      });
    });

    it('applies default limit 50 and offset 0', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await getAuditLog();
      const sql: string = mockQuery.mock.calls[0][0];
      const values: unknown[] = mockQuery.mock.calls[0][1];
      expect(sql).toContain('LIMIT');
      expect(values).toContain(50);
      expect(values).toContain(0);
    });

    it('caps limit at 500', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await getAuditLog({ limit: 9999 });
      const values: unknown[] = mockQuery.mock.calls[0][1];
      expect(values).toContain(500);
    });

    it('filters by username and action', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await getAuditLog({ username: 'alice', action: 'car:start' });
      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain('username = $1');
      expect(sql).toContain('action = $2');
    });

    it('filters by since date', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const since = new Date('2026-01-01T00:00:00Z');
      await getAuditLog({ since });
      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain('created_at >=');
    });

    it('handles null optional fields', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 2,
          user_sub: null,
          username: 'demo',
          role: 'demo',
          action: 'view:dashboard',
          route: '/',
          method: 'GET',
          ip: null,
          details: null,
          created_at: new Date(),
        }],
      });
      const entries = await getAuditLog();
      expect(entries[0].userSub).toBeUndefined();
      expect(entries[0].ip).toBeUndefined();
      expect(entries[0].details).toBeUndefined();
    });
  });
});
