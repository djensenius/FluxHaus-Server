import crypto from 'crypto';
import { getPool } from './db';
import logger from './logger';

const webhookLogger = logger.child({ subsystem: 'webhooks' });

export interface WebhookToken {
  id: string;
  user_sub: string;
  name: string;
  token_hash: string;
  scopes: string[];
  last_used_at: string | null;
  enabled: boolean;
  created_at: string;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return `fh_${crypto.randomBytes(32).toString('hex')}`;
}

export async function validateToken(token: string): Promise<WebhookToken | null> {
  const pool = getPool();
  if (!pool) return null;

  const hash = hashToken(token);
  const result = await pool.query(
    'SELECT * FROM webhook_tokens WHERE token_hash = $1 AND enabled = true',
    [hash],
  );

  if (result.rows.length === 0) return null;

  const webhook = result.rows[0] as WebhookToken;

  // Update last_used_at (fire-and-forget)
  pool.query(
    'UPDATE webhook_tokens SET last_used_at = NOW() WHERE id = $1',
    [webhook.id],
  ).catch((err) => {
    webhookLogger.error({ err }, 'Failed to update webhook last_used_at');
  });

  return webhook;
}

export function hasScope(webhook: WebhookToken, scope: string): boolean {
  const scopes = Array.isArray(webhook.scopes) ? webhook.scopes : [];
  return scopes.includes('*') || scopes.includes(scope);
}

// ── CRUD helpers ──

export async function listTokens(userSub?: string): Promise<Omit<WebhookToken, 'token_hash'>[]> {
  const pool = getPool();
  if (!pool) return [];
  const query = userSub
    ? {
      text: `SELECT id, user_sub, name, scopes, last_used_at, enabled, created_at
        FROM webhook_tokens
        WHERE user_sub = $1
        ORDER BY created_at DESC`,
      values: [userSub],
    }
    : {
      text: `SELECT id, user_sub, name, scopes, last_used_at, enabled, created_at
        FROM webhook_tokens
        ORDER BY created_at DESC`,
      values: [],
    };
  const result = await pool.query(query.text, query.values);
  return result.rows;
}

export async function createToken(
  data: { user_sub: string; name: string; scopes?: string[] },
): Promise<{ token: string; webhook: Omit<WebhookToken, 'token_hash'> }> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const token = generateToken();
  const hash = hashToken(token);

  const result = await pool.query(
    `INSERT INTO webhook_tokens (user_sub, name, token_hash, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_sub, name, scopes, last_used_at, enabled, created_at`,
    [data.user_sub, data.name, hash, JSON.stringify(data.scopes || ['command'])],
  );

  webhookLogger.info({ name: data.name, userSub: data.user_sub }, 'Webhook token created');

  return { token, webhook: result.rows[0] };
}

export async function deleteToken(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM webhook_tokens WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function toggleToken(id: string, enabled: boolean): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    'UPDATE webhook_tokens SET enabled = $1 WHERE id = $2',
    [enabled, id],
  );
  return (result.rowCount ?? 0) > 0;
}
