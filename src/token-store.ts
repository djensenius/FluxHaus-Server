import fs from 'fs';
import path from 'path';
import { pool } from './db';

export interface TokenData {
  [key: string]: unknown;
}

export async function getToken(key: string): Promise<TokenData | null> {
  try {
    const result = await pool.query(
      'SELECT data FROM oauth_tokens WHERE key = $1',
      [key],
    );
    if (result.rows.length > 0) {
      return result.rows[0].data as TokenData;
    }
  } catch {
    // Fall through to file fallback
  }

  const filePath = path.join('cache', `${key}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as TokenData;
    } catch {
      return null;
    }
  }

  return null;
}

export async function saveToken(key: string, data: TokenData): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_tokens (key, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [key, JSON.stringify(data)],
  );
}
