import { runMcpKeysCli, runMcpKeysCommand } from '../mcp-keys-cli';
import { createMcpApiKey, listMcpApiKeys, revokeMcpApiKey } from '../mcp-api-keys';
import { logEvent } from '../audit';

vi.mock('../mcp-api-keys', async (importOriginal) => ({
  ...await importOriginal<typeof import('../mcp-api-keys')>(),
  createMcpApiKey: vi.fn(),
  listMcpApiKeys: vi.fn(),
  revokeMcpApiKey: vi.fn(),
}));

vi.mock('../audit', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db', () => ({
  initPool: vi.fn(),
  initDatabase: vi.fn(),
  closePool: vi.fn(),
  getPool: vi.fn(),
}));

const record = {
  id: '11111111-2222-3333-4444-555555555555',
  public_id: '0123456789abcdef',
  label: 'copilot',
  owner_sub: 'user-1',
  owner_issuer: null,
  owner_username: 'alice',
  scope: 'read',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  created_by_sub: null,
};

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
  };
}

describe('mcp-keys CLI', () => {
  const originalIssuer = process.env.OIDC_ISSUER_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OIDC_ISSUER_URL;
  });

  afterAll(() => {
    if (originalIssuer === undefined) delete process.env.OIDC_ISSUER_URL;
    else process.env.OIDC_ISSUER_URL = originalIssuer;
  });

  it('defaults the owner issuer to OIDC_ISSUER_URL for create and list', async () => {
    process.env.OIDC_ISSUER_URL = 'https://auth.example/application/o/fluxhaus/';
    (createMcpApiKey as vi.Mock).mockResolvedValue({ key: 'fhmcp_rawkey', record });
    (listMcpApiKeys as vi.Mock).mockResolvedValue([]);
    const t = io();
    expect(await runMcpKeysCommand([
      'create', '--sub', 'user-1', '--username', 'alice', '--scope', 'read', '--label', 'x',
    ], t.io)).toBe(0);
    expect(createMcpApiKey).toHaveBeenCalledWith(expect.objectContaining({
      ownerIssuer: 'https://auth.example/application/o/fluxhaus/',
    }));
    expect(await runMcpKeysCommand(['list', '--sub', 'user-1'], t.io)).toBe(0);
    expect(listMcpApiKeys).toHaveBeenCalledWith('user-1', 'https://auth.example/application/o/fluxhaus/');
    expect(await runMcpKeysCommand(['list', '--sub', 'user-1', '--issuer', 'https://other/'], t.io)).toBe(0);
    expect(listMcpApiKeys).toHaveBeenLastCalledWith('user-1', 'https://other/');
  });

  it('creates a key for a given owner and prints it once', async () => {
    (createMcpApiKey as vi.Mock).mockResolvedValue({ key: 'fhmcp_rawkey', record });
    const t = io();
    const code = await runMcpKeysCommand([
      'create', '--sub', 'user-1', '--username', 'alice', '--issuer', 'https://idp/',
      '--scope', 'read', '--label', 'copilot', '--expires', '2999-01-01T00:00:00Z',
    ], t.io);
    expect(code).toBe(0);
    expect(createMcpApiKey).toHaveBeenCalledWith({
      label: 'copilot',
      scope: 'read',
      expiresAt: new Date('2999-01-01T00:00:00Z'),
      ownerSub: 'user-1',
      ownerIssuer: 'https://idp/',
      ownerUsername: 'alice',
      createdBySub: null,
    });
    expect(t.out.filter((l) => l === 'fhmcp_rawkey')).toHaveLength(1);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp_api_key_created' }));
    expect(JSON.stringify((logEvent as vi.Mock).mock.calls)).not.toContain('fhmcp_rawkey');
  });

  it('validates create arguments', async () => {
    const t = io();
    expect(await runMcpKeysCommand(['create', '--sub', 'user-1', '--scope', 'read', '--label', 'x'], t.io)).toBe(2);
    expect(await runMcpKeysCommand([
      'create', '--sub', 'user-1', '--username', 'a', '--scope', 'admin', '--label', 'x',
    ], t.io)).toBe(2);
    expect(createMcpApiKey).not.toHaveBeenCalled();
  });

  it('lists keys', async () => {
    (listMcpApiKeys as vi.Mock).mockResolvedValue([record]);
    const t = io();
    expect(await runMcpKeysCommand(['list', '--sub', 'user-1'], t.io)).toBe(0);
    expect(listMcpApiKeys).toHaveBeenCalledWith('user-1', undefined);
    expect(t.out[1]).toContain('0123456789abcdef');
    expect(t.out[1]).toContain('active');
  });

  it('revokes keys by id or public id', async () => {
    (revokeMcpApiKey as vi.Mock).mockResolvedValueOnce({ ...record, revoked_at: '2026-01-02T00:00:00Z' });
    const t = io();
    expect(await runMcpKeysCommand(['revoke', '0123456789abcdef'], t.io)).toBe(0);
    expect(revokeMcpApiKey).toHaveBeenCalledWith('0123456789abcdef');
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'mcp_api_key_revoked' }));
    (revokeMcpApiKey as vi.Mock).mockResolvedValueOnce(null);
    expect(await runMcpKeysCommand(['revoke', 'missing'], t.io)).toBe(1);
    expect(await runMcpKeysCommand(['revoke'], t.io)).toBe(2);
  });

  it('prints help without touching the database', async () => {
    const t = io();
    expect(await runMcpKeysCli(['--help'], t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('Usage: node dist/mcp-keys.js');
  });

  it('rejects unknown commands and requires POSTGRES_URL', async () => {
    const t = io();
    expect(await runMcpKeysCommand(['explode'], t.io)).toBe(2);
    const saved = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    expect(await runMcpKeysCli(['list'], t.io)).toBe(1);
    expect(t.err).toContain('POSTGRES_URL is not set');
    if (saved !== undefined) process.env.POSTGRES_URL = saved;
  });
});
