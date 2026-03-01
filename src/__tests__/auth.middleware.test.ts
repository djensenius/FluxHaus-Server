import { Request, Response } from 'express';
import { authMiddleware, validateOidcToken } from '../middleware/auth.middleware';

jest.mock('../db');

describe('authMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RHIZOME_PASSWORD = 'rhizomepassword';
    process.env.DEMO_PASSWORD = 'demopassword';
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_TEST_TOKEN;

    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('should return 401 when no Authorization header is present', () => {
    authMiddleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should set admin role for valid Bearer token via OIDC_TEST_TOKEN', async () => {
    process.env.OIDC_TEST_TOKEN = 'test-admin-token';
    req.headers = { authorization: 'Bearer test-admin-token' };

    authMiddleware(req as Request, res as Response, next);

    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ name: 'admin', role: 'admin' });
  });

  it('should return 401 for invalid Bearer token', async () => {
    req.headers = { authorization: 'Bearer invalid-token' };

    authMiddleware(req as Request, res as Response, next);

    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should set demo role for valid demo basic auth', () => {
    const creds = Buffer.from('demo:demopassword').toString('base64');
    req.headers = { authorization: `Basic ${creds}` };

    authMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ name: 'demo', role: 'demo' });
  });

  it('should set rhizome role for valid rhizome basic auth', () => {
    const creds = Buffer.from('rhizome:rhizomepassword').toString('base64');
    req.headers = { authorization: `Basic ${creds}` };

    authMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ name: 'rhizome', role: 'rhizome' });
  });

  it('should return 401 for invalid basic auth credentials', () => {
    const creds = Buffer.from('demo:wrongpassword').toString('base64');
    req.headers = { authorization: `Basic ${creds}` };

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 401 for unknown basic auth user', () => {
    const creds = Buffer.from('unknown:password').toString('base64');
    req.headers = { authorization: `Basic ${creds}` };

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 401 for unsupported auth scheme', () => {
    req.headers = { authorization: 'Digest something' };

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('validateOidcToken', () => {
  beforeEach(() => {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_TEST_TOKEN;
  });

  it('should return admin user for matching OIDC_TEST_TOKEN', async () => {
    process.env.OIDC_TEST_TOKEN = 'my-test-token';

    const result = await validateOidcToken('my-test-token');

    expect(result).toEqual({ name: 'admin', role: 'admin' });
  });

  it('should return null when no OIDC config and token does not match test token', async () => {
    const result = await validateOidcToken('random-token');

    expect(result).toBeNull();
  });
});
