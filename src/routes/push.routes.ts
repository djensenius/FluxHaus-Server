import { Router } from 'express';
import {
  deleteDeviceToken, saveActivityToken, saveApnsToken, saveDeviceToken,
} from '../push-token-store';
import { getAllChannels, getChannelId } from '../apns-channels';
import { getSubscriptions, saveSubscriptions } from '../la-subscriptions';
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

// --- APNs device token for regular push notifications ---

router.post('/push-tokens/apns', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { token, deviceName } = req.body;
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  try {
    await saveApnsToken({
      userSub,
      token,
      deviceName,
      bundleId: process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus',
    });
    pushLogger.info({ userSub }, 'APNs device token registered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to register APNs token');
    res.status(500).json({ error: 'Failed to register APNs token' });
  }
});

// --- Per-activity push token for direct Live Activity updates ---

router.post('/push-tokens/activity', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { activityToken, deviceName } = req.body;
  if (!activityToken) {
    res.status(400).json({ error: 'activityToken is required' });
    return;
  }

  try {
    await saveActivityToken({
      userSub,
      activityToken,
      deviceName,
      bundleId: process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus',
    });
    pushLogger.info({ userSub }, 'Activity push token registered');
    res.json({ success: true });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to register activity token');
    res.status(500).json({ error: 'Failed to register activity token' });
  }
});

// --- Live Activity subscription preferences ---

router.get('/push-tokens/subscriptions', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const deviceTypes = await getSubscriptions(userSub);
    res.json({ deviceTypes });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to get subscriptions');
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

router.post('/push-tokens/subscriptions', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { deviceTypes } = req.body as { deviceTypes?: string[] };
  if (!Array.isArray(deviceTypes)) {
    res.status(400).json({ error: 'deviceTypes array is required' });
    return;
  }

  try {
    await saveSubscriptions(userSub, deviceTypes);
    pushLogger.info({ userSub, count: deviceTypes.length }, 'Subscriptions updated');
    res.json({ success: true, deviceTypes });
  } catch (err) {
    pushLogger.error({ err, userSub }, 'Failed to save subscriptions');
    res.status(500).json({ error: 'Failed to save subscriptions' });
  }
});

export default router;
