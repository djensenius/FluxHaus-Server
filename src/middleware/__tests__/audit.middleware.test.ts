import { NextFunction, Request, Response } from 'express';
import auditMiddleware from '../audit.middleware';
import { logEvent } from '../../audit';

vi.mock('../../audit', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../influx', () => ({ writePoint: vi.fn() }));
vi.mock('../../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

function run(user: Request['user']) {
  const req = { path: '/mcp', method: 'POST', ip: '127.0.0.1', user } as Request;
  const next = vi.fn() as NextFunction;
  auditMiddleware(req, {} as Response, next);
  expect(next).toHaveBeenCalled();
}

describe('auditMiddleware', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the auth method and key id for MCP API key requests', () => {
    run({
      role: 'admin',
      username: 'alice',
      sub: 'user-1',
      authMethod: 'mcp_api_key',
      mcpAccess: 'read',
      mcpKeyId: 'key-uuid',
    });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      user_sub: 'user-1',
      route: '/mcp',
      details: { authMethod: 'mcp_api_key', mcpKeyId: 'key-uuid', mcpAccess: 'read' },
    }));
  });

  it('does not add details for other requests', () => {
    run({ role: 'admin', username: 'alice', sub: 'user-1' });
    expect((logEvent as vi.Mock).mock.calls[0][0]).not.toHaveProperty('details');
  });
});
