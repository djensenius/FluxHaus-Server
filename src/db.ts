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

      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        title TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_user
        ON conversations (user_sub, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        is_voice BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON conversation_messages (conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS push_tokens (
        id SERIAL PRIMARY KEY,
        user_sub TEXT NOT NULL,
        device_name TEXT,
        push_token TEXT NOT NULL UNIQUE,
        activity_type TEXT NOT NULL,
        bundle_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_user
        ON push_tokens (user_sub);
      CREATE INDEX IF NOT EXISTS idx_push_tokens_activity_type
        ON push_tokens (activity_type);

      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        user_sub TEXT NOT NULL,
        device_name TEXT,
        push_to_start_token TEXT NOT NULL UNIQUE,
        bundle_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_device_tokens_user
        ON device_tokens (user_sub);

      CREATE TABLE IF NOT EXISTS live_activity_channels (
        activity_type TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        display_name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
