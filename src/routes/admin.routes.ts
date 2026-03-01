import { Request, Response, Router } from 'express';
import basicAuth from 'express-basic-auth';
import { getAuditLog } from '../audit';

const router = Router();

router.get('/audit', async (req: Request, res: Response) => {
  const authReq = req as basicAuth.IBasicAuthedRequest;
  const isAdmin = req.user?.role === 'admin' || authReq.auth?.user === 'admin';

  if (!isAdmin) {
    res.status(403).json({ message: 'Forbidden' });
    return;
  }

  const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 500);
  const offset = parseInt((req.query.offset as string) || '0', 10);
  const { username, action } = req.query as Record<string, string>;
  const since = req.query.since ? new Date(req.query.since as string) : undefined;

  const entries = await getAuditLog({
    limit,
    offset,
    username: username || undefined,
    action: action || undefined,
    since,
  });

  res.json(entries);
});

export default router;
