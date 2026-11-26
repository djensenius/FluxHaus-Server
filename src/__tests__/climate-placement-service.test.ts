import express from 'express';
import request from 'supertest';
import {
  buildPlacementQuery,
  ClimatePlacementService,
  parseClimateHistory,
  parsePlacementDays,
  PLACEMENT_CACHE_TTL_MS,
  PLACEMENT_DEGRADED_TTL_MS,
  resolveTimeZone,
  rowsToSeries,
  toCelsius,
} from '../climate-placement-service';
import { detectHvacEvents } from '../climate-placement';
import createClimatePlacementRouter from '../routes/climate-placement.routes';

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

const NOW = new Date('2026-01-20T00:00:00Z');

function sensor(entityId: string, name: string, isThermostat = false) {
  return {
    entityId, name, isThermostat, area: null, temperature: 20, unit: '°C', available: true, occupied: null, lastUpdated: null,
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const influxdb = {
    configured: true,
    query: vi.fn().mockResolvedValue([
      { _time: '2026-01-19T06:00:00Z', _value: '18.5', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:00:00Z', _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ]),
  };
  const homeAssistant = {
    getHistory: vi.fn().mockResolvedValue([[
      {
        state: 'heat',
        attributes: {
          hvac_action: 'heating', preset_mode: 'home', temperature: 21, current_temperature: 20,
        },
        last_updated: '2026-01-19T06:00:00Z',
      },
    ]]),
  };
  const indoorClimate = {
    cachedStatus: {
      timestamp: NOW,
      thermostat: { entityId: 'climate.home', temperatureUnit: '°C' },
      sensors: [
        sensor('sensor.home_current_temperature', 'Home', true),
        sensor('sensor.office_temperature', 'Office'),
        sensor('sensor.kitchen_temperature', 'Kitchen'),
        sensor('sensor.patio_environment_canada_temperature', 'Outside'),
      ],
      unit: '°C',
    },
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  let now = NOW.getTime();
  const deps = {
    influxdb, homeAssistant, indoorClimate, bucket: 'fluxhaus', timeZone: 'UTC', now: () => new Date(now), ...overrides,
  };
  return {
    deps,
    influxdb,
    homeAssistant,
    advance: (ms: number) => { now += ms; },
    service: new ClimatePlacementService(deps as never),
  };
}

describe('parsePlacementDays', () => {
  it('defaults to 14 and accepts 3–30', () => {
    expect(parsePlacementDays(undefined)).toBe(14);
    expect(parsePlacementDays('3')).toBe(3);
    expect(parsePlacementDays('30')).toBe(30);
  });

  it.each(['2', '31', '7.5', 'abc', '', '-5', ['7', '8']])('rejects %j', (value) => {
    expect(() => parsePlacementDays(value)).toThrow('days must be an integer from 3 to 30');
  });
});

describe('parseClimateHistory', () => {
  it('reads mode, set points, preset and action, converting °F, and keeps gaps', () => {
    expect(parseClimateHistory([[
      {
        state: 'heat', attributes: { temperature: 68, preset_mode: 'Home', hvac_action: 'heating' }, last_updated: '2026-01-19T06:00:00Z',
      },
      {
        state: 'heat_cool', attributes: { target_temp_low: 59, target_temp_high: 77 }, last_changed: '2026-01-19T07:00:00Z',
      },
      { state: 'unavailable', attributes: {}, last_updated: '2026-01-19T08:00:00Z' },
      { state: 'unknown', attributes: {}, last_updated: '2026-01-19T09:00:00Z' },
    ]], '°F')).toEqual([
      {
        t: Date.parse('2026-01-19T06:00:00Z'), gap: false, hvacMode: 'heat', setpoint: 20, presetMode: 'Home', hvacAction: 'heating',
      },
      {
        t: Date.parse('2026-01-19T07:00:00Z'), gap: false, hvacMode: 'heat_cool', setpoint: 15, presetMode: null, hvacAction: null,
      },
      {
        t: Date.parse('2026-01-19T08:00:00Z'), gap: true, hvacMode: null, setpoint: null, presetMode: null, hvacAction: null,
      },
      {
        t: Date.parse('2026-01-19T09:00:00Z'), gap: true, hvacMode: null, setpoint: null, presetMode: null, hvacAction: null,
      },
    ]);
  });

  it('does not read a return or heating start across unavailable history', () => {
    const samples = parseClimateHistory([[
      { state: 'heat', attributes: { preset_mode: 'away', hvac_action: 'idle', temperature: 17 }, last_updated: '2026-01-19T04:30:00Z' },
      { state: 'unavailable', attributes: {}, last_updated: '2026-01-19T05:00:00Z' },
      { state: 'heat', attributes: { preset_mode: 'home', hvac_action: 'heating', temperature: 21 }, last_updated: '2026-01-19T06:00:00Z' },
    ]], '°C');
    expect(detectHvacEvents(samples, 'UTC')).toEqual([]);
  });

  it('treats implausible converted set points as unknown', () => {
    // A history recorded in °F read as °C (or vice versa) can't be trusted.
    expect(parseClimateHistory([[
      { state: 'heat', attributes: { temperature: 70, hvac_action: 'idle' }, last_updated: '2026-01-19T06:00:00Z' },
    ]], '°C')[0].setpoint).toBeNull();
  });

  it('drops set points whose unit is unknown', () => {
    expect(parseClimateHistory([[
      { state: 'heat', attributes: { temperature: 21, hvac_action: 'idle' }, last_updated: '2026-01-19T06:00:00Z' },
    ]], null)[0].setpoint).toBeNull();
  });

  it('treats unexpected payloads as empty', () => {
    expect(parseClimateHistory({}, '°C')).toEqual([]);
    expect(parseClimateHistory([], '°C')).toEqual([]);
  });
});

describe('temperature units', () => {
  const sensors = [
    { id: 'office_temperature', name: 'Office', isThermostat: false },
    { id: 'den_temperature', name: 'Den', isThermostat: false },
  ];

  it('converts by measurement unit, else the unit recorded with the reading, and drops unknown units', () => {
    const { series, unknownUnitReadings } = rowsToSeries([
      {
        _time: '2026-01-19T06:00:00Z', _value: '68', _measurement: '°F', unit: '', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-19T06:00:00Z', _value: '20', _measurement: 'climate', unit: '', entity_id: 'den_temperature',
      },
      {
        _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: '°C', unit: '', entity_id: 'den_temperature',
      },
      {
        _time: '2026-01-19T06:30:00Z', _value: '20', _measurement: 'climate', unit: 'K', entity_id: 'den_temperature',
      },
    ], sensors);
    expect(series.map((s) => s.points.map((p) => p.v))).toEqual([[20], [20]]);
    expect(unknownUnitReadings).toBe(2);
  });

  it('converts each reading by its own recorded unit across a unit change', () => {
    // The sensor switched from °F to °C; the overridden `climate` measurement
    // keeps both, each tagged with the unit Home Assistant recorded then.
    const { series, unknownUnitReadings } = rowsToSeries([
      {
        _time: '2026-01-10T06:00:00Z', _value: '68', _measurement: 'climate', unit: '°F', entity_id: 'office_temperature',
      },
      // A window spanning the change is averaged per unit, so it yields two points.
      {
        _time: '2026-01-11T06:00:00Z', _value: '69.8', _measurement: 'climate', unit: '°F', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T06:00:00Z', _value: '21', _measurement: 'climate', unit: '°C', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-12T06:00:00Z', _value: '22', _measurement: 'climate', unit: '°C', entity_id: 'office_temperature',
      },
    ], sensors);
    expect(series[0].points.map((p) => Math.round(p.v * 10) / 10)).toEqual([20, 21, 21, 22]);
    expect(unknownUnitReadings).toBe(0);
  });

  it('only converts known units', () => {
    expect(toCelsius(212, '°F')).toBe(100);
    expect(toCelsius(20, '°C')).toBe(20);
    expect(toCelsius(20, 'K')).toBeNull();
    expect(toCelsius(20, null)).toBeNull();
  });
});

describe('resolveTimeZone', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('prefers an explicit zone, then TZ, then the system zone', () => {
    process.env.TZ = 'America/Toronto';
    expect(resolveTimeZone('Europe/Paris')).toBe('Europe/Paris');
    expect(resolveTimeZone()).toBe('America/Toronto');
    delete process.env.TZ;
    expect(resolveTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('skips invalid zones', () => {
    delete process.env.TZ;
    expect(resolveTimeZone('Not/AZone')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('ClimatePlacementService', () => {
  it('queries indoor sensors only, over the requested window', async () => {
    const { service, influxdb, homeAssistant } = makeDeps();
    const result = await service.getInsights('7');
    expect(result.windowDays).toBe(7);
    expect(result.coverage.start).toBe('2026-01-13T00:00:00.000Z');
    expect(result.sensors.map((s) => s.id)).toEqual(['home_current_temperature', 'office_temperature', 'kitchen_temperature']);
    const flux = influxdb.query.mock.calls[0][0] as string;
    expect(flux).toContain('"home_current_temperature", "office_temperature", "kitchen_temperature"');
    expect(flux).not.toContain('patio');
    expect(flux).toContain('range(start: time(v: "2026-01-13T00:00:00.000Z"), stop: time(v: "2026-01-20T00:00:00.000Z"))');
    expect(homeAssistant.getHistory).toHaveBeenCalledWith(
      'climate.home',
      '2026-01-13T00:00:00.000Z',
      '2026-01-20T00:00:00.000Z',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.coverage.hvacHistoryAvailable).toBe(true);
  });

  it('caches results per window for 15 minutes', async () => {
    const { service, influxdb, advance } = makeDeps();
    await service.getInsights('14');
    await service.getInsights('14');
    expect(influxdb.query).toHaveBeenCalledTimes(1);
    await service.getInsights('7');
    expect(influxdb.query).toHaveBeenCalledTimes(2);
    advance(PLACEMENT_CACHE_TTL_MS + 1);
    await service.getInsights('14');
    expect(influxdb.query).toHaveBeenCalledTimes(3);
  });

  it('degrades when Home Assistant history fails and retries sooner', async () => {
    const { service, homeAssistant, advance } = makeDeps();
    homeAssistant.getHistory.mockRejectedValue(new Error('recorder down'));
    const result = await service.getInsights(undefined);
    expect(result.coverage.hvacHistoryAvailable).toBe(false);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights(undefined);
    expect(homeAssistant.getHistory).toHaveBeenCalledTimes(2);
  });

  it('retries discovery and treats a missing thermostat as degraded', async () => {
    const { service, deps, influxdb, advance } = makeDeps();
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, thermostat: null } as never;
    const result = await service.getInsights('14');
    expect(deps.indoorClimate.refresh).toHaveBeenCalledTimes(1);
    expect(result.coverage.hvacHistoryAvailable).toBe(false);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('14');
    expect(influxdb.query).toHaveBeenCalledTimes(2);
  });

  it('retries soon when discovery found no sensors', async () => {
    const { service, deps, influxdb, advance } = makeDeps();
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, sensors: [] } as never;
    const result = await service.getInsights('14');
    expect(deps.indoorClimate.refresh).toHaveBeenCalled();
    expect(result.sensors).toEqual([]);
    expect(influxdb.query).not.toHaveBeenCalled();
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, sensors: [sensor('sensor.office_temperature', 'Office')] } as never;
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    const retried = await service.getInsights('14');
    expect(retried.sensors.map((s) => s.id)).toEqual(['office_temperature']);
  });

  it('reports readings dropped for an unknown unit in coverage', async () => {
    const { service, influxdb } = makeDeps();
    influxdb.query.mockResolvedValue([
      {
        _time: '2026-01-19T06:00:00Z', _value: '18.5', _measurement: 'climate', unit: '', entity_id: 'office_temperature',
      },
    ]);
    const result = await service.getInsights('14');
    expect(result.coverage.unknownUnitReadings).toBe(1);
    expect(result.sensors.every((s) => s.sampleCount === 0)).toBe(true);
  });

  it('degrades to empty analysis when InfluxDB fails', async () => {
    const { service, influxdb } = makeDeps();
    influxdb.query.mockRejectedValue(new Error('influx down'));
    const result = await service.getInsights('14');
    expect(result.sensors.every((s) => s.sampleCount === 0 && s.classification === 'insufficient')).toBe(true);
    expect(result.recommendations).toEqual([]);
  });

  it('builds a safe Flux query limited to sensor entities in any temperature unit', () => {
    const flux = buildPlacementQuery('fluxhaus', ['office_temperature', 'bad"id'], new Date(0), new Date(1000));
    expect(flux).toContain('from(bucket: "fluxhaus")');
    expect(flux).toContain('r.domain == "sensor" and contains(value: r.entity_id, set: ["office_temperature"])');
    expect(flux).toContain('r._measurement == "°F"');
    expect(flux).toContain('r._field == "value" or r._field == "unit_of_measurement_str"');
    expect(flux).toContain('pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")');
    expect(flux).toContain('group(columns: ["domain", "entity_id", "_measurement", "unit"])');
    expect(flux).toContain('aggregateWindow(every: 15m, fn: mean, createEmpty: false, timeSrc: "_start")');
  });
});

describe('GET /climate/placement-insights', () => {
  function buildApp(service: ClimatePlacementService, role: string | null = 'admin') {
    const app = express();
    app.use((req, _res, next) => {
      if (role) req.user = { role, username: role } as never;
      next();
    });
    app.use(createClimatePlacementRouter(service, (_req, _res, next) => next()));
    return app;
  }

  it('returns insights', async () => {
    const { service } = makeDeps();
    const response = await request(buildApp(service)).get('/climate/placement-insights').expect(200);
    expect(response.body).toMatchObject({ windowDays: 14, unit: '°C', coverage: { hvacHistoryAvailable: true } });
    expect(Array.isArray(response.body.sensors)).toBe(true);
    expect(Array.isArray(response.body.recommendations)).toBe(true);
  });

  it.each(['2', '31', 'abc'])('returns 400 for days=%s', async (days) => {
    const { service } = makeDeps();
    const response = await request(buildApp(service)).get(`/climate/placement-insights?days=${days}`).expect(400);
    expect(response.body.error).toBe('days must be an integer from 3 to 30');
  });

  it('returns 503 when InfluxDB is not configured', async () => {
    const { service } = makeDeps({ influxdb: { configured: false } });
    const response = await request(buildApp(service)).get('/climate/placement-insights').expect(503);
    expect(response.body.error).toBe('InfluxDB is not configured');
  });

  it('returns 403 for roles without indoor climate access', async () => {
    const { service } = makeDeps();
    await request(buildApp(service, 'rhizome')).get('/climate/placement-insights').expect(403);
    await request(buildApp(service, null)).get('/climate/placement-insights').expect(403);
  });

  it('allows demo users', async () => {
    const { service } = makeDeps();
    await request(buildApp(service, 'demo')).get('/climate/placement-insights').expect(200);
  });
});
