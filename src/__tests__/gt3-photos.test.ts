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
const RIDE_ID = '11111111-1111-1111-1111-111111111111';
const PHOTO_ID = '22222222-2222-2222-2222-222222222222';
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);

function buildApp(userSub: string | null) {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/gt3', gt3PublicRouter);
  app.use('/gt3', (req, _res, next) => {
    if (userSub) req.user = { sub: userSub, role: 'admin', username: 'u' };
    next();
  }, gt3Router);
  return app;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: new Date().toISOString(),
    latitude: 43.6532,
    longitude: -79.3832,
    mimeType: 'image/jpeg',
    imageData: jpegBytes.toString('base64'),
    ...overrides,
  };
}

describe('GT3 ride photos', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    (getPool as jest.Mock).mockReturnValue({ query: mockQuery, connect: jest.fn() });
  });

  describe('POST /gt3/rides/:id/photos', () => {
    it('stores a validated JPEG photo for an owned ride', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: PHOTO_ID }] });

      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, id: PHOTO_ID });
      expect(mockQuery.mock.calls[0][1]).toEqual([RIDE_ID, USER_SUB]);
      const insertArgs = mockQuery.mock.calls[2][1];
      expect(insertArgs[0]).toBe(RIDE_ID);
      expect(insertArgs[1]).toBe(USER_SUB);
      expect(insertArgs[5]).toBe('image/jpeg');
      expect(Buffer.isBuffer(insertArgs[6])).toBe(true);
      expect(insertArgs[6]).toEqual(jpegBytes);
    });

    it('requires an authenticated OIDC user', async () => {
      const res = await request(buildApp(null))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload());

      expect(res.status).toBe(401);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 404 when the ride is not owned by the user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload());

      expect(res.status).toBe(404);
    });

    it('rejects unsupported mime types', async () => {
      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ mimeType: 'image/png' }));

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects invalid base64 and non-JPEG bytes', async () => {
      const invalidBase64 = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ imageData: 'not base64' }));
      expect(invalidBase64.status).toBe(400);

      const nonJPEG = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ imageData: Buffer.from('hello').toString('base64') }));
      expect(nonJPEG.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects invalid dates and coordinates', async () => {
      const badDate = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ capturedAt: 'not-a-date' }));
      expect(badDate.status).toBe(400);

      const badLatitude = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ latitude: 91 }));
      expect(badLatitude.status).toBe(400);

      const missingLongitude = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload({ longitude: null }));
      expect(missingLongitude.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('enforces the per-ride photo cap', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: RIDE_ID }] })
        .mockResolvedValueOnce({ rows: [{ count: 200 }] });

      const res = await request(buildApp(USER_SUB))
        .post(`/gt3/rides/${RIDE_ID}/photos`)
        .send(validPayload());

      expect(res.status).toBe(409);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /gt3/rides/:id/photos', () => {
    it('returns metadata without image bytes', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          ride_id: RIDE_ID,
          id: PHOTO_ID,
          captured_at: new Date(),
          latitude: 43,
          longitude: -79,
          mime_type: 'image/jpeg',
          byte_length: jpegBytes.length,
          created_at: new Date(),
        }],
      });

      const res = await request(buildApp(USER_SUB)).get(`/gt3/rides/${RIDE_ID}/photos`);

      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
      expect(res.body.photos[0].id).toBe(PHOTO_ID);
      expect(res.body.photos[0].imageData).toBeUndefined();
      expect(mockQuery.mock.calls[0][1]).toEqual([RIDE_ID, USER_SUB]);
    });
  });

  describe('GET /gt3/rides/:id/photos/:photoId', () => {
    it('returns owned photo bytes with safe headers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: PHOTO_ID,
          captured_at: new Date(),
          mime_type: 'image/jpeg',
          image_data: jpegBytes,
          created_at: new Date(),
        }],
      });

      const res = await request(buildApp(USER_SUB))
        .get(`/gt3/rides/${RIDE_ID}/photos/${PHOTO_ID}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/jpeg');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toEqual(jpegBytes);
      expect(mockQuery.mock.calls[0][1]).toEqual([PHOTO_ID, RIDE_ID, USER_SUB]);
    });
  });

  describe('public shared ride photos', () => {
    it('includes photo metadata in shared ride responses without raw bytes', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'share-id', ride_id: RIDE_ID, expires_at: null, revoked_at: null,
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
            created_at: new Date(),
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: PHOTO_ID,
            captured_at: new Date(),
            latitude: 43,
            longitude: -79,
            mime_type: 'image/jpeg',
            byte_length: jpegBytes.length,
            created_at: new Date(),
          }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(null)).get('/gt3/shared/raw-token');

      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
      expect(res.body.photos[0].imageData).toBeUndefined();
      expect(res.body.share.token).toBeUndefined();
    });

    it('serves shared photo bytes only when the photo belongs to the shared ride', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            share_id: 'share-id',
            id: PHOTO_ID,
            captured_at: new Date(),
            mime_type: 'image/jpeg',
            image_data: jpegBytes,
            created_at: new Date(),
          }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(null)).get(`/gt3/shared/token/photos/${PHOTO_ID}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/jpeg');
      expect(mockQuery.mock.calls[0][0]).toContain('JOIN gt3_ride_photos p ON p.ride_id = s.ride_id');
      expect(mockQuery.mock.calls[0][1][1]).toBe(PHOTO_ID);
    });

    it('returns 404 for expired, revoked, unknown, or mismatched shared photos', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(null)).get(`/gt3/shared/token/photos/${PHOTO_ID}`);

      expect(res.status).toBe(404);
    });
  });
});
