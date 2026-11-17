import express from 'express';
import request from 'supertest';
import { METRIC_CATALOG, createMetricsRouter } from '../metrics';

vi.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
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

  it('applies seriesRename to relabel the outdoor series as "Outside"', async () => {
    const influxdb = {
      configured: true,
      query: vi.fn().mockResolvedValue([
        {
          _time: '2024-01-01T00:00:00Z', _value: '18.2', friendly_name: 'Environment Canada Temperature',
        },
      ]),
    };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    const res = await request(app).get('/metrics/series?metric=temperature').expect(200);
    expect(res.body.series).toEqual([
      { name: 'Outside', points: [{ t: '2024-01-01T00:00:00Z', v: 18.2 }] },
    ]);
  });

  it('exposes Energy and Outdoor metric groups in the catalog', async () => {
    const app = buildApp({});
    const res = await request(app).get('/metrics/catalog').expect(200);
    const groups = new Set(res.body.metrics.map((m: { group: string }) => m.group));
    expect(groups.has('Energy')).toBe(true);
    expect(groups.has('Outdoor')).toBe(true);
    const ids = res.body.metrics.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['power_draw', 'aqhi', 'outdoor_air_quality']));
  });

  it('returns 200 with series for a valid influx metric', async () => {
    const influxdb = {
      configured: true,
      query: vi.fn().mockResolvedValue([
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
    const query = vi.fn().mockResolvedValue([]);
    const influxdb = { configured: true, query };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    await request(app).get('/metrics/series?metric=temperature').expect(200);
    const flux = query.mock.calls[0][0] as string;
    expect(flux).toContain('r._measurement == "climate"');
    expect(flux).toContain('contains(value: r.entity_id');
    expect(flux).toContain('bedroom_temperature');
  });

  it('merges, dedupes and sanitizes dynamic entity ids into the Flux filter', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const app = buildApp({
      influxdb: { configured: true, query } as never,
      bucket: 'fluxhaus',
      dynamicEntityIds: {
        temperature: () => ['office_temperature', 'bedroom_temperature', 'x"]) |> drop(columns: ["y', 'Upper'],
      },
    });
    await request(app).get('/metrics/series?metric=temperature').expect(200);
    const flux = query.mock.calls[0][0] as string;
    expect(flux).toContain(
      'set: ["bedroom_temperature", "kitchen_temperature", "living_room_temperature", '
      + '"home_current_temperature", "patio_environment_canada_temperature", "office_temperature"]',
    );
    expect(flux).not.toContain('drop(');
    expect(flux).not.toContain('Upper');
  });

  it('falls back to the static entity ids when the dynamic provider throws', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const app = buildApp({
      influxdb: { configured: true, query } as never,
      bucket: 'fluxhaus',
      dynamicEntityIds: {
        temperature: () => { throw new Error('not ready'); },
      },
    });
    await request(app).get('/metrics/series?metric=temperature').expect(200);
    expect(query.mock.calls[0][0]).toContain(
      'set: ["bedroom_temperature", "kitchen_temperature", "living_room_temperature", '
      + '"home_current_temperature", "patio_environment_canada_temperature"]',
    );
  });

  it('ORs together multiple measurements for a metric', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const app = buildApp({ influxdb: { configured: true, query } as never, bucket: 'fluxhaus' });
    await request(app).get('/metrics/series?metric=temperature').expect(200);
    await request(app).get('/metrics/series?metric=humidity').expect(200);
    const multi = query.mock.calls[0][0] as string;
    const single = query.mock.calls[1][0] as string;
    expect(multi).toContain(
      'filter(fn: (r) => (r._measurement == "climate" or r._measurement == "°C") and r._field == "value")',
    );
    expect(multi).toMatch(
      /contains\(value: r\.entity_id[^\n]*\n {2}\|> group\(columns: \["entity_id", "friendly_name"\]\)\n {2}\|> aggregateWindow\(/,
    );
    expect(single).toContain(
      'filter(fn: (r) => r._measurement == "climate" and r._field == "value")',
    );
    expect(single).not.toContain('group(');
  });

  it('returns 502 when the upstream influx query fails', async () => {
    const influxdb = {
      configured: true,
      query: vi.fn().mockRejectedValue(new Error('influx down')),
    };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    const res = await request(app).get('/metrics/series?metric=temperature').expect(502);
    expect(res.body.error).toBe('Failed to fetch metric series');
  });

  it('returns series from a Prometheus-backed metric', async () => {
    const client = {
      configured: true,
      queryRange: vi.fn().mockResolvedValue({
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
    const client = { configured: false, queryRange: vi.fn() };
    const app = buildApp({ prometheus: client as never });
    const res = await request(app).get('/metrics/series?metric=cpu_usage').expect(200);
    expect(client.queryRange).not.toHaveBeenCalled();
    expect(res.body.series).toEqual([]);
  });

  it('returns 502 when Prometheus responds with an error status', async () => {
    const client = {
      configured: true,
      queryRange: vi.fn().mockResolvedValue({
        status: 'error', errorType: 'bad_data', error: 'invalid query',
      }),
    };
    const app = buildApp({ prometheus: client as never });
    const res = await request(app).get('/metrics/series?metric=cpu_usage').expect(502);
    expect(res.body.error).toBe('Failed to fetch metric series');
  });

  it('uses last() aggregation for the monotonic car odometer', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const influxdb = { configured: true, query };
    const app = buildApp({ influxdb: influxdb as never, bucket: 'fluxhaus' });
    await request(app).get('/metrics/series?metric=car_odometer').expect(200);
    const flux = query.mock.calls[0][0] as string;
    expect(flux).toContain('fn: last');
  });
});
