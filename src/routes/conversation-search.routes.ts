import { Request, Response, Router } from 'express';
import { getPool } from '../db';
import { decrypt } from '../encryption';
import logger from '../logger';

const searchLogger = logger.child({ subsystem: 'conversation-search' });

const router = Router();

interface SearchResult {
  conversationId: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  matches: Array<{
    messageId: string;
    role: string;
    snippet: string;
    createdAt: string;
  }>;
}

/**
 * GET /conversations/search?q=query
 *
 * Searches conversation titles and message content (decrypted server-side).
 * Returns matching conversations with message snippets.
 */
router.get('/conversations/search', async (req: Request, res: Response) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }

  const query = (req.query.q as string || '').trim().toLowerCase();
  if (!query || query.length < 2) {
    res.status(400).json({ error: 'Search query must be at least 2 characters' });
    return;
  }

  const db = getPool();
  if (!db) {
    res.status(503).json({ error: 'Database unavailable' });
    return;
  }

  try {
    // Fetch all conversations with their messages for this user
    const convResult = await db.query(
      `SELECT c.id, c.title, c.updated_at,
              COUNT(m.id)::int AS message_count
       FROM conversations c
       LEFT JOIN conversation_messages m ON m.conversation_id = c.id
       WHERE c.user_sub = $1
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
      [req.user.sub],
    );

    const results: SearchResult[] = [];

    await Promise.all(convResult.rows.map(async (conv) => {
      const decTitle = conv.title ? decrypt(conv.title, req.user!.sub!) : null;
      const titleMatches = decTitle?.toLowerCase().includes(query) ?? false;

      // Search message content
      const msgResult = await db.query(
        `SELECT id, role, content, created_at
         FROM conversation_messages
         WHERE conversation_id = $1
         ORDER BY created_at`,
        [conv.id],
      );

      const matchingMessages: SearchResult['matches'] = [];
      msgResult.rows.forEach((msg) => {
        try {
          let decContent = decrypt(msg.content, req.user!.sub!);
          // Handle JSON envelope (images)
          try {
            const parsed = JSON.parse(decContent);
            if (parsed && typeof parsed.text === 'string') {
              decContent = parsed.text;
            }
          } catch { /* plain text */ }

          if (decContent.toLowerCase().includes(query)) {
            // Extract snippet around match
            const idx = decContent.toLowerCase().indexOf(query);
            const start = Math.max(0, idx - 40);
            const end = Math.min(decContent.length, idx + query.length + 40);
            let snippet = decContent.substring(start, end);
            if (start > 0) snippet = `…${snippet}`;
            if (end < decContent.length) snippet = `${snippet}…`;

            matchingMessages.push({
              messageId: msg.id,
              role: msg.role,
              snippet,
              createdAt: msg.created_at,
            });
          }
        } catch {
          // Skip messages that fail to decrypt
        }
      });

      if (titleMatches || matchingMessages.length > 0) {
        results.push({
          conversationId: conv.id,
          title: decTitle,
          updatedAt: conv.updated_at,
          messageCount: conv.message_count,
          matches: matchingMessages,
        });
      }
    }));

    // Sort by most recent match
    results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    searchLogger.debug(
      { query, resultCount: results.length },
      'Conversation search completed',
    );
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    searchLogger.error({ error: message }, 'Search failed');
    res.status(500).json({ error: message });
  }
});

export default router;
