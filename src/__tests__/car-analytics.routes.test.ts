import express from 'express';
import cors from 'cors';
import request from 'supertest';
import { CarAnalyticsService } from '../car-analytics';
import createCarAnalyticsRouter from '../routes/car-analytics.routes';

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

const noopCors = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();

function buildApp(service: CarAnalyticsService) {
  const app = express();
  app.use(createCarAnalyticsRouter(service, noopCors));
  return app;
}

describe('car analytics route', () => {
  it('returns structured analytics', async () => {
    const response = {
      period: { range: '30d' },
      summary: 'You charged twice.',
      charging: { sessionCount: 2 },
      usage: { distanceKm: 100 },
      weather: {},
      comparison: null,
      dataQuality: { coveragePercent: 100 },
    };
    const service = {
      analyze: jest.fn().mockResolvedValue(response),
    } as unknown as CarAnalyticsService;
    const result = await request(buildApp(service))
      .get('/analytics/car?range=30d&topic=charging')
      .expect(200);
    expect(result.body).toEqual(response);
    expect(service.analyze).toHaveBeenCalledWith(expect.objectContaining({
      range: '30d',
      topic: 'charging',
    }));
  });

  it('returns 400 for invalid request parameters', async () => {
    const service = new CarAnalyticsService({
      influxdb: { configured: false } as never,
      bucket: 'fluxhaus',
    });
    const response = await request(buildApp(service))
      .get('/analytics/car?range=forever')
      .expect(400);
    expect(response.body.error).toMatch(/Unsupported range/);
  });

  it('returns 503 when InfluxDB is not configured', async () => {
    const service = new CarAnalyticsService({
      influxdb: { configured: false } as never,
      bucket: 'fluxhaus',
    });
    const response = await request(buildApp(service))
      .get('/analytics/car?range=30d')
      .expect(503);
    expect(response.body.error).toBe('InfluxDB is not configured');
  });

  it('returns 502 without leaking an upstream error', async () => {
    const service = {
      analyze: jest.fn().mockRejectedValue(new Error('token details')),
    } as unknown as CarAnalyticsService;
    const response = await request(buildApp(service))
      .get('/analytics/car')
      .expect(502);
    expect(response.body.error).toBe('Failed to calculate car analytics');
  });

  it('handles browser CORS preflight', async () => {
    const service = {
      analyze: jest.fn(),
    } as unknown as CarAnalyticsService;
    const app = express();
    app.use(createCarAnalyticsRouter(service, cors({
      origin: 'https://haus.fluxhaus.io',
    })));

    const response = await request(app)
      .options('/analytics/car')
      .set('Origin', 'https://haus.fluxhaus.io')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://haus.fluxhaus.io');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
  });
});
