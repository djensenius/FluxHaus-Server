import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

export async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      username TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      status INTEGER,
      ip TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
