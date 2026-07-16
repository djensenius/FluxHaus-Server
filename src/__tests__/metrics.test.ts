import express from 'express';
import request from 'supertest';
import { METRIC_CATALOG, createMetricsRouter } from '../metrics';

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

function buildApp(deps: Parameters<typeof createMetricsRouter>[0]) {
  const app = express();
  app.use(createMetricsRouter(deps, noopCors));
  return app;
}

describe('metrics router', () => {
  it('returns the metric catalog', async () => {
    const app = buildApp({});
    const res = await request(app).get('/metrics/catalog').expect(200);
    expect(Array.isArray(res.body.metrics)).toBe(true);
    expect(res.body.metrics).toHaveLength(METRIC_CATALOG.length);
    expect(res.body.metrics[0]).toHaveProperty('id');
    expect(res.body.metrics[0]).toHaveProperty('group');
  });

  it('returns 400 for an unknown metric id', async () => {
    const app = buildApp({});
    const res = await request(app).get('/metrics/series?metric=does_not_exist').expect(400);
    expect(res.body.error).toMatch(/Unknown metric/);
  });

  it('returns 200 with series for a valid influx metric', async () => {
    const influxdb = {
      configured: true,
      query: jest.fn().mockResolvedValue([
        {
          _time: '2024-01-01T00:00:00Z', _value: '21.5', room: 'Bedroom',
        },
      ]),
    };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    const res = await request(app).get('/metrics/series?metric=temperature').expect(200);
    expect(res.body.metric).toBe('temperature');
    expect(res.body.series.length).toBeGreaterThan(0);
  });

  it('returns 502 when the upstream influx query fails', async () => {
    const influxdb = {
      configured: true,
      query: jest.fn().mockRejectedValue(new Error('influx down')),
    };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    const res = await request(app).get('/metrics/series?metric=temperature').expect(502);
    expect(res.body.error).toBe('Failed to fetch metric series');
  });
});
