import { getPool } from './db';
import { decrypt, encrypt } from './encryption';
import logger from './logger';

const memLogger = logger.child({ subsystem: 'memory' });

/**
 * Categories let memories be organised the way Claude's memory feature groups
 * what it knows about a user (projects, things they own, things they want, etc.)
 * so the assistant can recall and reason about them by topic.
 */
export const MEMORY_CATEGORIES = [
  'project',
  'possession',
  'wishlist',
  'preference',
  'fact',
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const DEFAULT_MEMORY_CATEGORY: MemoryCategory = 'fact';

const CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
  project: "Projects they're working on",
  possession: 'Things they own',
  wishlist: "Things they're thinking about buying",
  preference: 'Preferences',
  fact: 'Other facts',
};

export function normalizeCategory(value: string | null | undefined): MemoryCategory {
  if (value && (MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as MemoryCategory;
  }
  return DEFAULT_MEMORY_CATEGORY;
}

export interface Memory {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: string;
}

interface MemoryRow {
  id: string;
  content: string;
  category: string;
  created_at: string;
}

function rowToMemory(row: MemoryRow, userSub: string): Memory {
  return {
    id: row.id,
    content: decrypt(row.content, userSub),
    category: normalizeCategory(row.category),
    createdAt: row.created_at,
  };
}

export async function saveMemory(
  userSub: string,
  content: string,
  category: string = DEFAULT_MEMORY_CATEGORY,
): Promise<Memory> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const normalizedCategory = normalizeCategory(category);
  const encrypted = encrypt(content, userSub);
  const result = await pool.query(
    'INSERT INTO user_memories (user_sub, content, category) VALUES ($1, $2, $3) RETURNING id, created_at',
    [userSub, encrypted, normalizedCategory],
  );

  const row = result.rows[0];
  memLogger.info({ userSub, memoryId: row.id, category: normalizedCategory }, 'Memory saved');
  return {
    id: row.id, content, category: normalizedCategory, createdAt: row.created_at,
  };
}

export async function listMemories(userSub: string): Promise<Memory[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    'SELECT id, content, category, created_at FROM user_memories WHERE user_sub = $1 ORDER BY created_at',
    [userSub],
  );

  return result.rows.map((row) => rowToMemory(row, userSub));
}

/**
 * Update an existing memory's text and/or category by id. Returns the updated
 * memory, or null if no memory with that id belongs to the user. Passing no
 * fields leaves the memory unchanged and returns it as-is.
 */
export async function updateMemory(
  userSub: string,
  memoryId: string,
  updates: { content?: string; category?: string },
): Promise<Memory | null> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.content !== undefined) {
    values.push(encrypt(updates.content, userSub));
    fields.push(`content = $${values.length}`);
  }
  if (updates.category !== undefined) {
    values.push(normalizeCategory(updates.category));
    fields.push(`category = $${values.length}`);
  }

  if (fields.length === 0) {
    const current = await pool.query(
      'SELECT id, content, category, created_at FROM user_memories WHERE id = $1 AND user_sub = $2',
      [memoryId, userSub],
    );
    return current.rowCount === 0 ? null : rowToMemory(current.rows[0], userSub);
  }

  values.push(memoryId, userSub);
  const result = await pool.query(
    `UPDATE user_memories SET ${fields.join(', ')}
       WHERE id = $${values.length - 1} AND user_sub = $${values.length}
       RETURNING id, content, category, created_at`,
    values,
  );

  if (result.rowCount === 0) return null;
  memLogger.info({ userSub, memoryId, category: result.rows[0].category }, 'Memory updated');
  return rowToMemory(result.rows[0], userSub);
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
 * Build a system prompt fragment describing the user's memories the way
 * Claude's memory feature does: a standing instruction to proactively capture
 * durable facts (projects, possessions, purchase ideas, preferences) without
 * being asked, plus the current memories grouped by category. The directive is
 * always present so the assistant captures the first memory from a blank slate;
 * it is only reached when the user's memoryEnabled preference is on.
 */
export async function buildMemoryPrompt(userSub: string): Promise<string> {
  const memories = await listMemories(userSub);

  const directive = '\n\nYou maintain a long-term memory about this user that persists across '
    + 'conversations. As you talk, proactively use the save_memory tool to remember durable facts '
    + 'on your own, without being asked — especially projects they are working on (category '
    + '"project"), things they own ("possession"), things they want or are thinking about buying '
    + '("wishlist"), and their preferences ("preference"); use "fact" for anything else. Do not '
    + 'save duplicates or trivial, ephemeral details. Use the delete_memory tool when a fact '
    + 'changes or the user asks you to forget it.';

  if (memories.length === 0) {
    return `${directive} You have no saved memories about this user yet.`;
  }

  const sections = MEMORY_CATEGORIES
    .map((category) => ({
      category,
      items: memories.filter((m) => m.category === category),
    }))
    .filter(({ items }) => items.length > 0)
    .map(({ category, items }) => {
      const lines = items.map((m) => `- [id:${m.id}] ${m.content}`).join('\n');
      return `${CATEGORY_HEADINGS[category]}:\n${lines}`;
    })
    .join('\n\n');

  return `${directive}\n\nHere is what you currently remember, organized by category:\n\n${sections}`;
}
