import { NextFunction, Request, Response } from 'express';
import { Issuer } from 'openid-client';
import * as jose from 'jose';
import { initOidc, oidcMiddleware } from '../oidc.middleware';

jest.mock('openid-client');
jest.mock('jose');

const mockIssuer = Issuer as jest.MockedClass<typeof Issuer>;
const mockJose = jose as jest.Mocked<typeof jose>;

describe('OIDC Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initOidc', () => {
    it('should warn and return early when OIDC_ISSUER_URL is missing', async () => {
      delete process.env.OIDC_ISSUER_URL;
      process.env.OIDC_CLIENT_ID = 'test-client';

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('OIDC not configured'),
      );
      expect(mockIssuer.discover).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should warn and return early when OIDC_CLIENT_ID is missing', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      delete process.env.OIDC_CLIENT_ID;

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('OIDC not configured'),
      );
      expect(mockIssuer.discover).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should warn and return early when both env vars are missing', async () => {
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('OIDC not configured'),
      );
      warnSpy.mockRestore();
    });

    it('should warn when issuer discovery fails', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockRejectedValue(new Error('Discovery failed'));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(warnSpy).toHaveBeenCalledWith(
        'OIDC initialization failed:',
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it('should warn when issuer has no jwks_uri', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: { issuer: 'https://auth.example.com', jwks_uri: undefined },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not provide a jwks_uri'),
      );
      warnSpy.mockRestore();
    });

    it('should initialize JWKS when issuer is discovered successfully', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      const mockJwksUri = 'https://auth.example.com/application/o/fluxhaus/jwks/';
      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: mockJwksUri,
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      expect(mockJose.createRemoteJWKSet).toHaveBeenCalledWith(new URL(mockJwksUri));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('OIDC initialized with issuer:'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('oidcMiddleware', () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: NextFunction;

    beforeEach(() => {
      req = { headers: {} };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      next = jest.fn();
    });

    it('should return 401 when OIDC is not configured (no jwks)', (done) => {
      jest.isolateModules(() => {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const { oidcMiddleware: freshMiddleware } = require('../oidc.middleware');
        freshMiddleware(req as Request, res as Response, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ message: 'OIDC not configured' });
        expect(next).not.toHaveBeenCalled();
        done();
      });
    });

    it('should return 401 when Authorization header is missing', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();
      warnSpy.mockRestore();

      req.headers = {};
      oidcMiddleware(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Missing or invalid Authorization header',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();
      warnSpy.mockRestore();

      req.headers = { authorization: 'Basic dXNlcjpwYXNz' };
      oidcMiddleware(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Missing or invalid Authorization header',
      });
    });

    it('should return 401 when JWT verification fails', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);
      (mockJose.jwtVerify as jest.Mock).mockRejectedValue(new Error('invalid signature'));

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();

      req.headers = { authorization: 'Bearer invalid.token.here' };
      oidcMiddleware(req as Request, res as Response, next);

      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(warnSpy).toHaveBeenCalledWith(
        'OIDC token validation failed:',
        expect.any(Error),
      );
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired token' });
      expect(next).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should return 401 when JWT payload is missing the sub claim', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);
      (mockJose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { email: 'user@example.com' },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();
      warnSpy.mockRestore();

      req.headers = { authorization: 'Bearer valid.jwt.token' };
      oidcMiddleware(req as Request, res as Response, next);

      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: 'Token missing required sub claim' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next and attach oidcUser when JWT is valid', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);
      (mockJose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'user-123',
          email: 'user@example.com',
          preferred_username: 'testuser',
          groups: ['admin', 'users'],
        },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();
      warnSpy.mockRestore();

      req.headers = { authorization: 'Bearer valid.jwt.token' };
      oidcMiddleware(req as Request, res as Response, next);

      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(next).toHaveBeenCalled();
      expect((req as Request).oidcUser).toEqual({
        sub: 'user-123',
        email: 'user@example.com',
        preferred_username: 'testuser',
        groups: ['admin', 'users'],
      });
    });

    it('should handle optional claims (email, preferred_username, groups) being absent', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus/';
      process.env.OIDC_CLIENT_ID = 'test-client';

      (mockIssuer.discover as jest.Mock).mockResolvedValue({
        metadata: {
          issuer: 'https://auth.example.com',
          jwks_uri: 'https://auth.example.com/jwks/',
        },
      });

      const mockJwksFunc = jest.fn();
      (mockJose.createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwksFunc);
      (mockJose.jwtVerify as jest.Mock).mockResolvedValue({
        payload: { sub: 'user-456' },
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initOidc();
      warnSpy.mockRestore();

      req.headers = { authorization: 'Bearer valid.jwt.token' };
      oidcMiddleware(req as Request, res as Response, next);

      await new Promise((resolve) => { setTimeout(resolve, 10); });

      expect(next).toHaveBeenCalled();
      expect((req as Request).oidcUser).toEqual({
        sub: 'user-456',
        email: undefined,
        preferred_username: undefined,
        groups: undefined,
      });
    });
  });
});
