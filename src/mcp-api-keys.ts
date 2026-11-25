import crypto from 'crypto';
import { getPool } from './db';
import logger from './logger';

const keysLogger = logger.child({ subsystem: 'mcp-api-keys' });

/** Every MCP API key starts with this prefix: `fhmcp_<publicId>_<secret>`. */
export const MCP_API_KEY_PREFIX = 'fhmcp_';
const KEY_PATTERN = /^fhmcp_([0-9a-f]{16})_([0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_LABEL_LENGTH = 100;

export type McpApiKeyScope = 'read' | 'full';

export interface McpApiKey {
  id: string;
  public_id: string;
  label: string;
  owner_sub: string;
  owner_issuer: string | null;
  owner_username: string;
  scope: McpApiKeyScope;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by_sub: string | null;
}

const PUBLIC_COLUMNS = `id, public_id, label, owner_sub, owner_issuer, owner_username, scope,
  created_at, expires_at, last_used_at, revoked_at, created_by_sub`;

/** Kill switch: MCP API key authentication is off unless explicitly enabled. */
export function isMcpApiKeysEnabled(): boolean {
  return ['true', '1', 'yes'].includes((process.env.MCP_API_KEYS_ENABLED || '').trim().toLowerCase());
}

export function isMcpApiKeyToken(token: string): boolean {
  return token.startsWith(MCP_API_KEY_PREFIX);
}

/** Public id of a well-formed key (safe to log), otherwise null. */
export function mcpApiKeyPublicId(token: string): string | null {
  return KEY_PATTERN.exec(token)?.[1] ?? null;
}

export function isMcpApiKeyScope(value: unknown): value is McpApiKeyScope {
  return value === 'read' || value === 'full';
}

export function hashMcpApiKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateMcpApiKey(): { key: string; publicId: string } {
  const publicId = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  return { key: `${MCP_API_KEY_PREFIX}${publicId}_${secret}`, publicId };
}

/**
 * Validates a presented key. Fails closed (returns null) on malformed keys,
 * unknown/revoked/expired keys, hash mismatch, or database errors.
 */
export async function validateMcpApiKey(token: string, now: Date = new Date()): Promise<McpApiKey | null> {
  const publicId = mcpApiKeyPublicId(token);
  if (!publicId) return null;
  const pool = getPool();
  if (!pool) return null;
  let row: (McpApiKey & { key_hash: string }) | undefined;
  try {
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS}, key_hash FROM mcp_api_keys WHERE public_id = $1`,
      [publicId],
    );
    [row] = result.rows;
  } catch (err) {
    keysLogger.error({ err, publicId }, 'MCP API key lookup failed');
    return null;
  }
  if (!row) return null;
  const { key_hash: keyHash, ...key } = row;
  const presented = Buffer.from(hashMcpApiKey(token), 'hex');
  const stored = Buffer.from(String(keyHash), 'hex');
  if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) return null;
  if (key.revoked_at) return null;
  if (key.expires_at && new Date(key.expires_at).getTime() <= now.getTime()) return null;
  if (!isMcpApiKeyScope(key.scope)) return null;

  pool.query('UPDATE mcp_api_keys SET last_used_at = NOW() WHERE id = $1', [key.id])
    .catch((err) => keysLogger.error({ err, publicId }, 'Failed to update MCP API key last_used_at'));

  return key;
}

export interface CreateMcpApiKeyInput {
  label: string;
  scope: McpApiKeyScope;
  ownerSub: string;
  ownerIssuer?: string | null;
  ownerUsername: string;
  expiresAt?: Date | null;
  createdBySub?: string | null;
}

/**
 * Validates label/scope/expiry input. Returns an error message or null.
 */
export function validateMcpApiKeyInput(
  input: { label?: unknown; scope?: unknown; expiresAt?: unknown },
  now: Date = new Date(),
): { error: string } | { label: string; scope: McpApiKeyScope; expiresAt: Date | null } {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > MAX_LABEL_LENGTH) {
    return { error: `label is required (max ${MAX_LABEL_LENGTH} characters)` };
  }
  if (!isMcpApiKeyScope(input.scope)) return { error: 'scope must be "read" or "full"' };
  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== '') {
    if (typeof input.expiresAt !== 'string') return { error: 'expiresAt must be an ISO 8601 timestamp' };
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { error: 'expiresAt must be an ISO 8601 timestamp' };
    if (expiresAt.getTime() <= now.getTime()) return { error: 'expiresAt must be in the future' };
  }
  return { label, scope: input.scope, expiresAt };
}

/** Creates a key. The raw key is returned once and only its hash is stored. */
export async function createMcpApiKey(input: CreateMcpApiKeyInput): Promise<{ key: string; record: McpApiKey }> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  const { key, publicId } = generateMcpApiKey();
  const result = await pool.query(
    `INSERT INTO mcp_api_keys
      (public_id, key_hash, label, owner_sub, owner_issuer, owner_username, scope, expires_at, created_by_sub)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      publicId,
      hashMcpApiKey(key),
      input.label,
      input.ownerSub,
      input.ownerIssuer ?? null,
      input.ownerUsername,
      input.scope,
      input.expiresAt ?? null,
      input.createdBySub ?? null,
    ],
  );
  keysLogger.info({ publicId, scope: input.scope, ownerSub: input.ownerSub }, 'MCP API key created');
  return { key, record: result.rows[0] };
}

/** Lists keys (never hashes), optionally restricted to one owner. */
export async function listMcpApiKeys(ownerSub?: string): Promise<McpApiKey[]> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  const result = ownerSub
    ? await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM mcp_api_keys WHERE owner_sub = $1 ORDER BY created_at DESC`,
      [ownerSub],
    )
    : await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM mcp_api_keys ORDER BY created_at DESC`);
  return result.rows;
}

/**
 * Revokes a key by UUID id or public id. When ownerSub is provided only that
 * owner's key can be revoked. Returns the revoked key or null if not found.
 */
export async function revokeMcpApiKey(identifier: string, ownerSub?: string): Promise<McpApiKey | null> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  const column = UUID_PATTERN.test(identifier) ? 'id' : 'public_id';
  const values: string[] = [identifier];
  let ownerClause = '';
  if (ownerSub) {
    values.push(ownerSub);
    ownerClause = ' AND owner_sub = $2';
  }
  const result = await pool.query(
    `UPDATE mcp_api_keys SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE ${column} = $1${ownerClause}
     RETURNING ${PUBLIC_COLUMNS}`,
    values,
  );
  const record = result.rows[0] as McpApiKey | undefined;
  if (record) keysLogger.info({ publicId: record.public_id }, 'MCP API key revoked');
  return record ?? null;
}
