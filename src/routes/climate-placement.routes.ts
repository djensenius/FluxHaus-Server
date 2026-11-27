import { type RequestHandler, Router } from 'express';
import {
  type ClimatePlacementService,
  isPlacementInputError,
  isPlacementUnavailableError,
} from '../climate-placement-service';
import logger from '../logger';

const placementLogger = logger.child({ subsystem: 'climate-placement-route' });

// Same audience as the indoor climate snapshot in GET /.
const ALLOWED_ROLES = new Set(['admin', 'demo']);

export default function createClimatePlacementRouter(
  service: ClimatePlacementService,
  cors: RequestHandler,
): Router {
  const router = Router();

  router.options('/climate/placement-insights', cors);

  router.get('/climate/placement-insights', cors, async (req, res) => {
    if (!req.user || !ALLOWED_ROLES.has(req.user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      res.json(await service.getInsights(req.query.days, req.query));
    } catch (error) {
      if (isPlacementInputError(error)) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      if (isPlacementUnavailableError(error)) {
        res.status(503).json({ error: (error as Error).message });
        return;
      }
      placementLogger.error({ error }, 'Failed to calculate sensor placement insights');
      res.status(502).json({ error: 'Failed to calculate sensor placement insights' });
    }
  });

  return router;
}
