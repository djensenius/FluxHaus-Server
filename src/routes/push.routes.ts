import { Router } from 'express';
import {
  deleteDeviceToken, getApnsTokensByUser, getDeviceTokensByUser,
  saveActivityToken, saveApnsToken, saveDeviceToken,
} from '../push-token-store';
import { getAllChannels, getChannelId } from '../apns-channels';
import { getSubscriptions, saveSubscriptions } from '../la-subscriptions';
import { onPushToStartTokenRegistered } from '../live-activity-hooks';
import {
  sendAlertNotification, sendGT3PushToStart, sendPushToStart,
} from '../apns';
import { requireRole } from '../middleware/auth.middleware';
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

  const { pushToStartToken, deviceName, bundleId } = req.body;
  if (!pushToStartToken) {
    res.status(400).json({ error: 'pushToStartToken is required' });
    return;
  }

  try {
    await saveDeviceToken({
      userSub,
      pushToStartToken,
      deviceName,
      bundleId: bundleId || process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus',
    });
    pushLogger.info({ userSub, bundleId: bundleId || 'default' }, 'Device push-to-start token registered');
    res.json({ success: true });

    // If devices are already running, send push-to-start immediately
    // Only for FluxHaus tokens — GT3 tokens use a different push format
    const effectiveBundleId = bundleId || process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
    if (effectiveBundleId === (process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus')) {
      onPushToStartTokenRegistered(pushToStartToken).catch(() => {});
    }
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

// --- Test push notification endpoints (admin only) ---

router.get('/push-test/tokens', requireRole('admin'), async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const [apnsTokens, deviceTokens] = await Promise.all([
      getApnsTokensByUser(userSub),
      getDeviceTokensByUser(userSub),
    ]);
    res.json({
      alert: apnsTokens.map((t) => ({
        deviceName: t.deviceName,
        bundleId: t.bundleId,
        token: `${t.token.substring(0, 8)}...`,
      })),
      pushToStart: deviceTokens.map((t) => ({
        deviceName: t.deviceName,
        bundleId: t.bundleId,
        token: `${t.pushToStartToken.substring(0, 8)}...`,
      })),
    });
  } catch (err) {
    pushLogger.error({ err }, 'Failed to list test tokens');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/push-test/alert', requireRole('admin'), async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { title, body, bundleId } = req.body as {
    title?: string; body?: string; bundleId?: string;
  };

  try {
    const tokens = await getApnsTokensByUser(userSub);
    const filtered = bundleId
      ? tokens.filter((t) => t.bundleId === bundleId)
      : tokens;

    if (filtered.length === 0) {
      res.status(404).json({ error: 'No alert tokens found' });
      return;
    }

    const results = await Promise.allSettled(
      filtered.map((t) => sendAlertNotification(
        t.token,
        title || 'Test Notification',
        body || 'This is a test push from FluxHaus Server',
        undefined,
        t.bundleId,
      )),
    );

    const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    pushLogger.info({ userSub, sent, total: filtered.length }, 'Test alert sent');
    res.json({ sent, total: filtered.length });
  } catch (err) {
    pushLogger.error({ err }, 'Test alert failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/push-test/push-to-start', requireRole('admin'), async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { app, bundleId } = req.body as { app?: string; bundleId?: string };
  const isGT3 = app === 'gt3' || bundleId === 'org.davidjensenius.GT3Companion';

  try {
    const tokens = await getDeviceTokensByUser(userSub);
    const targetBundle = isGT3
      ? 'org.davidjensenius.GT3Companion'
      : (bundleId || 'org.davidjensenius.FluxHaus');
    const filtered = tokens.filter((t) => t.bundleId === targetBundle);

    if (filtered.length === 0) {
      res.status(404).json({
        error: `No push-to-start tokens found for ${targetBundle}`,
        available: [...new Set(tokens.map((t) => t.bundleId))],
      });
      return;
    }

    let results;
    if (isGT3) {
      const contentState = {
        speed: 0,
        battery: 85,
        tripDistance: 0,
        estimatedRange: 42.0,
        gearMode: 2,
        bmsTemp: 25.0,
        isCharging: false,
        isAwake: true,
        isConnected: true,
      };
      results = await Promise.allSettled(
        filtered.map((t) => sendGT3PushToStart(t.pushToStartToken, contentState)),
      );
    } else {
      const contentState = {
        device: {
          name: 'Test Device',
          progress: 0.5,
          icon: 'washer',
          trailingText: 'Test push-to-start',
          shortText: '30 min',
          running: true,
        },
      };
      results = await Promise.allSettled(
        filtered.map((t) => sendPushToStart(t.pushToStartToken, contentState)),
      );
    }

    const sent = results.filter((r) => r.status === 'fulfilled' && r.value).length;
    pushLogger.info(
      {
        userSub,
        app: isGT3 ? 'GT3' : 'FluxHaus',
        sent,
        total: filtered.length,
      },
      'Test push-to-start sent',
    );
    res.json({
      app: isGT3 ? 'GT3' : 'FluxHaus',
      sent,
      total: filtered.length,
    });
  } catch (err) {
    pushLogger.error({ err }, 'Test push-to-start failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
