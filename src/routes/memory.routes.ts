import { Router } from 'express';
import { listMemories, deleteMemory, deleteAllMemories } from '../memory';
import { csrfMiddleware } from '../middleware/csrf.middleware';

const router = Router();

router.get('/memories', async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const memories = await listMemories(req.user.sub);
    res.json({ memories });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

router.delete('/memories/:id', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const deleted = await deleteMemory(req.user.sub, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

router.delete('/memories', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const count = await deleteAllMemories(req.user.sub);
    res.json({ success: true, deleted: count });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
