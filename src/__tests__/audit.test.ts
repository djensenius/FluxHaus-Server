import { NextFunction, Request, Response } from 'express';
import { getAuditLog, logEvent } from '../audit';
import { pool } from '../db';
import auditMiddleware from '../middleware/audit.middleware';

jest.mock('../db', () => ({
  pool: { query: jest.fn() },
}));

const mockQuery = pool.query as jest.Mock;

describe('logEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('should insert an audit log entry', async () => {
    await logEvent({
      action: 'GET /', username: 'admin', status: 200, ip: '127.0.0.1',
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      ['admin', 'GET /', null, 200, '127.0.0.1'],
    );
  });

  it('should insert with null values for optional fields', async () => {
    await logEvent({ action: 'POST /robot' });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [null, 'POST /robot', null, null, null],
    );
  });
});

describe('getAuditLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return entries from the database', async () => {
    const mockRows = [
      {
        id: 1,
        timestamp: new Date(),
        username: 'admin',
        action: 'GET /',
        resource: '/',
        status: 200,
        ip: '127.0.0.1',
      },
    ];
    mockQuery.mockResolvedValue({ rows: mockRows });

    const result = await getAuditLog();

    expect(mockQuery).toHaveBeenCalled();
    expect(result).toEqual(mockRows);
  });

  it('should apply username filter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAuditLog({ username: 'demo' });

    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain('username');
    expect(queryCall[1]).toContain('demo');
  });

  it('should apply action filter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAuditLog({ action: 'GET /' });

    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain('action');
    expect(queryCall[1]).toContain('GET /');
  });

  it('should apply since filter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const since = new Date('2024-01-01');

    await getAuditLog({ since });

    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[0]).toContain('timestamp');
    expect(queryCall[1]).toContain(since);
  });

  it('should use default limit and offset', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await getAuditLog();

    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[1]).toContain(100);
    expect(queryCall[1]).toContain(0);
  });
});

describe('auditMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('should call next and fire-and-forget log on finish', async () => {
    let finishCallback: (() => void) | undefined;
    const req = {
      user: { name: 'admin', role: 'admin' },
      method: 'GET',
      path: '/',
      ip: '127.0.0.1',
    } as unknown as Request;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishCallback = cb;
      }),
      statusCode: 200,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;

    auditMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();

    finishCallback!();
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['admin', 'GET /']),
    );
  });

  it('should not crash the server when audit write fails', async () => {
    mockQuery.mockRejectedValue(new Error('DB error'));

    let finishCallback: (() => void) | undefined;
    const req = {
      user: { name: 'admin' },
      method: 'GET',
      path: '/',
      ip: '127.0.0.1',
    } as unknown as Request;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') finishCallback = cb;
      }),
      statusCode: 200,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    auditMiddleware(req, res, next);
    finishCallback!();
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
