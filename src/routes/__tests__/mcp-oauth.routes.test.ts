import express from 'express';
import request from 'supertest';
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
    process.env.OIDC_CLIENT_ID = 'oidc-client';
    (getOidcIssuer as vi.Mock).mockReturnValue({
      metadata: {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      },
    });
  });

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
});
