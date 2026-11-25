import express from 'express';
import request from 'supertest';
import mcpKeysRouter from '../mcp-keys.routes';
import { createMcpApiKey, listMcpApiKeys, revokeMcpApiKey } from '../../mcp-api-keys';
import { logEvent } from '../../audit';
import { AuthenticatedUser } from '../../types/auth';

vi.mock('../../mcp-api-keys', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../mcp-api-keys')>(),
  createMcpApiKey: vi.fn(),
  listMcpApiKeys: vi.fn(),
  revokeMcpApiKey: vi.fn(),
}));

vi.mock('../../audit', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

const KEY_ID = '11111111-2222-3333-4444-555555555555';
const oidcUser: AuthenticatedUser = {
  role: 'admin', username: 'alice', sub: 'user-1', issuer: 'https://idp/',
};

function makeApp(user?: AuthenticatedUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(mcpKeysRouter);
  return app;
}

describe('/mcp-keys routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MCP_API_KEYS_ENABLED;
  });

  it.each([
    ['no user', undefined],
    ['Basic admin without sub', { role: 'admin', username: 'admin' }],
    ['demo user', { role: 'demo', username: 'demo', sub: 'demo-sub' }],
    ['MCP API key user', { ...oidcUser, authMethod: 'mcp_api_key', mcpAccess: 'full' }],
  ] as [string, AuthenticatedUser | undefined][])('rejects %s', async (_label, user) => {
    const app = makeApp(user);
    await request(app).get('/mcp-keys').expect(403);
    await request(app).post('/mcp-keys').send({ label: 'x', scope: 'read' }).expect(403);
    await request(app).delete(`/mcp-keys/${KEY_ID}`).expect(403);
    expect(listMcpApiKeys).not.toHaveBeenCalled();
    expect(createMcpApiKey).not.toHaveBeenCalled();
    expect(revokeMcpApiKey).not.toHaveBeenCalled();
  });

  it('lists only the caller keys', async () => {
    (listMcpApiKeys as vi.Mock).mockResolvedValue([{ id: KEY_ID, public_id: 'abc' }]);
    const res = await request(makeApp(oidcUser)).get('/mcp-keys').expect(200);
    expect(res.body).toEqual({ enabled: false, keys: [{ id: KEY_ID, public_id: 'abc' }] });
    expect(listMcpApiKeys).toHaveBeenCalledWith('user-1');
  });

  it('creates a key for the caller identity and returns the secret once', async () => {
    (createMcpApiKey as vi.Mock).mockResolvedValue({
      key: 'fhmcp_secret', record: { id: KEY_ID, public_id: 'abc', scope: 'read', label: 'laptop' },
    });
    const res = await request(makeApp(oidcUser)).post('/mcp-keys')
      .send({ label: 'laptop', scope: 'read', expiresAt: '2999-01-01T00:00:00Z' }).expect(201);
    expect(res.body).toEqual({
      id: KEY_ID, public_id: 'abc', scope: 'read', label: 'laptop', key: 'fhmcp_secret',
    });
    expect(createMcpApiKey).toHaveBeenCalledWith({
      label: 'laptop',
      scope: 'read',
      expiresAt: new Date('2999-01-01T00:00:00Z'),
      ownerSub: 'user-1',
      ownerIssuer: 'https://idp/',
      ownerUsername: 'alice',
      createdBySub: 'user-1',
    });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mcp_api_key_created', user_sub: 'user-1',
    }));
    expect(JSON.stringify((logEvent as vi.Mock).mock.calls)).not.toContain('fhmcp_secret');
  });

  it('validates create input', async () => {
    await request(makeApp(oidcUser)).post('/mcp-keys').send({ label: 'x', scope: 'admin' }).expect(400);
    await request(makeApp(oidcUser)).post('/mcp-keys').send({ scope: 'read' }).expect(400);
    expect(createMcpApiKey).not.toHaveBeenCalled();
  });

  it('revokes only the caller keys', async () => {
    (revokeMcpApiKey as vi.Mock).mockResolvedValueOnce({ id: KEY_ID, public_id: 'abc' });
    await request(makeApp(oidcUser)).delete(`/mcp-keys/${KEY_ID}`).expect(204);
    expect(revokeMcpApiKey).toHaveBeenCalledWith(KEY_ID, 'user-1');
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp_api_key_revoked' }));

    (revokeMcpApiKey as vi.Mock).mockResolvedValueOnce(null);
    await request(makeApp(oidcUser)).delete(`/mcp-keys/${KEY_ID}`).expect(404);
    await request(makeApp(oidcUser)).delete('/mcp-keys/not-a-uuid').expect(404);
    expect(revokeMcpApiKey).toHaveBeenCalledTimes(2);
  });

  it('returns 503 when the database is unavailable', async () => {
    (listMcpApiKeys as vi.Mock).mockRejectedValue(new Error('Database not available'));
    await request(makeApp(oidcUser)).get('/mcp-keys').expect(503);
  });
});
