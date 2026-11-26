import {
  analyzePlacement,
  detectHvacEvents,
  type HvacSample,
  type SensorSeriesInput,
} from '../climate-placement';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-01-05T00:00:00Z');

// House temperature: 17 °C overnight and while away, ramping to `peak` over the
// two hours after the 06:00 warm-up and the 17:00 return.
function base(t: number, peak = 21): number {
  const hour = ((t - START) % DAY) / HOUR;
  const ramp = (from: number) => 17 + ((peak - 17) * Math.min(1, (hour - from) / 2));
  if (hour >= 6 && hour < 9) return ramp(6);
  if (hour >= 17 && hour < 22) return ramp(17);
  return 17;
}

function series(
  biases: Record<string, number>,
  days: number,
  peak = 21,
): SensorSeriesInput[] {
  return Object.entries(biases).map(([id, bias]) => {
    const points = [];
    for (let t = START; t < START + days * DAY; t += 15 * 60 * 1000) {
      points.push({ t, v: base(t, peak) + bias });
    }
    const name = id.replace(/_temperature$/, '').replace(/^\w/, (c) => c.toUpperCase());
    return {
      id, name: id === 'home_current_temperature' ? 'Home' : name, isThermostat: id === 'home_current_temperature', points,
    };
  });
}

function hvac(days: number, { presets = true, setpoint = 21 } = {}): HvacSample[] {
  const samples: HvacSample[] = [];
  const add = (dayStart: number, hour: number, sp: number, preset: string, action: string) => {
    samples.push({
      t: dayStart + hour * HOUR, setpoint: sp, presetMode: presets ? preset : null, hvacAction: action,
    });
  };
  for (let d = 0; d < days; d += 1) {
    const dayStart = START + d * DAY;
    add(dayStart, 0, 17, 'sleep', 'idle');
    add(dayStart, 6, setpoint, 'home', 'heating');
    add(dayStart, 8.5, setpoint, 'home', 'idle');
    add(dayStart, 9, 17, 'away', 'idle');
    add(dayStart, 17, setpoint, 'home', 'heating');
    add(dayStart, 22, 17, 'sleep', 'idle');
  }
  return samples;
}

const BIASES = {
  home_current_temperature: 0.3,
  office_temperature: -2.1,
  kitchen_temperature: 1.5,
  living_temperature: 0.3,
};

function input(overrides: Partial<Parameters<typeof analyzePlacement>[0]> = {}) {
  return {
    start: new Date(START),
    end: new Date(START + 5 * DAY),
    windowDays: 5,
    timeZone: 'UTC',
    sensors: series(BIASES, 5),
    hvac: hvac(5),
    generatedAt: new Date(START + 5 * DAY),
    ...overrides,
  };
}

describe('detectHvacEvents', () => {
  it('finds one morning warm-up per day and each return from Away', () => {
    const events = detectHvacEvents(hvac(3), 'UTC');
    expect(events.filter((e) => e.type === 'morning').map((e) => new Date(e.t).toISOString())).toEqual([
      '2026-01-05T06:00:00.000Z', '2026-01-06T06:00:00.000Z', '2026-01-07T06:00:00.000Z',
    ]);
    expect(events.filter((e) => e.type === 'return').map((e) => new Date(e.t).toISOString())).toEqual([
      '2026-01-05T17:00:00.000Z', '2026-01-06T17:00:00.000Z', '2026-01-07T17:00:00.000Z',
    ]);
    expect(events[0].setpoint).toBe(21);
  });

  it('detects returns from a set point jump after a long setback when presets are missing', () => {
    const events = detectHvacEvents(hvac(2, { presets: false }), 'UTC');
    expect(events.map((e) => e.type)).toEqual(['morning', 'return', 'morning', 'return']);
  });

  it('uses the local time zone for the morning window', () => {
    // 06:00 UTC is 01:00 in Toronto, outside the morning window.
    const events = detectHvacEvents(hvac(2, { presets: false }), 'America/Toronto');
    expect(events.some((e) => e.type === 'morning')).toBe(false);
  });
});

describe('analyzePlacement', () => {
  it('reports coverage and the response contract', () => {
    const result = analyzePlacement(input());
    expect(result).toMatchObject({
      generatedAt: '2026-01-10T00:00:00.000Z',
      windowDays: 5,
      unit: '°C',
      coverage: {
        start: '2026-01-05T00:00:00.000Z',
        end: '2026-01-10T00:00:00.000Z',
        hvacHistoryAvailable: true,
        morningEvents: 5,
        returnEvents: 5,
      },
    });
    expect(Object.keys(result.sensors[0]).sort()).toEqual([
      'averageOffset', 'classification', 'id', 'isThermostat', 'morningOffset', 'name',
      'overshoot', 'returnOffset', 'sampleCount',
    ]);
  });

  it('classifies a cold-biased sensor and explains the overheating it causes', () => {
    const result = analyzePlacement(input());
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({
      classification: 'cold', morningOffset: -2.1, returnOffset: -2.1, averageOffset: -2.1, isThermostat: false,
    });
    expect(office.sampleCount).toBeGreaterThanOrEqual(12);
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen).toMatchObject({ classification: 'warm', overshoot: 1.5 });

    expect(result.recommendations[0]).toMatchObject({
      id: 'move-office', severity: 'high', sensorId: 'office_temperature', action: 'move', title: 'Move the Office sensor',
    });
    expect(result.recommendations[0].detail).toContain(
      'Office reads 2.1 °C below the house average during morning heat-ups, so the thermostat keeps heating while the Kitchen climbs to 22.5 °C.',
    );
    expect(result.recommendations.find((r) => r.sensorId === 'kitchen_temperature')).toMatchObject({
      action: 'include_in_comfort', severity: 'medium',
    });
  });

  it('leaves representative sensors without a recommendation when nothing overshoots', () => {
    const result = analyzePlacement(input());
    expect(result.sensors.find((s) => s.id === 'living_temperature')).toMatchObject({
      classification: 'representative', averageOffset: 0.3, overshoot: 0.3,
    });
    expect(result.recommendations.some((r) => r.sensorId === 'living_temperature')).toBe(false);
  });

  it('recommends including representative sensors in rooms that overshoot', () => {
    const result = analyzePlacement(input({
      sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5),
      hvac: hvac(5, { setpoint: 19.5 }),
    }));
    expect(result.sensors.every((s) => s.classification === 'representative')).toBe(true);
    expect(result.recommendations.map((r) => r.action)).toEqual(['include_in_comfort', 'include_in_comfort']);
    expect(result.recommendations[0].detail).toContain('rises 1.5 °C above the set point');
  });

  it('says so when every sensor is representative and nothing overshoots', () => {
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5) }));
    expect(result.recommendations).toEqual([expect.objectContaining({ id: 'no-changes', action: 'none', sensorId: null })]);
  });

  it('recommends excluding a cold-biased thermostat sensor', () => {
    const result = analyzePlacement(input({
      sensors: series({ home_current_temperature: -1.6, living_temperature: 0.8, bedroom_temperature: 0.8 }, 5),
    }));
    expect(result.recommendations[0]).toMatchObject({
      id: 'exclude-home-current', action: 'exclude_from_comfort', sensorId: 'home_current_temperature',
    });
  });

  it('marks sensors insufficient with too few events', () => {
    const result = analyzePlacement(input({ sensors: series(BIASES, 1), hvac: hvac(1) }));
    expect(result.coverage).toMatchObject({ morningEvents: 1, returnEvents: 1 });
    expect(result.sensors.every((s) => s.classification === 'insufficient')).toBe(true);
    expect(result.recommendations).toEqual([]);
  });

  it('returns nulls and no recommendations without temperature data', () => {
    const result = analyzePlacement(input({
      sensors: [{
        id: 'office_temperature', name: 'Office', isThermostat: false, points: [],
      }],
    }));
    expect(result.sensors[0]).toMatchObject({
      averageOffset: null, morningOffset: null, returnOffset: null, overshoot: null, sampleCount: 0, classification: 'insufficient',
    });
    expect(result.recommendations).toEqual([]);
  });

  it('infers morning warm-ups from temperatures when thermostat history is missing', () => {
    const result = analyzePlacement(input({ hvac: null }));
    expect(result.coverage).toMatchObject({ hvacHistoryAvailable: false, morningEvents: 5, returnEvents: 0 });
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({ classification: 'cold', morningOffset: -2.1, returnOffset: null, overshoot: null });
    expect(result.recommendations[0]).toMatchObject({ id: 'move-office', action: 'move' });
  });

  it('infers mornings before the start of shorter thermostat history', () => {
    const result = analyzePlacement(input({ hvac: hvac(5).filter((s) => s.t >= START + 2 * DAY) }));
    expect(result.coverage).toMatchObject({ hvacHistoryAvailable: true, morningEvents: 5, returnEvents: 3 });
  });
});
