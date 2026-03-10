import request from 'supertest';
import express from 'express';
import pushRouter from '../routes/push.routes';
import * as pushStore from '../push-token-store';
import * as apnsChannels from '../apns-channels';

jest.mock('../push-token-store');
jest.mock('../apns-channels');
jest.mock('../logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const app = express();
app.use(express.json());
// Simulate auth middleware
app.use((req, _res, next) => {
  req.user = { sub: 'test-user', role: 'admin', username: 'test' };
  next();
});
app.use(pushRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('push routes', () => {
  describe('GET /channels/:activityType', () => {
    it('returns channel ID for a valid activity type', async () => {
      (apnsChannels.getChannelId as jest.Mock).mockResolvedValue('ch-abc-123');
      const res = await request(app).get('/channels/dishwasher');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ activityType: 'dishwasher', channelId: 'ch-abc-123' });
    });

    it('returns 404 when no channel exists', async () => {
      (apnsChannels.getChannelId as jest.Mock).mockResolvedValue(null);
      const res = await request(app).get('/channels/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /channels', () => {
    it('returns all channels', async () => {
      (apnsChannels.getAllChannels as jest.Mock).mockResolvedValue({
        dishwasher: 'ch-1', washer: 'ch-2',
      });
      const res = await request(app).get('/channels');
      expect(res.status).toBe(200);
      expect(res.body.channels).toEqual({ dishwasher: 'ch-1', washer: 'ch-2' });
    });
  });

  describe('POST /push-tokens/device', () => {
    it('registers a device push-to-start token', async () => {
      (pushStore.saveDeviceToken as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .post('/push-tokens/device')
        .send({
          pushToStartToken: 'device-token-abc',
          deviceName: 'iPhone 15',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushStore.saveDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userSub: 'test-user',
          pushToStartToken: 'device-token-abc',
          deviceName: 'iPhone 15',
        }),
      );
    });

    it('returns 400 when pushToStartToken is missing', async () => {
      const res = await request(app)
        .post('/push-tokens/device')
        .send({ deviceName: 'iPhone 15' });
      expect(res.status).toBe(400);
    });

    it('returns 500 on save failure', async () => {
      (pushStore.saveDeviceToken as jest.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app)
        .post('/push-tokens/device')
        .send({ pushToStartToken: 'abc' });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /push-tokens/device/:token', () => {
    it('deletes a device push-to-start token', async () => {
      (pushStore.deleteDeviceToken as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app).delete('/push-tokens/device/device-token-abc');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushStore.deleteDeviceToken).toHaveBeenCalledWith('device-token-abc');
    });

    it('returns 500 on delete failure', async () => {
      (pushStore.deleteDeviceToken as jest.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app).delete('/push-tokens/device/abc');
      expect(res.status).toBe(500);
    });
  });
});
