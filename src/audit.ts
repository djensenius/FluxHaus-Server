import { getPool } from './db';
import logger from './logger';

const auditLogger = logger.child({ subsystem: 'audit' });

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 1000;

export interface AuditEvent {
  user_sub?: string;
  username?: string;
  role: string;
  action: string;
  route: string;
  method: string;
  ip?: string;
  details?: Record<string, unknown>;
}

export async function logEvent(event: AuditEvent): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_sub, username, role, action, route, method, ip, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.user_sub ?? null,
        event.username ?? null,
        event.role,
        event.action,
        event.route,
        event.method,
        event.ip ?? null,
        event.details ? JSON.stringify(event.details) : null,
      ],
    );
  } catch (err) {
    auditLogger.error({ err }, 'Failed to write audit log');
  }
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  username?: string;
  action?: string;
  since?: string;
}

export async function getAuditLog(
  query: AuditQuery = {},
): Promise<unknown[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.username) {
      conditions.push(`username = $${idx}`);
      idx += 1;
      params.push(query.username);
    }
    if (query.action) {
      conditions.push(`action = $${idx}`);
      idx += 1;
      params.push(query.action);
    }
    if (query.since) {
      conditions.push(`created_at >= $${idx}`);
      idx += 1;
      params.push(query.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(query.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const offset = query.offset ?? 0;
    const limitIdx = idx;
    const offsetIdx = idx + 1;

    const result = await pool.query(
      `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, limit, offset],
    );
    return result.rows;
  } catch (err) {
    auditLogger.error({ err }, 'Failed to query audit log');
    return [];
  }
}
