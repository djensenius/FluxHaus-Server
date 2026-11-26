import { getPool } from '../db';
import {
  createMcpApiKey, generateMcpApiKey, hashMcpApiKey, isMcpApiKeysEnabled, listMcpApiKeys,
  mcpApiKeyPublicId, normalizeMcpKeyIssuer, revokeMcpApiKey, validateMcpApiKey, validateMcpApiKeyInput,
} from '../mcp-api-keys';

vi.mock('../db', () => ({
  getPool: vi.fn(),
}));

vi.mock('../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

function row(key: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    public_id: mcpApiKeyPublicId(key),
    key_hash: hashMcpApiKey(key),
    label: 'laptop',
    owner_sub: 'user-1',
    owner_issuer: 'https://auth.example.com/',
    owner_username: 'alice',
    scope: 'read',
    created_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    created_by_sub: 'user-1',
    ...overrides,
  };
}

describe('mcp-api-keys', () => {
  let mockPool: { query: vi.Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    (getPool as vi.Mock).mockReturnValue(mockPool);
    delete process.env.MCP_API_KEYS_ENABLED;
  });

  it('generates fhmcp_<publicId>_<secret> keys with 32 random secret bytes', () => {
    const { key, publicId } = generateMcpApiKey();
    expect(key).toMatch(/^fhmcp_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(mcpApiKeyPublicId(key)).toBe(publicId);
    expect(generateMcpApiKey().key).not.toBe(key);
  });

  it('is disabled unless MCP_API_KEYS_ENABLED is truthy', () => {
    expect(isMcpApiKeysEnabled()).toBe(false);
    process.env.MCP_API_KEYS_ENABLED = 'false';
    expect(isMcpApiKeysEnabled()).toBe(false);
    process.env.MCP_API_KEYS_ENABLED = 'true';
    expect(isMcpApiKeysEnabled()).toBe(true);
  });

  describe('validateMcpApiKey', () => {
    it('rejects malformed keys without touching the database', async () => {
      expect(await validateMcpApiKey('fhmcp_nothex_abc')).toBeNull();
      expect(await validateMcpApiKey('fhmcp_')).toBeNull();
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('accepts a valid key, looks up by public id, and records last use', async () => {
      const { key, publicId } = generateMcpApiKey();
      mockPool.query.mockResolvedValueOnce({ rows: [row(key)] });
      const result = await validateMcpApiKey(key);
      expect(result).toMatchObject({ owner_sub: 'user-1', scope: 'read', public_id: publicId });
      expect(result).not.toHaveProperty('key_hash');
      expect(mockPool.query.mock.calls[0][1]).toEqual([publicId]);
      expect(mockPool.query.mock.calls[1][0]).toMatch(/SET last_used_at = NOW\(\)/);
    });

    it('rejects a wrong secret for a known public id', async () => {
      const { key } = generateMcpApiKey();
      const forged = `${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`;
      mockPool.query.mockResolvedValueOnce({ rows: [row(key)] });
      expect(await validateMcpApiKey(forged)).toBeNull();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('rejects revoked and expired keys', async () => {
      const { key } = generateMcpApiKey();
      mockPool.query.mockResolvedValueOnce({ rows: [row(key, { revoked_at: '2026-01-02T00:00:00Z' })] });
      expect(await validateMcpApiKey(key)).toBeNull();
      mockPool.query.mockResolvedValueOnce({ rows: [row(key, { expires_at: '2026-01-02T00:00:00Z' })] });
      expect(await validateMcpApiKey(key, new Date('2026-01-03T00:00:00Z'))).toBeNull();
      mockPool.query.mockResolvedValueOnce({ rows: [row(key, { expires_at: '2026-01-02T00:00:00Z' })] });
      expect(await validateMcpApiKey(key, new Date('2026-01-01T12:00:00Z'))).not.toBeNull();
    });

    it('fails closed when the database is unavailable or errors', async () => {
      const { key } = generateMcpApiKey();
      (getPool as vi.Mock).mockReturnValue(null);
      expect(await validateMcpApiKey(key)).toBeNull();
      (getPool as vi.Mock).mockReturnValue(mockPool);
      mockPool.query.mockRejectedValueOnce(new Error('db down'));
      expect(await validateMcpApiKey(key)).toBeNull();
    });
  });

  describe('validateMcpApiKeyInput', () => {
    const now = new Date('2026-01-01T00:00:00Z');

    it('accepts label, scope, and optional future expiry', () => {
      expect(validateMcpApiKeyInput({ label: ' laptop ', scope: 'full' }, now))
        .toEqual({ label: 'laptop', scope: 'full', expiresAt: null });
      expect(validateMcpApiKeyInput({ label: 'x', scope: 'read', expiresAt: '2026-02-01T00:00:00Z' }, now))
        .toEqual({ label: 'x', scope: 'read', expiresAt: new Date('2026-02-01T00:00:00Z') });
    });

    it('rejects invalid input', () => {
      expect(validateMcpApiKeyInput({ scope: 'read' }, now)).toHaveProperty('error');
      expect(validateMcpApiKeyInput({ label: 'x'.repeat(101), scope: 'read' }, now)).toHaveProperty('error');
      expect(validateMcpApiKeyInput({ label: 'x', scope: 'admin' }, now)).toHaveProperty('error');
      expect(validateMcpApiKeyInput({ label: 'x', scope: 'read', expiresAt: 'soon' }, now)).toHaveProperty('error');
      expect(validateMcpApiKeyInput({ label: 'x', scope: 'read', expiresAt: '2025-01-01T00:00:00Z' }, now))
        .toHaveProperty('error');
    });
  });

  it('creates keys storing only the hash', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'k1' }] });
    const { key, record } = await createMcpApiKey({
      label: 'laptop', scope: 'read', ownerSub: 'user-1', ownerUsername: 'alice', ownerIssuer: 'https://idp//',
    });
    expect(record).toEqual({ id: 'k1' });
    const params = mockPool.query.mock.calls[0][1];
    expect(params[4]).toBe('https://idp');
    expect(params).not.toContain(key);
    expect(params[0]).toBe(mcpApiKeyPublicId(key));
    expect(params[1]).toBe(hashMcpApiKey(key));
    expect(mockPool.query.mock.calls[0][0]).not.toMatch(/RETURNING[^;]*key_hash/);
  });

  it('normalizes issuers consistently', () => {
    expect(normalizeMcpKeyIssuer('https://idp/app/')).toBe('https://idp/app');
    expect(normalizeMcpKeyIssuer(' https://idp/app ')).toBe('https://idp/app');
    expect(normalizeMcpKeyIssuer('https://idp/app')).toBe('https://idp/app');
    expect(normalizeMcpKeyIssuer('')).toBeNull();
    expect(normalizeMcpKeyIssuer('/')).toBeNull();
    expect(normalizeMcpKeyIssuer(undefined)).toBeNull();
  });

  it('lists only the owner keys (sub + normalized issuer) without hashes', async () => {
    await listMcpApiKeys('user-1', 'https://idp/');
    expect(mockPool.query.mock.calls[0][0])
      .toMatch(/WHERE TRUE AND owner_sub = \$1 AND owner_issuer IS NOT DISTINCT FROM \$2 ORDER/);
    expect(mockPool.query.mock.calls[0][0]).not.toMatch(/key_hash/);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', 'https://idp']);
  });

  it('matches only issuer-less keys for a requester without an issuer, and all keys without an owner', async () => {
    await listMcpApiKeys('user-1');
    expect(mockPool.query.mock.calls[0][0]).toMatch(/owner_issuer IS NOT DISTINCT FROM \$2/);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', null]);
    await listMcpApiKeys();
    expect(mockPool.query.mock.calls[1][0]).toMatch(/WHERE TRUE ORDER BY/);
    expect(mockPool.query.mock.calls[1][1]).toEqual([]);
  });

  it('revokes by id scoped to the owner and issuer, or by public id', async () => {
    await revokeMcpApiKey('11111111-2222-3333-4444-555555555555', 'user-1', 'https://idp/');
    expect(mockPool.query.mock.calls[0][0])
      .toMatch(/WHERE id = \$1 AND owner_sub = \$2 AND owner_issuer IS NOT DISTINCT FROM \$3\n/);
    expect(mockPool.query.mock.calls[0][1]).toEqual(['11111111-2222-3333-4444-555555555555', 'user-1', 'https://idp']);
    await revokeMcpApiKey('11111111-2222-3333-4444-555555555555', 'user-1');
    expect(mockPool.query.mock.calls[1][1]).toEqual(['11111111-2222-3333-4444-555555555555', 'user-1', null]);
    await revokeMcpApiKey('0123456789abcdef');
    expect(mockPool.query.mock.calls[2][0]).toMatch(/WHERE public_id = \$1\n/);
    expect(mockPool.query.mock.calls[2][1]).toEqual(['0123456789abcdef']);
  });

  it('throws on management operations when the database is unavailable', async () => {
    (getPool as vi.Mock).mockReturnValue(null);
    await expect(listMcpApiKeys('user-1')).rejects.toThrow('Database not available');
    await expect(revokeMcpApiKey('x', 'user-1')).rejects.toThrow('Database not available');
  });
});
