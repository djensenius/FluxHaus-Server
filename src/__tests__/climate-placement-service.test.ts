import express from 'express';
import request from 'supertest';
import {
  buildLastCoolingQuery,
  buildPlacementQuery,
  buildReportedTemperatureQuery,
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
  rowsToReportedTemperature,
  rowsToSeries,
  toCelsius,
} from '../climate-placement-service';
import { analyzePlacement, detectHvacEvents } from '../climate-placement';
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

const coolingRows = (time: string) => [
  climateRow(time, 'state', 'cool'), climateRow(time, 'hvac_action_str', 'cooling'),
];

const queryKind = (flux: string) => {
  if (flux.includes('r._value == "cooling"')) return 'cooling';
  if (flux.includes('union(')) return 'states';
  if (flux.includes('r._field == "current_temperature"')) return 'reported';
  return 'temperatures';
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const rows: Record<'temperatures' | 'states' | 'cooling' | 'reported', Rows | Error> = {
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
    reported: [],
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
    placementDiscovery: vi.fn().mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map([
        ['sensor.home_current_temperature', 'binary_sensor.home_occupancy'],
        ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
        ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
      ]),
      unclassifiedTemperatureIds: new Set<string>(),
    }),
  };
  let now = NOW.getTime();
  const deps = {
    influxdb, indoorClimate,
    homeAssistantConfig: { getConfig: vi.fn(async () => ({ time_zone: 'UTC' })) },
    bucket: 'fluxhaus', timeZone: 'UTC', now: () => new Date(now), ...overrides,
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

function neutralHeating(fixture: ReturnType<typeof makeDeps>): void {
  const temperatures: Rows = [];
  for (let t = Date.parse('2026-01-17T00:00:00Z'); t < NOW.getTime(); t += 15 * 60_000) {
    ['home_current_temperature', 'office_temperature', 'kitchen_temperature'].forEach((entityId) => temperatures.push({
      _time: new Date(t).toISOString(), _value: '21', _measurement: '°C', entity_id: entityId,
    }));
  }
  fixture.rows.temperatures = temperatures;
  fixture.rows.states = [
    climateRow('2026-01-13T00:00:00Z', 'state', 'heat'),
    climateRow('2026-01-13T00:00:00Z', 'hvac_action_str', 'idle'),
    climateRow('2026-01-13T00:00:00Z', 'temperature', '21'),
    { _time: '2026-01-13T00:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
  ];
}

function statesForWindow(fixture: ReturnType<typeof makeDeps>, start: string, states: Rows): void {
  const query = fixture.deps.influxdb.query.getMockImplementation()!;
  fixture.deps.influxdb.query.mockImplementation(async (flux: string) => (
    queryKind(flux) === 'states' && flux.includes(start) ? states : query(flux)
  ));
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

  it.each(['home', 'sleep', 'away'] as const)('reads thermostat participation for %s as a tri-state', (setting) => {
    const param = `thermostat${setting[0].toUpperCase()}${setting.slice(1)}`;
    [true, false].forEach((value) => {
      expect(parsePlacementConfig({ [param]: String(value) })).toEqual({
        home: null,
        sleep: null,
        away: null,
        followMe: null,
        thermostat: { home: null, sleep: null, away: null, [setting]: value },
      });
    });
    expect(parsePlacementConfig({ [param]: undefined })).toBeNull();
    ['TRUE', '1', '', ['true'], true, null].forEach((value) => {
      expect(() => parsePlacementConfig({ [param]: value })).toThrow(`${param} must be true or false`);
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
        t: Date.parse('2026-01-19T06:00:00Z'), gap: false, hvacMode: 'heat', hvacAction: 'heating', presetMode: null, setpoint: 20,
        setpointObservedAt: Date.parse('2026-01-19T06:00:00Z'), coolSetpoint: null,
      },
      {
        t: Date.parse('2026-01-19T07:00:00Z'), gap: false, hvacMode: 'heat_cool', hvacAction: 'heating', presetMode: null, setpoint: 15,
        setpointObservedAt: Date.parse('2026-01-19T07:00:00Z'), coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T08:00:00Z'), gap: false, hvacMode: 'heat_cool', hvacAction: 'idle', presetMode: null, setpoint: 15,
        setpointObservedAt: Date.parse('2026-01-19T07:00:00Z'), coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T09:00:00Z'), gap: false, hvacMode: 'cool', hvacAction: 'idle', presetMode: null, setpoint: 25,
        setpointObservedAt: Date.parse('2026-01-19T09:00:00Z'), coolSetpoint: 25,
      },
      {
        t: Date.parse('2026-01-19T10:00:00Z'), gap: true, hvacMode: null, hvacAction: null, presetMode: null, setpoint: null,
      },
    ]);
  });

  it.each([
    ['unavailable mode', 'state', 'unavailable', 'state', 'heat', { gap: true, hvacMode: null }],
    ['conflicting modes', 'state', 'cool', 'state', 'heat', { gap: true, hvacMode: null }],
    ['unknown action', 'hvac_action_str', 'unknown', 'hvac_action_str', 'idle', { gap: false, hvacAction: null }],
    ['conflicting actions', 'hvac_action_str', 'heating', 'hvac_action_str', 'idle', { gap: false, hvacAction: null }],
    ['unknown target', 'temperature_str', 'unknown', 'temperature', '21', { gap: false, setpoint: null }],
    ['conflicting targets', 'temperature', '19', 'temperature', '21', { gap: false, setpoint: null }],
    ['malformed target', 'temperature_str', '21bad', 'temperature', '21', { gap: false, setpoint: null }],
    ['unknown preset', 'preset_mode_str', 'none', 'preset_mode', 'home', { gap: false, presetMode: null }],
    ['conflicting presets', 'preset_mode_str', 'away', 'preset_mode_str', 'home', { gap: false, presetMode: null }],
  ])('review 34fc041: retains %s at a rounded-millisecond collision', (_name, firstField, firstValue, secondField, secondValue, expected) => {
    const before = '2026-01-19T05:00:00Z';
    const first = '2026-01-19T06:05:00.000100Z';
    const second = '2026-01-19T06:05:00.000900Z';
    const unrelated = '2026-01-19T06:05:00.001000Z';
    const recovery = '2026-01-19T06:05:00.002000Z';
    expect(Date.parse(first)).toBe(Date.parse(second));
    const initial = [
      climateRow(before, 'state', 'heat'), climateRow(before, 'hvac_action_str', 'heating'),
      climateRow(before, 'temperature', '21'), climateRow(before, 'preset_mode_str', 'home'),
    ];
    const collisions = [
      climateRow(first, firstField, firstValue), climateRow(second, secondField, secondValue),
      climateRow(second, secondField, secondValue),
    ];
    const recovered = [
      climateRow(recovery, 'state', 'heat'), climateRow(recovery, 'hvac_action_str', 'idle'),
      climateRow(recovery, 'temperature', '21'), climateRow(recovery, 'preset_mode_str', 'home'),
    ];
    const otherField = firstField.startsWith('preset_mode') ? 'hvac_action_str' : 'preset_mode_str';
    const otherValue = otherField === 'hvac_action_str' ? 'heating' : 'home';
    [collisions, [...collisions].reverse()].forEach((ordered) => {
      const history = parseStates([...initial, ...ordered, climateRow(unrelated, otherField, otherValue), ...recovered], entities, '°C').hvac!;
      expect(history[1]).toMatchObject({ t: Date.parse(first), ...expected });
      expect(history[2]).toMatchObject({ t: Date.parse(unrelated), ...expected });
      expect(history[3]).toMatchObject({
        t: Date.parse(recovery), gap: false, hvacMode: 'heat', hvacAction: 'idle', setpoint: 21, presetMode: 'home',
      });
    });
  });

  it.each([
    ['target_temp_low', '20', '21', 'target_temp_high', '24', null, 24],
    ['target_temp_high', '24', '25', 'target_temp_low', '20', 20, null],
  ])('review 34fc041: keeps only the nonconflicting range target when %s collides',
    (field, firstValue, secondValue, otherField, otherValue, heating, cooling) => {
      const before = '2026-01-19T05:00:00Z';
      const first = '2026-01-19T06:05:00.000100Z';
      const second = '2026-01-19T06:05:00.000900Z';
      const parsed = parseStates([
        climateRow(before, 'state', 'heat_cool'), climateRow(before, 'hvac_action_str', 'idle'),
        climateRow(before, 'target_temp_low', '20'), climateRow(before, 'target_temp_high', '24'),
        climateRow(first, field, firstValue), climateRow(second, field, secondValue),
        climateRow(second, otherField, otherValue),
      ], entities, '°C');
      expect(parsed.hvac![1]).toMatchObject({ gap: false, setpoint: heating, coolSetpoint: cooling });
    });

  it('review 34fc041: does not replace a conflicting single target with a range target', () => {
    const time = '2026-01-19T06:05:00.000100Z';
    const later = '2026-01-19T06:05:00.000900Z';
    const parsed = parseStates([
      climateRow('2026-01-19T05:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T05:00:00Z', 'hvac_action_str', 'idle'),
      climateRow(time, 'temperature_str', 'unknown'), climateRow(later, 'temperature', '21'),
      climateRow(later, 'target_temp_low', '20'),
    ], entities, '°C');
    expect(parsed.hvac![1].setpoint).toBeNull();
  });

  it('review 34fc041: keeps simultaneous independent fields and identical duplicate readings', () => {
    const before = '2026-01-19T05:00:00Z';
    const first = '2026-01-19T06:00:00.000100Z';
    const second = '2026-01-19T06:00:00.000900Z';
    const parsed = parseStates([
      climateRow(before, 'state', 'heat'), climateRow(before, 'hvac_action_str', 'idle'),
      climateRow(before, 'temperature', '20'),
      climateRow(first, 'state', 'heat'), climateRow(second, 'state', 'heat'),
      climateRow(first, 'hvac_action_str', 'heating'), climateRow(second, 'hvac_action_str', 'heating'),
      climateRow(first, 'temperature', '21'), climateRow(second, 'temperature_str', '21.0'),
      climateRow(second, 'preset_mode_str', 'home'),
      { _time: first, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      { _time: second, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      { _time: first, _field: 'state', _value: 'on', domain: 'binary_sensor', entity_id: 'bedroom_occupancy' },
      { _time: second, _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'bedroom_occupancy' },
    ], entities, '°C');
    expect(parsed.hvac![1]).toMatchObject({
      t: Date.parse(first), gap: false, hvacMode: 'heat', hvacAction: 'heating', setpoint: 21, presetMode: 'home',
    });
    expect(detectHvacEvents(parsed.hvac!, 'UTC')).toEqual([{ type: 'morning', t: Date.parse(first), inferred: false }]);
    expect(parsed.comfort).toEqual([{ t: Date.parse(first), setting: 'home', subMillisecond: '1' }]);
    expect(parsed.occupancy.get('bedroom_occupancy'))
      .toEqual([{ t: Date.parse(first), occupied: true, afterMillisecond: true }]);
  });

  it.each([
    ['heat', 'cool', 'cooling'],
    ['cool', 'heat', 'heating'],
  ])('review 202e893: a %s → %s mode change does not apply an earlier action or target retroactively',
    (previous, next, action) => {
      const first = '2026-01-19T12:00:00.000100Z';
      const middle = '2026-01-19T12:00:00.000500Z';
      const last = '2026-01-19T12:00:00.000900Z';
      const read = (modeTime: string, valueTime: string, duplicate = false) => parseStates([
        climateRow('2026-01-19T11:00:00Z', 'state', previous),
        climateRow('2026-01-19T11:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T11:00:00Z', 'temperature', '20'),
        climateRow(modeTime, 'state', next),
        climateRow(valueTime, 'hvac_action_str', action),
        climateRow(valueTime, 'temperature', '23'),
        ...(duplicate ? [climateRow(last, 'hvac_action_str', action), climateRow(last, 'temperature', '23')] : []),
      ], entities, '°C').hvac![1];
      expect(read(last, first)).toMatchObject({ hvacMode: next, hvacAction: null, setpoint: null });
      expect(read(first, last)).toMatchObject({ hvacMode: next, hvacAction: action, setpoint: 23 });
      expect(read(middle, middle)).toMatchObject({ hvacMode: next, hvacAction: action, setpoint: 23 });
      expect(read(middle, first, true)).toMatchObject({ hvacMode: next, hvacAction: action, setpoint: 23 });
    });

  const collisionOffset = (extra: Rows, followMe: boolean, sourceHour = 6.25, sourceCount = 3) => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const selectEntities = { ...entities, occupancy: ['bedroom_occupancy', 'living_occupancy'] };
    const parsed = parseStates([
      climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T00:00:00Z', 'temperature', '20'),
      climateRow('2026-01-19T00:00:00Z', 'preset_mode_str', 'home'),
      ...['bedroom_occupancy', 'living_occupancy'].map((entityId) => ({
        _time: '2026-01-19T00:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: entityId,
      })),
      ...extra,
    ], selectEntities, '°C');
    const times = Array.from({ length: sourceCount }, (_, i) => start + (sourceHour + i / 4) * hour);
    const sensors = ['bedroom', 'living'].map((room) => ({
      id: `${room}_temperature`,
      name: room,
      isThermostat: false,
      points: times.map((t) => ({ t, v: room === 'bedroom' ? 22 : 20 })),
      occupancy: parsed.occupancy.get(`${room}_occupancy`),
    }));
    return analyzePlacement({
      start: new Date(start), end: new Date(start + 8 * hour), windowDays: 1, timeZone: 'UTC',
      sensors, primaryThermostatId: null, hvac: parsed.hvac, comfort: parsed.comfort,
      reportedTemperature: followMe ? null : { points: times.map((t) => ({ t, v: 20 })) },
      participation: {
        home: sensors.map((sensor) => sensor.id), sleep: null, away: null, followMe,
        thermostat: { home: false, sleep: false, away: false },
      },
    }).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.periodOffsets.home;
  };
  const selectRow = (time: string, value: string) => ({
    _time: time, _field: 'state', _value: value, domain: 'select', entity_id: 'home_current_mode',
  });
  const bedroomOccupancyRow = (time: string, field: string, value: string) => ({
    _time: time, _field: field, _value: value, domain: 'binary_sensor', entity_id: 'bedroom_occupancy',
  });

  it('keeps fractional HVAC changes out of unaligned source starts while retaining later complete windows', () => {
    const source = 6 + 17 / 60;
    const target = (time: string, value = '21') => climateRow(time, 'temperature', value);
    const exact = '2026-01-19T06:17:00.000000Z';
    const fractional = '2026-01-19T06:17:00.000500Z';
    expect(collisionOffset([target('2026-01-19T06:16:59.999900Z')], false, source, 1)).toBe(2);
    expect(collisionOffset([target(exact)], false, source, 1)).toBe(2);
    expect(collisionOffset([target(fractional)], false, source, 1)).toBeNull();
    expect(collisionOffset([target('2026-01-19T06:17:00.001000Z')], false, source, 1)).toBeNull();
    expect(collisionOffset([target(fractional, '20')], false, source, 1)).toBe(2);
    expect(collisionOffset([target(fractional)], false, 6 + 32 / 60, 1)).toBe(2);
    expect(collisionOffset([climateRow(fractional, 'hvac_action_str', 'heating')], false, source, 1)).toBeNull();
    expect(collisionOffset([
      climateRow(fractional, 'state', 'heat_cool'), climateRow(fractional, 'target_temp_low', '20'),
    ], false, source, 1)).toBeNull();
  });

  it('does not apply a fractional cooling target to an unaligned overlapping source window', () => {
    const run = (target: string, source: string) => {
      const start = Date.parse('2026-01-19T00:00:00Z');
      const t = Date.parse(source);
      const parsed = parseStates([
        climateRow('2026-01-19T00:00:00Z', 'state', 'cool'),
        climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow('2026-01-19T00:00:00Z', 'temperature', '21'),
        climateRow('2026-01-19T00:00:00Z', 'preset_mode_str', 'home'),
        climateRow(target, 'temperature', '22'),
      ], entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 8 * 60 * 60_000), windowDays: 1, timeZone: 'UTC',
        sensors: ['office', 'kitchen'].map((room) => ({
          id: `${room}_temperature`, name: room, isThermostat: false, points: [{ t, v: room === 'office' ? 18 : 20 }],
        })),
        hvac: parsed.hvac, cooling: { start: new Date(start), end: new Date(start + 8 * 60 * 60_000) },
        reportedTemperature: { points: [{ t, v: 20 }] },
      });
      return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.coolingUndershoot;
    };
    const source = '2026-01-19T06:17:00Z';
    expect(run('2026-01-19T06:16:59.999900Z', source)).toBe(4);
    expect(run('2026-01-19T06:17:00.000000Z', source)).toBe(4);
    expect(run('2026-01-19T06:17:00.000500Z', source)).toBeNull();
    expect(run('2026-01-19T06:17:00.001000Z', source)).toBeNull();
    expect(run('2026-01-19T06:17:00.000500Z', '2026-01-19T06:32:00Z')).toBe(4);
  });

  it('does not apply a range target across an intermediate fractional target omission', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const run = (low: string, high: string, source: string) => {
      const t = Date.parse(source);
      const parsed = parseStates([
        climateRow('2026-01-19T00:00:00Z', 'state', 'heat_cool'),
        climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T00:00:00Z', 'target_temp_low', '20'),
        climateRow('2026-01-19T00:00:00Z', 'target_temp_high', '24'),
        climateRow('2026-01-19T00:00:00Z', 'preset_mode_str', 'home'),
        climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow(low, 'target_temp_low', '20'),
        climateRow(high, 'target_temp_high', '24'),
        climateRow('2026-01-19T06:45:00Z', 'hvac_action_str', 'idle'),
      ], entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 8 * 60 * 60_000), windowDays: 1, timeZone: 'UTC',
        sensors: ['office', 'kitchen'].map((room) => ({
          id: `${room}_temperature`, name: room, isThermostat: false, points: [{ t, v: room === 'office' ? 18 : 20 }],
        })),
        hvac: parsed.hvac, cooling: { start: new Date(start), end: new Date(start + 8 * 60 * 60_000) },
        reportedTemperature: { points: [{ t, v: 20 }] },
      });
      return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.coolingUndershoot;
    };
    const first = '2026-01-19T06:00:00.000100Z';
    const later = '2026-01-19T06:00:00.000900Z';
    expect(run(first, later, '2026-01-19T06:00:00Z')).toBeNull();
    expect(run(first, first, '2026-01-19T06:00:00Z')).toBe(6);
    expect(run(first, later, '2026-01-19T06:15:00Z')).toBe(6);
  });

  it('does not infer zero heating runtime before a fractional initial action, but retains later known runtime', () => {
    const beginning = Date.parse('2026-01-15T00:00:00Z');
    const day = 24 * 60 * 60_000;
    const run = (kind: 'initially unknown' | 'known before' | 'simultaneous' | 'later window') => {
      const initial = kind === 'known before' ? '2026-01-14T23:59:59.999000Z'
        : kind === 'simultaneous' ? '2026-01-15T00:00:00.000000Z' : '2026-01-15T00:00:00.000100Z';
      const action = kind === 'simultaneous' ? initial : '2026-01-15T00:00:00.000900Z';
      const parsed = parseStates([
        climateRow(initial, 'state', 'heat'),
        climateRow(initial, 'temperature', '21'),
        climateRow(initial, 'preset_mode_str', 'home'),
        ...(kind === 'known before' ? [climateRow(initial, 'hvac_action_str', 'idle')] : []),
        climateRow(action, 'hvac_action_str', 'idle'),
        selectRow(initial, 'home'),
      ], entities, '°C');
      const points = Array.from({ length: 5 * 24 * 4 }, (_, i) => ({ t: beginning + i * 15 * 60_000, v: 23 }));
      const rooms = ['office', 'kitchen'].map((room) => ({
        id: `${room}_temperature`, name: room, isThermostat: false, points,
      }));
      const result = analyzePlacement({
        start: new Date(beginning + (kind === 'later window' ? 15 * 60_000 : 0)),
        end: new Date(beginning + 5 * day), windowDays: 5, timeZone: 'UTC',
        sensors: rooms, hvac: parsed.hvac, comfort: parsed.comfort, cooling: null,
        reportedTemperature: { points },
        participation: {
          home: rooms.map((room) => room.id), sleep: null, away: null, followMe: false, thermostat: { home: false },
        },
      });
      return result.recommendations.find((rec) => rec.id === 'passive-warmth-heating')!.detail;
    };
    expect(run('initially unknown')).not.toContain('heating was reported running 0.0 h');
    expect(run('known before')).toContain('heating was reported running 0.0 h');
    expect(run('simultaneous')).toContain('heating was reported running 0.0 h');
    expect(run('later window')).toContain('heating was reported running 0.0 h');
  });

  it('review 693b3c0: the recorded heating start and hidden comfort change retain their fractional order', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const iso = (t: number) => new Date(t).toISOString();
    const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
    const heating = start + 6 * hour;
    const points = Array.from({ length: 96 }, (_, i) => {
      const t = start + i * 15 * 60_000;
      const h = (t - start) / hour;
      return { t, office: h >= 6 && h < 7 ? 17 : 20, kitchen: h >= 7 && h < 9 ? 23 : 21 };
    });
    const sensors = ['office', 'kitchen'].map((room) => ({
      id: `${room}_temperature`, name: room, isThermostat: false,
      points: points.map((point) => ({ t: point.t, v: room === 'office' ? point.office : point.kitchen })),
    }));
    const run = (action: string, first: string | null, last: string | null, reverse = false, minutes = 0) => {
      const collision = heating + minutes * 60_000;
      const rows = [
        climateRow(iso(start), 'state', 'heat'),
        climateRow(iso(start), 'hvac_action_str', 'idle'),
        climateRow(iso(start), 'temperature', '21'),
        climateRow(iso(start), 'preset_mode_str', 'sleep'),
        selectRow(iso(start), 'home'),
        climateRow(micro(collision, action), 'hvac_action_str', 'heating'),
        ...(first && last ? [
          selectRow(micro(collision, first), 'unknown'),
          climateRow(micro(collision, last), 'preset_mode_str', 'home'),
        ] : []),
        climateRow(iso(start + 7 * hour), 'hvac_action_str', 'idle'),
        climateRow(iso(start + 17 * hour), 'hvac_action_str', 'heating'),
        climateRow(iso(start + 20 * hour), 'hvac_action_str', 'idle'),
      ];
      const parsed = parseStates(reverse ? [...rows].reverse() : rows, entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 24 * hour), windowDays: 1, timeZone: 'UTC',
        sensors, hvac: parsed.hvac, comfort: parsed.comfort, cooling: null,
        reportedTemperature: { points: points.map((p) => ({ t: p.t, v: (p.office + p.kitchen) / 2 })) },
        participation: {
          home: sensors.map((s) => s.id), sleep: sensors.map((s) => s.id), away: null,
          thermostat: { home: false, sleep: false }, followMe: false,
        },
      });
      return {
        events: result.coverage.morningEvents,
        samples: result.sensors.find((s) => s.id === 'office_temperature')!.sampleCount,
        overshoot: result.sensors.find((s) => s.id === 'kitchen_temperature')!.overshoot,
      };
    };
    expect(run('000000', '000100', '000900')).toEqual({ events: 1, samples: 0, overshoot: null });
    expect(run('000000', '000100', '000900', true)).toEqual({ events: 1, samples: 0, overshoot: null });
    expect(run('000000', '001100', '001900')).toEqual({ events: 1, samples: 0, overshoot: null });
    expect(run('000999', '000100', '000900')).toEqual({ events: 1, samples: 3, overshoot: 2 });
    expect(run('000999', '000100', '000900', true)).toEqual({ events: 1, samples: 3, overshoot: 2 });
    expect(run('000100', '000100', '000100')).toEqual({ events: 1, samples: 3, overshoot: 2 });
    expect(run('000000', null, null)).toEqual({ events: 1, samples: 4, overshoot: 2 });
    expect(run('000000', '000100', '000900', false, 5)).toEqual({ events: 1, samples: 0, overshoot: null });
    expect(run('000999', '000100', '000900', false, 5)).toEqual({ events: 1, samples: 3, overshoot: 2 });
  });

  it('review 693b3c0: an unknown-only interruption ends at its recorded final transition', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const time = (h: number) => new Date(start + h * hour).toISOString();
    const points = Array.from({ length: 16 }, (_, i) => ({ t: start + (6 + i / 4) * hour }));
    const sensors = ['office', 'kitchen'].map((room) => ({
      id: `${room}_temperature`, name: room, isThermostat: false,
      points: points.map(({ t }) => ({ t, v: room === 'kitchen' && t >= start + 7 * hour ? 23 : 20 })),
    }));
    const run = (action: string) => {
      const parsed = parseStates([
        climateRow(time(0), 'state', 'heat'), climateRow(time(0), 'hvac_action_str', 'idle'),
        climateRow(time(0), 'temperature', '21'), climateRow(time(0), 'preset_mode_str', 'none'),
        selectRow(time(0), 'unknown'),
        climateRow(`2026-01-19T06:00:00.${action}Z`, 'hvac_action_str', 'heating'),
        climateRow('2026-01-19T06:00:00.000100Z', 'preset_mode_str', 'home'),
        selectRow('2026-01-19T06:00:00.000900Z', 'unknown'),
        selectRow('2026-01-19T06:00:00.000900Z', 'sleep'),
        climateRow(time(7), 'hvac_action_str', 'idle'),
      ], entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 24 * hour), windowDays: 1, timeZone: 'UTC',
        sensors, hvac: parsed.hvac, comfort: parsed.comfort, cooling: null,
        reportedTemperature: { points: points.map(({ t }) => ({ t, v: 20 })) },
      });
      return {
        schedule: result.coverage.comfortScheduleAvailable,
        samples: result.sensors.find((s) => s.id === 'office_temperature')!.sampleCount,
        overshoot: result.sensors.find((s) => s.id === 'kitchen_temperature')!.overshoot,
      };
    };
    expect(run('000000')).toEqual({ schedule: false, samples: 0, overshoot: null });
    expect(run('000500')).toEqual({ schedule: false, samples: 0, overshoot: null });
    expect(run('000999')).toEqual({ schedule: false, samples: 3, overshoot: 2 });
  });

  it('review 693b3c0: an interruption at a heating stop prevents pairing its later peak', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const time = (h: number) => new Date(start + h * hour).toISOString();
    const points = Array.from({ length: 16 }, (_, i) => ({ t: start + (5 + i / 4) * hour }));
    const sensors = ['office', 'kitchen'].map((room) => ({
      id: `${room}_temperature`, name: room, isThermostat: false,
      points: points.map(({ t }) => ({ t, v: room === 'kitchen' && t >= start + 6 * hour ? 23 : 20 })),
    }));
    const run = (action: string, interruption: boolean) => {
      const parsed = parseStates([
        climateRow(time(0), 'state', 'heat'), climateRow(time(0), 'hvac_action_str', 'idle'),
        climateRow(time(0), 'temperature', '21'), climateRow(time(0), 'preset_mode_str', 'sleep'),
        selectRow(time(0), 'home'), climateRow(time(5), 'hvac_action_str', 'heating'),
        climateRow(`2026-01-19T06:00:00.${action}Z`, 'hvac_action_str', 'idle'),
        ...(interruption ? [
          selectRow('2026-01-19T06:00:00.000100Z', 'unknown'),
          climateRow('2026-01-19T06:00:00.000900Z', 'preset_mode_str', 'home'),
        ] : []),
      ], entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 24 * hour), windowDays: 1, timeZone: 'UTC',
        sensors, hvac: parsed.hvac, comfort: parsed.comfort, cooling: null,
        reportedTemperature: { points: points.map(({ t }) => ({ t, v: 20 })) },
      });
      return {
        samples: result.sensors.find((s) => s.id === 'office_temperature')!.sampleCount,
        overshoot: result.sensors.find((s) => s.id === 'kitchen_temperature')!.overshoot,
      };
    };
    for (const action of ['000000', '000100', '000500', '000900', '000999']) {
      expect(run(action, true)).toEqual({ samples: 4, overshoot: null });
    }
    expect(run('000000', false)).toEqual({ samples: 4, overshoot: 2 });
  });

  it('orders a target change around heating satisfaction without requiring comfort history', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const points = Array.from({ length: 16 }, (_, i) => ({ t: start + (5 + i / 4) * hour }));
    const sensors = ['office', 'kitchen'].map((room) => ({
      id: `${room}_temperature`, name: room, isThermostat: false,
      points: points.map(({ t }) => ({ t, v: room === 'kitchen' && t >= start + 6 * hour ? 23 : 20 })),
    }));
    const run = (action: string, target: string, value: string) => {
      const parsed = parseStates([
        climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
        climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T00:00:00Z', 'temperature', '21'),
        climateRow('2026-01-19T00:00:00Z', 'preset_mode_str', 'home'),
        climateRow('2026-01-19T05:00:00Z', 'hvac_action_str', 'heating'),
        climateRow(`2026-01-19T06:00:00.${action}Z`, 'hvac_action_str', 'idle'),
        climateRow(`2026-01-19T06:00:00.${target}Z`, 'temperature', value),
      ], entities, '°C');
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 24 * hour), windowDays: 1, timeZone: 'UTC',
        sensors, hvac: parsed.hvac, comfort: null, cooling: null,
        reportedTemperature: { points: points.map(({ t }) => ({ t, v: 20 })) },
      });
      return result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.overshoot;
    };
    expect(run('000100', '000900', '22')).toBeNull();
    expect(run('000900', '000100', '22')).toBeNull();
    expect(run('000100', '000100', '22')).toBeNull();
    expect(run('000100', '000900', '21')).toBe(2);
  });

  it('does not assume unordered fractional fields in a direct snapshot were simultaneous', () => {
    const start = Date.parse('2026-01-19T00:00:00Z');
    const hour = 60 * 60_000;
    const points = Array.from({ length: 24 }, (_, i) => ({ t: start + (6 + i / 4) * hour }));
    const run = (fields: Record<string, string>, later = false) => {
      const sensors = ['office', 'kitchen'].map((room) => ({
        id: `${room}_temperature`, name: room, isThermostat: false,
        points: points.map(({ t }) => ({ t, v: room === 'kitchen' && t >= start + (later ? 9 : 7) * hour ? 23 : 20 })),
      }));
      const state = {
        gap: false, hvacMode: 'heat', hvacAction: 'idle', presetMode: 'home', setpoint: 20,
      };
      const result = analyzePlacement({
        start: new Date(start), end: new Date(start + 24 * hour), windowDays: 1, timeZone: 'UTC',
        sensors, comfort: null, cooling: null, reportedTemperature: { points: points.map(({ t }) => ({ t, v: 20 })) },
        hvac: [
          { ...state, t: start },
          { ...state, t: start + 6 * hour, hvacAction: 'heating', setpoint: 21, subMillisecondFields: fields },
          { ...state, t: start + 7 * hour, setpoint: 21 },
          ...(later ? [
            { ...state, t: start + 8 * hour, hvacAction: 'heating', setpoint: 21 },
            { ...state, t: start + 9 * hour, setpoint: 21 },
          ] : []),
        ],
      });
      return result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.overshoot;
    };
    expect(run({ hvac_action: '1', temperature: '9' })).toBeNull();
    expect(run({ temperature: '9' })).toBeNull();
    expect(run({ hvac_action: '1', temperature: '1' })).toBe(2);
    expect(run({ hvac_action: '1', temperature: '9' }, true)).toBe(2);
  });

  it.each(['select-first', 'preset-first'] as const)(
    'review f8f2b2f: a hidden %s comfort transition invalidates only overlapping comparisons',
    (order) => {
      const read = (first: string, second: string, source: string, unchanged = false, reverseRows = false, cooling = false) => {
        const beginning = '2026-01-19T00:00:00Z';
        const initialPreset = order === 'select-first' ? 'sleep' : 'home';
        const initialSelect = order === 'select-first' ? 'home' : 'unknown';
        const firstRow = order === 'select-first'
          ? selectRow(first, unchanged ? initialSelect : 'unknown')
          : climateRow(first, 'preset_mode_str', unchanged ? initialPreset : 'sleep');
        const secondRow = order === 'select-first'
          ? climateRow(second, 'preset_mode_str', unchanged ? initialPreset : 'home')
          : selectRow(second, unchanged ? initialSelect : 'home');
        const rows = [
          climateRow(beginning, 'state', cooling ? 'cool' : 'heat'),
          climateRow(beginning, 'hvac_action_str', cooling ? 'cooling' : 'idle'),
          climateRow(beginning, 'temperature', '21'),
          climateRow(beginning, 'preset_mode_str', initialPreset),
          selectRow(beginning, initialSelect),
          firstRow, secondRow,
        ];
        const parsed = parseStates(reverseRows ? [...rows].reverse() : rows, entities, '°C');
        const t = Date.parse(source);
        const sensors = ['office', 'kitchen'].map((room) => ({
          id: `${room}_temperature`, name: room, isThermostat: false,
          points: [{ t, v: room === 'office' ? 23 : 20 }],
        }));
        const result = analyzePlacement({
          start: new Date(beginning), end: new Date('2026-01-19T08:00:00Z'), windowDays: 1, timeZone: 'UTC',
          sensors, hvac: parsed.hvac, comfort: parsed.comfort,
          cooling: cooling ? { start: new Date(beginning), end: new Date('2026-01-19T08:00:00Z') } : null,
          reportedTemperature: { points: [{ t, v: 20 }] },
          participation: {
            home: sensors.map((sensor) => sensor.id), sleep: sensors.map((sensor) => sensor.id), away: null,
            followMe: false, thermostat: { home: false, sleep: false },
          },
        });
        const offsets = result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets;
        return cooling ? offsets.cooling : offsets.home;
      };
      const first = '2026-01-19T06:20:00.000100Z';
      const second = '2026-01-19T06:20:00.000900Z';
      const overlap = '2026-01-19T06:15:00Z';
      expect(read(first, second, overlap)).toBeNull();
      expect(read(first, second, overlap, false, true)).toBeNull();
      expect(read(first, '2026-01-19T06:20:00.001000Z', overlap)).toBeNull();
      expect(read(first, second, '2026-01-19T06:30:00Z')).toBe(3);
      expect(read(second, first, overlap)).toBe(3);
      expect(read(first, first, overlap)).toBe(3);
      expect(read(first, second, overlap, true)).toBe(3);
      expect(read('2026-01-19T06:15:00.000100Z', '2026-01-19T06:15:00.000900Z', overlap)).toBeNull();
      expect(read('2026-01-19T06:15:00.000000Z', '2026-01-19T06:15:00.000000Z', overlap)).toBe(3);
      expect(read('2026-01-19T06:14:59.999100Z', '2026-01-19T06:14:59.999900Z', overlap)).toBe(3);
      expect(read('2026-01-19T06:30:00.000100Z', '2026-01-19T06:30:00.000900Z', overlap)).toBe(3);
      expect(read(first, second, overlap, false, false, true)).toBeNull();
      expect(read(first, second, '2026-01-19T06:30:00Z', false, false, true)).toBe(3);
      expect(read(second, first, overlap, false, false, true)).toBe(3);
      expect(read(first, second, '2026-01-19T06:17:00Z', false, false, true)).toBeNull();
      expect(read(first, second, '2026-01-19T06:05:00Z', false, false, true)).toBe(3);
      expect(read(first, second, '2026-01-19T06:20:00.001Z', false, false, true)).toBe(3);
    },
  );

  it('review f8f2b2f: an interruption between unknown settings still protects cooling comparisons', () => {
    const beginning = '2026-01-19T00:00:00Z';
    const first = '2026-01-19T06:20:00.000100Z';
    const second = '2026-01-19T06:20:00.000900Z';
    const read = (source: string, recovered = false) => {
      const parsed = parseStates([
        climateRow(beginning, 'state', 'cool'),
        climateRow(beginning, 'hvac_action_str', 'cooling'),
        climateRow(beginning, 'preset_mode_str', 'none'),
        selectRow(beginning, 'unknown'),
        climateRow(first, 'preset_mode_str', 'home'),
        selectRow(second, 'unknown'), selectRow(second, 'sleep'),
        ...(recovered ? [selectRow('2026-01-19T06:40:00Z', 'home')] : []),
      ], entities, '°C');
      const t = Date.parse(source);
      return analyzePlacement({
        start: new Date(beginning), end: new Date('2026-01-19T08:00:00Z'), windowDays: 1, timeZone: 'UTC',
        sensors: ['office', 'kitchen'].map((room) => ({
          id: `${room}_temperature`, name: room, isThermostat: false,
          points: [{ t, v: room === 'office' ? 23 : 20 }],
        })),
        hvac: parsed.hvac, comfort: parsed.comfort, reportedTemperature: { points: [{ t, v: 20 }] },
        cooling: { start: new Date(beginning), end: new Date('2026-01-19T08:00:00Z') },
      });
    };
    const interrupted = read('2026-01-19T06:15:00Z');
    expect(interrupted.coverage.comfortScheduleAvailable).toBe(false);
    expect(interrupted.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBeNull();
    expect(read('2026-01-19T06:30:00Z').sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBe(3);
    const recovered = read('2026-01-19T06:45:00Z', true);
    expect(recovered.coverage.comfortScheduleAvailable).toBe(true);
    expect(recovered.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBe(3);
  });

  it.each(['heating', 'cooling'] as const)(
    'review f8f2b2f: an unknown-only interruption preserves qualified %s advice',
    (mode) => {
      const start = Date.parse('2026-01-15T00:00:00Z');
      const hour = 60 * 60_000;
      const end = start + 3 * 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const rows = [
        climateRow(iso(start), 'state', mode === 'heating' ? 'heat' : 'cool'),
        climateRow(iso(start), 'hvac_action_str', 'idle'),
        climateRow(iso(start), 'temperature', '22'),
        climateRow(iso(start), 'preset_mode_str', 'none'),
        selectRow(iso(start), 'unknown'),
        climateRow('2026-01-15T12:20:00.000100Z', 'preset_mode_str', 'home'),
        selectRow('2026-01-15T12:20:00.000900Z', 'unknown'),
        selectRow('2026-01-15T12:20:00.000900Z', 'sleep'),
      ];
      for (let d = 0; d < 3; d += 1) {
        rows.push(
          climateRow(iso(start + (d * 24 + 6) * hour), 'hvac_action_str', mode),
          climateRow(iso(start + (d * 24 + 9) * hour), 'hvac_action_str', 'idle'),
        );
      }
      const parsed = parseStates(rows, entities, '°C');
      const sensors = ['kitchen', 'living', 'bedroom'].map((room) => ({
        id: `${room}_temperature`, name: room, isThermostat: false,
        points: Array.from({ length: 3 * 24 * 4 }, (_, i) => ({
          t: start + i * 15 * 60_000, v: room === 'kitchen' ? 25 : 22,
        })),
      }));
      const result = analyzePlacement({
        start: new Date(start), end: new Date(end), windowDays: 3, timeZone: 'UTC',
        sensors, hvac: parsed.hvac, comfort: parsed.comfort,
        cooling: mode === 'cooling' ? { start: new Date(start), end: new Date(end) } : null,
        participation: {
          home: ['living_temperature', 'bedroom_temperature'], sleep: sensors.map((sensor) => sensor.id), away: null,
          followMe: false, thermostat: { home: false, sleep: false },
        },
      });
      expect(result.coverage.comfortScheduleAvailable).toBe(false);
      const tip = result.recommendations.find((rec) => rec.mode === mode && rec.sensorId === 'kitchen_temperature')!;
      expect(tip).toMatchObject({ action: 'move', severity: 'low', comfortSetting: null });
      expect(tip.detail).toContain('If it participates in the comfort setting active at that time');
      expect(result.recommendations.some((rec) => rec.action === 'include_in_comfort')).toBe(false);
    },
  );

  it.each(['sleep', 'unknown'])(
    'review 34fc041: a %s/home comfort collision stays unknown rather than falling back to the preset',
    (firstValue) => {
      const first = '2026-01-19T06:00:00.000100Z';
      const second = '2026-01-19T06:00:00.000900Z';
      const collision = [selectRow(first, firstValue), selectRow(second, 'home')];
      [collision, [...collision].reverse()].forEach((ordered) => {
        expect(collisionOffset(ordered, false)).toBeNull();
        expect(collisionOffset([...ordered, selectRow('2026-01-19T07:00:00.001Z', 'home')], false, 7.25)).toBe(2);
      });
      expect(collisionOffset([selectRow(first, 'home'), selectRow(second, 'home')], false)).toBe(2);
    },
  );

  it.each(['off', 'unavailable'])(
    'review 34fc041: a %s/occupied collision leaves Follow Me occupancy unknown',
    (firstValue) => {
      const first = '2026-01-19T06:00:00.000100Z';
      const second = '2026-01-19T06:00:00.000900Z';
      const collision = [bedroomOccupancyRow(first, 'state', firstValue), bedroomOccupancyRow(second, 'value', '1')];
      [collision, [...collision].reverse()].forEach((ordered) => {
        expect(collisionOffset(ordered, true)).toBeNull();
        expect(collisionOffset([...ordered, bedroomOccupancyRow('2026-01-19T07:00:00.001Z', 'value', '1')], true, 7.25))
          .toBe(1);
      });
      expect(collisionOffset([bedroomOccupancyRow(first, 'state', 'on'), bedroomOccupancyRow(second, 'value', '1')], true))
        .toBe(1);
    },
  );

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

  it.each([
    ['cool', 'cooling', 'heat', 'heating'],
    ['heat', 'heating', 'cool', 'cooling'],
  ])('review 8c5e5d2: does not carry %s/%s into %s mode', (beforeMode, beforeAction, nextMode, nextAction) => {
    const rows = [
      climateRow('2026-01-19T05:00:00Z', 'state', beforeMode),
      climateRow('2026-01-19T05:00:00Z', 'hvac_action_str', beforeAction),
      climateRow('2026-01-19T06:00:00Z', 'state', nextMode),
      climateRow('2026-01-19T07:00:00Z', 'hvac_action_str', 'idle'),
    ];
    const actions = (history: Rows) => parseStates(history, entities, '°C').hvac!.map((sample) => sample.hvacAction);
    expect(actions(rows)).toEqual([beforeAction, null, 'idle']);
    expect(actions([...rows, climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', nextAction)]))
      .toEqual([beforeAction, nextAction, 'idle']);
    expect(actions([...rows, climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'idle')]))
      .toEqual([beforeAction, 'idle', 'idle']);
    expect(actions([...rows, climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', beforeAction)]))
      .toEqual([beforeAction, null, 'idle']);
    const compatible = [rows[0], rows[1], climateRow('2026-01-19T06:00:00Z', 'state', 'heat_cool'), rows[3]];
    expect(actions(compatible)).toEqual([beforeAction, beforeAction, 'idle']);
    const idle = [rows[0], climateRow('2026-01-19T05:00:00Z', 'hvac_action_str', 'idle'), rows[2], rows[3]];
    expect(actions(idle)).toEqual(['idle', 'idle', 'idle']);
    const recovery = [...rows.slice(0, 3), climateRow('2026-01-19T07:00:00Z', 'hvac_action_str', nextAction)];
    expect(detectHvacEvents(parseStates(recovery, entities, '°C').hvac!, 'UTC')).toEqual([]);
  });

  it('review 8c5e5d2: does not use a carried cooling action after a mode-only switch for placement advice', () => {
    const start = Date.parse('2026-01-05T00:00:00Z');
    const hour = 60 * 60 * 1000;
    const days = 3;
    const at = (day: number, h: number) => new Date(start + (day * 24 + h) * hour).toISOString();
    const rows = Array.from({ length: days }, (_, day) => [
      climateRow(at(day, 0), 'state', 'cool'),
      climateRow(at(day, 0), 'hvac_action_str', 'idle'),
      climateRow(at(day, 1), 'hvac_action_str', 'cooling'),
      climateRow(at(day, 2), 'state', 'heat'),
      climateRow(at(day, 4), 'hvac_action_str', 'idle'),
    ]).flat();
    const sensors = ['bedroom_temperature', 'living_temperature', 'kitchen_temperature'].map((id) => ({
      id,
      name: id.replace('_temperature', ''),
      isThermostat: false,
      points: Array.from({ length: days * 24 * 4 }, (_, i) => ({
        t: start + (i * hour) / 4,
        v: 20 + (id === 'kitchen_temperature' && i % 96 >= 8 && i % 96 < 16 ? 3 : 0),
      })),
    }));
    const end = new Date(start + days * 24 * hour);
    const result = analyzePlacement({
      sensors,
      primaryThermostatId: null,
      hvac: parseStates(rows, entities, '°C').hvac,
      comfort: [{ t: start, setting: 'home' }],
      participation: {
        home: sensors.map((sensor) => sensor.id),
        sleep: null,
        away: null,
        followMe: false,
        thermostat: { home: false, sleep: false, away: false },
      },
      start: new Date(start),
      end,
      windowDays: days,
      timeZone: 'UTC',
      generatedAt: end,
      cooling: { start: new Date(start), end },
    });
    expect(result.coverage.coolingEvents).toBe(3);
    expect(result.recommendations.filter((rec) => rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature')).toEqual([]);
  });

  it('review 8c5e5d2: does not claim heating runtime through a mode-only switch', () => {
    const start = Date.parse('2026-01-05T00:00:00Z');
    const hour = 60 * 60 * 1000;
    const days = 5;
    const at = (day: number, h: number) => new Date(start + (day * 24 + h) * hour).toISOString();
    const sensors = ['bedroom_temperature', 'living_temperature'].map((id) => ({
      id,
      name: id,
      isThermostat: false,
      points: Array.from({ length: days * 24 * 4 }, (_, i) => ({ t: start + (i * hour) / 4, v: 22 })),
    }));
    const end = new Date(start + days * 24 * hour);
    const run = (reportedAction: string | null) => {
      const rows = Array.from({ length: days }, (_, day) => [
        climateRow(at(day, 0), 'state', 'heat'),
        climateRow(at(day, 0), 'hvac_action_str', 'idle'),
        climateRow(at(day, 0), 'temperature', '20'),
        climateRow(at(day, 1), 'hvac_action_str', 'heating'),
        climateRow(at(day, 2), 'state', 'cool'),
        ...(reportedAction ? [climateRow(at(day, 2), 'hvac_action_str', reportedAction)] : []),
        climateRow(at(day, 4), 'state', 'heat'),
        climateRow(at(day, 4), 'hvac_action_str', 'idle'),
        climateRow(at(day, 4), 'temperature', '20'),
      ]).flat();
      return analyzePlacement({
        sensors,
        primaryThermostatId: null,
        hvac: parseStates(rows, entities, '°C').hvac,
        comfort: [{ t: start, setting: 'home' }],
        participation: {
          home: sensors.map((sensor) => sensor.id),
          sleep: null,
          away: null,
          followMe: false,
          thermostat: { home: false, sleep: false, away: false },
        },
        start: new Date(start),
        end,
        windowDays: days,
        timeZone: 'UTC',
        generatedAt: end,
      }).recommendations.find((rec) => rec.id === 'passive-warmth-heating')!;
    };
    expect(run(null).detail).not.toContain('heating was reported running');
    expect(run('cooling').detail).toContain('heating was reported running 5.0 h over 5 days');
  });

  it('review 8c5e5d2: does not mistake a carried target for a new Sleep observation', () => {
    const start = Date.parse('2026-01-05T00:00:00Z');
    const hour = 60 * 60 * 1000;
    const days = 5;
    const at = (day: number, h: number) => start + (day * 24 + h) * hour;
    const time = (day: number, h: number) => new Date(at(day, h)).toISOString();
    const sensors = ['bedroom_temperature', 'living_temperature', 'kitchen_temperature'].map((id) => ({
      id,
      name: id.replace('_temperature', ''),
      isThermostat: false,
      points: Array.from({ length: days * 24 * 4 }, (_, i) => ({
        t: start + (i * hour) / 4,
        v: (i % 96 >= 24 && i % 96 < 88 ? 21 : 17) + (id === 'bedroom_temperature' ? -1.5 : 0.5),
      })),
    }));
    const end = new Date(at(days, 0));
    const comfort = Array.from({ length: days }, (_, day) => [
      { t: at(day, 0), setting: 'sleep' },
      { t: at(day, 4.75), setting: 'away' },
      { t: at(day, 5), setting: 'sleep' },
      { t: at(day, 6), setting: 'home' },
      { t: at(day, 22), setting: 'sleep' },
    ]).flat();
    const run = (sleepTarget: string | null) => {
      const rows = Array.from({ length: days }, (_, day) => [
        climateRow(time(day, 0), 'state', 'heat'),
        climateRow(time(day, 0), 'hvac_action_str', 'idle'),
        climateRow(time(day, 0), 'temperature', '17'),
        climateRow(time(day, 5.1), 'hvac_action_str', 'idle'),
        ...(sleepTarget ? [climateRow(time(day, 5.1), 'temperature', sleepTarget)] : []),
        climateRow(time(day, 5.5), 'hvac_action_str', 'heating'),
        climateRow(time(day, 5.5), 'temperature', '21'),
        climateRow(time(day, 7), 'hvac_action_str', 'idle'),
      ]).flat();
      const all = sensors.map((sensor) => sensor.id);
      return analyzePlacement({
        sensors,
        primaryThermostatId: null,
        hvac: parseStates(rows, entities, '°C').hvac,
        comfort,
        participation: {
          home: all, sleep: all, away: null, followMe: false, thermostat: { home: false, sleep: false, away: false },
        },
        start: new Date(start),
        end,
        windowDays: days,
        timeZone: 'UTC',
        generatedAt: end,
      }).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
    };
    const carried = run(null);
    expect(carried).toBeDefined();
    expect(carried.detail).not.toMatch(/Sleep set point|smaller Sleep setback/);
    expect(run('20').detail).toContain('The Sleep set point averaged 1.0 °C below Home');
  });

  it('review 202e893: a target just before the recorded Sleep transition is not attributed to Sleep', () => {
    const start = Date.parse('2026-01-05T00:00:00Z');
    const hour = 60 * 60_000;
    const days = 5;
    const at = (day: number, h: number) => start + (day * 24 + h) * hour;
    const time = (day: number, h: number) => new Date(at(day, h)).toISOString();
    const micro = (day: number, h: number, fraction: string) => time(day, h).replace('.000Z', `.${fraction}Z`);
    const sensors = ['bedroom_temperature', 'living_temperature', 'kitchen_temperature'].map((id) => ({
      id,
      name: id.replace('_temperature', ''),
      isThermostat: false,
      points: Array.from({ length: days * 24 * 4 }, (_, i) => ({
        t: start + (i * hour) / 4,
        v: (i % 96 >= 24 && i % 96 < 88 ? 21 : 17) + (id === 'bedroom_temperature' ? -1.5 : 0.5),
      })),
    }));
    const end = new Date(at(days, 0));
    const select = (timestamp: string, setting: string) => ({
      _time: timestamp, _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
    });
    const run = (
      targetFraction: string, sleepFraction: string, duplicate: boolean, source: 'select' | 'preset', dual = false,
    ) => {
      const setting = (timestamp: string, value: string) => (
        source === 'select' ? select(timestamp, value) : climateRow(timestamp, 'preset_mode_str', value)
      );
      const target = dual ? 'target_temp_low' : 'temperature';
      const rows = Array.from({ length: days }, (_, day) => [
        climateRow(time(day, 0), 'state', dual ? 'heat_cool' : 'heat'),
        climateRow(time(day, 0), 'hvac_action_str', 'idle'),
        climateRow(time(day, 0), target, '20'),
        setting(time(day, 0), 'sleep'),
        setting(time(day, 4.75), 'away'),
        climateRow(micro(day, 5, targetFraction), target, '17'),
        ...(duplicate ? [climateRow(micro(day, 5, '000900'), target, '17')] : []),
        ...(dual ? [climateRow(micro(day, 5, '000900'), 'target_temp_high', '24')] : []),
        setting(micro(day, 5, sleepFraction), 'sleep'),
        climateRow(time(day, 5.5), 'hvac_action_str', 'heating'),
        climateRow(time(day, 5.5), target, '21'),
        setting(time(day, 6), 'home'),
        climateRow(time(day, 7), 'hvac_action_str', 'idle'),
        setting(time(day, 22), 'sleep'),
      ]).flat();
      const parsed = parseStates(rows, entities, '°C');
      const all = sensors.map((sensor) => sensor.id);
      return analyzePlacement({
        sensors, primaryThermostatId: null, hvac: parsed.hvac, comfort: parsed.comfort,
        participation: {
          home: all, sleep: all, away: null, followMe: false, thermostat: { home: false, sleep: false, away: false },
        },
        start: new Date(start), end, windowDays: days, timeZone: 'UTC', generatedAt: end,
      }).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
    };
    for (const source of ['select', 'preset'] as const) {
      for (const fraction of ['000000', '000100']) {
        const earlier = run(fraction, '000500', false, source);
        expect(earlier).toBeDefined();
        expect(earlier.detail).not.toMatch(/Sleep set point|smaller Sleep setback/);
      }
      for (const fraction of ['000500', '000900']) {
        expect(run(fraction, '000500', false, source).detail).toContain('The Sleep set point averaged 4.0 °C below Home');
      }
      expect(run('000100', '000000', false, source).detail).toContain('The Sleep set point averaged 4.0 °C below Home');
      expect(run('000100', '000500', true, source).detail).toContain('The Sleep set point averaged 4.0 °C below Home');
      expect(run('000100', '000500', false, source, true).detail).not.toMatch(/Sleep set point|smaller Sleep setback/);
      expect(run('000900', '000500', false, source, true).detail).toContain('The Sleep set point averaged 4.0 °C below Home');
    }
  });

  it.each(['heat_cool', 'auto'])(
    'review 22241a2: does not carry a cooling target into heat or treat a %s single target as heating',
    (mode) => {
      const parsed = parseStates([
        climateRow('2026-01-19T05:00:00Z', 'state', 'cool'),
        climateRow('2026-01-19T05:00:00Z', 'temperature', '24'),
        climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
        climateRow('2026-01-19T06:30:00Z', 'temperature', '21'),
        climateRow('2026-01-19T07:00:00Z', 'state', mode),
        climateRow('2026-01-19T07:00:00Z', 'temperature', '25'),
        climateRow('2026-01-19T07:30:00Z', 'target_temp_low', '20'),
        climateRow('2026-01-19T07:30:00Z', 'target_temp_high', '24'),
        climateRow('2026-01-19T08:00:00Z', 'state', 'cool'),
      ], entities, '°C');
      expect(parsed.hvac!.map((sample) => [sample.hvacMode, sample.setpoint, sample.coolSetpoint])).toEqual([
        ['cool', 24, 24],
        ['heat', null, null],
        ['heat', 21, null],
        [mode, null, null],
        [mode, 20, 24],
        ['cool', null, null],
      ]);
    },
  );

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

  it('rejects target assumptions contradicted by recorded climate unit tags or fields', () => {
    const time = '2026-01-19T06:00:00Z';
    const base = [climateRow(time, 'state', 'cool'), climateRow(time, 'temperature', '35')];
    const tagged = base.map((row) => ({ ...row, _measurement: 'climate', unit_of_measurement: '°F' }));
    const byField = [...base, climateRow(time, 'unit_of_measurement_str', '°F')];
    const byMeasurement = base.map((row) => ({ ...row, _measurement: '°F' }));
    const unknown = [...base, climateRow(time, 'unit_of_measurement_str', 'K')];
    [tagged, byField, byMeasurement, unknown].forEach((rows) => {
      expect(parseStates(rows, entities, '°C').hvac![0]).toMatchObject({ setpoint: null, coolSetpoint: null });
    });
    expect(parseStates(base, entities, '°C').hvac![0]).toMatchObject({ setpoint: 35, coolSetpoint: 35 });
    const matching = tagged.map((row, i) => (i === 1 ? { ...row, _value: '68' } : row));
    expect(parseStates(matching, entities, '°F').hvac![0]).toMatchObject({ setpoint: 20, coolSetpoint: 20 });
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
    expect(flux).toContain('keep(columns: ["_time", "_value", "_field", "domain", "entity_id", "_measurement", "unit_of_measurement"])');
    const prior = flux.split('priorStateHistory =')[0];
    const changes = flux.split('changes =')[1].split('union(tables:')[0];
    [prior, changes].forEach((branch) => {
      const climate = branch.split('or (r.domain == "select"')[0];
      [
        'state', 'hvac_action_str', 'preset_mode', 'preset_mode_str', 'temperature', 'temperature_str',
        'target_temp_low', 'target_temp_low_str', 'target_temp_high', 'target_temp_high_str', 'unit_of_measurement_str',
      ].forEach((field) => expect(climate).toContain(`r._field == "${field}"`));
      expect(branch).not.toContain('r._measurement');
    });
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
    expect(flux).toContain('r._field == "state"');
    expect(flux).toContain('union(tables: [prior, changes])');
    expect(flux).toContain('keep(columns: ["_time", "_field", "_value"])');
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

  it('uses the HA climate unit only as an explicit assumption for untagged reported readings', () => {
    const time = '2026-01-19T06:00:00Z';
    const row = {
      _time: time, _value: '20', _measurement: 'climate', domain: 'climate', entity_id: 'home',
    };
    const parse = (rows: Rows, unit: string | null) => rowsToReportedTemperature(
      rows, 'home', unit, new Date('2026-01-19T06:00:00Z'), new Date('2026-01-19T07:00:00Z'),
    );
    expect(parse([row], '°C')).toMatchObject({
      points: [{ t: Date.parse(time), v: 20 }], invalidWindows: [], assumedUnit: true,
    });
    expect(parse([{ ...row, _value: '68' }], '°F').points).toEqual([{ t: Date.parse(time), v: 20 }]);
    expect(parse([row], null)).toMatchObject({ points: [], invalidWindows: [Date.parse(time)] });
    expect(parse([row], 'K').points).toEqual([]);
    expect(parse([{ ...row, _value: '68', unit_tag: '°F' }], null)).toMatchObject({
      points: [{ t: Date.parse(time), v: 20 }], assumedUnit: false,
    });
    expect(parse([{ ...row, unit_tag: 'K' }], '°C').points).toEqual([]);
    expect(parse([{ ...row, unit_tag: '°F', unit_field: '°C' }], '°C').points).toEqual([]);
    expect(parse([row, { ...row, entity_id: 'other', _value: '99' }], '°C').points)
      .toEqual([{ t: Date.parse(time), v: 20 }]);
  });

  it('does not assume untagged units across evidence of a change or mix split windows', () => {
    const row = {
      _time: '2026-01-19T06:00:00Z', _value: '68', _measurement: 'climate',
      domain: 'climate', entity_id: 'home', unit_tag: '°F',
    };
    const next = { ...row, _time: '2026-01-19T06:15:00Z', _value: '20', unit_tag: '' };
    const start = new Date('2026-01-19T06:00:00Z');
    const end = new Date('2026-01-19T07:00:00Z');
    expect(rowsToReportedTemperature([row, next], 'home', '°C', start, end)).toMatchObject({
      points: [{ t: start.getTime(), v: 20 }],
      invalidWindows: [start.getTime() + 15 * 60_000],
      assumedUnit: false,
    });
    const split = { ...row, _value: '20', unit_tag: '°C' };
    expect(rowsToReportedTemperature([row, split], 'home', '°C', start, end)).toMatchObject({
      points: [], invalidWindows: [start.getTime()],
    });
    expect(rowsToReportedTemperature([row], 'home', '°F', new Date(start.getTime() + 1), end).points).toEqual([]);
    expect(rowsToReportedTemperature([next], 'home', '°C', start, new Date(start.getTime() + 29 * 60_000)).points)
      .toEqual([]);
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
  const reportedRow = (time = '2026-01-19T06:00:00Z', value = '20') => ({
    _time: time, _value: value, _measurement: 'climate', domain: 'climate', entity_id: 'home',
  });

  function useClimateReference(fixture: ReturnType<typeof makeDeps>) {
    fixture.deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: null,
      thermostatOccupancyEntityId: 'binary_sensor.home_occupancy',
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    fixture.rows.reported = [reportedRow()];
    fixture.rows.temperatures = fixture.rows.temperatures.map((row) => (
      row.entity_id === 'home_current_temperature' ? { ...row, _value: '24' } : row
    ));
  }

  it('resolves yesterday in the HA zone, rejects invalid house zones and validates explicit dates strictly', async () => {
    const fixture = makeDeps();
    fixture.advance(Date.parse('2026-01-20T12:00:00Z') - NOW.getTime());
    const yesterday = await fixture.service.getDayInsights(undefined);
    expect(yesterday).toMatchObject({ date: '2026-01-19', timeZone: 'UTC' });
    await expect(fixture.service.getDayInsights('2026-02-29')).rejects.toThrow('valid YYYY-MM-DD');
    await expect(fixture.service.getDayInsights('2026-01-21')).rejects.toThrow('today or within');
    await expect(fixture.service.getDayInsights('2025-01-20')).rejects.toThrow('today or within');
    fixture.deps.homeAssistantConfig.getConfig.mockResolvedValue({ time_zone: 'Invalid/HouseZone' });
    await expect(fixture.service.getDayInsights('2026-01-19')).rejects.toThrow('unavailable or invalid');
  });

  it('queries one day plus 14 house-calendar baseline dates and passes participation through', async () => {
    const fixture = makeDeps();
    const response = await fixture.service.getDayInsights('2026-01-19', {
      home: 'office_temperature,kitchen_temperature',
      followMe: 'false',
      thermostatHome: 'true',
      thermostatSleep: 'false',
    }) as {
      timeline: { average: number | null; rooms: Record<string, number | null> }[];
      date: string;
      sensors: { id: string; isThermostat?: boolean; dayOffset: number | null; unusual: boolean | null }[];
    };
    expect(response.date).toBe('2026-01-19');
    expect(response.timeline).toHaveLength(96);
    expect(response.timeline[24].average).toBeCloseTo(59 / 3);
    expect(response.timeline[24].rooms).not.toHaveProperty('home_current_temperature');
    expect(response.sensors.find((sensor) => sensor.id === 'home_current_temperature'))
      .toMatchObject({ isThermostat: true, dayOffset: null, unusual: null });
    expect(response.sensors.find((sensor) => sensor.id === 'office_temperature')).toMatchObject({
      dayOffset: null, unusual: null,
    });
    const temperatureQuery = fixture.calls('temperatures')[0];
    expect(temperatureQuery).toContain('2026-01-05T00:00:00.000Z');
    expect(temperatureQuery).toContain('2026-01-20T00:00:00.000Z');
    expect(temperatureQuery).not.toContain('2026-01-04T');
    const stateQuery = fixture.calls('states')[0];
    expect(stateQuery).toContain('2026-01-05T00:00:00.000Z');
    expect(stateQuery).toContain('office_occupancy');
    expect(stateQuery).toContain('kitchen_occupancy');
  });

  it('marks incomplete sensor discovery and withholds daily outlier conclusions', async () => {
    const fixture = makeDeps();
    fixture.deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set(['sensor.mystery_temperature']),
    });
    const result = await fixture.service.getDayInsights('2026-01-19') as {
      sensors: { isThermostat: boolean; dayOffset: number | null; baselineOffset: number | null; deviation: number | null; unusual: boolean | null }[];
      findings: unknown[];
      coverage: { incompleteSensorInventory: boolean };
    };
    expect(result.coverage.incompleteSensorInventory).toBe(true);
    expect(result.sensors.filter((sensor) => !sensor.isThermostat).every((sensor) => (
      sensor.dayOffset === null && sensor.baselineOffset === null
      && sensor.deviation === null && sensor.unusual === null
    ))).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('caches completed past-day analysis longer than the 14-day endpoint', async () => {
    const fixture = makeDeps();
    await fixture.service.getDayInsights('2026-01-19');
    const temperatureQueries = fixture.calls('temperatures').length;
    fixture.advance(16 * 60 * 1000);
    await fixture.service.getDayInsights('2026-01-19');
    expect(fixture.calls('temperatures')).toHaveLength(temperatureQueries);
  });

  it('queries the selected climate attribute without identifying a physical temperature entity', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    (fixture.rows.reported as Rows).unshift({ ...reportedRow(), entity_id: 'other', _value: '5' });
    (fixture.rows.reported as Rows).unshift({ ...reportedRow(), domain: 'sensor', _value: '30' });
    const result = await fixture.service.getInsights('7', { thermostatHome: 'true' });
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(-1.5);
    expect(result.sensors.find((s) => s.id === 'home_current_temperature')).toMatchObject({
      name: 'Home', isThermostat: true, verdictSummary: expect.stringContaining('not known'),
    });
    expect(result.sensors.map((s) => s.id)).toEqual(['home_current_temperature', 'office_temperature', 'kitchen_temperature']);
    expect(result.coverage.thermostatParticipationSupported).toBe(true);
    const [query] = fixture.calls('reported');
    expect(query).toContain('r.domain == "climate" and r.entity_id == "home"');
    expect(query).toContain('r._field == "current_temperature"');
    expect(query).not.toContain('r.domain == "sensor"');
  });

  it('rejects the first aggregated reference bucket after an unavailable attribute', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T06:14:00Z', 'current_temperature_str', 'unknown'),
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    // The 06:15 aggregate could contain only the numeric recovery at 06:29.
    fixture.rows.reported = [reportedRow('2026-01-19T06:15:00Z')];
    fixture.rows.temperatures = fixture.rows.temperatures.map((row) => (
      row.entity_id === 'office_temperature'
        ? { ...row, _time: '2026-01-19T06:15:00Z', _value: '18' } : row
    ));
    const ambiguous = await fixture.service.getInsights('7');
    expect(ambiguous.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    (fixture.rows.reported as Rows).push(reportedRow('2026-01-19T06:30:00Z'));
    (fixture.rows.temperatures as Rows).push({
      _time: '2026-01-19T06:30:00Z', _value: '18', _measurement: '°C', entity_id: 'office_temperature',
    });
    const recovered = await fixture.service.getInsights('7');
    expect(recovered.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(-2);
    expect(fixture.calls('reported')).toHaveLength(2);
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('reported')).toHaveLength(2);
  });

  it('requires a gap-free recovery anchor before using and caching the reference', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = [
      climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T00:01:00Z', 'current_temperature_str', 'unknown'),
      climateRow('2026-01-19T00:15:02Z', 'state', 'unavailable'),
      climateRow('2026-01-19T00:30:00Z', 'state', 'heat'),
      climateRow('2026-01-19T00:30:00Z', 'hvac_action_str', 'idle'),
      { _time: '2026-01-19T00:30:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    fixture.rows.reported = [reportedRow('2026-01-19T00:15:00Z'), reportedRow('2026-01-19T00:30:00Z')];
    fixture.rows.temperatures = [
      { _time: '2026-01-19T00:30:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T00:30:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    const ambiguous = await fixture.service.getInsights('7');
    expect(ambiguous.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBeNull();
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    (fixture.rows.reported as Rows).push(reportedRow('2026-01-19T00:45:00Z'));
    (fixture.rows.temperatures as Rows).push({
      _time: '2026-01-19T00:45:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature',
    });
    const recovered = await fixture.service.getInsights('7');
    expect(recovered.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBe(3);
    expect(recovered.coverage.unitAssumptions).toEqual({
      reportedTemperature: true, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
    });
    expect(fixture.calls('reported')).toHaveLength(2);
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('reported')).toHaveLength(2);
  });

  it.each([
    ['just before', '2026-01-19T00:14:59.999999Z', 3, false],
    ['exactly at', '2026-01-19T00:15:00.000000Z', 3, false],
    ['exactly at with a later identical duplicate', '2026-01-19T00:15:00.000000Z', 3, true],
    ['one nanosecond after', '2026-01-19T00:15:00.000000001Z', null, false],
    ['half a millisecond after', '2026-01-19T00:15:00.000500Z', null, false],
    ['half a millisecond after with an offset', '2026-01-19T01:15:00.000500+01:00', null, false],
    ['one millisecond after', '2026-01-19T00:15:00.001000Z', null, false],
  ])('review 202e893: a climate recovery %s the source boundary only anchors a fully gap-free bucket',
    async (_description, recovery, expected, duplicate) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      fixture.rows.states = [
        climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
        climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T00:01:00.000100Z', 'state', 'unavailable'),
        climateRow('2026-01-19T00:01:00.000900Z', 'state', 'heat'),
        climateRow(recovery, 'state', 'heat'),
        climateRow(recovery, 'hvac_action_str', 'idle'),
        ...(duplicate ? [climateRow('2026-01-19T00:15:00.000500Z', 'state', 'heat')] : []),
        { _time: '2026-01-19T00:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
      // These are already 15-minute aggregate starts, not raw numeric readings.
      fixture.rows.reported = [reportedRow('2026-01-19T00:15:00Z'), reportedRow('2026-01-19T00:30:00Z')];
      fixture.rows.temperatures = [
        { _time: '2026-01-19T00:30:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: '2026-01-19T00:30:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      const result = await fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', followMe: 'false', thermostatHome: 'true',
      });
      expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBe(expected);
      if (expected === null) expect(result.recommendations.some((rec) => rec.sensorId === 'office_temperature')).toBe(false);
    });

  it('review 202e893: a later complete reference bucket remains usable after fractional recovery', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = [
      climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T00:01:00.000100Z', 'state', 'unavailable'),
      climateRow('2026-01-19T00:01:00.000900Z', 'state', 'heat'),
      climateRow('2026-01-19T00:15:00.000500Z', 'state', 'heat'),
      climateRow('2026-01-19T00:15:00.000500Z', 'hvac_action_str', 'idle'),
      { _time: '2026-01-19T00:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    fixture.rows.reported = [
      reportedRow('2026-01-19T00:15:00Z'), reportedRow('2026-01-19T00:30:00Z'), reportedRow('2026-01-19T00:45:00Z'),
    ];
    fixture.rows.temperatures = [
      { _time: '2026-01-19T00:30:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T00:45:00Z', _value: '22', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T00:30:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      { _time: '2026-01-19T00:45:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    const result = await fixture.service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', followMe: 'false', thermostatHome: 'true',
    });
    expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBe(2);
  });

  it('review 202e893: a preset reported before fractional climate recovery is not carried through the outage', async () => {
    const run = async (presetTime: string) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      fixture.rows.states = [
        climateRow('2026-01-19T06:00:00Z', 'state', 'unavailable'),
        climateRow('2026-01-19T06:15:00.000500Z', 'state', 'heat'),
        climateRow('2026-01-19T06:15:00.000500Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T06:15:00.000500Z', 'temperature', '21'),
        climateRow(presetTime, 'preset_mode_str', 'home'),
      ];
      fixture.rows.reported = [reportedRow('2026-01-19T06:30:00Z'), reportedRow('2026-01-19T06:45:00Z')];
      fixture.rows.temperatures = [
        { _time: '2026-01-19T06:45:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: '2026-01-19T06:45:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      const result = await fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'false',
      });
      return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home;
    };
    expect(await run('2026-01-19T06:15:00.000100Z')).toBeNull();
    expect(await run('2026-01-19T06:15:00.000500Z')).toBe(3);
    expect(await run('2026-01-19T06:15:00.000900Z')).toBe(3);
  });

  it.each(['action', 'preset', 'comfort', 'occupancy'] as const)(
    'review 202e893: a %s recovery after a source boundary cannot be applied retroactively',
    async (field) => {
      const run = async (recovery: string, unchanged = false) => {
        const fixture = makeDeps();
        useClimateReference(fixture);
        const start = '2026-01-19T06:00:00Z';
        const before = '2026-01-19T06:14:00Z';
        const select = (time: string, value: string) => ({
          _time: time, _field: 'state', _value: value, domain: 'select', entity_id: 'home_current_mode',
        });
        const occupancy = (time: string, id: string, name: string, value: string) => ({
          _time: time, _field: name, _value: value, domain: 'binary_sensor', entity_id: id,
        });
        const states: Rows = [
          climateRow(start, 'state', 'heat'), climateRow(start, 'hvac_action_str', 'idle'),
          climateRow(start, 'temperature', '21'), climateRow(start, 'preset_mode_str', 'home'),
        ];
        if (field !== 'preset') states.push(select(start, 'home'));
        if (field === 'action') {
          if (!unchanged) states.push(climateRow(before, 'hvac_action_str', 'unknown'));
          states.push(climateRow(recovery, 'hvac_action_str', 'idle'));
        } else if (field === 'preset') {
          if (!unchanged) states.push(climateRow(before, 'preset_mode_str', 'sleep'));
          states.push(climateRow(recovery, 'preset_mode_str', 'home'));
        } else if (field === 'comfort') {
          if (!unchanged) states.push(select(before, 'sleep'));
          states.push(select(recovery, 'home'));
        } else {
          fixture.deps.indoorClimate.placementDiscovery.mockReturnValue({
            climateEntityId: 'climate.home', thermostatTemperatureEntityId: null, thermostatOccupancyEntityId: null,
            occupancyByTemperature: new Map([
              ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
              ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
            ]),
            unclassifiedTemperatureIds: new Set<string>(),
          });
          states.push(
            occupancy(start, 'office_occupancy', 'value', '1'),
            occupancy(start, 'kitchen_occupancy', 'value', '1'),
            ...(!unchanged ? [occupancy(before, 'office_occupancy', 'state', 'unavailable')] : []),
            occupancy(recovery, 'office_occupancy', 'value', '1'),
          );
          fixture.rows.reported = [];
        }
        fixture.rows.states = states;
        if (field !== 'occupancy') fixture.rows.reported = [reportedRow('2026-01-19T06:15:00Z')];
        fixture.rows.temperatures = [
          { _time: '2026-01-19T06:15:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
          { _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
        ];
        const result = await fixture.service.getInsights('7', {
          home: 'office_temperature,kitchen_temperature',
          followMe: field === 'occupancy' ? 'true' : 'false',
          thermostatHome: field === 'occupancy' ? 'false' : 'true',
        });
        return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home;
      };
      const valid = field === 'occupancy' ? 1.5 : 3;
      expect(await run('2026-01-19T06:14:59.999999Z')).toBe(valid);
      expect(await run('2026-01-19T06:15:00.000000Z')).toBe(valid);
      expect(await run('2026-01-19T06:15:00.000500Z')).toBeNull();
      expect(await run('2026-01-19T06:15:00.000500Z', true)).toBe(valid);
    },
  );

  it('review 202e893: a fractional duplicate does not invalidate a known source window', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T06:15:00.000000Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T06:15:00.000500Z', 'hvac_action_str', 'idle'),
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    fixture.rows.reported = [reportedRow('2026-01-19T06:15:00Z')];
    fixture.rows.temperatures = [
      { _time: '2026-01-19T06:15:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    const result = await fixture.service.getInsights('7', { thermostatHome: 'true', followMe: 'false' });
    expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBe(3);
  });

  it('review 202e893: fractional built-in occupancy recovery stays unknown only for the overlapping bucket', async () => {
    const run = async (recovery: string, source: string) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      fixture.deps.indoorClimate.placementDiscovery.mockReturnValue({
        climateEntityId: 'climate.home', thermostatTemperatureEntityId: null,
        thermostatOccupancyEntityId: 'binary_sensor.home_occupancy',
        occupancyByTemperature: new Map([
          ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
          ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
        ]),
        unclassifiedTemperatureIds: new Set<string>(),
      });
      const occupancy = (time: string, id: string, field: string, value: string) => ({
        _time: time, _field: field, _value: value, domain: 'binary_sensor', entity_id: id,
      });
      fixture.rows.states = [
        climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
        climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
        { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
        occupancy('2026-01-19T06:00:00Z', 'office_occupancy', 'value', '1'),
        occupancy('2026-01-19T06:00:00Z', 'kitchen_occupancy', 'value', '1'),
        occupancy('2026-01-19T06:00:00Z', 'home_occupancy', 'state', 'unavailable'),
        occupancy(recovery, 'home_occupancy', 'value', '0'),
      ];
      fixture.rows.reported = [];
      fixture.rows.temperatures = [
        { _time: source, _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: source, _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      const result = await fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
      });
      return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home;
    };
    const source = '2026-01-19T06:15:00Z';
    expect(await run('2026-01-19T06:14:59.999999Z', source)).toBe(1.5);
    expect(await run('2026-01-19T06:15:00.000000Z', source)).toBe(1.5);
    expect(await run('2026-01-19T06:15:00.000500Z', source)).toBeNull();
    expect(await run('2026-01-19T06:15:00.000500Z', '2026-01-19T06:30:00Z')).toBe(1.5);
  });

  it('review 202e893: an ordinary fractional transition keeps later data and the healthy cache TTL', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '21'),
      climateRow('2026-01-19T06:15:00.000500Z', 'hvac_action_str', 'heating'),
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    fixture.rows.reported = [reportedRow('2026-01-19T06:15:00Z'), reportedRow('2026-01-19T06:30:00Z')];
    fixture.rows.temperatures = [
      { _time: '2026-01-19T06:15:00Z', _value: '23', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:30:00Z', _value: '22', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:15:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      { _time: '2026-01-19T06:30:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    const config = { home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'false' };
    const result = await fixture.service.getInsights('7', config);
    expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.home).toBe(2);
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7', config);
    expect(fixture.calls('reported')).toHaveLength(1);
    fixture.advance(PLACEMENT_CACHE_TTL_MS);
    await fixture.service.getInsights('7', config);
    expect(fixture.calls('reported')).toHaveLength(2);
  });

  it('review 202e893: fractional wake recovery cannot create a reference-based wake tip', async () => {
    const run = async (fraction: string) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      const start = Date.parse('2026-01-15T00:00:00Z');
      const hour = 60 * 60_000;
      const day = 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const micro = (t: number, part: string) => iso(t).replace('.000Z', `.${part}Z`);
      const select = (t: number, setting: string) => ({
        _time: iso(t), _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
      });
      const temperatures: Rows = [];
      const reported: Rows = [];
      const states: Rows = [];
      for (let d = 0; d < 5; d += 1) {
        const beginning = start + d * day;
        const wake = beginning + 6 * hour;
        const interruption = wake - 5 * 60_000;
        states.push(
          climateRow(iso(beginning), 'state', 'heat'), climateRow(iso(beginning), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning), 'temperature', '21'), select(beginning, 'sleep'),
          climateRow(micro(interruption, '000100'), 'state', 'unavailable'),
          climateRow(micro(interruption, '000900'), 'state', 'heat'),
          climateRow(micro(wake, fraction), 'state', 'heat'),
          climateRow(micro(wake, fraction), 'hvac_action_str', 'heating'),
          climateRow(micro(wake, fraction), 'temperature', '21'),
          select(wake, 'home'), climateRow(iso(wake + hour), 'hvac_action_str', 'idle'),
          select(beginning + 22 * hour, 'sleep'),
        );
        reported.push(reportedRow(iso(wake), '21'), reportedRow(iso(wake + 15 * 60_000), '21'));
        for (let t = wake; t < wake + 3 * hour; t += 15 * 60_000) {
          const running = t < wake + hour;
          [
            ['office_temperature', running ? '18' : '21'],
            ['kitchen_temperature', '23'],
          ].forEach(([entityId, value]) => temperatures.push({
            _time: iso(t), _value: value, _measurement: '°C', entity_id: entityId,
          }));
        }
      }
      fixture.rows.states = states;
      fixture.rows.reported = reported;
      fixture.rows.temperatures = temperatures;
      return fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', sleep: 'office_temperature,kitchen_temperature',
        followMe: 'false', thermostatHome: 'true', thermostatSleep: 'true',
      });
    };
    const exact = await run('000000');
    expect(exact.recommendations.find((rec) => rec.id === 'wake-office')).toBeDefined();
    const fractional = await run('000500');
    expect(fractional.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.wake).toBeNull();
    expect(fractional.recommendations.some((rec) => rec.id === 'wake-office')).toBe(false);
  });

  it('review 202e893: a fractional cooling anchor does not make partial buckets into cooling advice', async () => {
    const run = async (position: 'before' | 'exact' | 'after', minutes = 15) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      const start = Date.parse('2026-01-16T00:00:00Z');
      const hour = 60 * 60_000;
      const day = 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const anchor = (t: number) => {
        if (position === 'before') return iso(t - 1_000).replace('.000Z', '.999999Z');
        if (position === 'after') return iso(t).replace('.000Z', '.000500Z');
        return iso(t);
      };
      const temperatures: Rows = [];
      const reported: Rows = [];
      const states: Rows = [];
      for (let d = 0; d < 4; d += 1) {
        const beginning = start + d * day;
        states.push(
          climateRow(iso(beginning), 'state', 'cool'), climateRow(iso(beginning), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning), 'temperature', '24'),
          { _time: iso(beginning), _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
        );
        for (const h of [12, 14]) {
          const beginningRun = beginning + h * hour;
          states.push(
            climateRow(anchor(beginningRun), 'hvac_action_str', 'cooling'),
            climateRow(iso(beginningRun + minutes * 60_000), 'hvac_action_str', 'idle'),
          );
          for (let t = beginningRun; t < beginningRun + minutes * 60_000; t += 15 * 60_000) {
            reported.push(reportedRow(iso(t), '20'));
            [
              ['office_temperature', '26'], ['kitchen_temperature', '20'],
            ].forEach(([entityId, value]) => temperatures.push({
              _time: iso(t), _value: value, _measurement: '°C', entity_id: entityId,
            }));
          }
        }
      }
      fixture.rows.states = states;
      fixture.rows.cooling = states.filter(({ domain, _field: field, _value: value }) =>
        domain === 'climate' && (field === 'state' || value === 'cooling'));
      fixture.rows.reported = reported;
      fixture.rows.temperatures = temperatures;
      return fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'false',
      });
    };
    for (const position of ['before', 'exact'] as const) {
      const result = await run(position);
      expect(result.coverage.coolingEvents).toBe(8);
      expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBe(6);
      expect(result.recommendations.find((rec) => rec.id === 'cooling-office')).toBeDefined();
    }
    const fractional = await run('after');
    expect(fractional.coverage.coolingEvents).toBe(8);
    expect(fractional.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBeNull();
    expect(fractional.recommendations.some((rec) => rec.mode === 'cooling')).toBe(false);
    const longer = await run('after', 60);
    expect(longer.coverage.coolingEvents).toBe(8);
    expect(longer.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBe(6);
    expect(longer.recommendations.find((rec) => rec.id === 'cooling-office')!.detail).toContain('8 of 8 cooling runs');
  });

  it.each(['current', 'older'] as const)('review 202e893: a %s cooling run retains its later whole source bucket', async (window) => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    const date = window === 'current' ? '2026-01-19' : '2025-10-15';
    const states = [
      climateRow(`${date}T11:00:00Z`, 'state', 'cool'),
      climateRow(`${date}T11:00:00Z`, 'hvac_action_str', 'idle'),
      climateRow(`${date}T11:00:00Z`, 'temperature', '22'),
      { _time: `${date}T11:00:00Z`, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      climateRow(`${date}T12:00:00.000500Z`, 'hvac_action_str', 'cooling'),
      climateRow(`${date}T12:30:00Z`, 'hvac_action_str', 'idle'),
    ];
    fixture.rows.cooling = [
      climateRow(`${date}T11:00:00Z`, 'state', 'cool'),
      climateRow(`${date}T12:00:00.000500Z`, 'hvac_action_str', 'cooling'),
    ];
    const reported = [
      reportedRow(`${date}T12:00:00Z`), reportedRow(`${date}T12:15:00Z`),
    ];
    const temperatures = [
      { _time: `${date}T12:00:00Z`, _value: '26', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: `${date}T12:15:00Z`, _value: '20', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: `${date}T12:00:00Z`, _value: '18', _measurement: '°C', entity_id: 'kitchen_temperature' },
      { _time: `${date}T12:15:00Z`, _value: '22', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    if (window === 'current') {
      fixture.rows.states = states;
      fixture.rows.reported = reported;
      fixture.rows.temperatures = temperatures;
    } else {
      const currentQuery = fixture.deps.influxdb.query.getMockImplementation()!;
      fixture.deps.influxdb.query.mockImplementation(async (flux: string) => {
        if (!flux.includes('2025-10-08T14:00:00.000Z')) return currentQuery(flux);
        if (queryKind(flux) === 'states') return states;
        if (queryKind(flux) === 'reported') return reported;
        if (queryKind(flux) === 'temperatures') return temperatures;
        return [];
      });
    }
    const result = await fixture.service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'false',
    });
    expect(result.coverage.coolingFrom).toBe(window === 'current' ? '2026-01-13T00:00:00.000Z' : '2025-10-08T14:00:00.000Z');
    expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.periodOffsets.cooling).toBe(0);
    expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.coolingUndershoot).toBe(0);
  });

  it('review 202e893: a fractional cooling target cannot be applied to the preceding bucket', async () => {
    const run = async (target: string) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      fixture.rows.states = [
        climateRow('2026-01-19T11:00:00Z', 'state', 'cool'),
        climateRow('2026-01-19T11:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T11:59:00Z', 'temperature', 'unknown'),
        climateRow(target, 'temperature', '22'),
        climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow('2026-01-19T12:15:00Z', 'hvac_action_str', 'idle'),
        { _time: '2026-01-19T11:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
      fixture.rows.cooling = [
        climateRow('2026-01-19T11:00:00Z', 'state', 'cool'),
        climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
      ];
      fixture.rows.reported = [reportedRow('2026-01-19T12:00:00Z')];
      fixture.rows.temperatures = [
        { _time: '2026-01-19T12:00:00Z', _value: '18', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: '2026-01-19T12:00:00Z', _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      const result = await fixture.service.getInsights('7', { thermostatHome: 'true', followMe: 'false' });
      return result.sensors.find((sensor) => sensor.id === 'office_temperature')!.coolingUndershoot;
    };
    expect(await run('2026-01-19T11:59:59.999999Z')).toBe(4);
    expect(await run('2026-01-19T12:00:00.000000Z')).toBe(4);
    expect(await run('2026-01-19T12:00:00.000500Z')).toBeNull();
  });

  it('review 202e893: a numerically unchanged target is not carried through a mode change', async () => {
    const run = async (target: string) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      fixture.rows.states = [
        climateRow('2026-01-19T00:00:00Z', 'state', 'heat'),
        climateRow('2026-01-19T00:00:00Z', 'hvac_action_str', 'idle'),
        climateRow('2026-01-19T00:00:00Z', 'temperature', '21'),
        { _time: '2026-01-19T00:00:00Z', _field: 'state', _value: 'sleep', domain: 'select', entity_id: 'home_current_mode' },
        climateRow('2026-01-19T05:30:00Z', 'hvac_action_str', 'heating'),
        climateRow('2026-01-19T06:00:00Z', 'state', 'heat_cool'),
        climateRow(target, 'target_temp_low', '21'),
        { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
        climateRow('2026-01-19T07:00:00Z', 'hvac_action_str', 'idle'),
      ];
      const temperatures: Rows = [];
      const reported: Rows = [];
      for (let t = Date.parse('2026-01-19T06:00:00Z'); t < Date.parse('2026-01-19T08:00:00Z'); t += 15 * 60_000) {
        const time = new Date(t).toISOString();
        reported.push(reportedRow(time, '21'));
        temperatures.push(
          { _time: time, _value: '21', _measurement: '°C', entity_id: 'office_temperature' },
          {
            _time: time, _value: t === Date.parse('2026-01-19T06:00:00Z') ? '25' : '21',
            _measurement: '°C', entity_id: 'kitchen_temperature',
          },
        );
      }
      fixture.rows.reported = reported;
      fixture.rows.temperatures = temperatures;
      const result = await fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', sleep: 'office_temperature,kitchen_temperature',
        thermostatHome: 'true', thermostatSleep: 'true', followMe: 'false',
      });
      return result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot;
    };
    expect(await run('2026-01-19T06:00:00.000000Z')).toBe(4);
    expect(await run('2026-01-19T06:00:00.000500Z')).toBe(0);
  });

  it('review 202e893: a later fractional mode cannot retroactively validate a cooling anchor', async () => {
    const run = async (mode: string, action: string) => {
      const fixture = makeDeps();
      const priorMode = climateRow('2026-01-19T11:00:00Z', 'state', 'heat');
      const modeChange = climateRow(mode, 'state', 'cool');
      const cooling = climateRow(action, 'hvac_action_str', 'cooling');
      fixture.rows.cooling = [
        ...coolingRows('2025-10-15T12:00:00Z'), priorMode, modeChange, cooling,
      ];
      fixture.rows.states = [priorMode, modeChange, cooling];
      statesForWindow(fixture, '2025-10-08T14:00:00.000Z', coolingRows('2025-10-15T12:00:00Z'));
      return fixture.service.getInsights('7');
    };
    const actionBeforeMode = await run('2026-01-19T12:00:00.000900Z', '2026-01-19T12:00:00.000100Z');
    expect(actionBeforeMode.coverage.coolingFrom).toBe('2025-10-08T14:00:00.000Z');
    for (const [mode, action] of [
      ['2026-01-19T12:00:00.000100Z', '2026-01-19T12:00:00.000900Z'],
      ['2026-01-19T12:00:00.000500Z', '2026-01-19T12:00:00.000500Z'],
      ['2026-01-19T12:00:00.000000Z', '2026-01-19T12:00:00.000900Z'],
    ]) {
      expect((await run(mode, action)).coverage.coolingFrom).toBe('2026-01-13T00:00:00.000Z');
    }
  });

  it('review 202e893: a cooling action followed by an incompatible mode in the same millisecond stays uncertain', async () => {
    const run = async (mode: string) => {
      const fixture = makeDeps();
      neutralHeating(fixture);
      const previous = climateRow('2026-01-19T11:00:00Z', 'state', 'cool');
      const action = climateRow('2026-01-19T12:00:00.000100Z', 'hvac_action_str', 'cooling');
      const next = climateRow('2026-01-19T12:00:00.000900Z', 'state', mode);
      fixture.rows.cooling = [...coolingRows('2025-10-15T12:00:00Z'), previous, action, next];
      fixture.rows.states.push(previous, action, next);
      return { result: await fixture.service.getInsights('7'), fixture };
    };
    const interrupted = await run('heat');
    expect(interrupted.result.coverage.coolingFrom).toBeNull();
    expect(interrupted.result.recommendations.find((rec) => rec.id === 'no-changes')!.detail)
      .toContain('Cooling history could not be assessed reliably.');
    interrupted.fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await interrupted.fixture.service.getInsights('7');
    expect(interrupted.fixture.calls('cooling')).toHaveLength(2);
    const compatible = await run('heat_cool');
    expect(compatible.result.coverage).toMatchObject({ coolingFrom: '2026-01-13T00:00:00.000Z', coolingEvents: 1 });
  });

  it('does not convert cooling targets with today’s unit when reported history contradicts it', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.reported = [
      { ...reportedRow('2026-01-19T06:00:00Z', '68'), unit_tag: '°F' },
      { ...reportedRow('2026-01-19T06:15:00Z', '20'), unit_tag: '°C' },
    ];
    fixture.rows.cooling = coolingRows('2026-01-19T06:00:00Z');
    fixture.rows.temperatures = fixture.rows.temperatures.map((row) => (
      row.entity_id === 'office_temperature' ? { ...row, _value: '18' } : row
    ));
    (fixture.rows.temperatures as Rows).push(
      { _time: '2026-01-19T06:15:00Z', _value: '18', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: '2026-01-19T06:15:00Z', _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
    );
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00.000100Z', 'state', 'cool'),
      climateRow('2026-01-19T06:00:00.000300Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-19T06:00:00.000500Z', 'temperature', '35'),
      climateRow('2026-01-19T06:30:00Z', 'hvac_action_str', 'idle'),
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    const result = await fixture.service.getInsights('7');
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office.periodOffsets.cooling).toBe(-2);
    expect(office.coolingUndershoot).toBeNull();
    expect(result.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: false, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
      },
    });
  });

  it('keeps current target assumptions separate from conflicts in older cooling history', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.reported = [{ ...reportedRow(), unit_tag: '°C' }];
    fixture.rows.cooling = coolingRows('2025-10-15T12:00:00Z');
    const currentQuery = fixture.deps.influxdb.query.getMockImplementation()!;
    fixture.deps.influxdb.query.mockImplementation(async (flux: string) => {
      if (!flux.includes('2025-10-08T14:00:00.000Z')) return currentQuery(flux);
      const time = '2025-10-15T12:00:00Z';
      if (queryKind(flux) === 'reported') return [{ ...reportedRow(time, '68'), unit_tag: '°F' }];
      if (queryKind(flux) === 'temperatures') return [
        { _time: time, _value: '18.5', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: time, _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      return [
        climateRow(time, 'state', 'cool'), climateRow(time, 'hvac_action_str', 'cooling'),
        climateRow(time, 'temperature', '35'), climateRow('2025-10-15T12:30:00Z', 'hvac_action_str', 'idle'),
        { _time: time, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
    });
    const result = await fixture.service.getInsights('7');
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office.periodOffsets.cooling).toBe(-1.5);
    expect(office.coolingUndershoot).toBeNull();
    expect(result.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: false, setpoints: true, coolingReportedTemperature: false, coolingSetpoints: false,
      },
    });
  });

  it('does not assume reference or target units when climate state metadata conflicts', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = (fixture.rows.states as Rows).map((row) => (
      row.domain === 'climate' ? { ...row, unit_of_measurement: '°F' } : row
    ));
    const result = await fixture.service.getInsights('7');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
    expect(result.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: false, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
      },
    });
  });

  it('keeps explicitly tagged reference buckets while dropping untagged ones after a state-unit conflict', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.states = (fixture.rows.states as Rows).map((row) => (
      row.domain === 'climate' ? { ...row, unit_of_measurement: '°F' } : row
    ));
    fixture.rows.reported = [
      { ...reportedRow('2026-01-19T06:00:00Z'), unit_tag: '°C' },
      reportedRow('2026-01-19T06:15:00Z'),
    ];
    (fixture.rows.temperatures as Rows).push({
      _time: '2026-01-19T06:15:00Z', _value: '10', _measurement: '°C', entity_id: 'office_temperature',
    });
    const result = await fixture.service.getInsights('7');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(-1.5);
    expect(result.coverage.unitAssumptions).toEqual({
      reportedTemperature: false, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
    });
  });

  it('discloses assumed target units independently of explicitly tagged reference units', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.reported = [{ ...reportedRow(), unit_tag: '°C' }];
    const result = await fixture.service.getInsights('7', { home: '', thermostatHome: 'false' });
    expect(result.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: false, setpoints: true, coolingReportedTemperature: false, coolingSetpoints: false,
      },
    });
    const rec = result.recommendations.find((r) => r.id === 'participation-empty-home')!;
    expect(rec.detail).toContain('Historical thermostat set points assume Home Assistant\'s last known temperature unit applied historically');
  });

  it('retains the normal TTL for an old but usable climate history', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    // A latest raw value 36 minutes before NOW belongs to this 23:15 bucket.
    fixture.rows.reported = [reportedRow('2026-01-19T23:15:00Z')];
    await fixture.service.getInsights('7');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('reported')).toHaveLength(1);
    fixture.advance(PLACEMENT_CACHE_TTL_MS);
    await fixture.service.getInsights('7');
    expect(fixture.calls('reported')).toHaveLength(2);
  });

  it('does not shorten the TTL for an unused physical thermostat sensor without history', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.temperatures = fixture.rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    await fixture.service.getInsights('7');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('reported')).toHaveLength(1);
  });

  it.each(['missing', 'failed', 'unknown unit', 'unavailable bucket', 'unavailable attribute'])(
    'retries a %s climate reference with no other usable reference history',
    async (problem) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      if (problem === 'missing') fixture.rows.reported = [];
      if (problem === 'failed') fixture.rows.reported = new Error('influx down');
      if (problem === 'unknown unit') fixture.deps.indoorClimate.cachedStatus.thermostat.temperatureUnit = null as never;
      if (problem === 'unavailable bucket') {
        (fixture.rows.states as Rows).push(
          climateRow('2026-01-19T06:07:00Z', 'state', 'unavailable'),
          climateRow('2026-01-19T06:15:00Z', 'state', 'heat'),
        );
      }
      if (problem === 'unavailable attribute') {
        (fixture.rows.states as Rows).push(climateRow('2026-01-19T06:07:00Z', 'current_temperature_str', 'unknown'));
      }
      const result = await fixture.service.getInsights('7');
      expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
      fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
      await fixture.service.getInsights('7');
      expect(fixture.calls('reported')).toHaveLength(2);
    },
  );

  it('reuses the reported reference for recent cooling and fetches a separate older reference', async () => {
    const configureCooling = (fixture: ReturnType<typeof makeDeps>) => {
      useClimateReference(fixture);
      fixture.rows.states = [
        climateRow('2026-01-19T06:00:00Z', 'state', 'cool'),
        climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow('2026-01-19T06:00:00Z', 'temperature', '24'),
        climateRow('2026-01-19T06:30:00Z', 'hvac_action_str', 'idle'),
        { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
    };
    const recent = makeDeps();
    configureCooling(recent);
    recent.rows.cooling = coolingRows('2026-01-19T06:00:00Z');
    const current = await recent.service.getInsights('7');
    expect(current.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBe(-1.5);
    expect(current.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: true, setpoints: true, coolingReportedTemperature: true, coolingSetpoints: true,
      },
    });
    expect(recent.calls('reported')).toHaveLength(1);

    const older = makeDeps();
    configureCooling(older);
    older.rows.cooling = coolingRows('2025-10-15T12:00:00Z');
    const queryCurrentWindow = older.deps.influxdb.query.getMockImplementation()!;
    older.deps.influxdb.query.mockImplementation(async (flux: string) => {
      if (!flux.includes('2025-10-08T14:00:00.000Z')) return queryCurrentWindow(flux);
      const time = '2025-10-15T12:00:00Z';
      if (queryKind(flux) === 'reported') return [{ ...reportedRow(time, '22'), unit_tag: '°C' }];
      if (queryKind(flux) === 'temperatures') return [
        { _time: time, _value: '24', _measurement: '°C', entity_id: 'home_current_temperature' },
        { _time: time, _value: '18.5', _measurement: '°C', entity_id: 'office_temperature' },
        { _time: time, _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
      return [
        climateRow(time, 'state', 'cool'), climateRow(time, 'hvac_action_str', 'cooling'),
        climateRow(time, 'temperature', '24'), climateRow('2025-10-15T12:30:00Z', 'hvac_action_str', 'idle'),
        { _time: time, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
    });
    const separate = await older.service.getInsights('7');
    expect(separate.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBe(-3.5);
    expect(separate.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: true, setpoints: true, coolingReportedTemperature: false, coolingSetpoints: true,
      },
    });
    expect(older.calls('reported')).toHaveLength(2);
    expect(older.calls('reported')[1]).toContain('2025-10-08T14:00:00.000Z');

    older.advance(PLACEMENT_CACHE_TTL_MS + 1);
    const previous = older.deps.influxdb.query.getMockImplementation()!;
    older.deps.influxdb.query.mockImplementation(async (flux: string) => {
      if (flux.includes('2025-10-08T14:00:00.000Z') && queryKind(flux) === 'reported') return [];
      return previous(flux);
    });
    const missing = await older.service.getInsights('7');
    expect(missing.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBeNull();
  });

  it('builds a safe climate query over complete source buckets', () => {
    const flux = buildReportedTemperatureQuery(
      'home_assistant', 'home', new Date('2026-01-19T06:07:00Z'), new Date('2026-01-19T07:07:00Z'),
    );
    expect(flux).toContain('range(start: time(v: "2026-01-19T06:15:00.000Z"), stop: time(v: "2026-01-19T07:00:00.000Z"))');
    expect(flux).toContain('aggregateWindow(every: 15m, fn: mean, createEmpty: false, timeSrc: "_start")');
    expect(() => buildReportedTemperatureQuery('bucket', 'home") or true', new Date(0), new Date(86_400_000)))
      .toThrow('Unsafe entity id');
  });

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

  it('uses thermostat occupancy independently of an unverified thermostat temperature', async () => {
    const run = async (thermostatHome: string | undefined, followMe: string, occupancy: string) => {
      const { service, deps, rows, calls } = makeDeps();
      deps.indoorClimate.placementDiscovery.mockReturnValue({
        climateEntityId: 'climate.home',
        thermostatTemperatureEntityId: null,
        thermostatOccupancyEntityId: 'binary_sensor.home_occupancy',
        occupancyByTemperature: new Map([
          ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
          ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
        ]),
        unclassifiedTemperatureIds: new Set<string>(),
      });
      rows.temperatures = rows.temperatures.map((row) => (
        row.entity_id === 'home_current_temperature' ? { ...row, _value: '24' } : row
      ));
      (rows.states as Rows).push(
        { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: occupancy, domain: 'binary_sensor', entity_id: 'home_occupancy' },
        { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'office_occupancy' },
        { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
      );
      const result = await service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature', thermostatHome, followMe,
      });
      expect(calls('states')[0]).toContain('r.entity_id == "home_occupancy"');
      expect(result.sensors.find((s) => s.id === 'home_current_temperature')).toMatchObject({
        name: 'Home',
        isThermostat: true,
        verdictSummary: expect.stringContaining('not known to be the selected thermostat\'s comfort reading'),
      });
      return result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home;
    };

    expect(await run('false', 'false', '1')).toBe(-1);
    expect(await run(undefined, 'false', '0')).toBeNull();
    expect(await run('true', 'true', '0')).toBe(-2);
    expect(await run('true', 'true', '1')).toBeNull();
  });

  it.each([
    ['0', -2],
    ['1', null],
  ])('uses the separate cooling history for physical thermostat occupancy %s', async (value, offset) => {
    const { service, deps, rows, calls } = makeDeps();
    deps.indoorClimate.cachedStatus.sensors = deps.indoorClimate.cachedStatus.sensors.filter((s) => !s.isThermostat);
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: null,
      thermostatOccupancyEntityId: 'binary_sensor.home_occupancy',
      occupancyByTemperature: new Map([
        ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
        ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
      ]),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    rows.cooling = coolingRows('2025-10-15T12:00:00Z');
    (rows.states as Rows).push({
      _time: '2026-01-19T06:00:00Z', _field: 'value', _value: value === '0' ? '1' : '0',
      domain: 'binary_sensor', entity_id: 'home_occupancy',
    });
    const coolingTime = '2025-10-15T12:00:00Z';
    const coolingTemperatures = [
      { _time: coolingTime, _value: '18.5', _measurement: '°C', entity_id: 'office_temperature' },
      { _time: coolingTime, _value: '20.5', _measurement: '°C', entity_id: 'kitchen_temperature' },
    ];
    const coolingStates = [
      climateRow(coolingTime, 'state', 'cool'),
      climateRow(coolingTime, 'hvac_action_str', 'cooling'),
      { _time: coolingTime, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      { _time: coolingTime, _field: 'value', _value: value, domain: 'binary_sensor', entity_id: 'home_occupancy' },
      { _time: coolingTime, _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'office_occupancy' },
      { _time: coolingTime, _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
    ];
    const queryCurrentWindow = deps.influxdb.query.getMockImplementation()!;
    deps.influxdb.query.mockImplementation(async (flux: string) => {
      if (flux.includes('2025-10-08T14:00:00.000Z')) {
        return queryKind(flux) === 'temperatures' ? coolingTemperatures : coolingStates;
      }
      return queryCurrentWindow(flux);
    });
    const result = await service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
    });
    expect(calls('states')).toHaveLength(2);
    expect(calls('states')[1]).toContain('r.entity_id == "home_occupancy"');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBe(offset);
  });

  it.each([
    ['0', -2],
    ['1', null],
    ['unavailable', null],
  ])('associates thermostat occupancy %s with the aggregate entity', async (value, offset) => {
    const { service, rows } = makeDeps();
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    (rows.states as Rows).push(
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: value, domain: 'binary_sensor', entity_id: 'home_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'office_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
    );
    const result = await service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
    });
    expect(result.coverage.occupancyAvailable).toBe(true);
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(offset);
  });

  it('uses the discovered thermostat occupancy even when entity names collide', async () => {
    const { service, deps, rows, calls } = makeDeps();
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map([
        ['sensor.home_current_temperature', 'binary_sensor.renamed_hall_motion'],
        ['sensor.office_temperature', 'binary_sensor.home_occupancy'],
        ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
      ]),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    (rows.states as Rows).push(
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'renamed_hall_motion' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'home_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
    );
    const result = await service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
    });
    expect(calls('states')[0]).toContain('r.entity_id == "renamed_hall_motion"');
    expect(calls('states')[0]).not.toContain('r.entity_id == "office_occupancy"');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
  });

  it('does not guess thermostat occupancy when discovery cannot uniquely match it', async () => {
    const { service, deps, rows, calls } = makeDeps();
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map([
        ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
        ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
      ]),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    (rows.states as Rows).push(
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'home_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'office_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
    );
    const result = await service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
    });
    expect(calls('states')[0]).not.toContain('r.entity_id == "home_occupancy"');
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
  });

  it('uses only the selected climate device’s thermostat reading and leaves other thermostats out of rooms', async () => {
    const run = async (primary: string | null, climateEntityId = 'climate.home') => {
      const { service, deps, rows } = makeDeps();
      deps.indoorClimate.cachedStatus.sensors.unshift(sensor('sensor.second_temperature', 'Second thermostat', true));
      deps.indoorClimate.placementDiscovery.mockReturnValue({
        climateEntityId,
        thermostatTemperatureEntityId: primary,
        occupancyByTemperature: new Map(),
        unclassifiedTemperatureIds: new Set<string>(),
      });
      rows.temperatures.push({
        _time: '2026-01-19T06:00:00Z', _value: '15', _measurement: '°C', entity_id: 'second_temperature',
      });
      return service.getInsights('7');
    };
    const selected = await run('sensor.home_current_temperature');
    expect(selected.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(-1.5);
    const secondary = selected.sensors.find((s) => s.id === 'second_temperature')!;
    expect(secondary.isThermostat).toBe(true);
    expect(secondary.name).toBe('Second thermostat');
    expect(secondary.verdictSummary).toContain('not known to be the selected thermostat\'s comfort reading');
    for (const result of [await run(null), await run('sensor.home_current_temperature', 'climate.other')]) {
      expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBeNull();
      expect(result.sensors.find((s) => s.id === 'second_temperature')!.isThermostat).toBe(true);
      expect(result.sensors.find((s) => s.id === 'home_current_temperature')!.verdictSummary)
        .toContain('not known to be the selected thermostat\'s comfort reading');
    }
  });

  it.each([
    ['0', '1', -2],
    ['1', '0', null],
  ])('uses the primary thermostat occupancy %s, not the secondary %s', async (primary, secondary, expected) => {
    const { service, deps, rows } = makeDeps();
    deps.indoorClimate.cachedStatus.sensors.unshift(sensor('sensor.second_temperature', 'Second thermostat', true));
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map([
        ['sensor.home_current_temperature', 'binary_sensor.home_occupancy'],
        ['sensor.second_temperature', 'binary_sensor.second_occupancy'],
        ['sensor.office_temperature', 'binary_sensor.office_occupancy'],
        ['sensor.kitchen_temperature', 'binary_sensor.kitchen_occupancy'],
      ]),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    rows.temperatures.push({
      _time: '2026-01-19T06:00:00Z', _value: '15', _measurement: '°C', entity_id: 'second_temperature',
    });
    (rows.states as Rows).push(
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: primary, domain: 'binary_sensor', entity_id: 'home_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: secondary, domain: 'binary_sensor', entity_id: 'second_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '0', domain: 'binary_sensor', entity_id: 'office_occupancy' },
      { _time: '2026-01-19T06:00:00Z', _field: 'value', _value: '1', domain: 'binary_sensor', entity_id: 'kitchen_occupancy' },
    );
    const result = await service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', thermostatHome: 'true', followMe: 'true',
    });
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.home).toBe(expected);
  });

  it('omits unclassifiable temperatures without reclassifying a secondary thermostat as a room', async () => {
    const { service, deps, rows, calls, advance } = makeDeps();
    deps.indoorClimate.cachedStatus.sensors = [
      sensor('sensor.second_temperature', 'Second thermostat', true),
      sensor('sensor.home_current_temperature', 'Unknown thermostat', false),
      sensor('sensor.office_temperature', 'Unknown room', false),
    ];
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: null,
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set(['sensor.home_current_temperature', 'sensor.office_temperature']),
    });
    rows.temperatures.push({
      _time: '2026-01-19T06:00:00Z', _value: '15', _measurement: '°C', entity_id: 'second_temperature',
    });
    const result = await service.getInsights('7', { home: 'home_current_temperature', thermostatHome: 'false' });
    expect(result.coverage.thermostatParticipationSupported).toBe(true);
    expect(result.sensors.map((s) => [s.id, s.isThermostat])).toEqual([['second_temperature', true]]);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7', { home: 'home_current_temperature', thermostatHome: 'false' });
    expect(calls('temperatures')).toHaveLength(2);
  });

  it('treats a partially unclassifiable inventory as degraded even with an identified primary and rooms', async () => {
    const { service, deps, calls, advance } = makeDeps();
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set(['sensor.office_temperature']),
    });
    const result = await service.getInsights('7');
    expect(result.sensors.map((s) => s.id)).toEqual(['home_current_temperature', 'kitchen_temperature']);
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('temperatures')).toHaveLength(2);
  });

  it('treats an unreadable discovery candidate absent from the snapshot as an incomplete inventory', async () => {
    const { service, deps, calls, advance } = makeDeps();
    deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: 'sensor.home_current_temperature',
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set(['sensor.mystery']),
    });
    const result = await service.getInsights('7');
    expect(result.sensors.map((s) => s.id)).not.toContain('mystery');
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await service.getInsights('7');
    expect(calls('temperatures')).toHaveLength(2);
  });

  it.each([
    ['current', 'failed'], ['current', 'empty'], ['current', 'select-only'], ['current', 'missing'],
    ['current', 'carried'], ['current', 'different'], ['current', 'valid'],
    ['older', 'failed'], ['older', 'empty'], ['older', 'select-only'], ['older', 'missing'],
    ['older', 'carried'], ['older', 'different'], ['older', 'valid'],
  ] as const)(
    'review f8f2b2f: %s cooling anchor with %s unfiltered history',
    async (window, history) => {
      const fixture = makeDeps();
      neutralHeating(fixture);
      useClimateReference(fixture);
      const quarter = 15 * 60_000;
      const iso = (t: number) => new Date(t).toISOString();
      const currentReported: Rows = [];
      for (let t = Date.parse('2026-01-17T00:00:00Z'); t < NOW.getTime(); t += quarter) {
        currentReported.push(reportedRow(iso(t), '21'));
      }
      fixture.rows.reported = currentReported;
      for (let d = 15; d <= 19; d += 1) {
        (fixture.rows.states as Rows).push(
          climateRow(`2026-01-${d}T06:00:00Z`, 'hvac_action_str', 'heating'),
          climateRow(`2026-01-${d}T07:00:00Z`, 'hvac_action_str', 'idle'),
        );
      }
      const anchor = window === 'current' ? '2026-01-19T12:00:00Z' : '2025-10-15T12:00:00Z';
      const initial = window === 'current' ? '2026-01-19T11:00:00Z' : '2025-10-13T00:00:00Z';
      const before = iso(Date.parse(anchor) - 30 * 60_000);
      const after = iso(Date.parse(anchor) + 60 * 60_000);
      const selected: Rows = [
        climateRow(initial, 'state', 'cool'),
        climateRow(initial, 'hvac_action_str', 'idle'),
        climateRow(initial, 'temperature', '24'),
        { _time: initial, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
      if (history === 'carried') {
        selected.push(climateRow(before, 'hvac_action_str', 'cooling'), climateRow(anchor, 'temperature', '24'));
      } else if (history === 'different') selected.push(climateRow(anchor, 'hvac_action_str', 'idle'));
      else if (history === 'valid') {
        selected.push(climateRow(anchor, 'hvac_action_str', 'cooling'), climateRow(after, 'hvac_action_str', 'idle'));
      }
      fixture.rows.cooling = [
        climateRow(initial, 'state', 'cool'), climateRow(anchor, 'hvac_action_str', 'cooling'),
      ];
      const selectedHistory = history === 'empty' ? [] : history === 'select-only'
        ? [{ ...selected[3], _time: window === 'current' ? '2026-01-13T00:00:00Z' : initial }]
        : selected;
      if (window === 'current') {
        fixture.rows.states = history === 'failed' ? new Error('state query failed')
          : history === 'empty' || history === 'select-only' ? selectedHistory : [...fixture.rows.states as Rows, ...selectedHistory];
      } else {
        const oldTemperatures: Rows = [];
        const oldReported: Rows = [];
        for (let t = Date.parse('2025-10-13T00:00:00Z'); t < Date.parse('2025-10-15T14:00:00Z'); t += quarter) {
          oldReported.push(reportedRow(iso(t), '24'));
          ['office_temperature', 'kitchen_temperature'].forEach((entityId) => oldTemperatures.push({
            _time: iso(t), _value: '24', _measurement: '°C', entity_id: entityId,
          }));
        }
        const currentQuery = fixture.deps.influxdb.query.getMockImplementation()!;
        fixture.deps.influxdb.query.mockImplementation(async (flux: string) => {
          if (!flux.includes('2025-10-08T14:00:00.000Z')) return currentQuery(flux);
          if (queryKind(flux) === 'states') {
            if (history === 'failed') throw new Error('state query failed');
            return selectedHistory;
          }
          if (queryKind(flux) === 'temperatures') return oldTemperatures;
          if (queryKind(flux) === 'reported') return oldReported;
          return [];
        });
      }
      const result = await fixture.service.getInsights('7');
      if (history === 'valid') {
        expect(result.coverage).toMatchObject({
          coolingFrom: window === 'current' ? '2026-01-13T00:00:00.000Z' : '2025-10-08T14:00:00.000Z',
          coolingTo: window === 'current' ? '2026-01-20T00:00:00.000Z' : '2025-10-15T14:00:00.000Z',
          coolingEvents: 1,
        });
      } else {
        expect(result.coverage).toMatchObject({ coolingFrom: null, coolingTo: null, coolingEvents: 0 });
        const summary = result.recommendations.find((rec) => rec.id === 'no-changes')!;
        expect(summary.title).not.toBe('No placement issues found');
        expect(summary.detail).toContain('Cooling history could not be assessed reliably.');
        expect(summary.detail).not.toContain('No mode-compatible cooling runs were found');
        expect(summary.detail).not.toContain('No cooling action was confirmed');
      }
      fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
      await fixture.service.getInsights('7');
      expect(fixture.calls('cooling')).toHaveLength(history === 'valid' ? 1 : 2);
    },
  );

  it('reuses the window for cooling within it, else fetches the last cooling season', async () => {
    const recent = makeDeps();
    recent.rows.cooling = coolingRows('2026-01-18T12:00:00Z');
    (recent.rows.states as Rows).push(...recent.rows.cooling);
    const shared = await recent.service.getInsights('7');
    expect(shared.coverage).toMatchObject({ coolingFrom: '2026-01-13T00:00:00.000Z', coolingTo: '2026-01-20T00:00:00.000Z' });
    expect(recent.calls('temperatures')).toHaveLength(1);

    const old = makeDeps();
    old.rows.cooling = coolingRows('2025-10-15T12:00:00Z');
    statesForWindow(old, '2025-10-08T14:00:00.000Z', old.rows.cooling);
    const result = await old.service.getInsights('7');
    expect(result.coverage).toMatchObject({ coolingFrom: '2025-10-08T14:00:00.000Z', coolingTo: '2025-10-15T14:00:00.000Z' });
    expect(old.calls('temperatures')).toHaveLength(2);
    expect(old.calls('temperatures')[1]).toContain('range(start: time(v: "2025-10-08T14:00:00.000Z"), stop: time(v: "2025-10-15T14:00:00.000Z"))');
    expect(old.calls('states')[1]).toContain('stop: time(v: "2025-10-15T14:00:00.000Z")');
  });

  it('review 57a228c: does not pair a preheat across a parsed climate outage', async () => {
    const run = async (outage: 'none' | 'five-minutes' | 'mode-collision' | 'action-collision' | 'target-collision') => {
      const fixture = makeDeps();
      const start = Date.parse('2026-01-15T00:00:00Z');
      const hour = 60 * 60_000;
      const day = 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
      const comfort = (t: number, setting: string) => ({
        _time: iso(t), _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
      });
      const temperatures: Rows = [];
      const states: Rows = [];
      for (let d = 0; d < 5; d += 1) {
        const beginning = start + d * day;
        const wake = beginning + 6 * hour;
        const collision = wake + 5 * 60_000;
        let interruption: Rows = [climateRow(iso(collision), 'hvac_action_str', 'idle')];
        if (outage === 'five-minutes') interruption = [
          climateRow(iso(collision), 'state', 'unavailable'),
          climateRow(iso(wake + 10 * 60_000), 'state', 'heat'),
          climateRow(iso(wake + 10 * 60_000), 'hvac_action_str', 'idle'),
          climateRow(iso(wake + 10 * 60_000), 'temperature', '21'),
        ];
        if (outage === 'mode-collision') interruption = [
          climateRow(micro(collision, '000100'), 'state', 'unavailable'),
          climateRow(micro(collision, '000900'), 'state', 'heat'),
          climateRow(micro(collision, '000900'), 'hvac_action_str', 'idle'),
          climateRow(micro(collision, '000900'), 'temperature', '21'),
          climateRow(iso(wake + 10 * 60_000), 'state', 'heat'),
          climateRow(iso(wake + 10 * 60_000), 'hvac_action_str', 'idle'),
          climateRow(iso(wake + 10 * 60_000), 'temperature', '21'),
        ];
        if (outage === 'action-collision') interruption = [
          climateRow(micro(collision, '000100'), 'hvac_action_str', 'unknown'),
          climateRow(micro(collision, '000900'), 'hvac_action_str', 'idle'),
          climateRow(iso(wake + 10 * 60_000), 'hvac_action_str', 'idle'),
        ];
        if (outage === 'target-collision') interruption = [
          climateRow(micro(collision, '000100'), 'temperature_str', 'unknown'),
          climateRow(micro(collision, '000900'), 'temperature', '21'),
          climateRow(micro(collision, '000900'), 'hvac_action_str', 'idle'),
          climateRow(iso(wake + 10 * 60_000), 'temperature', '21'),
        ];
        states.push(
          climateRow(iso(beginning), 'state', 'heat'),
          climateRow(iso(beginning), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning), 'temperature', '21'),
          comfort(beginning, 'sleep'),
          climateRow(iso(beginning + 5.5 * hour), 'hvac_action_str', 'heating'),
          comfort(wake, 'home'),
          ...interruption,
          climateRow(iso(beginning + 17 * hour), 'hvac_action_str', 'heating'),
          climateRow(iso(beginning + 20 * hour), 'hvac_action_str', 'idle'),
          comfort(beginning + 22 * hour, 'sleep'),
        );
        for (let t = beginning; t < beginning + day; t += 15 * 60_000) {
          const localHour = (t - beginning) / hour;
          const reference = localHour >= 6.25 && localHour < 8 ? 23 : 21;
          [
            ['home_current_temperature', reference],
            ['office_temperature', reference - (localHour >= 5.5 && localHour < 6 ? 3 : 0)],
            ['kitchen_temperature', reference],
          ].forEach(([entityId, value]) => temperatures.push({
            _time: iso(t), _value: String(value), _measurement: '°C', entity_id: String(entityId),
          }));
        }
      }
      fixture.rows.temperatures = temperatures;
      fixture.rows.states = states;
      return fixture.service.getInsights('7', {
        home: 'office_temperature,kitchen_temperature',
        sleep: 'office_temperature,kitchen_temperature',
        followMe: 'false',
        thermostatHome: 'false',
        thermostatSleep: 'false',
      });
    };
    for (const kind of ['five-minutes', 'mode-collision', 'action-collision', 'target-collision'] as const) {
      const interrupted = await run(kind);
      expect(interrupted.coverage.wakeEvents).toBe(5);
      expect(interrupted.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot).toBeNull();
      expect(interrupted.recommendations.some((rec) => rec.id === 'wake-office')).toBe(false);
    }

    const continuous = await run('none');
    expect(continuous.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot).toBe(2);
    expect(continuous.recommendations.find((rec) => rec.id === 'wake-office')).toMatchObject({
      severity: 'high', comfortSetting: 'sleep',
    });
  });

  it.each([
    ['select-first', 5],
    ['preset-first', 5],
    ['select-first', 15],
    ['preset-first', 15],
  ] as const)(
    'review f8f2b2f: a hidden %s comfort transition at Home + %i minutes interrupts wake evidence',
    async (order, minute) => {
      const run = async (transition: 'hidden' | 'separated' | 'stable' | 'none' | 'once') => {
        const fixture = makeDeps();
        useClimateReference(fixture);
        const start = Date.parse('2026-01-15T00:00:00Z');
        const hour = 60 * 60_000;
        const day = 24 * hour;
        const iso = (t: number) => new Date(t).toISOString();
        const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
        const select = (time: string, setting: string) => ({
          _time: time, _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
        });
        const temperatures: Rows = [];
        const reported: Rows = [];
        const states: Rows = [];
        for (let d = 0; d < 5; d += 1) {
          const beginning = start + d * day;
          const wake = beginning + 6 * hour;
          const collision = wake + minute * 60_000;
          const first = micro(collision, transition === 'stable' ? '000900' : '000100');
          const second = micro(collision, transition === 'stable' ? '000100' : transition === 'separated' ? '001000' : '000900');
          const changes = transition === 'none' || (transition === 'once' && d > 0) ? [] : order === 'select-first'
            ? [select(first, 'unknown'), climateRow(second, 'preset_mode_str', 'home')]
            : [climateRow(first, 'preset_mode_str', 'sleep'), select(second, 'home')];
          states.push(
            climateRow(iso(beginning), 'state', 'heat'),
            climateRow(iso(beginning), 'hvac_action_str', 'idle'),
            climateRow(iso(beginning), 'temperature', '21'),
            climateRow(iso(beginning), 'preset_mode_str', order === 'select-first' ? 'sleep' : 'home'),
            select(iso(beginning), 'sleep'),
            climateRow(iso(beginning + 5.5 * hour), 'hvac_action_str', 'heating'),
            select(iso(wake), 'home'),
            ...(order === 'preset-first' ? [select(iso(wake + 60_000), 'unknown')] : []),
            climateRow(iso(wake + 5 * 60_000), 'hvac_action_str', 'idle'),
            ...changes,
            climateRow(iso(beginning + 17 * hour), 'hvac_action_str', 'heating'),
            climateRow(iso(beginning + 20 * hour), 'hvac_action_str', 'idle'),
            select(iso(beginning + 22 * hour), 'sleep'),
          );
          for (let t = beginning; t < beginning + day; t += 15 * 60_000) {
            const localHour = (t - beginning) / hour;
            const reference = localHour >= 6.25 && localHour < 8 ? 23 : 21;
            reported.push(reportedRow(iso(t), String(reference)));
            [
              ['office_temperature', reference - (localHour >= 5.5 && localHour < 6 ? 3 : 0)],
              ['kitchen_temperature', reference],
            ].forEach(([entityId, value]) => temperatures.push({
              _time: iso(t), _value: String(value), _measurement: '°C', entity_id: String(entityId),
            }));
          }
        }
        fixture.rows.states = states;
        fixture.rows.temperatures = temperatures;
        fixture.rows.reported = reported;
        const config = {
          home: 'office_temperature,kitchen_temperature',
          sleep: 'office_temperature,kitchen_temperature',
          thermostatHome: 'false',
          thermostatSleep: 'false',
          followMe: 'false',
        };
        const result = await fixture.service.getInsights('5', config);
        if (transition === 'hidden') {
          fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
          await fixture.service.getInsights('5', config);
          expect(fixture.calls('cooling')).toHaveLength(1);
        }
        return result;
      };

      const interrupted = await run('hidden');
      expect(interrupted.coverage.wakeEvents).toBe(5);
      expect(interrupted.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot).toBeNull();
      expect(interrupted.recommendations.some((rec) => rec.id === 'wake-office')).toBe(false);
      expect((await run('separated')).recommendations.some((rec) => rec.id === 'wake-office')).toBe(false);
      const recovered = await run('once');
      expect(recovered.coverage.wakeEvents).toBe(5);
      expect(recovered.recommendations.find((rec) => rec.id === 'wake-office')).toMatchObject({
        severity: 'high', comfortSetting: 'sleep',
      });
      for (const control of ['none', 'stable'] as const) {
        const continuous = await run(control);
        expect(continuous.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot).toBe(2);
        expect(continuous.recommendations.find((rec) => rec.id === 'wake-office')).toMatchObject({
          severity: 'high', comfortSetting: 'sleep',
        });
      }
    },
  );

  it.each([
    ['before', '000000', '000100', '000900', null, 0],
    ['at start', '000100', '000100', '000900', null, 0],
    ['inside', '000500', '000100', '000900', null, 0],
    ['at end', '000900', '000100', '000900', 2, 15],
    ['after', '000999', '000100', '000900', 2, 15],
    ['preset-first before', '000000', '000100', '000900', null, 0],
    ['preset-first at end', '000900', '000100', '000900', 2, 15],
    ['preset-first after', '000999', '000100', '000900', 2, 15],
    ['next millisecond', '000000', '001100', '001900', null, 0],
    ['simultaneous setting updates', '000100', '000100', '000100', 2, 15],
    ['unchanged duplicates', '000000', '000100', '000900', 2, 20],
    ['heating repeated after the barrier', '000000', '000100', '000900', null, 0],
    ['target before heating', '000999', '000100', '000900', 2, 15],
    ['target with heating', '000999', '000100', '000900', 2, 15],
    ['target after heating', '000950', '000100', '000900', null, 0],
    ['mode before heating', '000999', '000100', '000900', 2, 15],
    ['mode after heating', '000950', '000100', '000900', null, 0],
    ['unchanged target after mode', '000950', '000100', '000900', null, 0],
    ['target repeated across mode', '000950', '000100', '000900', null, 0],
    ['target repeated across mode with valid middle', '000950', '000100', '000900', 2, 15],
    ['unchanged target repeated later', '000950', '000100', '000900', 2, 15],
    ['unrelated cooling target later', '000950', '000100', '000900', 2, 15],
    ['compatible action repeated after mode', '000000', '000100', '000900', null, 0],
    ['incompatible action repeated after mode', '000000', '000100', '000900', 2, 15],
    ['later valid heat-ups', '000000', '000100', '000900', 2, 16],
    ['no interruption', '000000', null, null, 2, 20],
    ['target after heating in stable Home', '000100', null, null, null, 0],
    ['target after heating next millisecond', '000100', null, null, null, 0],
    ['target with heating in stable Home', '000100', null, null, 2, 15],
    ['target before heating in stable Home', '000900', null, null, 2, 15],
    ['target after heating with no select', '000100', null, null, null, 0],
    ['mode after heating in stable Home', '000100', null, null, null, 0],
    ['mode after heating next millisecond', '000100', null, null, null, 0],
    ['mode after heating with no select', '000100', null, null, null, 0],
    ['mode with heating in stable Home', '000100', null, null, 2, 15],
    ['mode before heating in stable Home', '000900', null, null, 2, 15],
    ['select after heating', '000100', '000900', null, null, 0],
    ['select after heating next millisecond', '000100', '001900', null, null, 0],
    ['select before heating', '000900', '000100', null, 2, 15],
    ['select with heating', '000100', '000100', null, 2, 15],
    ['preset after heating', '000100', '000900', null, null, 0],
    ['preset before heating', '000999', '000100', null, 2, 15],
    ['preset with heating', '000500', '000500', null, 2, 15],
  ] as const)(
    'review 693b3c0: heating %s uses recorded HVAC and setting order',
    async (description, actionFraction, firstFraction, lastFraction, expectedOvershoot, expectedSamples) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      const start = Date.parse('2026-01-15T00:00:00Z');
      const hour = 60 * 60_000;
      const day = 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
      const select = (time: string, setting: string) => ({
        _time: time, _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
      });
      const states: Rows = [];
      const temperatures: Rows = [];
      const reported: Rows = [];
      const modeChange = description.startsWith('mode ') || description.includes('target after mode')
        || description.includes('target repeated') || description.includes('action repeated after mode');
      const targetChange = description.startsWith('target ');
      const rangeTargets = description === 'unrelated cooling target later';
      const incompatibleAction = description === 'incompatible action repeated after mode';
      const presetFirst = description.startsWith('preset-first');
      const singleSelect = description.startsWith('select ');
      const singlePreset = description.startsWith('preset ');
      const noSelect = description.endsWith('no select');
      const stableHome = description.includes('stable Home')
        || description.startsWith('target after heating next millisecond') || description.startsWith('mode after heating next millisecond');
      for (let d = 0; d < 5; d += 1) {
        const beginning = start + d * day;
        const heating = beginning + 6 * hour;
        states.push(
          climateRow(iso(beginning), 'state', incompatibleAction ? 'cool' : modeChange || rangeTargets ? 'heat_cool' : 'heat'),
          climateRow(iso(beginning), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning), (modeChange && !incompatibleAction) || rangeTargets ? 'target_temp_low' : 'temperature',
            targetChange || rangeTargets ? '20' : '21'),
          climateRow(iso(beginning), 'preset_mode_str',
            singleSelect || singlePreset ? 'none' : presetFirst || noSelect || stableHome ? 'home' : 'sleep'),
          ...(noSelect || singlePreset ? [] : [select(iso(beginning), presetFirst || singleSelect ? 'unknown' : 'home')]),
          climateRow(micro(heating, actionFraction), 'hvac_action_str', 'heating'),
          ...(description === 'heating repeated after the barrier'
            ? [climateRow(micro(heating, '000999'), 'hvac_action_str', 'heating')] : []),
          ...(description.includes('action repeated after mode')
            ? [climateRow(micro(heating, '000999'), 'hvac_action_str', 'heating')] : []),
          ...(targetChange ? [climateRow(micro(heating, description === 'target before heating in stable Home' ? '000100'
            : description.startsWith('target before heating') ? '000010'
            : description.startsWith('target with heating') ? actionFraction
              : description === 'target after heating next millisecond' ? '001900'
                : description === 'target after heating in stable Home' || description === 'target after heating with no select'
                  ? '000900' : '000990'), 'temperature', '21')] : []),
          ...(rangeTargets ? [
            climateRow(micro(heating, '000050'), 'target_temp_low', '21'),
            climateRow(micro(heating, '000990'), 'target_temp_high', '25'),
          ] : []),
          ...(modeChange ? [
            climateRow(micro(heating, description === 'mode after heating next millisecond' ? '001300'
              : description === 'mode after heating in stable Home' || description === 'mode after heating with no select' ? '000300'
                : description.startsWith('mode after heating') ? '000970'
                  : description.startsWith('mode with heating') ? actionFraction
                    : description.includes('action repeated after mode') || description === 'target repeated across mode with valid middle'
                      || description === 'mode before heating in stable Home'
                      ? '000300' : '000010'), 'state', 'heat'),
            climateRow(micro(heating, description.startsWith('target repeated across mode') ? '000000'
              : description.includes('action repeated after mode') ? '000400'
                : description === 'mode after heating next millisecond' ? '001400'
                  : description === 'mode after heating in stable Home' || description === 'mode after heating with no select'
                    || description === 'mode before heating in stable Home' ? '000400'
                : description.startsWith('mode before heating') || description === 'unchanged target repeated later' ? '000050'
                  : description.startsWith('mode with heating') ? actionFraction : '000990'),
            'temperature', '21'),
            ...(description === 'target repeated across mode with valid middle'
              ? [climateRow(micro(heating, '000400'), 'temperature', '21')] : []),
            ...(description.includes('target repeated') ? [climateRow(micro(heating, '000990'), 'temperature', '21')] : []),
          ] : []),
          ...(firstFraction && singleSelect ? [select(micro(heating, firstFraction), 'home')] : []),
          ...(firstFraction && singlePreset ? [climateRow(micro(heating, firstFraction), 'preset_mode_str', 'home')] : []),
          ...(firstFraction && lastFraction && (description !== 'later valid heat-ups' || d === 0) ? [
            ...(presetFirst ? [
              climateRow(micro(heating, firstFraction), 'preset_mode_str', 'sleep'),
              select(micro(heating, lastFraction), 'home'),
            ] : [
              select(micro(heating, firstFraction), description === 'unchanged duplicates' ? 'home' : 'unknown'),
              climateRow(micro(heating, lastFraction), 'preset_mode_str', description === 'unchanged duplicates' ? 'sleep' : 'home'),
            ]),
          ] : []),
          climateRow(iso(beginning + 7 * hour), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning + 17 * hour), 'hvac_action_str', 'heating'),
          climateRow(iso(beginning + 20 * hour), 'hvac_action_str', 'idle'),
        );
        for (let t = beginning; t < beginning + day; t += 15 * 60_000) {
          const localHour = (t - beginning) / hour;
          const kitchen = localHour >= 7 && localHour < 9 ? 23 : 21;
          const office = localHour >= 6 && localHour < 7 ? 17 : 20;
          reported.push(reportedRow(iso(t), String((office + kitchen) / 2)));
          [
            ['office_temperature', office],
            ['kitchen_temperature', kitchen],
          ].forEach(([entityId, value]) => temperatures.push({
            _time: iso(t), _value: String(value), _measurement: '°C', entity_id: String(entityId),
          }));
        }
      }
      fixture.rows.states = states;
      fixture.rows.temperatures = temperatures;
      fixture.rows.reported = reported;
      const result = await fixture.service.getInsights('5', {
        home: 'office_temperature,kitchen_temperature',
        sleep: 'office_temperature,kitchen_temperature',
        thermostatHome: 'false',
        thermostatSleep: 'false',
        followMe: 'false',
      });
      expect(result.coverage.morningEvents).toBe(5);
      expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.overshoot).toBe(expectedOvershoot);
      expect(result.sensors.find((sensor) => sensor.id === 'office_temperature')!.sampleCount).toBe(expectedSamples);
      const tip = result.recommendations.find((rec) => rec.id === 'move-office');
      if (expectedOvershoot === null) {
        expect(tip?.severity).not.toBe('high');
        expect(tip?.detail ?? '').not.toContain('peaked 2.0 °C');
      } else {
        expect(tip).toMatchObject({ severity: 'high', comfortSetting: 'home' });
        expect(tip!.detail).toContain('Kitchen peaked 2.0 °C');
      }
    },
  );

  it.each([
    'start before', 'start after', 'already heating', 'none', 'fractional Home after preheat',
    'fractional Home after same-ms heating start',
    'first compatible action inside interruption', 'first compatible action after interruption',
    'first compatible action at interruption end', 'first compatible action just after interruption',
    'first compatible action inside interruption with reversed rows',
    'first compatible action inside interruption with four observations', 'unknown action among duplicates',
  ] as const)(
    'review 693b3c0: wake pairing with %s uses recorded order',
    async (kind) => {
      const fixture = makeDeps();
      useClimateReference(fixture);
      const start = Date.parse('2026-01-15T00:00:00Z');
      const hour = 60 * 60_000;
      const day = 24 * hour;
      const iso = (t: number) => new Date(t).toISOString();
      const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
      const select = (time: string, setting: string) => ({
        _time: time, _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
      });
      const states: Rows = [];
      const temperatures: Rows = [];
      const reported: Rows = [];
      const repeatedAfterMode = kind.startsWith('first compatible action') || kind === 'unknown action among duplicates';
      const fractionalHome = kind.startsWith('fractional Home');
      const sameMsStart = kind === 'fractional Home after same-ms heating start';
      for (let d = 0; d < 5; d += 1) {
        const beginning = start + d * day;
        const interrupted = beginning + 6 * hour;
        states.push(
          climateRow(iso(beginning), 'state', repeatedAfterMode ? 'cool' : 'heat'),
          climateRow(iso(beginning), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning), 'temperature', repeatedAfterMode ? '24' : '21'),
          climateRow(iso(beginning), 'preset_mode_str', 'home'),
          select(iso(beginning), 'sleep'),
          climateRow(kind === 'already heating' ? iso(interrupted - hour / 2)
            : sameMsStart ? micro(beginning + 7 * hour, '000100')
              : micro(interrupted, kind === 'start after' ? '000999' : '000000'), 'hvac_action_str', 'heating'),
          ...(kind === 'already heating' ? [climateRow(micro(interrupted, '000000'), 'hvac_action_str', 'heating')] : []),
          ...(repeatedAfterMode ? [
            climateRow(micro(interrupted, '000300'), 'state', 'heat'),
            climateRow(micro(interrupted, '000400'), 'temperature', '21'),
            ...(kind.includes('inside interruption')
              ? [climateRow(micro(interrupted, '000500'), 'hvac_action_str', 'heating')]
              : kind === 'first compatible action at interruption end'
                ? [climateRow(micro(interrupted, '000900'), 'hvac_action_str', 'heating')]
                : kind === 'first compatible action just after interruption'
                  ? [climateRow(micro(interrupted, '000950'), 'hvac_action_str', 'heating')]
                  : kind === 'unknown action among duplicates'
                    ? [climateRow(micro(interrupted, '000500'), 'hvac_action_str', 'unknown')] : []),
            ...(kind.endsWith('four observations') ? [climateRow(micro(interrupted, '000700'), 'hvac_action_str', 'heating')] : []),
            climateRow(micro(interrupted, '000999'), 'hvac_action_str', 'heating'),
          ] : []),
          ...(kind === 'none' || fractionalHome ? [] : [
            select(micro(interrupted, '000100'), 'unknown'),
            climateRow(micro(interrupted, '000900'), 'preset_mode_str', 'sleep'),
          ]),
          select(fractionalHome ? micro(beginning + 7 * hour, '000900')
            : iso(beginning + 7 * hour), 'home'),
          climateRow(iso(beginning + 8 * hour), 'hvac_action_str', 'idle'),
          climateRow(iso(beginning + 17 * hour), 'hvac_action_str', 'heating'),
          climateRow(iso(beginning + 20 * hour), 'hvac_action_str', 'idle'),
        );
        for (let t = beginning; t < beginning + day; t += 15 * 60_000) {
          const localHour = (t - beginning) / hour;
          const kitchen = localHour >= 8 && localHour < 9 ? 23 : 21;
          const office = localHour >= (sameMsStart ? 7 : 6) && localHour < (sameMsStart ? 8 : 7) ? 17 : 21;
          reported.push(reportedRow(iso(t), String((office + kitchen) / 2)));
          [
            ['office_temperature', office],
            ['kitchen_temperature', kitchen],
          ].forEach(([entityId, value]) => temperatures.push({
            _time: iso(t), _value: String(value), _measurement: '°C', entity_id: String(entityId),
          }));
        }
      }
      fixture.rows.states = kind.endsWith('reversed rows') ? [...states].reverse() : states;
      fixture.rows.temperatures = temperatures;
      fixture.rows.reported = reported;
      const result = await fixture.service.getInsights('5', {
        home: 'office_temperature,kitchen_temperature',
        sleep: 'office_temperature,kitchen_temperature',
        thermostatHome: 'false',
        thermostatSleep: 'false',
        followMe: 'false',
      });
      expect(result.coverage.wakeEvents).toBe(5);
      if (fractionalHome) {
        expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.overshoot).toBe(2);
      }
      if (repeatedAfterMode) {
        expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.wakeOvershoot)
          .toBe(kind === 'unknown action among duplicates' ? null : 2);
      }
      const tip = result.recommendations.find((rec) => rec.id === 'wake-office');
      if (kind === 'start before' || kind === 'already heating' || kind.includes('inside interruption')
        || kind === 'unknown action among duplicates') {
        expect(tip).toBeUndefined();
      } else if (sameMsStart) {
        expect(tip).toMatchObject({ severity: 'high', comfortSetting: 'home' });
      } else {
        expect(tip).toMatchObject({ severity: 'high', comfortSetting: 'sleep' });
        expect(tip!.detail).toContain('Kitchen peaked 2.0 °C');
      }
    },
  );

  it.each(['before', 'after', 'already cooling'] as const)(
    'review 693b3c0: cooling %s the interruption uses only whole source windows',
    async (kind) => {
      const run = async (laterBias: boolean) => {
        const fixture = makeDeps();
        useClimateReference(fixture);
        const start = Date.parse('2026-01-16T00:00:00Z');
        const hour = 60 * 60_000;
        const day = 24 * hour;
        const iso = (t: number) => new Date(t).toISOString();
        const micro = (t: number, fraction: string) => iso(t).replace('.000Z', `.${fraction}Z`);
        const select = (time: string, setting: string) => ({
          _time: time, _field: 'state', _value: setting, domain: 'select', entity_id: 'home_current_mode',
        });
        const states: Rows = [];
        const temperatures: Rows = [];
        const reported: Rows = [];
        for (let d = 0; d < 4; d += 1) {
          const beginning = start + d * day;
          const collision = beginning + 12 * hour;
          const from = kind === 'already cooling' ? collision - hour / 2 : collision;
          states.push(
            climateRow(iso(beginning), 'state', 'cool'),
            climateRow(iso(beginning), 'hvac_action_str', 'idle'),
            climateRow(iso(beginning), 'temperature', '24'),
            climateRow(iso(beginning), 'preset_mode_str', 'sleep'),
            select(iso(beginning), 'home'),
            climateRow(from === collision ? micro(from, kind === 'after' ? '000999' : '000000') : iso(from), 'hvac_action_str', 'cooling'),
            ...(kind === 'already cooling' ? [climateRow(micro(collision, '000000'), 'hvac_action_str', 'cooling')] : []),
            select(micro(collision, '000100'), 'unknown'),
            climateRow(micro(collision, '000900'), 'preset_mode_str', 'home'),
            climateRow(iso(beginning + 13 * hour), 'hvac_action_str', 'idle'),
          );
          for (let t = from; t < beginning + 13 * hour; t += 15 * 60_000) {
            const office = laterBias ? (t === collision ? 20 : 26) : (t === collision ? 26 : 20);
            reported.push(reportedRow(iso(t), '20'));
            [
              ['office_temperature', office],
              ['kitchen_temperature', 20],
            ].forEach(([entityId, value]) => temperatures.push({
              _time: iso(t), _value: String(value), _measurement: '°C', entity_id: String(entityId),
            }));
          }
        }
        fixture.rows.states = states;
        fixture.rows.cooling = states.filter(({ domain, _field: field, _value: value }) =>
          domain === 'climate' && (field === 'state' || value === 'cooling'));
        fixture.rows.temperatures = temperatures;
        fixture.rows.reported = reported;
        return fixture.service.getInsights('7', {
          home: 'office_temperature,kitchen_temperature',
          thermostatHome: 'false',
          followMe: 'false',
        });
      };
      const overlappingOnly = await run(false);
      expect(overlappingOnly.coverage.coolingEvents).toBe(4);
      expect(overlappingOnly.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBe(0);
      expect(overlappingOnly.recommendations.some((rec) => rec.mode === 'cooling')).toBe(false);
      const later = await run(true);
      expect(later.coverage.coolingEvents).toBe(4);
      expect(later.sensors.find((s) => s.id === 'office_temperature')!.periodOffsets.cooling).toBe(6);
      expect(later.recommendations.find((rec) => rec.id === 'cooling-office')!.detail).toContain('4 of 4 cooling runs');
    },
  );

  it('review 017f8c1: finds older compatible cooling when a newer cooling action is in heat mode', async () => {
    const fixture = makeDeps();
    fixture.rows.cooling = [
      climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-13T00:00:00Z', 'state', 'heat'),
      climateRow('2025-10-15T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2025-10-13T00:00:00Z', 'state', 'cool'),
      climateRow('2025-10-14T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2025-10-13T12:00:00Z', 'hvac_action_str', 'cooling'),
    ];
    fixture.rows.states = [
      climateRow('2026-01-13T00:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
    ];
    const oldTemperatures: Rows = [];
    for (let t = Date.parse('2025-10-13T00:00:00Z'); t < Date.parse('2025-10-15T14:00:00Z'); t += 15 * 60_000) {
      [
        ['home_current_temperature', '23'], ['office_temperature', '21'], ['kitchen_temperature', '24'],
      ].forEach(([entityId, value]) => oldTemperatures.push({
        _time: new Date(t).toISOString(), _value: value, _measurement: '°C', entity_id: entityId,
      }));
    }
    const oldStates: Rows = [
      climateRow('2025-10-13T00:00:00Z', 'state', 'cool'),
      climateRow('2025-10-13T00:00:00Z', 'hvac_action_str', 'idle'),
      climateRow('2025-10-13T00:00:00Z', 'temperature', '24'),
      { _time: '2025-10-13T00:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ...['13', '14', '15'].flatMap((day) => [
        climateRow(`2025-10-${day}T12:00:00Z`, 'hvac_action_str', 'cooling'),
        ...(day === '15' ? [] : [climateRow(`2025-10-${day}T15:00:00Z`, 'hvac_action_str', 'idle')]),
      ]),
    ];
    const currentQuery = fixture.deps.influxdb.query.getMockImplementation()!;
    fixture.deps.influxdb.query.mockImplementation(async (flux: string) => {
      if (!flux.includes('2025-10-08T14:00:00.000Z')) return currentQuery(flux);
      if (queryKind(flux) === 'temperatures') return oldTemperatures;
      if (queryKind(flux) === 'states') return oldStates;
      return [];
    });
    const result = await fixture.service.getInsights('7', {
      home: 'office_temperature,kitchen_temperature', followMe: 'false', thermostatHome: 'false',
    });
    expect(result.coverage).toMatchObject({
      coolingFrom: '2025-10-08T14:00:00.000Z', coolingTo: '2025-10-15T14:00:00.000Z', coolingEvents: 3,
    });
    expect(result.recommendations.find((rec) => rec.id === 'cooling-kitchen')!.detail).toContain('3 of 3 cooling runs');
    expect(fixture.calls('temperatures')).toHaveLength(2);
  });

  it.each(['current', 'older'] as const)(
    'review 34fc041: a conflicting %s cooling anchor is uncertain even though the lookup only returns cooling actions',
    async (window) => {
      const fixture = makeDeps();
      neutralHeating(fixture);
      const anchor = window === 'current' ? '2026-01-19T12:00:00' : '2025-10-15T12:00:00';
      const first = `${anchor}.000100Z`;
      const second = `${anchor}.000900Z`;
      const mode = climateRow(`${anchor}.000000Z`, 'state', 'cool');
      const conflicting = [climateRow(first, 'hvac_action_str', 'unknown'), climateRow(second, 'hvac_action_str', 'cooling')];
      // The bounded lookback query filters out the unknown action, while the
      // selected window's state query sees both action records.
      fixture.rows.cooling = [mode, conflicting[1], ...coolingRows('2025-10-13T12:00:00Z')];
      if (window === 'current') {
        fixture.rows.states.push(mode, ...conflicting);
      } else {
        const oldStates = [mode, ...conflicting];
        const oldTemperatures = ['home_current_temperature', 'office_temperature', 'kitchen_temperature'].map((entityId) => ({
          _time: '2025-10-15T12:00:00Z', _value: '21', _measurement: '°C', entity_id: entityId,
        }));
        const currentQuery = fixture.deps.influxdb.query.getMockImplementation()!;
        fixture.deps.influxdb.query.mockImplementation(async (flux: string) => {
          if (!flux.includes('2025-10-08T14:00:00.000Z')) return currentQuery(flux);
          if (queryKind(flux) === 'states') return oldStates;
          if (queryKind(flux) === 'temperatures') return oldTemperatures;
          return [];
        });
      }

      const result = await fixture.service.getInsights('7');
      expect(result.coverage.coolingFrom).toBeNull();
      const summary = result.recommendations.find((rec) => rec.id === 'no-changes')!.detail;
      expect(summary).toContain('Cooling history could not be assessed reliably.');
      expect(summary).not.toContain('No mode-compatible cooling runs were found');
      expect(summary).not.toContain('No cooling action was confirmed');
      fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
      await fixture.service.getInsights('7');
      expect(fixture.calls('cooling')).toHaveLength(2);
    },
  );

  it('review 34fc041: identical cooling action duplicates keep a valid current cooling anchor', async () => {
    const fixture = makeDeps();
    neutralHeating(fixture);
    const first = '2026-01-19T12:00:00.000100Z';
    const second = '2026-01-19T12:00:00.000900Z';
    const mode = climateRow('2026-01-19T11:00:00Z', 'state', 'cool');
    const actions = [climateRow(first, 'hvac_action_str', 'cooling'), climateRow(second, 'hvac_action_str', 'cooling')];
    fixture.rows.cooling = [mode, ...actions];
    fixture.rows.states.push(mode, ...actions);
    const result = await fixture.service.getInsights('7');
    expect(result.coverage).toMatchObject({ coolingFrom: '2026-01-13T00:00:00.000Z', coolingEvents: 1 });
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('cooling')).toHaveLength(1);
  });

  it.each(['cool', 'heat_cool', 'auto'])(
    'review 017f8c1: accepts a fresh cooling action with a simultaneous %s mode',
    async (mode) => {
      const fixture = makeDeps();
      fixture.rows.cooling = [
        climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow('2026-01-19T12:00:00Z', 'state', mode),
        climateRow('2026-01-13T00:00:00Z', 'state', 'heat'),
      ];
      (fixture.rows.states as Rows).push(...fixture.rows.cooling);
      const result = await fixture.service.getInsights('7');
      expect(result.coverage.coolingFrom).toBe('2026-01-13T00:00:00.000Z');
      expect(fixture.calls('temperatures')).toHaveLength(1);
    },
  );

  it.each([
    ['unavailable', [climateRow('2026-01-18T00:00:00Z', 'state', 'unavailable')]],
    ['unknown', [climateRow('2026-01-18T00:00:00Z', 'state', 'unknown')]],
    ['unsupported', [climateRow('2026-01-18T00:00:00Z', 'state', 'vendor_mode')]],
    ['conflicting', [
      climateRow('2026-01-19T12:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T12:00:00Z', 'state', 'cool'),
    ]],
    ['malformed action', [{ _time: '2026-01-19T13:00:00Z', _field: 'hvac_action_str' }]],
  ])('review 017f8c1: leaves cooling uncertain with %s mode evidence', async (_description, recentRows) => {
    const fixture = makeDeps();
    neutralHeating(fixture);
    fixture.rows.cooling = [
      climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
      ...recentRows,
      climateRow('2025-10-15T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2025-10-15T12:00:00Z', 'state', 'cool'),
    ];
    const result = await fixture.service.getInsights('7');
    expect(result.coverage.coolingFrom).toBeNull();
    expect(result.recommendations.find((rec) => rec.id === 'no-changes')!.detail).not.toContain('No cooling was found');
    expect(result.recommendations.find((rec) => rec.id === 'no-changes')!.detail).not.toContain('No cooling action was confirmed');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('cooling')).toHaveLength(2);
  });

  it('review 017f8c1: does not treat an action without any mode as evidence of no cooling', async () => {
    const fixture = makeDeps();
    neutralHeating(fixture);
    fixture.rows.cooling = [climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling')];
    const result = await fixture.service.getInsights('7');
    expect(result.coverage.coolingFrom).toBeNull();
    expect(result.recommendations.find((rec) => rec.id === 'no-changes')!.detail).not.toContain('No cooling was found');
    expect(result.recommendations.find((rec) => rec.id === 'no-changes')!.detail).not.toContain('No cooling action was confirmed');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('cooling')).toHaveLength(2);
  });

  it('review 017f8c1: ignores an incompatible simultaneous action after a prior valid cooling run', async () => {
    const fixture = makeDeps();
    fixture.rows.cooling = [
      climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-19T12:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T13:00:00Z', 'state', 'cool'),
      ...coolingRows('2025-10-15T12:00:00Z'),
    ];
    statesForWindow(fixture, '2025-10-08T14:00:00.000Z', coolingRows('2025-10-15T12:00:00Z'));
    const result = await fixture.service.getInsights('7');
    expect(result.coverage.coolingFrom).toBe('2025-10-08T14:00:00.000Z');
    expect(fixture.calls('temperatures')).toHaveLength(2);
  });

  it.each(['incompatible', 'empty'] as const)(
    'review 57a228c: describes %s cooling history as unconfirmed, not absent',
    async (history) => {
      const fixture = makeDeps();
      neutralHeating(fixture);
      fixture.rows.cooling = history === 'empty' ? [] : [
        climateRow('2026-01-19T12:00:00Z', 'hvac_action_str', 'cooling'),
        climateRow('2026-01-19T12:00:00Z', 'state', 'heat'),
      ];
      const result = await fixture.service.getInsights('7');
      expect(result.coverage.coolingFrom).toBeNull();
      const summary = result.recommendations.find((rec) => rec.id === 'no-changes')!.detail;
      expect(summary).toContain('No cooling action was confirmed with a compatible thermostat mode in the available history for the past year.');
      expect(summary).toContain('Gaps or conflicting records do not rule out cooling.');
      expect(summary).not.toContain('No cooling was found');
      fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
      await fixture.service.getInsights('7');
      expect(fixture.calls('cooling')).toHaveLength(1);
    },
  );

  it('review 017f8c1: accepts a later verified cooling action after an uncertain candidate', async () => {
    const fixture = makeDeps();
    neutralHeating(fixture);
    fixture.rows.cooling = [
      climateRow('2026-01-18T12:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-18T00:00:00Z', 'state', 'unavailable'),
      ...coolingRows('2026-01-19T12:00:00Z'),
    ];
    (fixture.rows.states as Rows).push(...fixture.rows.cooling);
    const result = await fixture.service.getInsights('7');
    expect(result.coverage.coolingFrom).toBe('2026-01-13T00:00:00.000Z');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('cooling')).toHaveLength(1);
  });

  it('review 017f8c1: includes the cooling lookback start but excludes the end and uses a prior mode', async () => {
    const fixture = makeDeps();
    fixture.rows.cooling = [
      climateRow('2025-01-19T23:00:00Z', 'state', 'cool'),
      climateRow('2025-01-20T00:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-20T00:00:00Z', 'state', 'cool'),
      climateRow('2026-01-20T00:00:00Z', 'hvac_action_str', 'cooling'),
    ];
    statesForWindow(fixture, '2025-01-20T00:00:00.000Z', [
      climateRow('2025-01-19T23:00:00Z', 'state', 'cool'),
      climateRow('2025-01-20T00:00:00Z', 'hvac_action_str', 'cooling'),
    ]);
    const result = await fixture.service.getInsights('7');
    expect(result.coverage).toMatchObject({
      coolingFrom: '2025-01-20T00:00:00.000Z', coolingTo: '2025-01-20T02:00:00.000Z',
    });
  });

  it('degrades when the cooling lookup fails and retries sooner', async () => {
    const fixture = makeDeps();
    neutralHeating(fixture);
    fixture.rows.cooling = new Error('influx down');
    const result = await fixture.service.getInsights('7');
    expect(result.coverage.coolingFrom).toBeNull();
    expect(result.recommendations.find((rec) => rec.id === 'no-changes')).toBeDefined();
    const details = result.recommendations.map((rec) => rec.detail).join(' ');
    expect(details).not.toContain('No cooling was found');
    expect(details).not.toContain('No cooling action was confirmed');
    fixture.advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    await fixture.service.getInsights('7');
    expect(fixture.calls('cooling')).toHaveLength(2);
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

  it('separates the cache for every thermostat setting and tri-state', async () => {
    const { service, calls } = makeDeps();
    const base = { home: 'office_temperature', followMe: 'false' };
    const variants: Record<string, string>[] = [base];
    ['thermostatHome', 'thermostatSleep', 'thermostatAway'].forEach((param) => {
      variants.push({ ...base, [param]: 'true' }, { ...base, [param]: 'false' });
    });
    variants.push(
      { ...base, thermostatHome: 'true', thermostatSleep: 'false' },
      { ...base, thermostatHome: 'false', thermostatSleep: 'true' },
    );
    for (const variant of variants) await service.getInsights('14', variant);
    expect(calls('temperatures')).toHaveLength(variants.length);
    for (const variant of variants) await service.getInsights('14', variant);
    expect(calls('temperatures')).toHaveLength(variants.length);
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
    expect(result.coverage.thermostatParticipationSupported).toBe(true);
    expect(result.coverage.unitAssumptions).toEqual({
      reportedTemperature: false, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
    });
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
    expect(response.body).toMatchObject({
      windowDays: 14, unit: '°C', coverage: { hvacHistoryAvailable: true, thermostatParticipationSupported: true },
    });
    expect(Array.isArray(response.body.sensors)).toBe(true);
    expect(Array.isArray(response.body.recommendations)).toBe(true);
  });

  it('serves the day endpoint to admin/demo and validates dates and house-zone availability', async () => {
    const fixture = makeDeps();
    const response = await request(buildApp(fixture.service, 'demo'))
      .get('/climate/placement-insights/day?date=2026-01-19&thermostatHome=true')
      .expect(200);
    expect(response.body).toMatchObject({
      date: '2026-01-19', timeZone: 'UTC', unit: '°C',
    });
    expect(response.body.timeline).toHaveLength(96);
    await request(buildApp(fixture.service, 'user'))
      .get('/climate/placement-insights/day').expect(403);
    await request(buildApp(fixture.service))
      .get('/climate/placement-insights/day?date=2026-02-30').expect(400);
    fixture.deps.homeAssistantConfig.getConfig.mockRejectedValue(new Error('unavailable'));
    await request(buildApp(fixture.service))
      .get('/climate/placement-insights/day').expect(503);
  });

  it('returns reference provenance over HTTP even when a single room yields no recommendations', async () => {
    const fixture = makeDeps();
    fixture.deps.indoorClimate.cachedStatus.sensors = [sensor('sensor.office_temperature', 'Office')];
    fixture.deps.indoorClimate.placementDiscovery.mockReturnValue({
      climateEntityId: 'climate.home',
      thermostatTemperatureEntityId: null,
      thermostatOccupancyEntityId: null,
      occupancyByTemperature: new Map(),
      unclassifiedTemperatureIds: new Set<string>(),
    });
    fixture.rows.temperatures = [{
      _time: '2026-01-19T06:00:00Z', _value: '18', _measurement: '°C', entity_id: 'office_temperature',
    }];
    fixture.rows.reported = [{
      _time: '2026-01-19T06:00:00Z', _value: '20', _measurement: 'climate', domain: 'climate', entity_id: 'home',
    }];
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00Z', 'state', 'heat'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'heating'),
      { _time: '2026-01-19T06:00:00Z', _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
    ];
    const response = await request(buildApp(fixture.service)).get('/climate/placement-insights').expect(200);
    expect(response.body.sensors[0].periodOffsets.home).toBe(-2);
    expect(response.body.recommendations).toEqual([]);
    expect(response.body.coverage.unitAssumptions).toEqual({
      reportedTemperature: true, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
    });
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

  it.each(['home', 'sleep', 'away'])('review d29c8d1: rejects thermostat-associated sensors in %s room lists', async (setting) => {
    const { service } = makeDeps();
    const response = await request(buildApp(service)).get('/climate/placement-insights')
      .query({ [setting]: 'office_temperature,home_current_temperature', followMe: 'false' }).expect(400);
    expect(response.body.error).toBe('Thermostat-associated sensors cannot be listed as rooms: home_current_temperature. '
      + 'Use thermostatHome, thermostatSleep or thermostatAway to configure the built-in sensor.');
  });

  it('review d29c8d1: names multiple thermostat-associated sensors without identifying them as averages', async () => {
    const fixture = makeDeps();
    fixture.deps.indoorClimate.cachedStatus.sensors.push(sensor('sensor.hall_temperature', 'Hall', true));
    const response = await request(buildApp(fixture.service)).get('/climate/placement-insights')
      .query({ home: 'home_current_temperature,hall_temperature', sleep: 'hall_temperature' }).expect(400);
    expect(response.body.error).toBe('Thermostat-associated sensors cannot be listed as rooms: hall_temperature, home_current_temperature. '
      + 'Use thermostatHome, thermostatSleep or thermostatAway to configure the built-in sensor.');
  });

  it.each(['home', 'sleep', 'away'] as const)('applies thermostat %s through the HTTP query', async (setting) => {
    const { service, rows } = makeDeps();
    rows.temperatures = rows.temperatures.filter((row) => row.entity_id !== 'home_current_temperature');
    rows.states = (rows.states as Rows).map((row) => (row.domain === 'select' ? { ...row, _value: setting } : row));
    const param = `thermostat${setting[0].toUpperCase()}${setting.slice(1)}`;
    const query = { [setting]: 'office_temperature,kitchen_temperature', followMe: 'false' };
    for (const [value, expected] of [['true', null], ['false', -1], [undefined, null]] as const) {
      const response = await request(buildApp(service)).get('/climate/placement-insights')
        .query(value === undefined ? query : { ...query, [param]: value }).expect(200);
      expect(response.body.coverage.thermostatParticipationSupported).toBe(true);
      const office = response.body.sensors.find((s: { id: string }) => s.id === 'office_temperature');
      expect(office.periodOffsets.heatingRuns).toBe(expected);
    }
    for (const value of ['TRUE', '', '1', 'true&duplicate']) {
      const response = await request(buildApp(service)).get('/climate/placement-insights')
        .query({ [param]: value }).expect(400);
      expect(response.body.error).toBe(`${param} must be true or false`);
    }
    await request(buildApp(service)).get(`/climate/placement-insights?${param}=true&${param}=false`).expect(400);
  });

  it.each([false, true])('defers unknown room ids when discovery has no eligible rooms (thermostat: %s)', async (hasThermostat) => {
    const { service, deps, advance } = makeDeps();
    deps.indoorClimate.cachedStatus = {
      ...deps.indoorClimate.cachedStatus,
      sensors: hasThermostat ? [sensor('sensor.home_current_temperature', 'Home', true)] : [],
    } as never;
    const app = buildApp(service);
    const query = { home: 'office_temperature', thermostatHome: 'false' };
    const response = await request(app).get('/climate/placement-insights').query(query).expect(200);
    expect(response.body.coverage.thermostatParticipationSupported).toBe(true);
    await request(app).get('/climate/placement-insights').query({ ...query, thermostatAway: 'maybe' }).expect(400);
    if (hasThermostat) {
      await request(app).get('/climate/placement-insights').query({ home: 'home_current_temperature' }).expect(400);
    }
    deps.indoorClimate.cachedStatus = {
      ...deps.indoorClimate.cachedStatus, sensors: [sensor('sensor.kitchen_temperature', 'Kitchen')],
    } as never;
    advance(PLACEMENT_DEGRADED_TTL_MS + 1);
    const retried = await request(app).get('/climate/placement-insights').query(query).expect(400);
    expect(retried.body.error).toBe('Unknown sensor ids: office_temperature');
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
