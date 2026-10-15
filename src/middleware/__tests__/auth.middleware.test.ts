import { NextFunction, Request, Response } from 'express';
import { authMiddleware, requireOidcForMutations, requireRole } from '../auth.middleware';
import { validateBearerToken } from '../oidc.middleware';
import { verifyMcpToken } from '../../mcp-auth';

vi.mock('../oidc.middleware', () => ({
  validateBearerToken: vi.fn(),
  isOidcEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../mcp-auth', () => ({
  verifyMcpToken: vi.fn().mockResolvedValue(null),
  mcpResource: vi.fn().mockReturnValue('http://localhost:8888/mcp'),
  serverOrigin: vi.fn().mockReturnValue('http://localhost:8888'),
}));

function mockReq(headers: Record<string, string> = {}, path = '/test'): Partial<Request> {
  return { headers, path } as Partial<Request>;
}

function mockRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  const next: NextFunction = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (verifyMcpToken as vi.Mock).mockResolvedValue(null);
    (validateBearerToken as vi.Mock).mockResolvedValue(null);
    process.env.BASIC_AUTH_PASSWORD = 'adminpass';
    process.env.RHIZOME_PASSWORD = 'rhizomepass';
    process.env.DEMO_PASSWORD = 'demopass';
  });

  it('should return 401 when no auth provided', async () => {
    const req = mockReq() as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should authenticate admin via Bearer token (OIDC)', async () => {
    (validateBearerToken as vi.Mock).mockResolvedValue({
      sub: 'user-123',
      email: 'admin@example.com',
      preferred_username: 'adminuser',
    });
    const req = mockReq({ authorization: 'Bearer valid-token' }) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(req.user).toEqual({
      role: 'admin',
      username: 'adminuser',
      sub: 'user-123',
      email: 'admin@example.com',
    });
    expect(next).toHaveBeenCalled();
  });

  it('should authenticate /mcp with an audience-bound MCP token only', async () => {
    (verifyMcpToken as vi.Mock).mockResolvedValue({
      sub: 'user-123',
      email: 'admin@example.com',
      preferred_username: 'adminuser',
    });
    const req = mockReq({ authorization: 'Bearer mcp-token' }, '/mcp') as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(verifyMcpToken).toHaveBeenCalledWith('mcp-token', 'http://localhost:8888/mcp');
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(req.user).toEqual({
      role: 'admin',
      username: 'adminuser',
      sub: 'user-123',
      email: 'admin@example.com',
    });
    expect(next).toHaveBeenCalled();
  });

  it('should reject generic OIDC bearer tokens on /mcp', async () => {
    (verifyMcpToken as vi.Mock).mockResolvedValue(null);
    (validateBearerToken as vi.Mock).mockResolvedValue({ sub: 'oidc-user' });
    const req = mockReq({ authorization: 'Bearer oidc-token' }, '/mcp') as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer resource_metadata="http://localhost:8888/.well-known/oauth-protected-resource/mcp"',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['/mcp/', '/MCP'])('should apply MCP-only auth to equivalent path %s', async (path) => {
    (verifyMcpToken as vi.Mock).mockResolvedValue(null);
    (validateBearerToken as vi.Mock).mockResolvedValue({ sub: 'oidc-user' });
    const req = mockReq({ authorization: 'Bearer oidc-token' }, path) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject invalid Bearer token', async () => {
    (validateBearerToken as vi.Mock).mockResolvedValue(null);
    const req = mockReq({ authorization: 'Bearer bad-token' }) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should authenticate demo user via Basic auth', async () => {
    const encoded = Buffer.from('demo:demopass').toString('base64');
    const req = mockReq({ authorization: `Basic ${encoded}` }) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(req.user).toEqual({ role: 'demo', username: 'demo' });
    expect(next).toHaveBeenCalled();
  });

  it('should authenticate rhizome user via Basic auth', async () => {
    const encoded = Buffer.from('rhizome:rhizomepass').toString('base64');
    const req = mockReq({ authorization: `Basic ${encoded}` }) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(req.user).toEqual({ role: 'rhizome', username: 'rhizome' });
    expect(next).toHaveBeenCalled();
  });

  it('should reject invalid Basic auth credentials', async () => {
    const encoded = Buffer.from('demo:wrongpass').toString('base64');
    const req = mockReq({ authorization: `Basic ${encoded}` }) as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  it('should call next when role matches', () => {
    const req = { user: { role: 'admin' } } as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should return 403 when role does not match', () => {
    const req = { user: { role: 'demo' } } as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 when no user', () => {
    const req = {} as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireOidcForMutations', () => {
  const middleware = requireOidcForMutations(['/webhooks/trigger']);

  it('should allow GET requests without OIDC', () => {
    const req = { method: 'GET', path: '/startCar', user: { role: 'demo', username: 'demo' } } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should allow POST from OIDC user (has sub)', () => {
    const req = {
      method: 'POST', path: '/startCar', user: { role: 'admin', username: 'admin', sub: 'user-123' },
    } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should block POST from non-OIDC user (no sub)', () => {
    const req = { method: 'POST', path: '/startCar', user: { role: 'admin', username: 'admin' } } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'OIDC authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should block POST from demo user', () => {
    const req = { method: 'POST', path: '/command', user: { role: 'demo', username: 'demo' } } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should block DELETE from non-OIDC user', () => {
    const req = {
      method: 'DELETE', path: '/conversations/1', user: { role: 'admin', username: 'admin' },
    } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should allow excluded paths without OIDC', () => {
    const req = {
      method: 'POST', path: '/webhooks/trigger', user: { role: 'admin', username: 'admin' },
    } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should block when no user at all', () => {
    const req = { method: 'POST', path: '/startCar' } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = vi.fn();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
