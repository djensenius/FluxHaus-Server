import { Request, Response, Router } from 'express';
import logger from '../logger';

const router = Router();

/**
 * GET /api/radar/config
 *
 * Fetches the current Rainbow.ai radar snapshot and returns tile
 * configuration so the iOS/macOS/visionOS app can render radar
 * tiles without exposing the API key.
 *
 * Response: { snapshot, tileBase, tileQuery }
 */
router.get('/api/radar/config', async (req: Request, res: Response) => {
  if (!req.user?.sub) {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }

  const apiKey = process.env.RAINBOW_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'RAINBOW_API_KEY not configured' });
    return;
  }

  try {
    const response = await fetch(
      `https://api.rainbow.ai/tiles/v1/snapshot?token=${apiKey}`,
    );

    if (!response.ok) {
      logger.error(`Rainbow.ai snapshot failed: ${response.status}`);
      res.status(502).json({ error: 'Failed to fetch radar snapshot' });
      return;
    }

    const data = await response.json() as { snapshot: number };

    res.json({
      snapshot: data.snapshot,
      tileBase: 'https://api.rainbow.ai/tiles/v1/precip',
      tileQuery: `token=${apiKey}&color=${process.env.RAINBOW_COLOR || '1'}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`Radar config error: ${message}`);
    res.status(500).json({ error: message });
  }
});

export default router;
