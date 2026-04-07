import { Router } from 'express';
import { getUserPreferences, setUserPreferences } from '../user-preferences';
import { csrfMiddleware } from '../middleware/csrf.middleware';

const router = Router();

router.get('/preferences', async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const prefs = await getUserPreferences(req.user.sub);
    res.json(prefs);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

router.patch('/preferences', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  const { memoryEnabled, defaultCalendarId } = req.body as {
    memoryEnabled?: boolean;
    defaultCalendarId?: string | null;
  };
  if (memoryEnabled === undefined && defaultCalendarId === undefined) {
    res.status(400).json({ error: 'No valid preference fields provided' });
    return;
  }
  try {
    const prefs = await setUserPreferences(req.user.sub, {
      memoryEnabled,
      defaultCalendarId,
    });
    res.json(prefs);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
