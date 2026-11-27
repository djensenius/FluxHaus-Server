import express from 'express';
import request from 'supertest';
import {
  buildLastCoolingQuery,
  buildPlacementQuery,
  buildStatesQuery,
  ClimatePlacementService,
  occupancyId,
  parsePlacementConfig,
  parsePlacementDays,
  parseStates,
  PLACEMENT_CACHE_MAX_ENTRIES,
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

type Rows = Record<string, string>[];

const climateRow = (time: string, field: string, value: string) => ({
  _time: time, _field: field, _value: value, domain: 'climate', entity_id: 'home',
});

const queryKind = (flux: string) => {
  if (flux.includes('union(')) return 'states';
  if (flux.includes('r._value == "cooling"')) return 'cooling';
  return 'temperatures';
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const rows: Record<'temperatures' | 'states' | 'cooling', Rows | Error> = {
    temperatures: [
      { _time: '2026-01-19T06:00:00Z', _value: '20', _measurement: '°C', entity_id: 'home_current_temperature' },
      { _time: '2026-01-19T06:00:00Z', _value: '18.5', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:00:00Z', _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ],
    states: [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
      {
        _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode',
      },
    ],
    cooling: [],
  };
  const influxdb = {
    configured: true,
    query: vi.fn(async (flux: string) => {
      const result = rows[queryKind(flux)];
      if (result instanceof Error) throw result;
      return result;
    }),
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
    influxdb, indoorClimate, bucket: 'fluxhaus', timeZone: 'UTC', now: () => new Date(now), ...overrides,
  };
  const calls = (kind: string) => influxdb.query.mock.calls.filter(([flux]) => queryKind(flux) === kind).map(([flux]) => flux);
  return {
    deps,
    influxdb,
    rows,
    calls,
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

describe('parsePlacementConfig', () => {
  it('is null without participation parameters', () => {
    expect(parsePlacementConfig({})).toBeNull();
    expect(parsePlacementConfig({ days: '7' })).toBeNull();
  });

  it('reads sorted, de-duplicated ids, an empty list as none, and followMe', () => {
    expect(parsePlacementConfig({
      home: 'living_temperature,bedroom_temperature,living_temperature', sleep: '', followMe: 'true',
    })).toEqual({
      home: ['bedroom_temperature', 'living_temperature'], sleep: [], away: null, followMe: true,
    });
    expect(parsePlacementConfig({ followMe: 'false' })).toEqual({
      home: null, sleep: null, away: null, followMe: false,
    });
  });

  it.each([
    [{ home: 'bad"id' }, 'home must be a comma-separated list of sensor ids'],
    [{ sleep: 'a,,b' }, 'sleep must be a comma-separated list of sensor ids'],
    [{ away: ['a', 'b'] }, 'away must be a comma-separated list of sensor ids'],
    [{ followMe: 'yes' }, 'followMe must be true or false'],
    [{ followMe: ['true'] }, 'followMe must be true or false'],
  ])('rejects %j', (query, message) => {
    expect(() => parsePlacementConfig(query)).toThrow(message);
  });
});

describe('thermostat, comfort and occupancy history', () => {
  const entities = {
    climate: 'home', comfort: 'home_current_mode', occupancy: ['home_occupancy', 'bedroom_occupancy'],
  };

  it('maps temperature sensors to their occupancy entities', () => {
    expect(occupancyId('home_current_temperature')).toBe('home_occupancy');
    expect(occupancyId('living_room_temperature')).toBe('living_room_occupancy');
  });

  it('reads set points per change, carries mode and action forward, converts °F and keeps gaps', () => {
    const parsed = parseStates([
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '68'),
      climateRow('2026-01-19T07:00:00Z', 'state', 'heat_cool'),
      climateRow('2026-01-19T07:00:00Z', 'target_temp_low_str', '59'),
      climateRow('2026-01-19T07:00:00Z', 'target_temp_high_str', '77'),
      climateRow('2026-01-19T08:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T09:00:00Z', 'state', 'cool'),
      climateRow('2026-01-19T09:00:00Z', 'temperature', '77'),
      climateRow('2026-01-19T10:00:00Z', 'state', 'unavailable'),
    ], entities, '°F');
    expect(parsed.hvac).toEqual([
      {
        t: Date.parse('2026-01-19T06:00:00Z'), gap: false, hvacMode: 'heat', hvacAction: 'heating', presetMode: null, setpoint: 20, coolSetpoint: null,
      },
      {
        t: Date.parse('2026-01-19T07:00:00Z'), gap: false, hvacMode: 'heat_cool', hvacAction: 'heating', presetMode: null, setpoint: 15, coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T08:00:00Z'), gap: false, hvacMode: 'heat_cool', hvacAction: 'idle', presetMode: null, setpoint: 15, coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T09:00:00Z'), gap: false, hvacMode: 'cool', hvacAction: 'idle', presetMode: null, setpoint: 25, coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T10:00:00Z'), gap: true, hvacMode: null, hvacAction: null, presetMode: null, setpoint: null,
      },
    ]);
  });

  it('carries prior climate fields across distinct timestamps', () => {
    const parsed = parseStates([
      climateRow('2026-01-19T05:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T05:20:00Z', 'preset_mode_str', 'home'),
      climateRow('2026-01-19T05:30:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T05:45:00Z', 'temperature', '21'),
    ], entities, '°C');
    expect(parsed.hvac!.at(-1)).toMatchObject({
      gap: false, hvacMode: 'heat', hvacAction: 'heating', presetMode: 'home', setpoint: 21,
    });
  });

  it('carries the preset forward as a fallback comfort setting', () => {
    const parsed = parseStates([
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'preset_mode_str', 'away'),
      climateRow('2026-01-19T07:00:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T08:00:00Z', 'preset_mode_str', 'home'),
      climateRow('2026-01-19T09:00:00Z', 'preset_mode_str', 'none'),
    ], entities, '°C');
    expect(parsed.hvac!.map((s) => s.presetMode)).toEqual(['away', 'away', 'home', null]);
    const flux = buildStatesQuery('fluxhaus', entities, new Date(0), new Date(1));
    expect(flux).toContain('r._field == "preset_mode" or r._field == "preset_mode_str"');
  });

  it('keeps unavailable occupancy as unknown rather than carrying the last value', () => {
    const occupancyRow = (time: string, field: string, value: string) => ({
      _time: time, _field: field, _value: value, domain: 'binary_sensor', entity_id: 'bedroom_occupancy',
    });
    const parsed = parseStates([
      occupancyRow('2026-01-19T11:00:00Z', 'value', '1'),
      occupancyRow('2026-01-19T12:00:00Z', 'state', 'unavailable'),
      occupancyRow('2026-01-19T13:00:00Z', 'state', 'off'),
    ], entities, '°C');
    expect(parsed.occupancy.get('bedroom_occupancy')).toEqual([
      { t: Date.parse('2026-01-19T11:00:00Z'), occupied: true },
      { t: Date.parse('2026-01-19T12:00:00Z'), occupied: null },
      { t: Date.parse('2026-01-19T13:00:00Z'), occupied: false },
    ]);
    const flux = buildStatesQuery('fluxhaus', { ...entities, occupancy: ['bedroom_occupancy'] }, new Date(0), new Date(1));
    expect(flux).toContain('(r._field == "value" or r._field == "state")');
  });

  it('does not read a heating start across unavailable history', () => {
    const samples = parseStates([
      climateRow('2026-01-19T04:30:00Z', 'state', 'heat'),
      climateRow('2026-01-19T04:30:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T04:30:00Z', 'temperature', '17'),
      climateRow('2026-01-19T05:00:00Z', 'state', 'unavailable'),
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
    ], entities, '°C').hvac!;
    expect(detectHvacEvents(samples, 'UTC')).toEqual([]);
  });

  it('treats unknown or unavailable HVAC actions as unknown', () => {
    const rows = (sentinel: string, before: string, after: string) => [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', before),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
      climateRow('2026-01-19T06:30:00Z', 'hvac_action_str', sentinel),
      climateRow('2026-01-19T07:00:00Z', 'hvac_action_str', after),
    ];
    ['unknown', 'unavailable'].forEach((sentinel) => {
      // Unknown → heating isn't a heating start.
      const start = parseStates(rows(sentinel, 'idle', 'heating'), entities, '°C').hvac!;
      expect(start.map((s) => s.hvacAction)).toEqual(['idle', null, 'heating']);
      expect(detectHvacEvents(start, 'UTC')).toEqual([]);
      // Heating → unknown isn't a reported (satisfied) idle.
      const end = parseStates(rows(sentinel, 'heating', 'idle'), entities, '°C').hvac!;
      expect(end.map((s) => s.hvacAction)).toEqual(['heating', null, 'idle']);
    });
  });

  it('clears the carried action, preset and set points at an outage', () => {
    const parsed = parseStates([
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'heating'),
      climateRow('2026-01-19T06:00:00Z', 'preset_mode_str', 'home'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
      climateRow('2026-01-19T07:00:00Z', 'state', 'unavailable'),
      // Recovery reports the mode only: nothing before the outage carries over.
      climateRow('2026-01-19T08:00:00Z', 'state', 'heat'),
    ], entities, '°C');
    expect(parsed.hvac![2]).toEqual({
      t: Date.parse('2026-01-19T08:00:00Z'), gap: false, hvacMode: 'heat', hvacAction: null, presetMode: null, setpoint: null, coolSetpoint: null,
    });
    // So heating isn't continued past the outage, and no heat-up is read.
    expect(parsed.hvac!.map((s) => s.hvacAction)).toEqual(['heating', null, null]);
    expect(detectHvacEvents(parsed.hvac!, 'UTC')).toEqual([]);
  });

  it('treats implausible or unknown-unit set points as unknown', () => {
    const rows = [climateRow('2026-01-19T06:00:00Z', 'state', 'heat'), climateRow('2026-01-19T06:00:00Z', 'temperature', '70')];
    expect(parseStates(rows, entities, '°C').hvac![0].setpoint).toBeNull();
    expect(parseStates(rows, entities, null).hvac![0].setpoint).toBeNull();
  });

  it('reads comfort settings and change-driven occupancy, ignoring other entities', () => {
    const parsed = parseStates([
      {
        _time: '2026-01-19T11:30:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode',
      },
      {
        _time: '2026-01-19T03:30:00Z', _field: 'state', _value: 'sleep', domain: 'select', entity_id: 'home_current_mode',
      },
      {
        _time: '2026-01-19T12:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'bedroom_occupancy',
      },
      {
        _time: '2026-01-19T11:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'bedroom_occupancy',
      },
      {
        _time: '2026-01-19T11:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'patio_door_occupancy',
      },
    ], entities, '°C');
    expect(parsed.hvac).toBeNull();
    expect(parsed.comfort).toEqual([
      { t: Date.parse('2026-01-19T03:30:00Z'), setting: 'sleep' },
      { t: Date.parse('2026-01-19T11:30:00Z'), setting: 'home' },
    ]);
    expect([...parsed.occupancy.entries()]).toEqual([['bedroom_occupancy', [
      { t: Date.parse('2026-01-19T11:00:00Z'), occupied: false },
      { t: Date.parse('2026-01-19T12:00:00Z'), occupied: true },
    ]]]);
  });

  it('builds a safe Flux query with the state in force at the start', () => {
    const flux = buildStatesQuery('home_assistant', { ...entities, occupancy: ['bedroom_occupancy', 'kitchen_occupancy', 'bad"id'] }, new Date(60 * 86_400_000), new Date(61 * 86_400_000));
    expect(flux).toContain('from(bucket: "home_assistant")');
    expect(flux).toContain('prior = from(bucket: "home_assistant")\n  |> range(start: time(v: "1970-01-31T00:00:00.000Z"), stop: time(v: "1970-03-02T00:00:00.000Z"))');
    expect(flux).toContain('priorStateHistory = from(bucket: "home_assistant")\n  |> range(start: time(v: "1970-01-31T00:00:00.000Z"), stop: time(v: "1970-03-02T00:00:00.000Z"))');
    expect(flux).toContain('|> last()');
    expect(flux).toContain('r.domain == "climate" and r.entity_id == "home" and r._field == "state"');
    expect(flux).toContain('r.domain == "climate" and r.entity_id == "home"');
    expect(flux).toContain('r.domain == "select" and r.entity_id == "home_current_mode" and r._field == "state"');
    expect(flux).toContain('r.entity_id == "bedroom_occupancy" or r.entity_id == "kitchen_occupancy"');
    expect(flux).not.toContain('contains(');
    expect(flux).not.toContain('bad');
    expect(flux).toContain('union(tables: [prior, priorStateHistory, changes])');
    expect(flux).toContain('keep(columns: ["_time", "_value", "_field", "domain", "entity_id"])');
    expect(() => buildStatesQuery('home_assistant', { ...entities, climate: 'x") or true or ("' }, new Date(0), new Date(1))).toThrow('Unsafe entity id');
  });

  it('omits occupancy when no safe occupancy ids are available', () => {
    const flux = buildStatesQuery('fluxhaus', { ...entities, occupancy: ['bad"id'] }, new Date(0), new Date(1));
    expect(flux).not.toContain('r.domain == "binary_sensor"');
    expect(flux).not.toContain('bad');
    expect(flux).toContain('r.domain == "select"');
  });

  it('builds a query for the last cooling', () => {
    const flux = buildLastCoolingQuery('home_assistant', 'home', new Date(0), new Date(1000));
    expect(flux).toContain('r._field == "hvac_action_str"');
    expect(flux).toContain('r._value == "cooling"');
    expect(flux).toContain('|> group()\n  |> sort(columns: ["_time"])\n  |> last()');
    expect(() => buildLastCoolingQuery('home_assistant', 'bad"', new Date(0), new Date(1))).toThrow('Unsafe entity id');
  });
});

describe('temperature units', () => {
  const sensors = [
    { id: 'office_temperature', name: 'Office', isThermostat: false },
    { id: 'den_temperature', name: 'Den', isThermostat: false },
  ];

  it('converts by measurement unit, else the unit recorded with the reading, and drops unknown units', () => {
    const { series, unknownUnitWindows } = rowsToSeries([
      {
        _time: '2026-01-19T06:00:00Z', _value: '68', _measurement: '°F', unit_field: '', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-19T06:00:00Z', _value: '20', _measurement: 'climate', unit_field: '', entity_id: 'den_temperature',
      },
      {
        _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: '°C', unit_field: '', entity_id: 'den_temperature',
      },
      {
        _time: '2026-01-19T06:30:00Z', _value: '20', _measurement: 'climate', unit_field: 'K', entity_id: 'den_temperature',
      },
    ], sensors);
    expect(series.map((s) => s.points.map((p) => p.v))).toEqual([[20], [20]]);
    expect(unknownUnitWindows).toBe(2);
  });

  it('converts each reading by its own recorded unit across a unit change', () => {
    // The sensor switched from °F to °C; the overridden `climate` measurement
    // keeps both, each tagged with the unit Home Assistant recorded then.
    const { series, unknownUnitWindows } = rowsToSeries([
      {
        _time: '2026-01-10T06:00:00Z', _value: '68', _measurement: 'climate', unit_field: '°F', entity_id: 'office_temperature',
      },
      // A window spanning the change has readings in both units: dropped, not guessed.
      {
        _time: '2026-01-11T06:00:00Z', _value: '69.8', _measurement: 'climate', unit_field: '°F', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T06:00:00Z', _value: '21', _measurement: 'climate', unit_field: '°C', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-12T06:00:00Z', _value: '22', _measurement: 'climate', unit_field: '°C', entity_id: 'office_temperature',
      },
    ], sensors);
    expect(series[0].points.map((p) => Math.round(p.v * 10) / 10)).toEqual([20, 22]);
    expect(unknownUnitWindows).toBe(1);
  });

  it('drops a window with conflicting units whatever order its rows arrive in', () => {
    const rows = [
      {
        _time: '2026-01-11T06:00:00Z', _value: '69.8', _measurement: 'climate', unit_field: '°F', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T06:00:00Z', _value: '21', _measurement: '°C', unit_field: '', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T05:45:00Z', _value: '20', _measurement: '°C', unit_field: '', entity_id: 'office_temperature',
      },
    ];
    [rows, [...rows].reverse()].forEach((ordered) => {
      const { series, unknownUnitWindows } = rowsToSeries(ordered, sensors);
      expect(series[0].points).toEqual([{ t: Date.parse('2026-01-11T05:45:00Z'), v: 20 }]);
      expect(unknownUnitWindows).toBe(1);
    });
  });

  it('drops a window split across same-unit series rather than averaging their means unweighted', () => {
    // `climate` (°C recorded with the reading) holds nine 20 °C readings and
    // `°C` one 30 °C reading; their counts aren't queried, so the 25 °C
    // unweighted mean would be wrong. The window is dropped instead.
    const rows = [
      {
        _time: '2026-01-11T06:00:00Z', _value: '20', _measurement: 'climate', unit_field: '°C', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T06:00:00Z', _value: '30', _measurement: '°C', unit_field: '', entity_id: 'office_temperature',
      },
      {
        _time: '2026-01-11T06:15:00Z', _value: '20', _measurement: '°C', unit_field: '', entity_id: 'office_temperature',
      },
    ];
    [rows, [...rows].reverse()].forEach((ordered) => {
      const { series, unknownUnitWindows } = rowsToSeries(ordered, sensors);
      expect(series[0].points).toEqual([{ t: Date.parse('2026-01-11T06:15:00Z'), v: 20 }]);
      expect(unknownUnitWindows).toBe(1);
    });
  });

  it('prefers the unit_of_measurement tag over the field', () => {
    const { series } = rowsToSeries([
      {
        _time: '2026-01-11T06:00:00Z', _value: '68', _measurement: 'climate', unit_tag: '°F', unit_field: '°C', entity_id: 'office_temperature',
      },
    ], sensors);
    expect(series[0].points.map((p) => p.v)).toEqual([20]);
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
    const { service, calls } = makeDeps();
    const result = await service.getInsights('7');
    expect(result.windowDays).toBe(7);
    expect(result.coverage.start).toBe('2026-01-13T00:00:00.000Z');
    expect(result.sensors.map((s) => s.id)).toEqual(['home_current_temperature', 'office_temperature', 'kitchen_temperature']);
    // Every query reads the configured bucket.
    const [flux] = calls('temperatures');
    expect(flux).toContain('from(bucket: "fluxhaus")');
    expect(calls('states')[0]).toContain('from(bucket: "fluxhaus")');
    expect(calls('cooling')[0]).toContain('from(bucket: "fluxhaus")');
    expect(flux).toContain('"home_current_temperature", "office_temperature", "kitchen_temperature"');
    expect(flux).not.toContain('patio');
    expect(flux).toContain('range(start: time(v: "2026-01-13T00:00:00.000Z"), stop: time(v: "2026-01-20T00:00:00.000Z"))');
    const [states] = calls('states');
    expect(states).toContain('r.entity_id == "home_current_mode"');
    expect(states).toContain('r.entity_id == "home_occupancy" or r.entity_id == "office_occupancy" or r.entity_id == "kitchen_occupancy"');
    expect(states).toContain('range(start: time(v: "2026-01-13T00:00:00.000Z"), stop: time(v: "2026-01-20T00:00:00.000Z"))');
    expect(calls('cooling')[0]).toContain('range(start: time(v: "2025-01-20T00:00:00.000Z"), stop: time(v: "2026-01-20T00:00:00.000Z"))');
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: true, comfortScheduleAvailable: true, participationConfigured: false, coolingFrom: null,
    });
  });

  it('passes occupancy to its temperature sensor', async () => {
    const { service, rows } = makeDeps();
    (rows.states as Rows).push({
      _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'office_occupancy',
    });
    const result = await service.getInsights('7');
    expect(result.coverage.occupancyAvailable).toBe(true);
  });

  it('reuses the window for cooling within it, else fetches the last cooling season', async () => {
    const recent = makeDeps();
    recent.rows.cooling = [{ _time: '2026-01-18T12:00:00Z' }];
    const shared = await recent.service.getInsights('7');
    expect(shared.coverage).toMatchObject({ coolingFrom: '2026-01-13T00:00:00.000Z', coolingTo: '2026-01-20T00:00:00.000Z' });
    expect(recent.calls('temperatures')).toHaveLength(1);

    const old = makeDeps();
    old.rows.cooling = [{ _time: '2025-10-15T12:00:00Z' }];
    const result = await old.service.getInsights('7');
    expect(result.coverage).toMatchObject({ coolingFrom: '2025-10-08T14:00:00.000Z', coolingTo: '2025-10-15T14:00:00.000Z' });
    expect(old.calls('temperatures')).toHaveLength(2);
    expect(old.calls('temperatures')[1]).toContain('range(start: time(v: "2025-10-08T14:00:00.000Z"), stop: time(v: "2025-10-15T14:00:00.000Z"))');
    expect(old.calls('states')[1]).toContain('stop: time(v: "2025-10-15T14:00:00.000Z")');
  });

  it('degrades when the cooling lookup fails and retries sooner', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.cooling = new Error('influx down');
    const result = await service.getInsights('7');
    expect(result.coverage.coolingFrom).toBeNull();
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('cooling')).toHaveLength(2);
  });

  it('caches per participation configuration and rejects unknown sensor ids', async () => {
    const { service, calls } = makeDeps();
    const configured = await service.getInsights('14', { home: 'office_temperature', followMe: 'false' });
    expect(configured.coverage).toMatchObject({ participationConfigured: true, followMe: false });
    expect(configured.sensors.find((s) => s.id === 'office_temperature')!.participation.home).toBe(true);
    await service.getInsights('14', { followMe: 'false', home: 'office_temperature' });
    expect(calls('temperatures')).toHaveLength(1);
    await service.getInsights('14');
    expect(calls('temperatures')).toHaveLength(2);
    await expect(service.getInsights('14', { home: 'den_temperature' })).rejects.toThrow('Unknown sensor ids: den_temperature');
    await expect(service.getInsights('14', { home: 'den_temperature' })).rejects.toThrow('Unknown sensor ids');
  });

  it('caches results per window for 15 minutes', async () => {
    const { service, calls, advance } = makeDeps();
    await service.getInsights('14');
    await service.getInsights('14');
    expect(calls('temperatures')).toHaveLength(1);
    await service.getInsights('7');
    expect(calls('temperatures')).toHaveLength(2);
    advance(PLACEMENT_CACHE_TTL_MS + 1);
    await service.getInsights('14');
    expect(calls('temperatures')).toHaveLength(3);
  });

  it('evicts expired results and bounds the cache across configurations', async () => {
    const { service, calls, advance } = makeDeps();
    await service.getInsights('14');
    await service.getInsights('7');
    expect(service.cacheSize).toBe(2);
    advance(PLACEMENT_CACHE_TTL_MS + 1);
    // Expired entries are dropped when another result is cached.
    await service.getInsights('10');
    expect(service.cacheSize).toBe(1);
    // Many configurations stay bounded; the least recently used is evicted.
    const variant = (i: number) => ({ home: 'office_temperature', followMe: String(i === 1) });
    for (let d = 3; d <= 30; d += 1) {
      await service.getInsights(String(d), variant(0));
      await service.getInsights(String(d), variant(1));
    }
    expect(service.cacheSize).toBe(PLACEMENT_CACHE_MAX_ENTRIES);
    const before = calls('temperatures').length;
    await service.getInsights('30', variant(1));
    expect(calls('temperatures')).toHaveLength(before);
    await service.getInsights('3', variant(0));
    expect(calls('temperatures')).toHaveLength(before + 1);
    expect(service.cacheSize).toBe(PLACEMENT_CACHE_MAX_ENTRIES);
  });

  it('degrades when thermostat history fails and retries sooner', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.states = new Error('influx down');
    const result = await service.getInsights(undefined);
    expect(result.coverage).toMatchObject({ hvacHistoryAvailable: false, comfortScheduleAvailable: false });
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights(undefined);
    expect(calls('states')).toHaveLength(2);
  });

  it('retries soon when a room has no temperature history', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'office_temperature');
    const result = await service.getInsights('7');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.sampleCount).toBe(0);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('temperatures')).toHaveLength(2);
  });

  it('retries soon when temperature windows are dropped for unknown units', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.temperatures.push({
      _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: 'climate', unit_field: 'K', entity_id: 'office_temperature',
    });
    const result = await service.getInsights('7');
    expect(result.coverage.unknownUnitWindows).toBe(1);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('temperatures')).toHaveLength(2);
  });

  it('retries discovery and treats a missing thermostat as degraded', async () => {
    const { service, deps, influxdb, advance } = makeDeps();
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, thermostat: null } as never;
    const result = await service.getInsights('14');
    expect(deps.indoorClimate.refresh).toHaveBeenCalledTimes(1);
    expect(result.coverage.hvacHistoryAvailable).toBe(false);
    // Only temperatures are read without a thermostat.
    expect(influxdb.query).toHaveBeenCalledTimes(1);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('14');
    expect(influxdb.query).toHaveBeenCalledTimes(2);
  });

  it('retries soon when discovery found no sensors', async () => {
    const { service, deps, calls, advance } = makeDeps();
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, sensors: [] } as never;
    const result = await service.getInsights('14');
    expect(deps.indoorClimate.refresh).toHaveBeenCalled();
    expect(result.sensors).toEqual([]);
    expect(calls('temperatures')).toHaveLength(0);
    deps.indoorClimate.cachedStatus = { ...deps.indoorClimate.cachedStatus, sensors: [sensor('sensor.office_temperature', 'Office')] } as never;
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    const retried = await service.getInsights('14');
    expect(retried.sensors.map((s) => s.id)).toEqual(['office_temperature']);
  });

  it('reports readings dropped for an unknown unit in coverage', async () => {
    const { service, rows } = makeDeps();
    rows.temperatures = [
      {
        _time: '2026-01-19T06:00:00Z', _value: '18.5', _measurement: 'climate', unit_field: '', entity_id: 'office_temperature',
      },
    ];
    const result = await service.getInsights('14');
    expect(result.coverage.unknownUnitWindows).toBe(1);
    expect(result.sensors.every((s) => s.sampleCount === 0)).toBe(true);
  });

  it.each([
    ['tag', { unit_tag: '°F', unit_field: '' }],
    ['field', { unit_tag: '', unit_field: '°F' }],
  ])('reads the unit from a unit_of_measurement %s in query results', async (_schema, unit) => {
    const { service, rows } = makeDeps();
    rows.temperatures = [
      {
        _time: '2026-01-19T06:00:00Z', _value: '68', _measurement: 'climate', entity_id: 'office_temperature', ...unit,
      },
      {
        _time: '2026-01-19T06:00:00Z', _value: '70', _measurement: 'climate', entity_id: 'kitchen_temperature',
      },
    ];
    const result = await service.getInsights('14');
    // Only the kitchen row, which has no unit at all, is dropped.
    expect(result.coverage.unknownUnitWindows).toBe(1);
  });

  it('treats thermostat history with only unavailable states as degraded', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.states = [climateRow('2026-01-19T06:00:00Z', 'state', 'unavailable')];
    const result = await service.getInsights('14');
    expect(result.coverage).toMatchObject({ hvacHistoryAvailable: false, hvacEarliestStateAt: null });
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('14');
    expect(calls('states')).toHaveLength(2);
  });

  it('treats a prior outage after a valid state as degraded', async () => {
    const { service, rows, calls, advance } = makeDeps();
    rows.states = [
      climateRow('2026-01-10T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-12T06:00:00Z', 'state', 'unavailable'),
    ];
    const result = await service.getInsights('7');
    expect(result.coverage).toMatchObject({ hvacHistoryAvailable: false, hvacEarliestStateAt: null });
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('states')).toHaveLength(2);
  });

  it('degrades to empty analysis when InfluxDB fails', async () => {
    const { service, rows } = makeDeps();
    rows.temperatures = new Error('influx down');
    rows.states = new Error('influx down');
    rows.cooling = new Error('influx down');
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
    expect(flux).toContain('unit_tag: if exists r.unit_of_measurement then r.unit_of_measurement else ""');
    expect(flux).toContain('unit_field: if exists r.unit_of_measurement_str then r.unit_of_measurement_str else ""');
    expect(flux).toContain('group(columns: ["domain", "entity_id", "_measurement", "unit_tag", "unit_field"])');
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

  it.each([
    ['home=bad%22id', 'home must be a comma-separated list of sensor ids'],
    ['followMe=maybe', 'followMe must be true or false'],
    ['home=den_temperature', 'Unknown sensor ids: den_temperature'],
  ])('returns 400 for %s', async (query, message) => {
    const { service } = makeDeps();
    const response = await request(buildApp(service)).get(`/climate/placement-insights?${query}`).expect(400);
    expect(response.body.error).toBe(message);
  });

  it('passes participation parameters through', async () => {
    const { service } = makeDeps();
    const response = await request(buildApp(service))
      .get('/climate/placement-insights?days=7&home=office_temperature,kitchen_temperature&sleep=&followMe=true')
      .expect(200);
    expect(response.body.coverage).toMatchObject({ participationConfigured: true, followMe: true });
    expect(response.body.sensors.find((s: { id: string }) => s.id === 'office_temperature').participation)
      .toEqual({ home: true, sleep: false, away: null });
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
