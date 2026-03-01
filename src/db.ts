import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

export async function initDatabase(): Promise<void> {
  if (!process.env.POSTGRES_URL) {
    throw new Error('POSTGRES_URL environment variable is not set');
  }
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
}

export async function closePool(): Promise<void> {
  await pool.end();
}
