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

      CREATE TABLE IF NOT EXISTS scheduled_routines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        name TEXT NOT NULL,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled BOOLEAN DEFAULT true,
        last_run_at TIMESTAMPTZ,
        last_result TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_routines_user
        ON scheduled_routines (user_sub);

      CREATE TABLE IF NOT EXISTS alert_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        name TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        condition_type TEXT NOT NULL,
        condition_value JSONB NOT NULL,
        message_template TEXT,
        cooldown_minutes INTEGER DEFAULT 60,
        last_triggered_at TIMESTAMPTZ,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_alert_rules_user
        ON alert_rules (user_sub);

      CREATE TABLE IF NOT EXISTS webhook_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes JSONB DEFAULT '["command"]'::jsonb,
        last_used_at TIMESTAMPTZ,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_tokens_hash
        ON webhook_tokens (token_hash);

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_sub TEXT PRIMARY KEY,
        memory_enabled BOOLEAN DEFAULT true,
        default_calendar_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS default_calendar_id TEXT;

      CREATE TABLE IF NOT EXISTS calendar_sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled BOOLEAN DEFAULT true,
        config_encrypted TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_sources_user
        ON calendar_sources (user_sub, created_at);

      CREATE TABLE IF NOT EXISTS user_memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_user_memories_user
        ON user_memories (user_sub);

      CREATE TABLE IF NOT EXISTS la_subscriptions (
        user_sub TEXT PRIMARY KEY,
        device_types JSONB NOT NULL DEFAULT '["dishwasher","washer","dryer","broombot","mopbot"]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS apns_tokens (
        id SERIAL PRIMARY KEY,
        user_sub TEXT NOT NULL,
        device_name TEXT,
        token TEXT NOT NULL UNIQUE,
        bundle_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_apns_tokens_user ON apns_tokens (user_sub);

      CREATE TABLE IF NOT EXISTS activity_tokens (
        id SERIAL PRIMARY KEY,
        user_sub TEXT NOT NULL,
        device_name TEXT,
        activity_token TEXT NOT NULL UNIQUE,
        bundle_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_activity_tokens_user ON activity_tokens (user_sub);

      CREATE TABLE IF NOT EXISTS gt3_rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        distance DOUBLE PRECISION,
        max_speed DOUBLE PRECISION,
        avg_speed DOUBLE PRECISION,
        battery_used INTEGER,
        start_battery INTEGER,
        end_battery INTEGER,
        gear_mode INTEGER,
        gps_track JSONB,
        health_data JSONB,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_gt3_rides_user ON gt3_rides (user_sub, start_time DESC);

      -- Add gear_mode column if missing (existing deployments)
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS gear_mode INTEGER;

      -- Weather data for rides
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_temp DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_feels_like DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_humidity DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_wind_speed DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_wind_direction DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_condition TEXT;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_uv_index DOUBLE PRECISION;
      ALTER TABLE gt3_rides ADD COLUMN IF NOT EXISTS weather_pressure DOUBLE PRECISION;

      CREATE TABLE IF NOT EXISTS gt3_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        battery INTEGER,
        estimated_range DOUBLE PRECISION,
        odometer DOUBLE PRECISION,
        total_runtime INTEGER,
        total_ride_time INTEGER,
        bms1_cycle_count INTEGER,
        bms2_cycle_count INTEGER,
        bms1_energy_throughput INTEGER,
        bms2_energy_throughput INTEGER,
        firmware_versions JSONB,
        settings JSONB,
        timestamp TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_gt3_snapshots_user ON gt3_snapshots (user_sub, timestamp DESC);

      -- Add columns if missing (existing tables)
      ALTER TABLE gt3_snapshots ADD COLUMN IF NOT EXISTS battery INTEGER;
      ALTER TABLE gt3_snapshots ADD COLUMN IF NOT EXISTS estimated_range DOUBLE PRECISION;

      CREATE TABLE IF NOT EXISTS gt3_samples (
        id BIGSERIAL PRIMARY KEY,
        ride_id UUID NOT NULL REFERENCES gt3_rides(id) ON DELETE CASCADE,
        timestamp TIMESTAMPTZ NOT NULL,
        speed DOUBLE PRECISION DEFAULT 0,
        battery INTEGER DEFAULT 0,
        bms_voltage DOUBLE PRECISION DEFAULT 0,
        bms_current DOUBLE PRECISION DEFAULT 0,
        bms_soc INTEGER DEFAULT 0,
        bms_temp DOUBLE PRECISION DEFAULT 0,
        body_temp DOUBLE PRECISION DEFAULT 0,
        gear_mode INTEGER DEFAULT 0,
        trip_distance DOUBLE PRECISION DEFAULT 0,
        trip_time INTEGER DEFAULT 0,
        range_estimate DOUBLE PRECISION DEFAULT 0,
        error_code INTEGER DEFAULT 0,
        warn_code INTEGER DEFAULT 0,
        regen_level INTEGER DEFAULT 0,
        speed_response INTEGER DEFAULT 0,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        altitude DOUBLE PRECISION,
        gps_speed DOUBLE PRECISION,
        gps_course DOUBLE PRECISION,
        horizontal_accuracy DOUBLE PRECISION,
        roughness_score DOUBLE PRECISION,
        max_acceleration DOUBLE PRECISION,
        heart_rate INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_gt3_samples_ride ON gt3_samples (ride_id, timestamp);

      CREATE TABLE IF NOT EXISTS gt3_ride_shares (
        token TEXT PRIMARY KEY,
        ride_id UUID NOT NULL REFERENCES gt3_rides(id) ON DELETE CASCADE,
        user_sub TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ,
        access_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_gt3_ride_shares_ride ON gt3_ride_shares (ride_id);
      CREATE INDEX IF NOT EXISTS idx_gt3_ride_shares_user ON gt3_ride_shares (user_sub, created_at DESC);
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
