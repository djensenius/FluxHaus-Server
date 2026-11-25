import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { decodeJwt } from 'jose';
import createMcpOAuthRouter from '../mcp-oauth.routes';
import { getOidcIssuer } from '../../middleware/oidc.middleware';

vi.mock('../../middleware/oidc.middleware', () => ({
  getOidcIssuer: vi.fn(),
}));

function app() {
  const application = express();
  application.use(express.json());
  application.use(express.urlencoded({ extended: true }));
  application.use(createMcpOAuthRouter());
  return application;
}

describe('MCP OAuth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MCP_AUTH_MODE;
    delete process.env.MCP_ISSUER_URL;
    delete process.env.MCP_RESOURCE_URL;
    process.env.OIDC_CLIENT_ID = 'oidc-client';
    (getOidcIssuer as vi.Mock).mockReturnValue({
      metadata: {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
    });
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

  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'publishes canonical direct metadata independent of Host at %s', async (path) => {
      directMode();
      const res = await request(app()).get(path).set('Host', 'attacker.example')
        .set('X-Forwarded-Host', 'other.example').set('X-Forwarded-Proto', 'http').expect(200);
      expect(res.body).toEqual({
        resource: 'https://haus.example.com/mcp',
        authorization_servers: ['https://auth.example.com/application/o/fluxhaus-mcp/'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['fluxhaus:mcp'],
      });
    },
  );

  it.each([
    ['get', '/.well-known/oauth-authorization-server'],
    ['post', '/register'],
    ['get', '/authorize'],
    ['post', '/token'],
    ['get', '/oauth/mcp-callback'],
  ])('disables local proxy %s %s in direct mode', async (method, path) => {
    directMode();
    const application = request(app());
    const res = method === 'get' ? await application.get(path) : await application.post(path).send({});
    expect(res.status).toBe(404);
    expect(getOidcIssuer).not.toHaveBeenCalled();
  });

  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/authorize'])(
    'returns a sanitized 503 for invalid direct configuration at %s', async (path) => {
      directMode();
      process.env.MCP_ISSUER_URL = 'https://user:secret@auth.example/';
      await request(app()).get(path).expect(503).expect(({ body }) => {
        expect(body).toEqual({ error: 'MCP authentication not configured' });
      });
    },
  );

  it('publishes MCP protected resource metadata for /mcp', async () => {
    const res = await request(app())
      .get('/.well-known/oauth-protected-resource/mcp')
      .set('Host', 'haus.example.com')
      .expect(200);
    expect(res.body).toEqual({
      resource: 'http://haus.example.com/mcp',
      authorization_servers: ['http://haus.example.com'],
      bearer_methods_supported: ['header'],
    });
  });

  it('accepts dynamic client registration for loopback redirects with a port', async () => {
    const res = await request(app())
      .post('/register')
      .send({ redirect_uris: ['http://localhost:6274/callback'] })
      .expect(201);
    expect(res.body.client_id).toMatch(/^mcp-client-/);
    expect(res.body.redirect_uris).toEqual(['http://localhost:6274/callback']);
  });

  it('rejects dynamic client registration for untrusted remote redirects', async () => {
    await request(app())
      .post('/register')
      .send({ redirect_uris: ['https://evil.example.com/callback'] })
      .expect(400);
  });

  it('rejects authorize requests for unknown clients before redirecting to OIDC', async () => {
    await request(app())
      .get('/authorize')
      .query({
        client_id: 'unknown',
        redirect_uri: 'http://localhost:6274/callback',
        state: 'state',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('invalid_client'));
  });

  it('rejects tampered signed client IDs without a server error', async () => {
    const registered = await request(app())
      .post('/register')
      .send({ redirect_uris: ['http://localhost:6274/callback'] })
      .expect(201);
    const tamperedClientId = `${registered.body.client_id.slice(0, -4)}bad`;

    await request(app())
      .get('/authorize')
      .query({
        client_id: tamperedClientId,
        redirect_uri: 'http://localhost:6274/callback',
        state: 'state',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('invalid_client'));
  });

  it('rejects non-S256 PKCE after client registration', async () => {
    const registered = await request(app())
      .post('/register')
      .send({ redirect_uris: ['http://localhost:6274/callback'] })
      .expect(201);

    await request(app())
      .get('/authorize')
      .query({
        client_id: registered.body.client_id,
        redirect_uri: 'http://localhost:6274/callback',
        state: 'state',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'plain',
      })
      .expect(400)
      .expect(({ body }) => expect(body.error).toBe('invalid_request'));
  });

  describe('records the original OIDC issuer in minted MCP tokens', () => {
    const ISSUER = 'https://auth.example.com/application/o/fluxhaus/';
    const redirectUri = 'http://localhost:6274/callback';
    const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
    const unsignedJwt = (claims: Record<string, unknown>) => (
      `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.`
    );
    const originalFetch = global.fetch;

    beforeEach(() => {
      process.env.SESSION_SECRET = 'test-session-secret';
      (getOidcIssuer as vi.Mock).mockReturnValue({
        metadata: {
          issuer: ISSUER,
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        },
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.SESSION_SECRET;
    });

    async function mintToken(idTokenIss: string) {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'upstream-access',
          id_token: unsignedJwt({ sub: 'user-1', iss: idTokenIss, email: 'u@example.com' }),
        }),
      }) as never;
      const application = app();
      const registered = await request(application)
        .post('/register')
        .send({ redirect_uris: [redirectUri] })
        .expect(201);
      const clientId = registered.body.client_id;
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

      const authorize = await request(application)
        .get('/authorize')
        .query({
          client_id: clientId,
          redirect_uri: redirectUri,
          state: 'client-state',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        .expect(302);
      const internalState = new URL(authorize.headers.location).searchParams.get('state');

      const callback = await request(application)
        .get('/oauth/mcp-callback')
        .query({ code: 'upstream-code', state: internalState })
        .expect(302);
      const code = new URL(callback.headers.location).searchParams.get('code');

      const token = await request(application)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: redirectUri,
        })
        .expect(200);
      return decodeJwt(token.body.access_token);
    }

    it('mints oidc_iss when the id_token iss matches the issuer', async () => {
      const claims = await mintToken(ISSUER);
      expect(claims.sub).toBe('user-1');
      expect(claims.oidc_iss).toBe(ISSUER);
    });

    it('omits oidc_iss when the id_token iss does not match', async () => {
      const claims = await mintToken('https://auth.example.com/application/o/other/');
      expect(claims.sub).toBe('user-1');
      expect(claims.oidc_iss).toBeUndefined();
    });
  });
});
