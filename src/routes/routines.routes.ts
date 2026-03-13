import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import {
  listRoutines, getRoutine, createRoutine, updateRoutine, deleteRoutine,
} from '../scheduler';
import { FluxHausServices } from '../services';

export default function createRoutinesRouter(services: FluxHausServices): Router {
  const router = Router();

  router.get('/routines', requireRole('admin'), async (_req: Request, res: Response) => {
    const routines = await listRoutines();
    res.json(routines);
  });

  router.get('/routines/:id', requireRole('admin'), async (req: Request, res: Response) => {
    const routine = await getRoutine(req.params.id);
    if (!routine) {
      res.status(404).json({ error: 'Routine not found' });
      return;
    }
    res.json(routine);
  });

  router.post('/routines', requireRole('admin'), async (req: Request, res: Response) => {
    const { name, cron, prompt, enabled } = req.body as {
      name?: string;
      cron?: string;
      prompt?: string;
      enabled?: boolean;
    };

    if (!name || !cron || !prompt) {
      res.status(400).json({ error: 'name, cron, and prompt are required' });
      return;
    }

    const routine = await createRoutine(
      {
        user_sub: req.user?.sub || 'admin',
        name,
        cron,
        prompt,
        enabled,
      },
      services,
    );
    res.status(201).json(routine);
  });

  router.put('/routines/:id', requireRole('admin'), async (req: Request, res: Response) => {
    const routine = await updateRoutine(req.params.id, req.body, services);
    if (!routine) {
      res.status(404).json({ error: 'Routine not found' });
      return;
    }
    res.json(routine);
  });

  router.delete('/routines/:id', requireRole('admin'), async (req: Request, res: Response) => {
    const deleted = await deleteRoutine(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Routine not found' });
      return;
    }
    res.status(204).send();
  });

  return router;
}
