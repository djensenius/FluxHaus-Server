import { NextFunction, Request, Response } from 'express';
import { authMiddleware } from '../auth.middleware';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const jose = require('jose');

describe('authMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.OIDC_AUDIENCE = 'fluxhaus';
    process.env.DEMO_PASSWORD = 'demopassword';
    process.env.RHIZOME_PASSWORD = 'rhizomepassword';

    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('should return 401 with WWW-Authenticate when no Authorization header', async () => {
    await authMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="fluxhaus"',
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 500 when OIDC is not configured', async () => {
    delete process.env.OIDC_ISSUER;
    req.headers = { authorization: 'Bearer some-token' };

    await authMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  it('should authenticate admin user with valid Bearer token', async () => {
    req.headers = { authorization: 'Bearer valid-token' };
    jose.createRemoteJWKSet.mockReturnValue('mock-jwks');
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123',
        email: 'admin@example.com',
      },
    });

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({
      role: 'admin',
      username: 'admin@example.com',
      sub: 'user-123',
      email: 'admin@example.com',
    });
    expect(next).toHaveBeenCalled();
  });

  it('should use sub as username when email is absent', async () => {
    req.headers = { authorization: 'Bearer valid-token' };
    jose.createRemoteJWKSet.mockReturnValue('mock-jwks');
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'user-456' },
    });

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({
      role: 'admin',
      username: 'user-456',
      sub: 'user-456',
      email: undefined,
    });
    expect(next).toHaveBeenCalled();
  });

  it('should use empty string username when both email and sub are absent', async () => {
    req.headers = { authorization: 'Bearer valid-token' };
    jose.createRemoteJWKSet.mockReturnValue('mock-jwks');
    jose.jwtVerify.mockResolvedValue({
      payload: {},
    });

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({
      role: 'admin',
      username: '',
      sub: undefined,
      email: undefined,
    });
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 with invalid_token error when Bearer token is invalid', async () => {
    req.headers = { authorization: 'Bearer invalid-token' };
    jose.createRemoteJWKSet.mockReturnValue('mock-jwks');
    jose.jwtVerify.mockRejectedValue(new Error('Invalid token'));

    await authMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Bearer realm="fluxhaus", error="invalid_token"',
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should authenticate demo user with valid Basic credentials', async () => {
    const credentials = Buffer.from('demo:demopassword').toString('base64');
    req.headers = { authorization: `Basic ${credentials}` };

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({ role: 'demo', username: 'demo' });
    expect(next).toHaveBeenCalled();
  });

  it('should authenticate rhizome user with valid Basic credentials', async () => {
    const credentials = Buffer.from('rhizome:rhizomepassword').toString('base64');
    req.headers = { authorization: `Basic ${credentials}` };

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({ role: 'rhizome', username: 'rhizome' });
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 for Basic auth with wrong password', async () => {
    const credentials = Buffer.from('demo:wrongpassword').toString('base64');
    req.headers = { authorization: `Basic ${credentials}` };

    await authMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for Basic auth with unknown username', async () => {
    const credentials = Buffer.from('admin:adminpassword').toString('base64');
    req.headers = { authorization: `Basic ${credentials}` };

    await authMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for unrecognized auth scheme', async () => {
    req.headers = { authorization: 'Digest somevalue' };

    await authMiddleware(req as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      'Basic realm="fluxhaus"',
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should handle Basic credentials with colon in password', async () => {
    const credentials = Buffer.from('demo:pass:word').toString('base64');
    req.headers = { authorization: `Basic ${credentials}` };
    process.env.DEMO_PASSWORD = 'pass:word';

    await authMiddleware(req as Request, res as Response, next);

    expect(req.user).toEqual({ role: 'demo', username: 'demo' });
    expect(next).toHaveBeenCalled();
  });
});
