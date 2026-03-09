import request from 'supertest';
import express from 'express';
import pushRouter from '../routes/push.routes';
import * as pushStore from '../push-token-store';

jest.mock('../push-token-store');
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
  describe('POST /push-tokens', () => {
    it('registers a push token', async () => {
      (pushStore.savePushToken as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app)
        .post('/push-tokens')
        .send({
          pushToken: 'abc-token',
          activityType: 'dishwasher',
          deviceName: 'iPhone 15',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushStore.savePushToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userSub: 'test-user',
          pushToken: 'abc-token',
          activityType: 'dishwasher',
        }),
      );
    });

    it('returns 400 when pushToken is missing', async () => {
      const res = await request(app)
        .post('/push-tokens')
        .send({ activityType: 'dishwasher' });
      expect(res.status).toBe(400);
    });

    it('returns 400 when activityType is missing', async () => {
      const res = await request(app)
        .post('/push-tokens')
        .send({ pushToken: 'abc-token' });
      expect(res.status).toBe(400);
    });

    it('returns 500 on save failure', async () => {
      (pushStore.savePushToken as jest.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app)
        .post('/push-tokens')
        .send({ pushToken: 'abc', activityType: 'dishwasher' });
      expect(res.status).toBe(500);
    });
  });

  describe('DELETE /push-tokens/:token', () => {
    it('deletes a push token', async () => {
      (pushStore.deletePushToken as jest.Mock).mockResolvedValue(undefined);
      const res = await request(app).delete('/push-tokens/abc-token');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(pushStore.deletePushToken).toHaveBeenCalledWith('abc-token');
    });

    it('returns 500 on delete failure', async () => {
      (pushStore.deletePushToken as jest.Mock).mockRejectedValue(new Error('DB error'));
      const res = await request(app).delete('/push-tokens/abc-token');
      expect(res.status).toBe(500);
    });
  });
});
