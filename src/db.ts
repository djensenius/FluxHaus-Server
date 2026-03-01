import { Pool } from 'pg';
import logger from './logger';

const dbLogger = logger.child({ subsystem: 'db' });

let pool: Pool | null = null;

export function getPool(): Pool | null {
  return pool;
}

export function initPool(): void {
  if (!process.env.POSTGRES_URL) {
    dbLogger.warn('POSTGRES_URL not set — PostgreSQL disabled');
    return;
  }
  pool = new Pool({ connectionString: process.env.POSTGRES_URL });
  pool.on('error', (err) => {
    dbLogger.error({ err }, 'PostgreSQL pool error');
  });
}

export async function initDatabase(): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_sub TEXT,
        username TEXT,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        route TEXT NOT NULL,
        method TEXT NOT NULL,
        ip TEXT,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_username ON audit_logs (username);

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id SERIAL PRIMARY KEY,
        provider TEXT UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        id_token TEXT,
        expires_in INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    dbLogger.info('Database tables initialized');
  } catch (err) {
    dbLogger.error({ err }, 'Failed to initialize database tables');
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbLogger.info('PostgreSQL pool closed');
  }
}
