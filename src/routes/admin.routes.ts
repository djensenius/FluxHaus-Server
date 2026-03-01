import { Router } from 'express';
import { getAuditLog } from '../audit';
import { requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/audit', requireRole('admin'), async (req, res) => {
  const {
    limit, offset, username, action, since,
  } = req.query;
  const logs = await getAuditLog({
    limit: limit ? parseInt(limit as string, 10) : undefined,
    offset: offset ? parseInt(offset as string, 10) : undefined,
    username: username as string | undefined,
    action: action as string | undefined,
    since: since as string | undefined,
  });
  res.json(logs);
});

export default router;
