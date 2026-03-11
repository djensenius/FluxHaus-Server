import { getPool } from './db';
import { decrypt, encrypt } from './encryption';
import logger from './logger';

const memLogger = logger.child({ subsystem: 'memory' });

export interface Memory {
  id: string;
  content: string;
  createdAt: string;
}

export async function saveMemory(userSub: string, content: string): Promise<Memory> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const encrypted = encrypt(content, userSub);
  const result = await pool.query(
    'INSERT INTO user_memories (user_sub, content) VALUES ($1, $2) RETURNING id, created_at',
    [userSub, encrypted],
  );

  const row = result.rows[0];
  memLogger.info({ userSub, memoryId: row.id }, 'Memory saved');
  return { id: row.id, content, createdAt: row.created_at };
}

export async function listMemories(userSub: string): Promise<Memory[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    'SELECT id, content, created_at FROM user_memories WHERE user_sub = $1 ORDER BY created_at',
    [userSub],
  );

  return result.rows.map((row) => ({
    id: row.id,
    content: decrypt(row.content, userSub),
    createdAt: row.created_at,
  }));
}

export async function deleteMemory(userSub: string, memoryId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    'DELETE FROM user_memories WHERE id = $1 AND user_sub = $2 RETURNING id',
    [memoryId, userSub],
  );

  if (result.rowCount === 0) return false;
  memLogger.info({ userSub, memoryId }, 'Memory deleted');
  return true;
}

export async function deleteAllMemories(userSub: string): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    'DELETE FROM user_memories WHERE user_sub = $1',
    [userSub],
  );

  const count = result.rowCount ?? 0;
  memLogger.info({ userSub, count }, 'All memories deleted');
  return count;
}

/**
 * Build a system prompt fragment with the user's memories.
 * Returns empty string if no memories exist.
 */
export async function buildMemoryPrompt(userSub: string): Promise<string> {
  const memories = await listMemories(userSub);
  if (memories.length === 0) return '';

  const memoryLines = memories.map((m) => `- [id:${m.id}] ${m.content}`).join('\n');
  return (
    '\n\nYou have a memory system. Here are things you remember about this user:\n'
    + `${memoryLines}\n\n`
    + 'Use the save_memory tool to remember new important facts, preferences, or context about the user. '
    + 'Use the delete_memory tool if the user asks you to forget something or if a memory is outdated.'
  );
}
