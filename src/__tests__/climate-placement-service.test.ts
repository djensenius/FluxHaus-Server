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
    expect(parsed.comfort).toEqual([{ t: Date.parse(first), setting: 'home' }]);
    expect(parsed.occupancy.get('bedroom_occupancy')).toEqual([{ t: Date.parse(first), occupied: true }]);
  });

  const collisionOffset = (extra: Rows, followMe: boolean, sourceHour = 6.25) => {
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
    const times = Array.from({ length: 3 }, (_, i) => start + (sourceHour + i / 4) * hour);
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

  it('does not convert cooling targets with today’s unit when reported history contradicts it', async () => {
    const fixture = makeDeps();
    useClimateReference(fixture);
    fixture.rows.reported = [{ ...reportedRow('2026-01-19T06:00:00Z', '68'), unit_tag: '°F' }];
    fixture.rows.cooling = coolingRows('2026-01-19T06:00:00Z');
    fixture.rows.temperatures = fixture.rows.temperatures.map((row) => (
      row.entity_id === 'office_temperature' ? { ...row, _value: '18' } : row
    ));
    fixture.rows.states = [
      climateRow('2026-01-19T06:00:00Z', 'state', 'cool'),
      climateRow('2026-01-19T06:00:00Z', 'hvac_action_str', 'cooling'),
      climateRow('2026-01-19T06:00:00Z', 'temperature', '35'),
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

  it('reuses the window for cooling within it, else fetches the last cooling season', async () => {
    const recent = makeDeps();
    recent.rows.cooling = coolingRows('2026-01-18T12:00:00Z');
    const shared = await recent.service.getInsights('7');
    expect(shared.coverage).toMatchObject({ coolingFrom: '2026-01-13T00:00:00.000Z', coolingTo: '2026-01-20T00:00:00.000Z' });
    expect(recent.calls('temperatures')).toHaveLength(1);

    const old = makeDeps();
    old.rows.cooling = coolingRows('2025-10-15T12:00:00Z');
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
