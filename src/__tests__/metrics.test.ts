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
          _time: '2024-01-01T00:00:00Z', _value: '21.5', friendly_name: 'Bedroom Temperature',
        },
      ]),
    };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    const res = await request(app).get('/metrics/series?metric=temperature').expect(200);
    expect(res.body.metric).toBe('temperature');
    expect(res.body.series).toEqual([
      { name: 'Bedroom Temperature', points: [{ t: '2024-01-01T00:00:00Z', v: 21.5 }] },
    ]);
  });

  it('applies an entity_id filter for room-scoped influx metrics', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const influxdb = { configured: true, query };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    await request(app).get('/metrics/series?metric=temperature').expect(200);
    const flux = query.mock.calls[0][0] as string;
    expect(flux).toContain('r._measurement == "climate"');
    expect(flux).toContain('contains(value: r.entity_id');
    expect(flux).toContain('bedroom_temperature');
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

  it('returns series from a Prometheus-backed metric', async () => {
    const client = {
      configured: true,
      queryRange: jest.fn().mockResolvedValue({
        data: {
          result: [
            { metric: { instance: 'node-1' }, values: [[1704067200, '12.5']] },
          ],
        },
      }),
    };
    const app = buildApp({ prometheus: client as never });
    const res = await request(app).get('/metrics/series?metric=cpu_usage').expect(200);
    expect(client.queryRange).toHaveBeenCalled();
    expect(res.body.series).toEqual([
      { name: 'node-1', points: [{ t: '2024-01-01T00:00:00.000Z', v: 12.5 }] },
    ]);
  });

  it('skips unconfigured Prometheus backends', async () => {
    const client = { configured: false, queryRange: jest.fn() };
    const app = buildApp({ prometheus: client as never });
    const res = await request(app).get('/metrics/series?metric=cpu_usage').expect(200);
    expect(client.queryRange).not.toHaveBeenCalled();
    expect(res.body.series).toEqual([]);
  });

  it('returns 502 when Prometheus responds with an error status', async () => {
    const client = {
      configured: true,
      queryRange: jest.fn().mockResolvedValue({
        status: 'error', errorType: 'bad_data', error: 'invalid query',
      }),
    };
    const app = buildApp({ prometheus: client as never });
    const res = await request(app).get('/metrics/series?metric=cpu_usage').expect(502);
    expect(res.body.error).toBe('Failed to fetch metric series');
  });

  it('uses last() aggregation for the monotonic car odometer', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const influxdb = { configured: true, query };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    await request(app).get('/metrics/series?metric=car_odometer').expect(200);
    const flux = query.mock.calls[0][0] as string;
    expect(flux).toContain('fn: last');
  });
});
