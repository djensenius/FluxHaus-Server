import {
  buildMemoryPrompt, deleteAllMemories, deleteMemory, listMemories, saveMemory,
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

    it('encrypts and inserts memory', async () => {
      mockPool.query.mockResolvedValue({
        rows: [{ id: 'mem-1', created_at: '2026-01-01T00:00:00Z' }],
      });
      const mem = await saveMemory('user-1', 'likes cats');
      expect(mem).toEqual({
        id: 'mem-1',
        content: 'likes cats',
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(mockPool.query.mock.calls[0][1]).toEqual(['user-1', 'enc:likes cats']);
    });
  });

  describe('listMemories', () => {
    it('returns empty when pool is null', async () => {
      getPool.mockReturnValue(null);
      const result = await listMemories('user-1');
      expect(result).toEqual([]);
    });

    it('decrypts and returns memories', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { id: 'mem-1', content: 'enc:likes cats', created_at: '2026-01-01T00:00:00Z' },
          { id: 'mem-2', content: 'enc:prefers Celsius', created_at: '2026-01-02T00:00:00Z' },
        ],
      });
      const result = await listMemories('user-1');
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('likes cats');
      expect(result[1].content).toBe('prefers Celsius');
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

  describe('deleteAllMemories', () => {
    it('returns count of deleted', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 5 });
      const count = await deleteAllMemories('user-1');
      expect(count).toBe(5);
    });
  });

  describe('buildMemoryPrompt', () => {
    it('returns empty string when no memories', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toBe('');
    });

    it('returns formatted prompt with memories', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          { id: 'mem-1', content: 'enc:likes cats', created_at: '2026-01-01T00:00:00Z' },
        ],
      });
      const prompt = await buildMemoryPrompt('user-1');
      expect(prompt).toContain('likes cats');
      expect(prompt).toContain('save_memory');
      expect(prompt).toContain('delete_memory');
      expect(prompt).toContain('id:mem-1');
    });
  });
});
