import { Router } from 'express';
import { deletePushToken, savePushToken } from '../push-token-store';
import logger from '../logger';

const pushLogger = logger.child({ subsystem: 'push-routes' });

const router = Router();

router.post('/push-tokens', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { pushToken, activityType, deviceName } = req.body;
  if (!pushToken || !activityType) {
    res.status(400).json({ error: 'pushToken and activityType are required' });
    return;
  }

  try {
    await savePushToken({
      userSub,
      pushToken,
      activityType,
      deviceName,
      bundleId: process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus',
    });
    pushLogger.info({ userSub, activityType }, 'Push token registered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to register push token');
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

router.delete('/push-tokens/:token', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await deletePushToken(req.params.token);
    pushLogger.info({ userSub }, 'Push token unregistered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to unregister push token');
    res.status(500).json({ error: 'Failed to unregister push token' });
  }
});

export default router;
