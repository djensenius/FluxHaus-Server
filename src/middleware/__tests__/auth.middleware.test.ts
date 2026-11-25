import { NextFunction, Request, Response } from 'express';
import { generateKeyPair, SignJWT } from 'jose';
import { authMiddleware, requireOidcForMutations, requireRole } from '../auth.middleware';
import { validateBearerToken } from '../oidc.middleware';
import { getMcpAuthConfig, McpScopeError, mcpResource, verifyMcpToken } from '../../mcp-auth';
import { validateMcpApiKey } from '../../mcp-api-keys';

const authLog = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../../logger', () => ({
  __esModule: true,
  default: { child: () => authLog },
}));

vi.mock('../../mcp-api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-api-keys')>();
  return { ...actual, validateMcpApiKey: vi.fn().mockResolvedValue(null) };
});

const API_KEY = `fhmcp_0123456789abcdef_${'a'.repeat(64)}`;

vi.mock('../oidc.middleware', () => ({
  validateBearerToken: vi.fn(),
  isOidcEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../../mcp-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-auth')>();
  return {
    ...actual,
    getMcpAuthConfig: vi.fn(actual.getMcpAuthConfig),
    verifyMcpToken: vi.fn().mockResolvedValue(null),
    mcpResource: vi.fn(actual.mcpResource),
    serverOrigin: vi.fn().mockReturnValue('http://localhost:8888'),
  };
});

function mockReq(headers: Record<string, string> = {}, path = '/test'): Partial<Request> {
  return { headers, path, protocol: 'http', get: (name: string) => headers[name] || 'localhost:8888' } as Partial<Request>;
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
    (validateMcpApiKey as vi.Mock).mockResolvedValue(null);
    delete process.env.MCP_API_KEYS_ENABLED;
    process.env.BASIC_AUTH_PASSWORD = 'adminpass';
    process.env.RHIZOME_PASSWORD = 'rhizomepass';
    process.env.DEMO_PASSWORD = 'demopass';
    delete process.env.MCP_AUTH_MODE;
    delete process.env.MCP_ISSUER_URL;
    delete process.env.MCP_RESOURCE_URL;
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_MODE;
    delete process.env.MCP_ISSUER_URL;
    delete process.env.MCP_RESOURCE_URL;
  });

  function directMode() {
    process.env.MCP_AUTH_MODE = 'oidc';
    process.env.MCP_ISSUER_URL = 'https://auth.example.com/application/o/fluxhaus-mcp/';
    process.env.MCP_RESOURCE_URL = 'https://haus.example.com/mcp';
  }

  it('propagates direct identity and exact issuer without using legacy validation', async () => {
    directMode();
    (verifyMcpToken as vi.Mock).mockResolvedValue({
      sub: 'account-1', name: 'Account One', email: 'one@example.com',
      oidcIssuer: process.env.MCP_ISSUER_URL,
    });
    const req = mockReq({ authorization: 'Bearer provider-token', host: 'evil.example' }, '/mcp') as Request;
    await authMiddleware(req, mockRes() as Response, next);
    expect(req.user).toEqual({
      role: 'admin', username: 'Account One', sub: 'account-1',
      email: 'one@example.com', name: 'Account One', issuer: process.env.MCP_ISSUER_URL,
    });
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(getMcpAuthConfig).toHaveBeenCalledTimes(1);
    const config = { mode: 'oidc', issuer: process.env.MCP_ISSUER_URL, resource: process.env.MCP_RESOURCE_URL };
    expect(mcpResource).toHaveBeenCalledWith(req, config);
    expect(verifyMcpToken).toHaveBeenCalledWith('provider-token', process.env.MCP_RESOURCE_URL, config);
    expect(next).toHaveBeenCalled();
  });

  it.each(['', 'Basic YWRtaW46YWRtaW5wYXNz', 'Bearer proxy-token'])(
    'excludes cookie/session/basic/proxy auth in direct mode (%s)', async (authorization) => {
      directMode();
      const req = {
        ...mockReq({ authorization }, '/MCP/'),
        signedCookies: { auth_user: JSON.stringify({ role: 'admin', username: 'admin' }) },
        session: { user: { role: 'admin', username: 'admin' } },
      } as Request;
      const res = mockRes() as Response;
      await authMiddleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Bearer resource_metadata="https://haus.example.com/.well-known/oauth-protected-resource/mcp"',
      );
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    },
  );

  it('returns 403 insufficient_scope only for a verified direct token', async () => {
    directMode();
    (verifyMcpToken as vi.Mock).mockRejectedValueOnce(new McpScopeError());
    const res = mockRes() as Response;
    await authMiddleware(mockReq({ authorization: 'Bearer no-scope' }, '/mcp') as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.setHeader).toHaveBeenLastCalledWith(
      'WWW-Authenticate',
      'Bearer resource_metadata="https://haus.example.com/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="fluxhaus:mcp"',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['bad-mode', 'oidc'])('fails closed for invalid MCP configuration (%s)', async (mode) => {
    process.env.MCP_AUTH_MODE = mode;
    const res = mockRes() as Response;
    await authMiddleware(mockReq({ authorization: 'Bearer any' }, '/mcp') as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(verifyMcpToken).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    { iss: 'https://auth.example.com/application/o/fluxhaus-mcp/', scope: 'fluxhaus:mcp' },
    { aud: 'https://haus.example.com/mcp', scope: 'read' },
    { aud: ['other', 'https://haus.example.com/mcp'] },
  ])('denies dedicated JWT claims on REST before accepting legacy userinfo (%j)', async (claims) => {
    directMode();
    (validateBearerToken as vi.Mock).mockResolvedValue({ sub: 'would-be-admin' });
    // Intentionally unsigned with missing/insufficient claims: decoding can only deny.
    const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.invalid`;
    const req = mockReq({ authorization: `Bearer ${token}` }, '/startCar') as Request;
    const res = mockRes() as Response;
    await authMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('denies a signed dedicated access token on REST even when proxy mode is restored', async () => {
    directMode();
    process.env.MCP_AUTH_MODE = 'proxy';
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ scope: 'fluxhaus:mcp' })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('account-1')
      .setIssuer(process.env.MCP_ISSUER_URL as string)
      .setAudience(process.env.MCP_RESOURCE_URL as string)
      .setExpirationTime('5m').sign(privateKey);
    (validateBearerToken as vi.Mock).mockResolvedValue({ sub: 'account-1' });
    const res = mockRes() as Response;
    await authMiddleware(mockReq({ authorization: `Bearer ${token}` }, '/test') as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  describe('MCP API keys', () => {
    const keyRecord = {
      id: 'key-uuid', public_id: '0123456789abcdef', owner_sub: 'user-1', owner_issuer: 'https://idp/',
      owner_username: 'alice', scope: 'read',
    };

    function expectNoSecretLogged() {
      const logged = JSON.stringify([...authLog.warn.mock.calls, ...authLog.debug.mock.calls]);
      expect(logged).not.toContain(API_KEY);
      expect(logged).not.toContain('a'.repeat(64));
      expect(logged).not.toContain('tokenHashPrefix');
    }

    it('authenticates /mcp with a valid key when enabled, without JWT/userinfo', async () => {
      process.env.MCP_API_KEYS_ENABLED = 'true';
      (validateMcpApiKey as vi.Mock).mockResolvedValue(keyRecord);
      const req = mockReq({ authorization: `Bearer ${API_KEY}` }, '/mcp') as Request;
      await authMiddleware(req, mockRes() as Response, next);
      expect(req.user).toEqual({
        role: 'admin', username: 'alice', sub: 'user-1', issuer: 'https://idp/',
        authMethod: 'mcp_api_key', mcpAccess: 'read', mcpKeyId: 'key-uuid',
      });
      expect(validateMcpApiKey).toHaveBeenCalledWith(API_KEY);
      expect(verifyMcpToken).not.toHaveBeenCalled();
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
      expectNoSecretLogged();
    });

    it('returns 401 with the MCP challenge for an invalid key', async () => {
      process.env.MCP_API_KEYS_ENABLED = 'true';
      const res = mockRes() as Response;
      await authMiddleware(mockReq({ authorization: `Bearer ${API_KEY}` }, '/mcp') as Request, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.setHeader).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Bearer resource_metadata="http://localhost:8888/.well-known/oauth-protected-resource/mcp"',
      );
      expect(verifyMcpToken).not.toHaveBeenCalled();
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(authLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ publicId: '0123456789abcdef' }),
        'MCP API key rejected',
      );
      expectNoSecretLogged();
    });

    it('returns 401 without validating when the kill switch is off', async () => {
      (validateMcpApiKey as vi.Mock).mockResolvedValue(keyRecord);
      const res = mockRes() as Response;
      await authMiddleware(mockReq({ authorization: `Bearer ${API_KEY}` }, '/mcp') as Request, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(validateMcpApiKey).not.toHaveBeenCalled();
      expect(verifyMcpToken).not.toHaveBeenCalled();
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('denies key-prefixed bearers on REST before any validator, even when enabled', async () => {
      process.env.MCP_API_KEYS_ENABLED = 'true';
      (validateMcpApiKey as vi.Mock).mockResolvedValue(keyRecord);
      (validateBearerToken as vi.Mock).mockResolvedValue({ sub: 'user-1' });
      for (const token of [API_KEY, 'fhmcp_malformed']) {
        const res = mockRes() as Response;
        // eslint-disable-next-line no-await-in-loop
        await authMiddleware(mockReq({ authorization: `Bearer ${token}` }, '/mcp-keys') as Request, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
      }
      expect(validateMcpApiKey).not.toHaveBeenCalled();
      expect(validateBearerToken).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });
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
    expect(getMcpAuthConfig).toHaveBeenCalledTimes(1);
    expect(mcpResource).toHaveBeenCalledWith(req, { mode: 'proxy' });
    expect(verifyMcpToken).toHaveBeenCalledWith('mcp-token', 'http://localhost:8888/mcp', { mode: 'proxy' });
    expect(validateBearerToken).not.toHaveBeenCalled();
    expect(req.user).toEqual({
      role: 'admin',
      username: 'adminuser',
      sub: 'user-123',
      email: 'admin@example.com',
    });
    expect(next).toHaveBeenCalled();
  });

  it('should carry the validating issuer for OIDC bearer users', async () => {
    (validateBearerToken as vi.Mock).mockResolvedValue({
      sub: 'user-123',
      preferred_username: 'adminuser',
      issuer: 'https://auth.example.com/application/o/mobile/',
    });
    const req = mockReq({ authorization: 'Bearer valid-token' }) as Request;
    await authMiddleware(req, mockRes() as Response, next);
    expect(req.user?.issuer).toBe('https://auth.example.com/application/o/mobile/');
  });

  it('should carry the recorded OIDC issuer for MCP tokens, and none when absent', async () => {
    (verifyMcpToken as vi.Mock).mockResolvedValueOnce({
      sub: 'user-123', oidcIssuer: 'https://auth.example.com/application/o/fluxhaus/',
    });
    const withIssuer = mockReq({ authorization: 'Bearer mcp-token' }, '/mcp') as Request;
    await authMiddleware(withIssuer, mockRes() as Response, next);
    expect(withIssuer.user?.issuer).toBe('https://auth.example.com/application/o/fluxhaus/');

    (verifyMcpToken as vi.Mock).mockResolvedValueOnce({ sub: 'user-123' });
    const legacy = mockReq({ authorization: 'Bearer mcp-token' }, '/mcp') as Request;
    await authMiddleware(legacy, mockRes() as Response, next);
    expect(legacy.user?.sub).toBe('user-123');
    expect(legacy.user?.issuer).toBeUndefined();
  });

  it('should restore issuer from the signed auth cookie', async () => {
    const cookieUser = {
      role: 'admin', username: 'adminuser', sub: 'user-123', issuer: 'https://auth.example.com/application/o/fluxhaus/',
    };
    const req = {
      headers: {}, path: '/test', signedCookies: { auth_user: JSON.stringify(cookieUser) }, session: {},
    } as unknown as Request;
    await authMiddleware(req, mockRes() as Response, next);
    expect(req.user).toEqual(cookieUser);
    expect(req.session.user).toEqual(cookieUser);
  });

  it('should not set an issuer for Basic auth users', async () => {
    const encoded = Buffer.from('admin:adminpass').toString('base64');
    const req = mockReq({ authorization: `Basic ${encoded}` }) as Request;
    await authMiddleware(req, mockRes() as Response, next);
    expect(req.user).toEqual({ role: 'admin', username: 'admin' });
    expect(req.user && 'issuer' in req.user).toBe(false);
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
