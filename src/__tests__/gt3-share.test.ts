import request from 'supertest';
import express from 'express';
import gt3Router from '../routes/gt3.routes';
import gt3PublicRouter from '../routes/gt3-public.routes';

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }),
  },
}));

jest.mock('../db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../influx', () => ({ writePoint: jest.fn() }));
jest.mock('../clients/influxdb', () => ({
  InfluxDBClient: jest.fn().mockImplementation(() => ({ configured: false, query: jest.fn() })),
}));
jest.mock('../apns', () => ({ sendGT3PushToStart: jest.fn() }));
jest.mock('../push-token-store', () => ({ getDeviceTokensByUserAndBundle: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { getPool } = require('../db');

const USER_SUB = 'owner-sub';
const OTHER_SUB = 'stranger-sub';
const RIDE_ID = '11111111-1111-1111-1111-111111111111';

function buildApp(userSub: string | null) {
  const app = express();
  app.use(express.json());
  // Public router mounts first (no auth)
  app.use('/gt3', gt3PublicRouter);
  // Then simulated auth
  app.use('/gt3', (req, _res, next) => {
    if (userSub) req.user = { sub: userSub, role: 'admin', username: 'u' };
    next();
  }, gt3Router);
  return app;
}

describe('GT3 ride share links', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery, connect: jest.fn() });
  });

  describe('POST /gt3/rides/:id/shares', () => {
    it('creates a share with a preset expiresIn', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] }) // ownership check
        .mockResolvedValueOnce({
          rows: [{ token: 'abc', expires_at: new Date(Date.now() + 3600_000), created_at: new Date() }],
        });

      const app = buildApp(USER_SUB);
      const res = await request(app)
        .post(`/gt3/rides/${RIDE_ID}/shares`)
        .send({ expiresIn: '1h' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('abc');
      expect(res.body.status).toBe('active');
      expect(res.body.expiresAt).toBeTruthy();
      // second call inserts with a non-null expires_at
      const insertArgs = mockQuery.mock.calls[1][1];
      expect(insertArgs[1]).toBe(RIDE_ID);
      expect(insertArgs[2]).toBe(USER_SUB);
      expect(insertArgs[3]).toBeInstanceOf(Date);
    });

    it('creates a never-expiring share', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ token: 'neverToken', expires_at: null, created_at: new Date() }],
        });

      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/shares`)
        .send({ expiresIn: 'never' });

      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBeNull();
      expect(mockQuery.mock.calls[1][1][3]).toBeNull();
    });

    it('accepts a custom expiresAt ISO string', async () => {
      const future = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] })
        .mockResolvedValueOnce({
          rows: [{ token: 'custToken', expires_at: new Date(future), created_at: new Date() }],
        });

      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/shares`)
        .send({ expiresAt: future });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('custToken');
    });

    it('rejects past expiresAt', async () => {
      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/shares`)
        .send({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(res.status).toBe(400);
    });

    it('returns 404 when the ride does not belong to the user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(buildApp(OTHER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/shares`)
        .send({ expiresIn: '24h' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /gt3/rides/:id/shares', () => {
    it('returns shares with computed status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] })
        .mockResolvedValueOnce({
          rows: [
            {
              token: 't-active',
              expires_at: new Date(Date.now() + 3600_000),
              revoked_at: null,
              created_at: new Date(),
              last_accessed_at: null,
              access_count: 0,
            },
            {
              token: 't-expired',
              expires_at: new Date(Date.now() - 3600_000),
              revoked_at: null,
              created_at: new Date(),
              last_accessed_at: null,
              access_count: 3,
            },
            {
              token: 't-revoked',
              expires_at: null,
              revoked_at: new Date(),
              created_at: new Date(),
              last_accessed_at: null,
              access_count: 1,
            },
          ],
        });

      const res = await request(buildApp(USER_SUB)).get(`/gt3/rides/${RIDE_ID}/shares`);
      expect(res.status).toBe(200);
      const statuses = res.body.shares.map((s: { status: string }) => s.status);
      expect(statuses).toEqual(['active', 'expired', 'revoked']);
    });
  });

  describe('DELETE /gt3/rides/:id/shares/:token', () => {
    it('revokes a share', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ token: 'abc' }] });
      const res = await request(buildApp(USER_SUB))
        .delete(`/gt3/rides/${RIDE_ID}/shares/abc`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('returns 404 if share does not exist / not owned', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(buildApp(USER_SUB))
        .delete(`/gt3/rides/${RIDE_ID}/shares/unknown`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /gt3/shared/:token (public)', () => {
    it('returns ride data for a valid share token', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            token: 'tok', ride_id: RIDE_ID, expires_at: null, revoked_at: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: RIDE_ID,
            start_time: new Date(),
            end_time: null,
            distance: 10,
            max_speed: 40,
            avg_speed: 20,
            battery_used: 5,
            start_battery: 100,
            end_battery: 95,
            gear_mode: 2,
            gps_track: null,
            health_data: null,
            metadata: null,
            weather_temp: null,
            weather_feels_like: null,
            weather_humidity: null,
            weather_wind_speed: null,
            weather_wind_direction: null,
            weather_condition: null,
            weather_uv_index: null,
            weather_pressure: null,
            created_at: new Date(),
          }],
        })
        .mockResolvedValueOnce({ rows: [] }); // bumpAccess (fire-and-forget)

      // No auth — anonymous request
      const res = await request(buildApp(null)).get('/gt3/shared/tok');
      expect(res.status).toBe(200);
      expect(res.body.ride.id).toBe(RIDE_ID);
      expect(res.body.share.token).toBe('tok');
      // user_sub must never be exposed
      expect(res.body.ride.user_sub).toBeUndefined();
    });

    it('returns 404 for unknown/expired/revoked tokens', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(buildApp(null)).get('/gt3/shared/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /gt3/shared/:token/samples (public)', () => {
    it('returns samples for a valid share token', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            token: 'tok', ride_id: RIDE_ID, expires_at: null, revoked_at: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            timestamp: new Date(),
            speed: 30,
            battery: 90,
            bms_voltage: 0,
            bms_current: 0,
            bms_soc: 0,
            bms_temp: 0,
            body_temp: 0,
            gear_mode: 2,
            trip_distance: 0,
            trip_time: 0,
            range_estimate: 0,
            error_code: 0,
            warn_code: 0,
            regen_level: 0,
            speed_response: 0,
            latitude: 0,
            longitude: 0,
            altitude: 0,
            gps_speed: 0,
            gps_course: 0,
            horizontal_accuracy: 0,
            roughness_score: 0,
            max_acceleration: 0,
            heart_rate: 120,
          }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(null)).get('/gt3/shared/tok/samples');
      expect(res.status).toBe(200);
      expect(res.body.samples).toHaveLength(1);
      expect(res.body.samples[0].heart_rate).toBe(120);
    });
  });
});
