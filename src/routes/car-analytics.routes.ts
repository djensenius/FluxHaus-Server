import { type RequestHandler, Router } from 'express';
import {
  CarAnalyticsService,
  isCarAnalyticsInputError,
  isCarAnalyticsUnavailableError,
} from '../car-analytics';
import logger from '../logger';

const analyticsLogger = logger.child({ subsystem: 'car-analytics-route' });

export default function createCarAnalyticsRouter(
  service: CarAnalyticsService,
  cors: RequestHandler,
): Router {
  const router = Router();

  router.options('/analytics/car', cors);

  router.get('/analytics/car', cors, async (req, res) => {
    try {
      const response = await service.analyze({
        range: req.query.range,
        start: req.query.start,
        end: req.query.end,
        timezone: req.query.timezone,
        comparison: req.query.comparison,
        topic: req.query.topic,
      });
      res.json(response);
    } catch (error) {
      if (isCarAnalyticsInputError(error)) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      if (isCarAnalyticsUnavailableError(error)) {
        res.status(503).json({ error: (error as Error).message });
        return;
      }
      analyticsLogger.error({ error }, 'Failed to calculate car analytics');
      res.status(502).json({ error: 'Failed to calculate car analytics' });
    }
  });

  return router;
}
