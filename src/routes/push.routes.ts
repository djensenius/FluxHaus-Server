import { Router } from 'express';
import {
  deleteDeviceToken, saveDeviceToken,
} from '../push-token-store';
import { getAllChannels, getChannelId } from '../apns-channels';
import logger from '../logger';

const pushLogger = logger.child({ subsystem: 'push-routes' });

const router = Router();

// --- Broadcast channel endpoints ---

router.get('/channels/:activityType', async (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { activityType } = req.params;
  try {
    const channelId = await getChannelId(activityType);
    if (!channelId) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({ activityType, channelId });
  } catch (err) {
    pushLogger.error({ err, activityType }, 'Failed to get channel');
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

router.get('/channels', async (_req, res) => {
  try {
    const channels = await getAllChannels();
    res.json({ channels });
  } catch (err) {
    pushLogger.error({ err }, 'Failed to get channels');
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

router.post('/push-tokens/device', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { pushToStartToken, deviceName } = req.body;
  if (!pushToStartToken) {
    res.status(400).json({ error: 'pushToStartToken is required' });
    return;
  }

  try {
    await saveDeviceToken({
      userSub,
      pushToStartToken,
      deviceName,
      bundleId: process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus',
    });
    pushLogger.info({ userSub }, 'Device push-to-start token registered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to register device token');
    res.status(500).json({ error: 'Failed to register device token' });
  }
});

router.delete('/push-tokens/device/:token', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await deleteDeviceToken(req.params.token);
    pushLogger.info({ userSub }, 'Device push-to-start token unregistered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to unregister device token');
    res.status(500).json({ error: 'Failed to unregister device token' });
  }
});

export default router;
