import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getMcpAuthConfig, getMcpSigningKey, McpConfigurationError, McpScopeError, mcpResource, verifyMcpToken } from '../mcp-auth';

describe('MCP auth token verification', () => {
  const resource = 'https://haus.example.com/mcp';

  beforeEach(() => {
    delete process.env.MCP_AUTH_MODE;
    process.env.SESSION_SECRET = 'test-secret';
  });

  describe('direct MCP OIDC verification (real asymmetric JWTs and HTTP JWKS)', () => {
    const resource = 'https://haus.example.com/mcp';
    let server: Server;
    let issuer: string;
    let keys: Awaited<ReturnType<typeof generateKeyPair>>;
    let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
    let discoveryIssuer: string;
    let discoveryStatus = 200;
    let jwksStatus = 200;
    let discoveryRequests = 0;

    beforeAll(async () => {
      keys = await generateKeyPair('RS256');
      otherKeys = await generateKeyPair('RS256');
      const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
      server = createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.endsWith('/.well-known/openid-configuration')) {
          discoveryRequests += 1;
          res.statusCode = discoveryStatus;
          res.end(JSON.stringify({ issuer: discoveryIssuer, jwks_uri: `${issuer}jwks` }));
        } else {
          res.statusCode = jwksStatus;
          res.end(JSON.stringify({ keys: [jwk] }));
        }
      });
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/application/o/mcp/`;
      discoveryIssuer = issuer;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });

    beforeEach(() => {
      process.env.MCP_AUTH_MODE = 'oidc';
      process.env.MCP_ISSUER_URL = issuer;
      process.env.MCP_RESOURCE_URL = resource;
    });

    afterEach(() => {
      delete process.env.MCP_AUTH_MODE;
      delete process.env.MCP_ISSUER_URL;
      delete process.env.MCP_RESOURCE_URL;
      discoveryIssuer = issuer;
      discoveryStatus = 200;
      jwksStatus = 200;
    });

    async function accessToken(overrides: Record<string, unknown> = {}, signingKey = keys.privateKey) {
      return new SignJWT({
        iss: issuer, aud: resource, sub: 'account-1',
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: 'openid fluxhaus:mcp offline_access',
        email: 'one@example.com', name: 'Account One',
        ...overrides,
      }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
    }

    it('accepts a dedicated access JWT and caches exact-issuer discovery/JWKS', async () => {
      const jwt = await accessToken();
      await expect(verifyMcpToken(jwt, 'https://attacker.example/mcp')).resolves.toEqual({
        sub: 'account-1', email: 'one@example.com', name: 'Account One',
        preferred_username: undefined, oidcIssuer: issuer,
      });
      await expect(verifyMcpToken(jwt, resource)).resolves.toMatchObject({ sub: 'account-1' });
      expect(discoveryRequests).toBe(1);
    });

    it('accepts actual IPv6 loopback HTTP issuer and resource configuration', () => {
      process.env.MCP_ISSUER_URL = 'http://[::1]:8888/application/o/mcp/';
      process.env.MCP_RESOURCE_URL = 'http://[::1]:8888/mcp';
      expect(new URL(process.env.MCP_ISSUER_URL).hostname).toBe('[::1]');
      expect(getMcpAuthConfig()).toEqual({
        mode: 'oidc', issuer: process.env.MCP_ISSUER_URL, resource: process.env.MCP_RESOURCE_URL,
      });
    });

    it('uses the resolved direct config for both resource and verification without reparsing', async () => {
      const config = getMcpAuthConfig();
      const jwt = await accessToken();
      process.env.MCP_AUTH_MODE = 'invalid-after-resolution';
      const req = { protocol: 'http', get: () => 'attacker.example' };
      expect(mcpResource(req, config)).toBe(resource);
      await expect(verifyMcpToken(jwt, mcpResource(req, config), config))
        .resolves.toMatchObject({ sub: 'account-1', oidcIssuer: issuer });
      await expect(verifyMcpToken(jwt, resource)).rejects.toBeInstanceOf(McpConfigurationError);
    });

    it.each([
      { iss: 'https://synthbook.example/issuer/' },
      { iss: undefined },
      { aud: 'claude-client-id' }, // ID tokens with the public client audience
      { aud: undefined },
      { exp: 1 },
      { exp: undefined },
      { sub: undefined },
      { sub: '' },
      { sub: '   ' },
      { sub: 42 },
    ])('rejects wrong or missing identity claims (%j)', async (claims) => {
      await expect(verifyMcpToken(await accessToken(claims), resource)).resolves.toBeNull();
    });

    it.each([undefined, '', 'read', 'fluxhaus:mcp:read', ['fluxhaus:mcp'], 'openid\tfluxhaus:mcp'])(
      'rejects insufficient/non-space-delimited scope (%j)', async (scope) => {
        await expect(verifyMcpToken(await accessToken({ scope }), resource)).rejects.toBeInstanceOf(McpScopeError);
      },
    );

    it('rejects invalid signatures, unsigned, opaque and self-issued proxy tokens', async () => {
      const badSignature = await accessToken({}, otherKeys.privateKey);
      const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({
        iss: issuer, aud: resource, sub: 'account-1', scope: 'fluxhaus:mcp', exp: 9999999999,
      })).toString('base64url')}.`;
      const proxy = await new SignJWT({ type: 'mcp', scope: 'fluxhaus:mcp' })
        .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience(resource)
        .setSubject('account-1').setExpirationTime('1h').sign(getMcpSigningKey());
      for (const jwt of [badSignature, unsigned, proxy, 'opaque', 'mock-token']) {
        await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
      }
    });

    it('requires exact discovery issuer including slash and retries rejected lookups', async () => {
      const retryIssuer = `${issuer}retry/`;
      process.env.MCP_ISSUER_URL = retryIssuer;
      discoveryIssuer = retryIssuer.slice(0, -1);
      const jwt = await accessToken({ iss: retryIssuer });
      await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
      discoveryIssuer = retryIssuer;
      discoveryStatus = 503;
      await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
      discoveryStatus = 200;
      await expect(verifyMcpToken(jwt, resource)).resolves.toMatchObject({ sub: 'account-1', oidcIssuer: retryIssuer });
    });

    it('preserves an issuer at an origin without adding a slash', async () => {
      const rootIssuer = new URL(issuer).origin;
      process.env.MCP_ISSUER_URL = rootIssuer;
      discoveryIssuer = rootIssuer;
      expect(getMcpAuthConfig()).toEqual({ mode: 'oidc', issuer: rootIssuer, resource });
      await expect(verifyMcpToken(await accessToken({ iss: rootIssuer }), resource))
        .resolves.toMatchObject({ sub: 'account-1', oidcIssuer: rootIssuer });
    });

    it('retries a failed JWKS fetch without retaining a rejected lookup promise', async () => {
      const retryIssuer = `${issuer}jwks-retry/`;
      process.env.MCP_ISSUER_URL = retryIssuer;
      discoveryIssuer = retryIssuer;
      const jwt = await accessToken({ iss: retryIssuer });
      jwksStatus = 503;
      await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
      jwksStatus = 200;
      await expect(verifyMcpToken(jwt, resource)).resolves.toMatchObject({ sub: 'account-1' });
    });

    it.each([
      ['MCP_AUTH_MODE', 'unknown'],
      ['MCP_ISSUER_URL', undefined],
      ['MCP_ISSUER_URL', 'not a url'],
      ['MCP_ISSUER_URL', 'https://user:pass@auth.example/'],
      ['MCP_ISSUER_URL', 'https://auth.example/?query=secret'],
      ['MCP_ISSUER_URL', 'https://auth.example/#fragment'],
      ['MCP_ISSUER_URL', 'http://auth.example/'],
      ['MCP_RESOURCE_URL', undefined],
      ['MCP_RESOURCE_URL', 'https://haus.example/MCP'],
      ['MCP_RESOURCE_URL', 'https://haus.example/mcp/'],
      ['MCP_RESOURCE_URL', 'https://haus.example/other/../mcp'],
      ['MCP_RESOURCE_URL', 'https://haus.example/mcp?'],
      ['MCP_RESOURCE_URL', 'https://haus.example/mcp#'],
    ])('fails closed for invalid %s=%s', async (name, value) => {
      if (value === undefined) delete process.env[name as string];
      else process.env[name as string] = value;
      expect(() => getMcpAuthConfig()).toThrow(McpConfigurationError);
      await expect(verifyMcpToken('any', resource)).rejects.toBeInstanceOf(McpConfigurationError);
    });
  });

  async function token(claims: Record<string, unknown>, issuer = 'https://haus.example.com', audience = resource) {
    return new SignJWT({ sub: 'user-1', type: 'mcp', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(getMcpSigningKey());
  }

  it('accepts MCP tokens with matching issuer and audience', async () => {
    const jwt = await token({ email: 'user@example.com' });
    await expect(verifyMcpToken(jwt, resource)).resolves.toEqual({
      sub: 'user-1',
      email: 'user@example.com',
      preferred_username: undefined,
    });
  });

  it('uses the resolved proxy config and preserves request-bound audience verification', async () => {
    const config = getMcpAuthConfig();
    const jwt = await token({});
    process.env.MCP_AUTH_MODE = 'invalid-after-resolution';
    try {
      const req = { protocol: 'https', get: () => 'haus.example.com' };
      expect(mcpResource(req, config)).toBe(resource);
      await expect(verifyMcpToken(jwt, mcpResource(req, config), config)).resolves.toMatchObject({ sub: 'user-1' });
      await expect(verifyMcpToken(jwt, 'https://attacker.example/mcp', config)).resolves.toBeNull();
      await expect(verifyMcpToken(jwt, resource)).rejects.toBeInstanceOf(McpConfigurationError);
    } finally {
      delete process.env.MCP_AUTH_MODE;
    }
  });

  it('returns the recorded OIDC issuer claim when present', async () => {
    const jwt = await token({ oidc_iss: 'https://auth.example.com/application/o/fluxhaus/' });
    await expect(verifyMcpToken(jwt, resource)).resolves.toMatchObject({
      sub: 'user-1',
      oidcIssuer: 'https://auth.example.com/application/o/fluxhaus/',
    });
  });

  it('leaves the OIDC issuer undefined for tokens minted without one', async () => {
    const jwt = await token({ oidc_iss: 42 });
    const claims = await verifyMcpToken(jwt, resource);
    expect(claims?.sub).toBe('user-1');
    expect(claims?.oidcIssuer).toBeUndefined();
  });

  it('rejects tokens with the wrong audience', async () => {
    const jwt = await token({}, 'https://haus.example.com', 'https://haus.example.com/other');
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });

  it('rejects tokens with the wrong issuer', async () => {
    const jwt = await token({}, 'https://evil.example.com', resource);
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });

  it('rejects tokens without MCP type', async () => {
    const jwt = await token({ type: 'session' });
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });
});
