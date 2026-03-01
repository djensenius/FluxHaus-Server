import fs from 'fs';
import { pool } from './db';

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  timestamp: Date;
}

const CACHE_FILES: Record<string, string> = {
  miele: 'cache/miele-token.json',
  homeconnect: 'cache/homeconnect-token.json',
};

export async function saveToken(provider: string, data: TokenData): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, id_token, expires_in, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       id_token = EXCLUDED.id_token,
       expires_in = EXCLUDED.expires_in,
       updated_at = EXCLUDED.updated_at`,
    [
      provider,
      data.access_token,
      data.refresh_token ?? null,
      data.id_token ?? null,
      data.expires_in ?? null,
      data.timestamp,
    ],
  );
}

export async function getToken(provider: string): Promise<TokenData | null> {
  const result = await pool.query(
    'SELECT access_token, refresh_token, id_token, expires_in, updated_at FROM oauth_tokens WHERE provider = $1',
    [provider],
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token ?? undefined,
      id_token: row.id_token ?? undefined,
      expires_in: row.expires_in ?? undefined,
      timestamp: new Date(row.updated_at),
    };
  }

  // Migration fallback: check for legacy cache file
  const cacheFile = CACHE_FILES[provider];
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const fileData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const tokenData: TokenData = {
        access_token: fileData.access_token,
        refresh_token: fileData.refresh_token,
        id_token: fileData.id_token,
        expires_in: fileData.expires_in,
        timestamp: new Date(fileData.timestamp),
      };
      await saveToken(provider, tokenData);
      return tokenData;
    } catch {
      console.warn(`token-store: could not migrate ${cacheFile}, ignoring`);
    }
  }

  return null;
}
