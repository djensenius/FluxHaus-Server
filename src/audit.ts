import { pool } from './db';

export interface AuditEntry {
  id?: number;
  timestamp?: Date;
  username?: string;
  action: string;
  resource?: string;
  status?: number;
  ip?: string;
}

export interface AuditFilter {
  limit?: number;
  offset?: number;
  username?: string;
  action?: string;
  since?: Date;
}

export async function logEvent(entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (username, action, resource, status, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.username ?? null, entry.action, entry.resource ?? null, entry.status ?? null, entry.ip ?? null],
  );
}

export async function getAuditLog(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const conditions: string[] = [];
  const params: (string | number | Date)[] = [];

  if (filter.username) {
    conditions.push(`username = $${params.length + 1}`);
    params.push(filter.username);
  }
  if (filter.action) {
    conditions.push(`action = $${params.length + 1}`);
    params.push(filter.action);
  }
  if (filter.since) {
    conditions.push(`timestamp >= $${params.length + 1}`);
    params.push(filter.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;

  const result = await pool.query(
    `SELECT id, timestamp, username, action, resource, status, ip
     FROM audit_logs
     ${where}
     ORDER BY timestamp DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, limit, offset],
  );
  return result.rows;
}
