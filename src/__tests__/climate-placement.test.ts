import {
  alignSensors,
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
  biases: Record<string, number | ((t: number) => number)>,
  days: number,
  peak = 21,
): SensorSeriesInput[] {
  return Object.entries(biases).map(([id, bias]) => {
    const points = [];
    for (let t = START; t < START + days * DAY; t += 15 * 60 * 1000) {
      points.push({ t, v: base(t, peak) + (typeof bias === 'number' ? bias : bias(t)) });
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
      t: dayStart + hour * HOUR, gap: false, hvacMode: 'heat', setpoint: sp, presetMode: presets ? preset : null, hvacAction: action,
    });
  };
  for (let d = 0; d < days; d += 1) {
    const dayStart = START + d * DAY;
    add(dayStart, 0, 17, 'sleep', 'idle');
    add(dayStart, 6, setpoint, 'home', 'heating');
    add(dayStart, 8.5, setpoint, 'home', 'idle');
    add(dayStart, 9, 17, 'away', 'idle');
    add(dayStart, 17, setpoint, 'home', 'heating');
    add(dayStart, 19.5, setpoint, 'home', 'idle');
    add(dayStart, 22, 17, 'sleep', 'idle');
  }
  return samples;
}

function at(day: number, hour: number): number {
  return START + day * DAY + hour * HOUR;
}

function state(
  t: number,
  hvacAction: string | null,
  { setpoint = 21, presetMode = 'home' as string | null, hvacMode = 'heat' as string | null } = {},
): HvacSample {
  return {
    t, gap: false, hvacMode, hvacAction, presetMode, setpoint,
  };
}

function gap(t: number): HvacSample {
  return {
    t, gap: true, hvacMode: null, hvacAction: null, presetMode: null, setpoint: null,
  };
}

// Two flat sensors over five days; `value(day, hour)` gives both readings.
function flatRooms(value: (hour: number) => number | null): SensorSeriesInput[] {
  return ['living_temperature', 'bedroom_temperature'].map((id) => {
    const points = [];
    for (let d = 0; d < 5; d += 1) {
      for (let h = 0; h < 24; h += 0.25) {
        const v = value(h);
        if (v !== null) points.push({ t: at(d, h), v });
      }
    }
    return {
      id, name: id, isThermostat: false, points,
    };
  });
}

// One morning warm-up per day: idle overnight, heating from 06:00, then `after`.
function mornings(after: (day: number) => HvacSample[]): HvacSample[] {
  return Array.from({ length: 5 }, (_, d) => [
    state(at(d, 0), 'idle', { presetMode: 'sleep', setpoint: 17 }),
    state(at(d, 6), 'heating'),
    ...after(d),
  ]).flat();
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
    expect(events.every((e) => !e.inferred)).toBe(true);
  });

  it('does not invent returns from set point changes when presets are missing', () => {
    const events = detectHvacEvents(hvac(2, { presets: false }), 'UTC');
    expect(events.map((e) => e.type)).toEqual(['morning', 'morning']);
  });

  it('does not treat Away to Sleep as a return', () => {
    const t = (h: number) => START + h * HOUR;
    const events = detectHvacEvents([
      { t: t(12), setpoint: 17, presetMode: 'away', gap: false, hvacMode: 'heat', hvacAction: 'idle' },
      { t: t(22), setpoint: 18, presetMode: 'sleep', gap: false, hvacMode: 'heat', hvacAction: 'heating' },
    ], 'UTC');
    expect(events).toEqual([]);
  });

  it('keeps an earlier heating start instead of a later set point change', () => {
    const t = (h: number) => START + h * HOUR;
    const events = detectHvacEvents([
      { t: t(0), setpoint: 18, presetMode: 'sleep', gap: false, hvacMode: 'heat', hvacAction: 'idle' },
      { t: t(5), setpoint: 18, presetMode: 'sleep', gap: false, hvacMode: 'heat', hvacAction: 'heating' },
      { t: t(7), setpoint: 21, presetMode: 'home', gap: false, hvacMode: 'heat', hvacAction: 'heating' },
    ], 'UTC');
    expect(events).toEqual([{ type: 'morning', t: t(5), inferred: false }]);
  });

  it('does not read transitions across a gap in history', () => {
    const events = detectHvacEvents([
      state(at(0, 0), 'idle', { presetMode: 'away', setpoint: 17 }),
      gap(at(0, 5)),
      state(at(0, 6), 'heating'),
      state(at(0, 12), 'idle', { presetMode: 'away', setpoint: 17 }),
      gap(at(0, 16)),
      state(at(0, 17), 'heating'),
    ], 'UTC');
    expect(events).toEqual([]);
  });

  it('does not label cooling, off or unreported-heating changes as heat-ups', () => {
    const events = detectHvacEvents([
      // Cooling: set point and preset change in the morning.
      state(at(0, 0), 'idle', { presetMode: 'sleep', setpoint: 20, hvacMode: 'cool' }),
      state(at(0, 6), 'cooling', { setpoint: 24, hvacMode: 'cool' }),
      // Off: Away → home with nothing heating.
      state(at(0, 12), 'off', { presetMode: 'away', setpoint: 17, hvacMode: 'off' }),
      state(at(0, 17), 'off', { hvacMode: 'off' }),
      // Heat mode, set point raised but no heating reported.
      state(at(1, 0), null, { presetMode: 'sleep', setpoint: 17 }),
      state(at(1, 6), null, { setpoint: 21 }),
      // Away → home in heat mode, but heating only reported an hour later.
      state(at(1, 12), 'idle', { presetMode: 'away', setpoint: 17 }),
      state(at(1, 17), 'idle'),
      state(at(1, 18), 'heating'),
    ], 'UTC');
    expect(events).toEqual([]);
  });

  it('counts a return in heat mode once heating is reported soon after', () => {
    const events = detectHvacEvents([
      state(at(0, 12), 'idle', { presetMode: 'away', setpoint: 17 }),
      state(at(0, 17), 'idle'),
      state(at(0, 17.25), 'heating'),
    ], 'UTC');
    expect(events).toEqual([{ type: 'return', t: at(0, 17), inferred: false }]);
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
        hvacEarliestStateAt: '2026-01-05T00:00:00.000Z',
        returnHistoryAvailable: true,
        morningEvents: 5,
        inferredMorningEvents: 0,
        returnEvents: 5,
        unknownUnitReadings: 0,
      },
    });
    expect(Object.keys(result.sensors[0]).sort()).toEqual([
      'averageOffset', 'classification', 'id', 'isThermostat', 'morningOffset', 'name',
      'overshoot', 'returnOffset', 'sampleCount',
    ]);
  });

  it('classifies a cold-biased sensor and suggests checking it as a hypothesis', () => {
    const result = analyzePlacement(input());
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({
      classification: 'cold', morningOffset: -2.1, returnOffset: -2.1, averageOffset: -2.1, isThermostat: false,
    });
    expect(office.sampleCount).toBeGreaterThanOrEqual(12);
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen).toMatchObject({ classification: 'warm', overshoot: 1.5 });

    expect(result.recommendations[0]).toMatchObject({
      id: 'move-office', severity: 'high', sensorId: 'office_temperature', action: 'move', title: 'Check the Office sensor placement',
    });
    expect(result.recommendations[0].detail).toBe(
      'Office read at least 1.0 °C below the house average in 10 of 10 heat-ups (2.1 °C below on average during morning heat-ups). '
      + 'If it is in the active comfort setting, it may be keeping the heat on while warmer rooms such as the Kitchen rose 1.5 °C above the set point after heating stopped; '
      + 'check the comfort setting, and whether the sensor sits near an exterior wall, window, draft or cold floor.',
    );
    result.recommendations.forEach((rec) => {
      expect(rec.detail).not.toMatch(/so the thermostat keeps heating|lets the thermostat|Remove the/);
    });
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
    expect(result.recommendations[0].detail).toContain('rose 1.5 °C above the set point on average');
  });

  it('says so when every sensor is representative and nothing overshoots', () => {
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5) }));
    expect(result.recommendations).toEqual([expect.objectContaining({
      id: 'no-changes', action: 'none', sensorId: null, title: 'No placement issues found',
    })]);
    expect(result.recommendations[0].detail).toContain('None of them rose 1.0 °C or more above the set point');
  });

  it('does not claim rooms stayed below the set point without set points', () => {
    const result = analyzePlacement(input({
      sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5),
      hvac: null,
    }));
    const [summary] = result.recommendations;
    expect(summary).toMatchObject({ id: 'no-changes', title: 'No placement issues found in the available data' });
    expect(summary.detail).not.toContain('None of them rose');
    expect(summary.detail).toContain('overshoot wasn\'t checked');
  });

  it('mentions sensors without enough data in the summary', () => {
    const sensors = [
      ...series({ living_temperature: 0, bedroom_temperature: 0 }, 5),
      { id: 'den_temperature', name: 'Den', isThermostat: false, points: [] },
    ];
    const [summary] = analyzePlacement(input({ sensors })).recommendations;
    expect(summary.title).toBe('No placement issues found in the available data');
    expect(summary.detail).toContain('Not enough data for Den.');
  });

  it('quotes a period that agrees with the classification when events disagree', () => {
    // Office reads warm in the morning but cold in the evening; mornings are
    // only detected on two of five days, so it is cold in 5 of 7 events.
    const hours = (t: number) => ((t - START) % DAY) / HOUR;
    const sensors = series({
      office_temperature: (t) => (hours(t) < 12 ? 0.8 : -2.4),
      living_temperature: 0,
      bedroom_temperature: 0,
      kitchen_temperature: 0,
    }, 5);
    const samples = hvac(5).filter((s) => s.t < START + 2 * DAY || ![6, 8.5].includes(((s.t - START) % DAY) / HOUR));
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(result.coverage).toMatchObject({ morningEvents: 2, returnEvents: 5 });
    expect(office.classification).toBe('cold');
    expect(office.morningOffset).toBeGreaterThan(0);
    expect(office.returnOffset).toBeLessThan(-1);
    const rec = result.recommendations.find((r) => r.sensorId === 'office_temperature')!;
    expect(rec.detail).toContain('below the house average in 5 of 7 heat-ups');
    expect(rec.detail).toContain('below on average after returns from Away');
    expect(rec.detail).not.toContain('morning');
  });

  it('recommends excluding a cold-biased thermostat sensor', () => {
    const result = analyzePlacement(input({
      sensors: series({ home_current_temperature: -1.6, living_temperature: 0.8, bedroom_temperature: 0.8 }, 5),
    }));
    expect(result.recommendations[0]).toMatchObject({
      id: 'exclude-home-current', action: 'exclude_from_comfort', sensorId: 'home_current_temperature',
      title: 'Review the Home thermostat sensor',
    });
    expect(result.recommendations[0].detail).toContain('If the thermostat\'s own sensor is in the active comfort setting, it may be');
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
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: false,
      hvacEarliestStateAt: null,
      returnHistoryAvailable: false,
      morningEvents: 5,
      inferredMorningEvents: 5,
      returnEvents: 0,
    });
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({ classification: 'cold', morningOffset: -2.1, returnOffset: null, overshoot: null });
    expect(result.recommendations[0]).toMatchObject({ id: 'move-office', action: 'move' });
    expect(result.recommendations[0].detail).toContain(
      '5 of these 5 heat-ups were inferred from room temperatures, not thermostat history',
    );
  });

  it('infers mornings before the start of shorter thermostat history', () => {
    const result = analyzePlacement(input({ hvac: hvac(5).filter((s) => s.t >= START + 2 * DAY) }));
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: true,
      hvacEarliestStateAt: '2026-01-07T00:00:00.000Z',
      morningEvents: 5,
      inferredMorningEvents: 2,
      returnEvents: 3,
    });
  });

  it('reports when return history is unavailable instead of inventing returns', () => {
    const result = analyzePlacement(input({ hvac: hvac(5, { presets: false }) }));
    expect(result.coverage).toMatchObject({ returnHistoryAvailable: false, returnEvents: 0, morningEvents: 5 });
    expect(result.sensors.every((s) => s.returnOffset === null)).toBe(true);
  });

  it('only measures overshoot after the thermostat reports it stopped heating', () => {
    // Heating never reported as stopping: no overshoot claim.
    const neverIdle = hvac(5).map((s) => ({ ...s, hvacAction: 'heating' }));
    const result = analyzePlacement(input({ hvac: neverIdle }));
    expect(result.sensors.every((s) => s.overshoot === null)).toBe(true);
  });

  it('ends the overshoot window at the next set point change', () => {
    // Heating stops at 07:00 at 21 °C; at 08:00 the set point is raised to
    // 24 °C and rooms warm to 25 °C. That later heat-up isn't overshoot of 21 °C.
    const samples: HvacSample[] = [];
    const sensors: SensorSeriesInput[] = ['living_temperature', 'bedroom_temperature'].map((id) => ({
      id, name: id, isThermostat: false, points: [],
    }));
    for (let d = 0; d < 5; d += 1) {
      const at = (h: number) => START + d * DAY + h * HOUR;
      samples.push(
        { t: at(0), setpoint: 17, presetMode: 'sleep', gap: false, hvacMode: 'heat', hvacAction: 'idle' },
        { t: at(6), setpoint: 21, presetMode: 'home', gap: false, hvacMode: 'heat', hvacAction: 'heating' },
        { t: at(7), setpoint: 21, presetMode: 'home', gap: false, hvacMode: 'heat', hvacAction: 'idle' },
        { t: at(8), setpoint: 24, presetMode: 'home', gap: false, hvacMode: 'heat', hvacAction: 'idle' },
      );
      for (let h = 0; h < 24; h += 0.25) {
        sensors.forEach((sensor) => sensor.points.push({ t: at(h), v: h >= 8 && h < 12 ? 25 : 21 }));
      }
    }
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => s.overshoot)).toEqual([0, 0]);
  });

  it('aligns staggered sensors with bounded forward-fill', () => {
    const flat = (id: string, name: string, bias: number, offsetMinutes: number): SensorSeriesInput => {
      const points = [];
      for (let t = START + offsetMinutes * 60_000; t < START + 5 * DAY; t += 15 * 60 * 1000) {
        points.push({ t, v: 20 + bias });
      }
      return {
        id, name, isThermostat: false, points,
      };
    };
    const result = analyzePlacement(input({
      sensors: [
        flat('office_temperature', 'Office', -2, 0),
        flat('living_temperature', 'Living', 1, 7),
        flat('bedroom_temperature', 'Bedroom', 1, 11),
      ],
    }));
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({ averageOffset: -2, classification: 'cold' });
    expect(office.sampleCount).toBe(90);
  });

  it('never compares stale readings across gaps and keeps the house average membership fixed', () => {
    const hours = (t: number) => ((t - START) % DAY) / HOUR;
    const sensors = series({
      office_temperature: -2,
      living_temperature: 0,
      bedroom_temperature: 0,
      kitchen_temperature: 2,
    }, 5).map((sensor) => (sensor.id === 'kitchen_temperature'
      // The kitchen sensor drops out every morning from 05:00 to 09:00.
      ? { ...sensor, points: sensor.points.filter((p) => hours(p.t) < 5 || hours(p.t) >= 9) }
      : sensor));
    const result = analyzePlacement(input({ sensors }));
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(kitchen.morningOffset).toBeNull();
    expect(kitchen.returnOffset).toBe(2);
    // Mornings average Office, Living and Bedroom only; returns all four.
    expect(office.morningOffset).toBe(-1.3);
    expect(office.returnOffset).toBe(-2);
  });

  it('infers mornings when the earliest state is only a snapshot from the window start', () => {
    // The recorder kept two days less than requested but returned the state in
    // force at the start of the window; that isn't evidence of no heating.
    const snapshot = state(START, 'idle', { presetMode: 'sleep', setpoint: 17 });
    const result = analyzePlacement(input({ hvac: [snapshot, ...hvac(5).filter((s) => s.t >= START + 2 * DAY)] }));
    expect(result.coverage).toMatchObject({
      hvacEarliestStateAt: '2026-01-05T00:00:00.000Z',
      morningEvents: 5,
      inferredMorningEvents: 2,
    });
    const office = result.recommendations.find((r) => r.sensorId === 'office_temperature')!;
    expect(office.detail).toContain('2 of these 8 heat-ups were inferred from room temperatures, not thermostat history');
  });

  it('does not infer a morning already observed or ruled out by recorded idle states', () => {
    // Days 0–2 heat from 06:00; days 3–4 the thermostat records idle states
    // through the morning while the rooms still warm (sun, cooking).
    const samples = hvac(5).filter((s) => s.t < START + 3 * DAY || ![6, 8.5].includes(((s.t - START) % DAY) / HOUR));
    const extra = [3, 4].map((d) => state(at(d, 5), 'idle', { presetMode: 'sleep', setpoint: 17 }));
    const result = analyzePlacement(input({ hvac: [...samples, ...extra].sort((a, b) => a.t - b.t) }));
    expect(result.coverage).toMatchObject({ morningEvents: 3, inferredMorningEvents: 0 });
  });

  it('ends the overshoot window when heating restarts', () => {
    // Heating stops at 07:00 and restarts at 08:00 at the same set point; the
    // rooms then reach 25 °C, which isn't overshoot after the first heat-up.
    const samples = mornings((d) => [state(at(d, 7), 'idle'), state(at(d, 8), 'heating'), state(at(d, 9), 'idle')]);
    const sensors = flatRooms((h) => (h >= 8.25 && h < 9 ? 25 : 21));
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => s.overshoot)).toEqual([0, 0]);
  });

  it('does not treat a gap in history as the thermostat being satisfied', () => {
    const samples = mornings((d) => [gap(at(d, 7)), state(at(d, 7.5), 'idle')]);
    const result = analyzePlacement(input({ sensors: flatRooms(() => 21), hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
  });

  it('never counts a point that may hold readings from before heating stopped', () => {
    // Heating stops at 06:55. The 06:45 point (06:45–07:00) is 25 °C, partly
    // before the stop; the 07:00 point is missing. Later points are 21 °C.
    const samples = mornings((d) => [state(at(d, 6 + 55 / 60), 'idle')]);
    const sensors = flatRooms((h) => {
      if (h === 7) return null;
      return h === 6.75 ? 25 : 21;
    });
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.sensors.map((s) => s.overshoot)).toEqual([0, 0]);
  });

  it('needs readings across most of the window to measure overshoot', () => {
    // Heating stops at 07:00; rooms report only once (07:00) in the next two hours.
    const samples = mornings((d) => [state(at(d, 7), 'idle')]);
    const sensors = flatRooms((h) => (h > 7 && h < 9 ? null : 21));
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
  });
});

describe('alignSensors', () => {
  it('uses a point only after its window ends and within 30 minutes of its earliest reading', () => {
    const grid = alignSensors([{
      id: 'office_temperature', name: 'Office', isThermostat: false, points: [{ t: at(0, 5), v: 20 }],
    }]);
    const office = grid.values.get('office_temperature')!;
    expect([5, 5.25, 5.5, 5.75].map((h) => office.get(at(0, h)) ?? null)).toEqual([null, 20, 20, null]);
  });
});
