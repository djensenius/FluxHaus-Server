import {
  MAX_MEMORIES_IN_PROMPT, buildMemoryPrompt, deleteAllMemories, deleteMemory,
  listMemories, saveMemory, updateMemory,
} from '../memory';

jest.mock('../db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../encryption', () => ({
  encrypt: jest.fn((text: string) => `enc:${text}`),
  decrypt: jest.fn((text: string) => text.replace('enc:', '')),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { child: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPool } = require('../db');

describe('memory', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = { query: jest.fn() };
    getPool.mockReturnValue(mockPool);
  });

  describe('saveMemory', () => {
    it('throws when pool is null', async () => {
      getPool.mockReturnValue(null);
      await expect(saveMemory('user-1', 'likes cats'))
        .rejects.toThrow('Database not available');
    });

    it('encrypts and inserts memory with default category', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'mem-1', created_at: '2026-01-01T00:00:00Z' }],
      });
      const mem = await saveMemory('user-1', 'likes cats');
      expect(mem).toEqual({
        id: 'mem-1',
        content: 'likes cats',
        category: 'fact',
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', 'enc:likes cats', 'fact']);
    });

    it('stores the provided category', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'mem-2', created_at: '2026-01-01T00:00:00Z' }],
      });
      const mem = await saveMemory('user-1', 'building a deck', 'project');
      expect(mem.category).toBe('project');
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', 'enc:building a deck', 'project']);
    });

    it('falls back to fact for unknown categories', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'mem-3', created_at: '2026-01-01T00:00:00Z' }],
      });
      const mem = await saveMemory('user-1', 'something', 'nonsense');
      expect(mem.category).toBe('fact');
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', 'enc:something', 'fact']);
    });
  });

  describe('listMemories', () => {
    it('returns empty when pool is null', async () => {
      getPool.mockReturnValue(null);
      const result = await listMemories('user-1');
      expect(result).toEqual([]);
    });

    it('decrypts and returns memories with category', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            id: 'mem-1', content: 'enc:likes cats', category: 'preference', created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'mem-2', content: 'enc:prefers Celsius', category: 'preference', created_at: '2026-01-02T00:00:00Z',
          },
        ],
      });
      const result = await listMemories('user-1');
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('likes cats');
      expect(result[0].category).toBe('preference');
      expect(result[1].content).toBe('prefers Celsius');
    });

    it('normalizes a missing category to fact', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { id: 'mem-1', content: 'enc:legacy note', created_at: '2026-01-01T00:00:00Z' },
        ],
      });
      const result = await listMemories('user-1');
      expect(result[0].category).toBe('fact');
    });

    it('pushes the category filter down into the SQL query', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await listMemories('user-1', 'project');
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('AND category = $2');
      expect(params).toEqual(['user-1', 'project']);
    });

    it('does not filter by category when none is given', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await listMemories('user-1');
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).not.toContain('AND category');
      expect(params).toEqual(['user-1']);
    });

    it('treats null or empty category as no filter', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await listMemories('user-1', '');
      await listMemories('user-1', null as unknown as string);
      expect(mockPool.query.mock.calls[0][0]).not.toContain('AND category');
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1']);
      expect(mockPool.query.mock.calls[1][0]).not.toContain('AND category');
      expect(mockPool.query.mock.calls[1][1]).toEqual(['user-1']);
    });

    it('orders by created_at with a stable id tie-breaker', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      await listMemories('user-1');
      expect(mockPool.query.mock.calls[0][0]).toContain('ORDER BY created_at, id');
    });
  });

  describe('deleteMemory', () => {
    it('returns true when deleted', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 1 });
      const result = await deleteMemory('user-1', 'mem-1');
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });
      const result = await deleteMemory('user-1', 'mem-99');
      expect(result).toBe(false);
    });
  });

  describe('updateMemory', () => {
    it('updates content and category', async () => {
      mockPool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{
          id: 'mem-1', content: 'enc:owns a GT3', category: 'possession', created_at: '2026-01-01T00:00:00Z',
        }],
      });
      const result = await updateMemory('user-1', 'mem-1', {
        content: 'owns a GT3',
        category: 'possession',
      });
      expect(result).toEqual({
        id: 'mem-1',
        content: 'owns a GT3',
        category: 'possession',
        createdAt: '2026-01-01T00:00:00Z',
      });
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('UPDATE user_memories SET content = $1, category = $2');
      expect(params).toEqual(['enc:owns a GT3', 'possession', 'mem-1', 'user-1']);
    });

    it('updates only the category', async () => {
      mockPool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{
          id: 'mem-1', content: 'enc:espresso machine', category: 'possession', created_at: '2026-01-01T00:00:00Z',
        }],
      });
      const result = await updateMemory('user-1', 'mem-1', { category: 'possession' });
      expect(result?.category).toBe('possession');
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('SET category = $1');
      expect(params).toEqual(['possession', 'mem-1', 'user-1']);
    });

    it('returns null when the memory does not exist', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0, rows: [] });
      const result = await updateMemory('user-1', 'mem-99', { content: 'x' });
      expect(result).toBeNull();
    });

    it('returns the current memory unchanged when no fields are provided', async () => {
      mockPool.query.mockResolvedValue({
        rowCount: 1,
        rows: [{
          id: 'mem-1', content: 'enc:likes cats', category: 'preference', created_at: '2026-01-01T00:00:00Z',
        }],
      });
      const result = await updateMemory('user-1', 'mem-1', {});
      expect(result?.content).toBe('likes cats');
      expect(mockPool.query.mock.calls[0][0]).toContain('SELECT');
    });
  });

  describe('deleteAllMemories', () => {
    it('returns count of deleted', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 5 });
      const count = await deleteAllMemories('user-1');
      expect(count).toBe(5);
    });
  });

  describe('buildMemoryPrompt', () => {
    it('returns an empty string when the database is unavailable', async () => {
      getPool.mockReturnValue(null);
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toBe('');
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('returns a proactive capture directive when there are no memories', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toContain('save_memory');
      expect(prompt).toContain('without being asked');
      expect(prompt).toContain('no saved memories');
    });

    it('groups memories by category', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            id: 'mem-1', content: 'enc:building a deck', category: 'project', created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'mem-2', content: 'enc:owns a GT3', category: 'possession', created_at: '2026-01-02T00:00:00Z',
          },
          {
            id: 'mem-3',
            content: 'enc:wants an espresso machine',
            category: 'wishlist',
            created_at: '2026-01-03T00:00:00Z',
          },
        ],
      });
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toContain("Projects they're working on:");
      expect(prompt).toContain('building a deck');
      expect(prompt).toContain('Things they own:');
      expect(prompt).toContain('owns a GT3');
      expect(prompt).toContain("Things they're thinking about buying:");
      expect(prompt).toContain('wants an espresso machine');
      expect(prompt).toContain('save_memory');
      expect(prompt).toContain('delete_memory');
      expect(prompt).toContain('id:mem-1');
    });

    it('caps embedded memories at MAX_MEMORIES_IN_PROMPT and notes truncation', async () => {
      const total = MAX_MEMORIES_IN_PROMPT + 5;
      const rows = Array.from({ length: total }, (_, i) => ({
        id: `mem-${i}`,
        content: `enc:memory ${i}`,
        category: 'fact',
        created_at: '2026-01-01T00:00:00Z',
      }));
      mockPool.query.mockResolvedValue({ rows });
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toContain(`${MAX_MEMORIES_IN_PROMPT} most recent of ${total}`);
      // Oldest entries (mem-0..mem-4) are dropped; the newest is retained.
      expect(prompt).not.toContain('[id:mem-0]');
      expect(prompt).toContain(`[id:mem-${total - 1}]`);
    });
  });
});
