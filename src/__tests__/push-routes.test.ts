import request from 'supertest';
import express from 'express';
import pushRouter from '../routes/push.routes';
import * as pushStore from '../push-token-store';
import * as apnsChannels from '../apns-channels';

vi.mock('../push-token-store');
vi.mock('../apns-channels');
vi.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
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
  vi.clearAllMocks();
});

describe('push routes', () => {
  describe('GET /channels/:activityType', () => {
    it('returns channel ID for a valid activity type', async () => {
      (apnsChannels.getChannelId as vi.Mock).mockResolvedValue('ch-abc-123');
      const res = await request(app).get('/channels/dishwasher');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ activityType: 'dishwasher', channelId: 'ch-abc-123' });
    });

    it('returns 404 when no channel exists', async () => {
      (apnsChannels.getChannelId as vi.Mock).mockResolvedValue(null);
      const res = await request(app).get('/channels/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /channels', () => {
    it('returns all channels', async () => {
      (apnsChannels.getAllChannels as vi.Mock).mockResolvedValue({
        dishwasher: 'ch-1', washer: 'ch-2',
      });
      const res = await request(app).get('/channels');
      expect(res.status).toBe(200);
      expect(res.body.channels).toEqual({ dishwasher: 'ch-1', washer: 'ch-2' });
    });
  });

  describe('POST /push-tokens/device', () => {
    it('registers a device push-to-start token', async () => {
      (pushStore.saveDeviceToken as vi.Mock).mockResolvedValue(undefined);
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
      (pushStore.saveDeviceToken as vi.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app)
        .post('/push-tokens/device')
        .send({ pushToStartToken: 'abc' });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /push-tokens/device/:token', () => {
    it('deletes a device push-to-start token', async () => {
      (pushStore.deleteDeviceToken as vi.Mock).mockResolvedValue(undefined);
      const res = await request(app).delete('/push-tokens/device/device-token-abc');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushStore.deleteDeviceToken).toHaveBeenCalledWith('device-token-abc');
    });

    it('returns 500 on delete failure', async () => {
      (pushStore.deleteDeviceToken as vi.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app).delete('/push-tokens/device/abc');
      expect(res.status).toBe(500);
    });
  });
});
