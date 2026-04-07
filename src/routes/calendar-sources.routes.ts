import { Router } from 'express';
import {
  CalendarSourceInput,
  CalendarSourcePatch,
  createCalendarSource,
  deleteCalendarSource,
  listCalendarSources,
  sanitizeCalendarSource,
  updateCalendarSource,
} from '../calendar-sources';
import { csrfMiddleware } from '../middleware/csrf.middleware';

const router = Router();

router.get('/calendar-sources', async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const sources = await listCalendarSources(req.user.sub);
    res.json(sources.map(sanitizeCalendarSource));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

router.post('/calendar-sources', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const source = await createCalendarSource(req.user.sub, req.body as CalendarSourceInput);
    res.status(201).json(sanitizeCalendarSource(source));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ error: message });
  }
});

router.patch('/calendar-sources/:id', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    const source = await updateCalendarSource(
      req.user.sub,
      req.params.id,
      req.body as CalendarSourcePatch,
    );
    res.json(sanitizeCalendarSource(source));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'Calendar source not found' ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

router.delete('/calendar-sources/:id', csrfMiddleware, async (req, res) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  try {
    await deleteCalendarSource(req.user.sub, req.params.id);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'Calendar source not found' ? 404 : 400;
    res.status(status).json({ error: message });
  }
});

export default router;
