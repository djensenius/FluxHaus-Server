import { NextFunction, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../auth.middleware';
import { validateBearerToken } from '../oidc.middleware';

jest.mock('../oidc.middleware', () => ({
  validateBearerToken: jest.fn(),
}));

function mockReq(headers: Record<string, string> = {}): Partial<Request> {
  return { headers } as Partial<Request>;
}

function mockRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

describe('authMiddleware', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
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
    (validateBearerToken as jest.Mock).mockResolvedValue({
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

  it('should reject invalid Bearer token', async () => {
    (validateBearerToken as jest.Mock).mockResolvedValue(null);
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
    const next: NextFunction = jest.fn();
    requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('should return 403 when role does not match', () => {
    const req = { user: { role: 'demo' } } as Request;
    const res = mockRes() as Response;
    const next: NextFunction = jest.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 when no user', () => {
    const req = {} as Request;
    const res = mockRes() as Response;
    const next: NextFunction = jest.fn();
    requireRole('admin')(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
