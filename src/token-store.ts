import fs from 'fs';
import { getPool } from './db';
import logger from './logger';

const tokenLogger = logger.child({ subsystem: 'token-store' });

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  timestamp?: string;
  [key: string]: unknown;
}

const LEGACY_FILES: Record<string, string> = {
  miele: 'cache/miele-token.json',
  homeconnect: 'cache/homeconnect-token.json',
};

export async function saveToken(provider: string, data: TokenData): Promise<void> {
  // Always write to legacy file for backward compat
  const legacyFile = LEGACY_FILES[provider];
  if (legacyFile) {
    try {
      fs.writeFileSync(
        legacyFile,
        JSON.stringify({ timestamp: data.timestamp ?? new Date().toISOString(), ...data }, null, 2),
      );
    } catch (err) {
      tokenLogger.error({ err, provider }, 'Failed to write legacy token file');
    }
  }

  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO oauth_tokens (provider, access_token, refresh_token, id_token, expires_in, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         id_token = EXCLUDED.id_token,
         expires_in = EXCLUDED.expires_in,
         updated_at = NOW()`,
      [
        provider,
        data.access_token,
        data.refresh_token ?? null,
        data.id_token ?? null,
        data.expires_in ?? null,
      ],
    );
  } catch (err) {
    tokenLogger.error({ err, provider }, 'Failed to save token to DB');
  }
}

export async function getToken(provider: string): Promise<TokenData | null> {
  const pool = getPool();
  if (pool) {
    try {
      const result = await pool.query(
        'SELECT access_token, refresh_token, id_token, expires_in, created_at FROM oauth_tokens WHERE provider = $1',
        [provider],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          id_token: row.id_token,
          expires_in: row.expires_in,
          timestamp: row.created_at,
        };
      }
    } catch (err) {
      tokenLogger.error({ err, provider }, 'Failed to get token from DB');
    }
  }

  // Migration fallback: read from cache file
  const legacyFile = LEGACY_FILES[provider];
  if (legacyFile && fs.existsSync(legacyFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as TokenData;
      tokenLogger.info({ provider }, 'Migrating token from cache file to DB');
      await saveToken(provider, data);
      return data;
    } catch (err) {
      tokenLogger.error({ err, provider }, 'Failed to read legacy token file');
    }
  }

  return null;
}
