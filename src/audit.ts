import { pool } from './db';

export interface AuditLogEntry {
  id: number;
  userSub?: string;
  username: string;
  role: string;
  action: string;
  route: string;
  method: string;
  ip?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

export interface LogEventOptions {
  userSub?: string;
  username: string;
  role: string;
  action: string;
  route: string;
  method: string;
  ip?: string;
  details?: Record<string, unknown>;
}

export async function logEvent(event: LogEventOptions): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (user_sub, username, role, action, route, method, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      event.userSub ?? null,
      event.username,
      event.role,
      event.action,
      event.route,
      event.method,
      event.ip ?? null,
      event.details ? JSON.stringify(event.details) : null,
    ],
  );
}

export interface GetAuditLogOptions {
  limit?: number;
  offset?: number;
  username?: string;
  action?: string;
  since?: Date;
}

export async function getAuditLog(options: GetAuditLogOptions = {}): Promise<AuditLogEntry[]> {
  const {
    limit = 50,
    offset = 0,
    username,
    action,
    since,
  } = options;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (username) {
    conditions.push(`username = $${idx}`);
    values.push(username);
    idx += 1;
  }
  if (action) {
    conditions.push(`action = $${idx}`);
    values.push(action);
    idx += 1;
  }
  if (since) {
    conditions.push(`created_at >= $${idx}`);
    values.push(since);
    idx += 1;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(limit, 500);

  values.push(safeLimit, offset);

  const result = await pool.query(
    `SELECT id, user_sub, username, role, action, route, method, ip, details, created_at
     FROM audit_logs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    values,
  );

  return result.rows.map((row) => ({
    id: row.id,
    userSub: row.user_sub ?? undefined,
    username: row.username,
    role: row.role,
    action: row.action,
    route: row.route,
    method: row.method,
    ip: row.ip ?? undefined,
    details: row.details ?? undefined,
    createdAt: row.created_at,
  }));
}
