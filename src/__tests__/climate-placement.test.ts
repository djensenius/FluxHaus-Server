import {
  alignSensors,
  analyzePlacement,
  detectHvacEvents,
  inferMorningEvents,
  type ComfortSample,
  type CoolingInput,
  type HvacSample,
  type OccupancySample,
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

// hvac(5) with the thermostat off through the morning (05:00–09:30) from
// `fromDay` on, so no morning warm-up is observed or inferred on those days.
function offMornings(fromDay: number): HvacSample[] {
  const hour = (t: number) => ((t - START) % DAY) / HOUR;
  const kept = hvac(5).filter((s) => s.t < START + fromDay * DAY || ![6, 8.5, 9].includes(hour(s.t)));
  const extra = [];
  for (let d = fromDay; d < 5; d += 1) {
    extra.push(
      state(at(d, 5), 'off', { presetMode: 'sleep', setpoint: null, hvacMode: 'off' }),
      state(at(d, 9.5), 'idle', { presetMode: 'away', setpoint: 17 }),
    );
  }
  return [...kept, ...extra].sort((a, b) => a.t - b.t);
}

// The fixture's thermostat series is a reported reference, not a room; the
// room-only house mean is 0. The reference swings hour to hour, so it fits no
// modeled subset of rooms and their participation stays unknown.
const BIASES = {
  home_current_temperature: (t: number) => (Math.floor((t - START) / HOUR) % 2 === 0 ? 0.8 : -0.2),
  office_temperature: -2.1,
  kitchen_temperature: 1.5,
  living_temperature: 0.3,
  bedroom_temperature: 0.3,
};

// Follow Me explicitly off with participation unknown: on or omitted, with no
// occupancy history, who Ecobee averaged can't be told (tested separately).
const FOLLOW_ME_OFF = {
  home: null, sleep: null, away: null, followMe: false,
};

// Fixtures using a room-only Ecobee average explicitly exclude the physical
// thermostat sensor; the aggregate series itself is still a separate reading.
const THERMOSTAT_EXCLUDED = { home: false, sleep: false, away: false };
const FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED = { ...FOLLOW_ME_OFF, thermostat: THERMOSTAT_EXCLUDED };

function input(overrides: Partial<Parameters<typeof analyzePlacement>[0]> = {}) {
  return {
    participation: FOLLOW_ME_OFF,
    start: new Date(START),
    end: new Date(START + 5 * DAY),
    windowDays: 5,
    timeZone: 'UTC',
    sensors: series(BIASES, 5),
    primaryThermostatId: 'home_current_temperature',
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

  it('cancels a return when the preset goes back to Away before heating starts', () => {
    const events = detectHvacEvents([
      state(at(0, 12), 'idle', { presetMode: 'away', setpoint: 17 }),
      state(at(0, 17), 'idle'),
      state(at(0, 17.1), 'idle', { presetMode: 'away', setpoint: 17 }),
      state(at(0, 17.25), 'heating', { presetMode: 'away', setpoint: 17 }),
    ], 'UTC');
    expect(events).toEqual([]);
  });

  it('uses the local time zone for the morning window', () => {
    // 06:00 UTC is 01:00 in Toronto, outside the morning window.
    const events = detectHvacEvents(hvac(2, { presets: false }), 'America/Toronto');
    expect(events.some((e) => e.type === 'morning')).toBe(false);
  });
});

describe('analyzePlacement', () => {
  it('reports coverage and the response contract', () => {
    const result = analyzePlacement(input({ participation: undefined }));
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
        unknownUnitWindows: 0,
        participationConfigured: false,
        thermostatParticipationSupported: true,
        followMe: null,
        occupancyAvailable: false,
        comfortScheduleAvailable: true,
        wakeEvents: 5,
        coolingFrom: null,
        coolingTo: null,
        coolingEvents: 0,
      },
    });
    // Only the agreed contract fields.
    expect(Object.keys(result.coverage).sort()).toEqual([
      'comfortScheduleAvailable', 'coolingEvents', 'coolingFrom', 'coolingTo', 'end', 'followMe',
      'hvacEarliestStateAt', 'hvacHistoryAvailable', 'inferredMorningEvents', 'morningEvents', 'occupancyAvailable',
      'participationConfigured', 'returnEvents', 'returnHistoryAvailable', 'start', 'thermostatParticipationSupported',
      'unitAssumptions', 'unknownUnitWindows', 'wakeEvents',
    ]);
    expect(Object.keys(result.sensors[0]).sort()).toEqual([
      'averageOffset', 'classification', 'consistency', 'coolingOffset', 'coolingUndershoot',
      'id', 'isThermostat', 'morningOffset', 'name', 'occupiedShare',
      'overshoot', 'participation', 'periodOffsets', 'recommendationIds', 'returnOffset',
      'sampleCount', 'verdict', 'verdictSummary', 'wakeOffset', 'wakeOvershoot',
    ]);
    expect(Object.keys(result.recommendations[0]).sort()).toEqual([
      'action', 'affectedSensorIds', 'comfortSetting', 'detail', 'id', 'likelyCauses', 'mode', 'period',
      'sensorId', 'severity', 'title',
    ]);
  });

  it('classifies a cold-biased sensor and suggests checking it as a hypothesis', () => {
    const result = analyzePlacement(input());
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({
      classification: 'cold', morningOffset: -2.1, returnOffset: -2.1, averageOffset: -2.1, isThermostat: false,
    });
    expect(office.sampleCount).toBeGreaterThanOrEqual(12);
    expect(office).toMatchObject({ verdict: 'cold_outlier', recommendationIds: ['wake-office', 'move-kitchen'] });
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen).toMatchObject({ classification: 'warm', overshoot: 1.5, verdict: 'warm_outlier' });
    expect(kitchen.recommendationIds).toEqual(['wake-office', 'move-kitchen']);

    // Participation is unknown (the thermostat fits no subset of rooms), so
    // the wake-up tip is conditional.
    expect(result.recommendations.map((r) => r.id)).toEqual(['wake-office', 'move-kitchen']);
    expect(result.recommendations[0]).toMatchObject({
      severity: 'high',
      sensorId: 'office_temperature',
      action: 'move',
      title: 'Office may be holding the morning warm-up on',
      mode: 'heating',
      period: 'wake',
      comfortSetting: 'home',
      affectedSensorIds: ['kitchen_temperature'],
    });
    expect(result.recommendations[0].detail).toBe(
      'In 5 of 5 wake-ups (Sleep → Home), Office read 2.4 °C below the reported or approximated comfort reading. '
      + 'If it\'s in your Home comfort setting, a low reading could contribute to a longer warm-up. Kitchen peaked 1.0 °C over '
      + 'the Home set point on average in the 2 hours after the corresponding heated wake-ups with sufficient readings. '
      + 'Move it to an interior wall at about chest height, away from windows, doors and vents, or remove it from Home. '
      + 'The Sleep set point averaged 4.0 °C below Home. '
      + 'Smart Recovery can start heating before Home; consider a smaller Sleep setback or reviewing Smart Recovery timing.',
    );
    expect(result.recommendations[0].likelyCauses.length).toBeGreaterThan(0);
    expect(result.recommendations[1]).toMatchObject({
      sensorId: 'kitchen_temperature', action: 'move', title: 'Kitchen may be stopping the heat early', mode: 'heating',
    });
    expect(result.recommendations[1].detail).toContain('Cooking and appliances');
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
    expect(result.recommendations[0]).toMatchObject({ id: 'add-living', comfortSetting: 'home', mode: 'heating' });
    expect(result.recommendations[0].detail).toBe(
      'Living peaked 1.5 °C above the set point on average after the thermostat stopped heating, while closely tracking '
      + 'the house average during heat-ups. If it isn\'t in your Home comfort setting, adding it may help Ecobee stop heating sooner.',
    );
  });

  it('does not use a Sleep-only overshoot to suggest adding a sensor to Home', () => {
    const hvac = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: 'sleep', setpoint: 17 }),
      state(at(d, 5), 'heating', { presetMode: 'sleep', setpoint: 21 }),
      state(at(d, 6), 'idle', { presetMode: 'sleep', setpoint: 21 }),
      state(at(d, 9), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 12), 'heating', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 14), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 22), 'idle', { presetMode: 'sleep', setpoint: 17 }),
    ]).flat();
    const comfort = Array.from({ length: 5 }, (_, d) => [
      { t: at(d, 0), setting: 'sleep' as const },
      { t: at(d, 9), setting: 'home' as const },
      { t: at(d, 22), setting: 'sleep' as const },
    ]).flat();
    const sensors = series({
      living_temperature: (t) => {
        const hour = ((t - START) % DAY) / HOUR;
        return hour >= 6 && hour < 8 ? 5 : 0;
      },
      bedroom_temperature: 0,
      kitchen_temperature: 0,
      office_temperature: 0,
    }, 5);
    const result = analyzePlacement(input({
      sensors,
      hvac,
      comfort,
      participation: {
        ...FOLLOW_ME_OFF,
        home: ['bedroom_temperature', 'kitchen_temperature', 'office_temperature'],
      },
    }));

    expect(result.sensors.find((s) => s.id === 'living_temperature')!.overshoot).toBeGreaterThan(1);
    expect(result.recommendations.some((r) => r.sensorId === 'living_temperature' && r.comfortSetting === 'home'))
      .toBe(false);
  });

  it('does not count Sleep readings after heating stops in Home', () => {
    const hvac = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: 'sleep', setpoint: 17 }),
      state(at(d, 2), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 5), 'heating', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 6), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 7), 'idle', { presetMode: 'sleep', setpoint: 17 }),
      state(at(d, 9), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 14), 'heating', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 17), 'idle', { presetMode: 'home', setpoint: 21 }),
      state(at(d, 22), 'idle', { presetMode: 'sleep', setpoint: 17 }),
    ]).flat();
    const comfort = Array.from({ length: 5 }, (_, d) => [
      { t: at(d, 0), setting: 'sleep' as const },
      { t: at(d, 2), setting: 'home' as const },
      { t: at(d, 7), setting: 'sleep' as const },
      { t: at(d, 9), setting: 'home' as const },
      { t: at(d, 22), setting: 'sleep' as const },
    ]).flat();
    const sensors = series({
      living_temperature: (t) => {
        const hour = ((t - START) % DAY) / HOUR;
        return hour >= 7 && hour < 9 ? 5 : 0;
      },
      bedroom_temperature: 0,
      kitchen_temperature: 0,
      office_temperature: 0,
    }, 5);
    const result = analyzePlacement(input({
      sensors,
      hvac,
      comfort,
      participation: {
        ...FOLLOW_ME_OFF,
        home: ['bedroom_temperature', 'kitchen_temperature', 'office_temperature'],
      },
    }));

    expect(result.sensors.find((s) => s.id === 'living_temperature')!.overshoot).toBe(0);
    expect(result.recommendations.some((r) => r.sensorId === 'living_temperature' && r.comfortSetting === 'home'))
      .toBe(false);
  });

  it('says so when every sensor is representative and nothing overshoots', () => {
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5) }));
    expect(result.recommendations).toEqual([expect.objectContaining({
      id: 'no-changes', action: 'none', sensorId: null, title: 'No placement issues found',
    })]);
    expect(result.recommendations[0].detail).toContain('None of them peaked 1.0 °C or more above the set point');
  });

  it('does not claim rooms stayed below the set point without set points', () => {
    const result = analyzePlacement(input({
      sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5),
      hvac: null,
    }));
    const [summary] = result.recommendations;
    expect(summary).toMatchObject({ id: 'no-changes', title: 'No placement issues found in the available data' });
    expect(summary.detail).not.toContain('None of them peaked');
    expect(summary.detail).toContain('Overshoot after heating stopped couldn\'t be measured for Living, Bedroom.');
  });

  // The no-changes overshoot sentence is coverage-neutral: it never says why
  // overshoot couldn't be measured, and never claims rooms stayed below it.
  const expectNeutralOvershoot = (result: ReturnType<typeof analyzePlacement>, rooms: string) => {
    const [summary] = result.recommendations;
    expect(summary).toMatchObject({ id: 'no-changes', title: 'No placement issues found in the available data' });
    expect(summary.detail).toContain(`Overshoot after heating stopped couldn't be measured for ${rooms}.`);
    expect(summary.detail).not.toMatch(/None of them peaked|Thermostat history|readings after|wasn't checked/);
  };

  it('stays neutral when a room lacks readings after heating stops', () => {
    const [living, bedroom] = series({ living_temperature: 0, bedroom_temperature: 0 }, 5);
    const afterStop = (t: number) => {
      const h = ((t - START) % DAY) / HOUR;
      return (h >= 8.5 && h < 10.5) || (h >= 19.5 && h < 21.5);
    };
    const result = analyzePlacement(input({
      sensors: [living, { ...bedroom, points: bedroom.points.filter((p) => !afterStop(p.t)) }],
    }));
    expect(result.sensors.map((s) => [s.classification, s.overshoot])).toEqual([['representative', 0], ['representative', null]]);
    expectNeutralOvershoot(result, 'Bedroom');
  });

  it('stays neutral when heating restarts right after stopping', () => {
    // Idle at 07:00, heating again at 07:15: too short to measure overshoot.
    const samples = mornings((d) => [state(at(d, 7), 'idle'), state(at(d, 7.25), 'heating'), state(at(d, 9), 'idle', { setpoint: 17 })]);
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5), hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => [s.classification, s.overshoot])).toEqual([['representative', null], ['representative', null]]);
    expectNeutralOvershoot(result, 'Living, Bedroom');
  });

  it('stays neutral when the heating action becomes unknown before going idle', () => {
    // Heating, then an unknown action at 07:00, idle at 07:30: when heating
    // ended isn't known, so the later idle isn't read as satisfaction.
    const samples = mornings((d) => [state(at(d, 7), null), state(at(d, 7.5), 'idle')]);
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5), hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => [s.classification, s.overshoot])).toEqual([['representative', null], ['representative', null]]);
  });

  it('does not treat an unsupported action as a heating start or satisfaction', () => {
    expect(detectHvacEvents([
      state(at(0, 5), 'vendor_wait'),
      state(at(0, 6), 'heating'),
    ], 'UTC')).toEqual([]);
    expect(detectHvacEvents([
      state(at(0, 5), 'idle'),
      state(at(0, 6), 'vendor_preheating'),
    ], 'UTC')).toEqual([]);
    const samples = mornings((d) => [state(at(d, 7), 'vendor_wait'), state(at(d, 7.5), 'idle')]);
    const result = analyzePlacement(input({ sensors: flatRooms(() => 23), hvac: samples }));
    expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
    const interrupted = mornings((d) => [state(at(d, 7), 'idle'), state(at(d, 7.25), 'vendor_wait')]);
    expect(analyzePlacement(input({ sensors: flatRooms(() => 23), hvac: interrupted }))
      .sensors.map((s) => s.overshoot)).toEqual([null, null]);
    const fan = mornings((d) => [state(at(d, 7), 'fan')]);
    expect(analyzePlacement(input({ sensors: flatRooms(() => 23), hvac: fan }))
      .sensors.map((s) => s.overshoot)).toEqual([null, null]);
  });

  it('stays neutral when heating stops with a simultaneous set point change', () => {
    const samples = mornings((d) => [state(at(d, 7), 'idle', { setpoint: 18 })]);
    const result = analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5), hvac: samples }));
    expect(result.coverage.morningEvents).toBe(5);
    expect(result.sensors.map((s) => [s.classification, s.overshoot])).toEqual([['representative', null], ['representative', null]]);
    expectNeutralOvershoot(result, 'Living, Bedroom');
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
    const result = analyzePlacement(input({ sensors, hvac: offMornings(2) }));
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

  it('treats the thermostat reading as a reported comfort reading, not an outlier', () => {
    const result = analyzePlacement(input({
      sensors: series({ home_current_temperature: -1.6, living_temperature: 0.8, bedroom_temperature: 0.8 }, 5),
    }));
    const thermostat = result.sensors.find((s) => s.id === 'home_current_temperature')!;
    expect(thermostat).toMatchObject({
      name: 'Thermostat (Ecobee average)',
      isThermostat: true,
      verdict: null,
      averageOffset: null,
      consistency: null,
      periodOffsets: {
        sleep: null, wake: null, home: null, heatingRuns: null, cooling: null,
      },
      recommendationIds: [],
    });
    expect(thermostat.verdictSummary).toContain('averaging is an approximation');
    expect(thermostat.verdictSummary).toContain('HomeKit reading\'s exact semantics are unverified');
    // The rooms' average excludes it, so both rooms are representative.
    expect(result.sensors.filter((s) => !s.isThermostat).map((s) => s.averageOffset)).toEqual([0, 0]);
    expect(result.recommendations.map((r) => r.id)).toEqual(['no-changes']);
  });

  it('words a cold sensor only from its offset when no room has overshoot evidence', () => {
    // Heating is never reported as stopping, so post-stop overshoot is unknown.
    // Wake-window peaks are an independent measurement.
    const neverIdle = hvac(5).map((s) => ({ ...s, hvacAction: 'heating' }));
    const result = analyzePlacement(input({ hvac: neverIdle }));
    expect(result.sensors.every((s) => s.overshoot === null)).toBe(true);
    const office = result.recommendations.find((r) => r.sensorId === 'office_temperature')!;
    expect(office.detail).toContain('If it\'s in your Home comfort setting, a low reading could contribute');
    expect(result.recommendations.every((r) => !/after heating stopped/.test(r.detail))).toBe(true);
  });

  it('discloses inferred heat-ups when recommending a sensor for comfort', () => {
    // Days 3–4 lack the reported 06:00 heating start, so those mornings are
    // inferred; their offsets feed the representative sensors' text.
    const hour = (t: number) => ((t - START) % DAY) / HOUR;
    const samples = hvac(5, { setpoint: 19.5 }).filter((s) => s.t < START + 3 * DAY || ![6, 8.5].includes(hour(s.t)));
    const result = analyzePlacement(input({
      sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5), hvac: samples,
    }));
    expect(result.coverage.inferredMorningEvents).toBe(2);
    const include = result.recommendations.filter((r) => r.action === 'include_in_comfort');
    expect(include).toHaveLength(2);
    include.forEach((r) => expect(r.detail).toMatch(/\. 2 of these \d+ heat-ups were inferred from room temperatures, not thermostat history\. /));
  });

  it.each([
    ['switched off', (t: number) => state(t, 'off', { presetMode: null, setpoint: null, hvacMode: 'off' })],
    ['switched to cool', (t: number) => state(t, 'idle', { presetMode: null, setpoint: 24, hvacMode: 'cool' })],
    ['unavailable', gap],
  ])('ends an inferred heat-up window when the thermostat is %s', (_, interruption) => {
    // No reported heating, so mornings are inferred from the rooms warming.
    // At 06:30 the thermostat is interrupted and the Office drops 3 °C; those
    // readings, taken when heating was impossible or unknown, must not count.
    const samples = Array.from({ length: 5 }, (_unused, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
      interruption(at(d, 6.5)),
      state(at(d, 12), 'idle', { presetMode: null, setpoint: 18 }),
    ]).flat();
    const office = (t: number) => {
      const h = ((t - START) % DAY) / HOUR;
      return h >= 6.5 && h < 12 ? -3 : 0;
    };
    const result = analyzePlacement(input({
      sensors: series({
        office_temperature: office, kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0,
      }, 5),
      hvac: samples,
    }));
    expect(result.coverage).toMatchObject({ morningEvents: 5, inferredMorningEvents: 5 });
    const sensor = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(sensor.classification).toBe('representative');
    expect(sensor.morningOffset).toBe(0);
  });

  it('marks sensors insufficient with too few events', () => {
    const result = analyzePlacement(input({ sensors: series(BIASES, 1), hvac: hvac(1) }));
    expect(result.coverage).toMatchObject({ morningEvents: 1, returnEvents: 1 });
    const rooms = result.sensors.filter((s) => !s.isThermostat);
    expect(rooms.every((s) => s.classification === 'insufficient' && s.verdict === 'insufficient')).toBe(true);
    expect(rooms[0].verdictSummary).toBe('There isn\'t enough data yet to judge Office.');
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
    // 10 events × 7 shared instants (06:30–08:00): only readings taken inside
    // each 2-hour window count, and the staggered sensors' first in-window
    // readings (06:07, 06:11) can only be used from 06:30.
    expect(office.sampleCount).toBe(70);
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
    // The snapshot's Sleep preset is in force through the inferred mornings,
    // so they aren't Home's evidence: the Home tip uses the 6 in Home.
    const kitchen = result.recommendations.find((r) => r.sensorId === 'kitchen_temperature')!;
    expect(kitchen.detail).toContain('in 6 of 6 heat-ups');
    expect(kitchen.detail).not.toContain('inferred');
  });

  it('does not infer a morning already observed or while the thermostat is off', () => {
    // Days 0–2 heat from 06:00; days 3–4 the thermostat is off through the
    // morning while the rooms still warm (sun, cooking).
    const result = analyzePlacement(input({ hvac: offMornings(3) }));
    expect(result.coverage).toMatchObject({ morningEvents: 3, inferredMorningEvents: 0 });
  });

  it('respects the first recorded off state without inventing heat-ups after it', () => {
    const points = [{ t: at(0, 6), v: 20 }, { t: at(0, 6.25), v: 21 }];
    const sensors = ['living_temperature', 'bedroom_temperature'].map((id) => ({
      id, name: id, isThermostat: false, points,
    }));
    const off = state(at(0, 5), 'off', { presetMode: null, hvacMode: 'off', setpoint: null });
    const priorHeat = state(START - HOUR, 'idle', { presetMode: null });
    expect(inferMorningEvents(sensors, 'UTC', [off])).toEqual([]);
    expect(inferMorningEvents(sensors, 'UTC', [priorHeat, off])).toEqual([]);
    expect(inferMorningEvents(sensors, 'UTC', [state(START - HOUR, 'off', { hvacMode: 'off' })])).toEqual([]);
    // Before the first observation, or with no history, the rise can still be inferred.
    expect(inferMorningEvents(sensors, 'UTC', [state(at(0, 8), 'off', { hvacMode: 'off' })]))
      .toEqual([{ type: 'morning', t: at(0, 6), inferred: true }]);
    expect(inferMorningEvents(sensors, 'UTC')).toEqual([{ type: 'morning', t: at(0, 6), inferred: true }]);

    const result = analyzePlacement(input({
      sensors: series(BIASES, 3), hvac: [off], end: new Date(START + 3 * DAY), windowDays: 3,
    }));
    expect(result.coverage).toMatchObject({ morningEvents: 0, inferredMorningEvents: 0 });
    expect(result.recommendations.some((rec) => rec.mode === 'heating')).toBe(false);
  });

  it.each([
    ['off', (t: number) => state(t, 'off', { presetMode: null, setpoint: null, hvacMode: 'off' })],
    ['cool', (t: number) => state(t, 'idle', { presetMode: null, setpoint: 24, hvacMode: 'cool' })],
    ['unavailable', gap],
  ])('does not start an inferred warm-up while the thermostat is already %s', (_, before) => {
    // The thermostat is off/cool/unavailable from 03:00 and switches to heat
    // at 07:30. The rooms warm from 06:00 (sun) while the Office stays cold;
    // a warm-up inferred from 06:00 would count those readings and call the
    // Office cold. One may only start once heat is in force, from 07:30.
    const samples = Array.from({ length: 5 }, (_unused, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
      before(at(d, 3)),
      state(at(d, 7.5), 'idle', { presetMode: null, setpoint: 20 }),
    ]).flat();
    const office = (t: number) => {
      const h = ((t - START) % DAY) / HOUR;
      return h >= 6 && h < 7.5 ? -3 : 0;
    };
    const result = analyzePlacement(input({
      sensors: series({
        office_temperature: office, kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0,
      }, 5),
      hvac: samples,
    }));
    const events = inferMorningEvents(
      series({ office_temperature: office, kitchen_temperature: 0, living_temperature: 0 }, 5),
      'UTC',
      samples,
    );
    expect(events).toHaveLength(5);
    expect(events.every((e) => ((e.t - START) % DAY) / HOUR >= 7.5)).toBe(true);
    expect(result.recommendations.some((r) => r.sensorId === 'office_temperature')).toBe(false);
    expect(result.sensors.find((s) => s.id === 'office_temperature')!.classification).not.toBe('cold');
  });

  // Four sensors with readings every 15 minutes from `value(sensor, hour)`.
  const rooms = (value: (id: string, hour: number) => number): SensorSeriesInput[] => [
    'office_temperature', 'kitchen_temperature', 'living_temperature', 'bedroom_temperature',
  ].map((id) => {
    const points = [];
    for (let t = START; t < START + 5 * DAY; t += 15 * 60 * 1000) {
      points.push({ t, v: value(id, ((t - START) % DAY) / HOUR) });
    }
    return {
      id, name: id, isThermostat: false, points,
    };
  });

  it('only infers a warm-up from a rise while heating is possible', () => {
    // Off from 03:00, heat from 07:30, off again from 08:15. The rooms stay at
    // 17 °C while heat is possible and only warm (sun) once it's off again,
    // with the Office lagging; that warming isn't a heat-up.
    const samples = Array.from({ length: 5 }, (_unused, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
      state(at(d, 3), 'off', { presetMode: null, setpoint: null, hvacMode: 'off' }),
      state(at(d, 7.5), 'idle', { presetMode: null, setpoint: 20 }),
      state(at(d, 8.25), 'off', { presetMode: null, setpoint: null, hvacMode: 'off' }),
      state(at(d, 12), 'idle', { presetMode: null, setpoint: 18 }),
    ]).flat();
    const sensors = rooms((id, h) => {
      if (h < 8.25 || h >= 12) return 17;
      return id === 'office_temperature' ? 17 : 21;
    });
    expect(inferMorningEvents(sensors, 'UTC', samples)).toEqual([]);
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.coverage).toMatchObject({ morningEvents: 0, inferredMorningEvents: 0 });
    expect(result.recommendations.some((r) => r.sensorId === 'office_temperature')).toBe(false);
  });

  it('only uses readings taken inside the heat-up window', () => {
    // Off from 03:00, heat from 07:30 until 08:15. The rooms warm 1 °C per 15
    // minutes from 07:30. The Office's 07:15–07:30 reading, taken while the
    // thermostat was still off, is 6 °C low; it must not make the Office cold.
    const samples = Array.from({ length: 5 }, (_unused, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
      state(at(d, 3), 'off', { presetMode: null, setpoint: null, hvacMode: 'off' }),
      state(at(d, 7.5), 'idle', { presetMode: null, setpoint: 20 }),
      state(at(d, 8.25), 'off', { presetMode: null, setpoint: null, hvacMode: 'off' }),
      state(at(d, 12), 'idle', { presetMode: null, setpoint: 18 }),
    ]).flat();
    const sensors = rooms((id, h) => {
      if (id === 'office_temperature' && h === 7.25) return 11;
      if (h < 7.5 || h >= 12) return 17;
      return Math.min(21, 18 + (h - 7.5) * 4);
    });
    const result = analyzePlacement(input({ sensors, hvac: samples }));
    expect(result.coverage).toMatchObject({ morningEvents: 5, inferredMorningEvents: 5 });
    const office = result.sensors.find((s) => s.id === 'office_temperature')!;
    expect(office).toMatchObject({ classification: 'representative', morningOffset: 0 });
    expect(result.recommendations.some((r) => r.sensorId === 'office_temperature')).toBe(false);
  });

  it('infers a warm-up from staggered sparse sensors using each one\'s own readings', () => {
    // Two sensors reporting every 30 minutes, 15 minutes apart, both warming
    // 0.5 °C from 06:15. No grid instant has fresh readings from both at the
    // start and end of an hour, but each sensor's own rise is clear.
    const sparse = (id: string, offsetMinutes: number): SensorSeriesInput => {
      const points = [];
      for (let t = START + offsetMinutes * 60_000; t < START + 5 * DAY; t += 30 * 60_000) {
        const h = ((t - START) % DAY) / HOUR;
        points.push({ t, v: h >= 6.25 && h < 12 ? 17.5 : 17 });
      }
      return {
        id, name: id, isThermostat: false, points,
      };
    };
    const events = inferMorningEvents([sparse('living_temperature', 0), sparse('bedroom_temperature', 15)], 'UTC');
    expect(events).toHaveLength(5);
    events.forEach((e, d) => expect(e).toEqual({ type: 'morning', t: at(d, 5.75), inferred: true }));
  });

  it('does not count an unverified thermostat-associated sensor as a second room for inference', () => {
    const sensors = series({ home_current_temperature: 0, bedroom_temperature: 0 }, 5);
    expect(inferMorningEvents(sensors, 'UTC')).toEqual([]);
    expect(analyzePlacement(input({ sensors, hvac: [], primaryThermostatId: null })).coverage.inferredMorningEvents).toBe(0);
    expect(inferMorningEvents(series({ bedroom_temperature: 0, living_temperature: 0 }, 5), 'UTC')).toHaveLength(5);
  });

  it('does work that grows about linearly with the length of history', () => {
    // Deterministic complexity check instead of a wall-clock gate: count reads
    // of reading/state timestamps and Map operations (the grid) while
    // analyzing, and require that doubling the days at most about doubles
    // them. Rescanning whole histories per candidate grows quadratically.
    const work = (days: number, observed: boolean): number => {
      let count = 0;
      const counted = <T extends { t: number }>(item: T): T => {
        const { t } = item;
        return Object.defineProperty({ ...item }, 't', {
          enumerable: true,
          get: () => {
            count += 1;
            return t;
          },
        });
      };
      const biases = Object.fromEntries(Array.from({ length: 6 }, (_unused, i) => [`room${i}_temperature`, (i % 3) - 1]));
      const sensors = series(biases, days).map((sensor) => ({ ...sensor, points: sensor.points.map(counted) }));
      // Observed: reported heating starts and stops each morning and evening
      // (with Away/home presets). Inferred: idle every 15 minutes.
      const samples = observed
        ? hvac(days).map(counted)
        : Array.from({ length: days * 96 }, (_unused, i) => counted(state(START + i * 15 * 60_000, 'idle', {
          presetMode: null, setpoint: 20,
        })));
      const proto = Map.prototype;
      const original = { get: proto.get, has: proto.has, set: proto.set, forEach: proto.forEach };
      proto.get = function get(key) { count += 1; return original.get.call(this, key); };
      proto.has = function has(key) { count += 1; return original.has.call(this, key); };
      proto.set = function set(key, value) { count += 1; return original.set.call(this, key, value); };
      proto.forEach = function forEach(callback, thisArg) {
        original.forEach.call(this, (...args: Parameters<typeof callback>) => {
          count += 1;
          callback.apply(thisArg, args);
        });
      };
      try {
        const result = analyzePlacement(input({
          sensors, hvac: samples, end: new Date(START + days * DAY), windowDays: days,
        }));
        expect(result.coverage).toMatchObject(observed
          ? { morningEvents: days, inferredMorningEvents: 0, returnEvents: days }
          : { morningEvents: days, inferredMorningEvents: days });
        expect(result.sensors.some((s) => s.overshoot !== null)).toBe(observed);
      } finally {
        Object.assign(proto, original);
      }
      return count;
    };
    // About 2.0 now; whole-history rescans gave about 2.9–3.8.
    expect(work(20, false) / work(10, false)).toBeLessThan(2.3);
    expect(work(20, true) / work(10, true)).toBeLessThan(2.3);
  });

  it('does not infer a warm-up while the thermostat reports cooling in heat_cool mode', () => {
    // heat_cool can heat, but an explicit cooling action shows it wasn't.
    const samples = Array.from({ length: 5 }, (_unused, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 20, hvacMode: 'heat_cool' }),
      state(at(d, 3), 'cooling', { presetMode: null, setpoint: 20, hvacMode: 'heat_cool' }),
      state(at(d, 8), 'cooling', { presetMode: null, setpoint: 20, hvacMode: 'heat_cool' }),
      state(at(d, 12), 'idle', { presetMode: null, setpoint: 20, hvacMode: 'heat_cool' }),
    ]).flat();
    const sensors = series({ living_temperature: 0, bedroom_temperature: 0 }, 5);
    expect(inferMorningEvents(sensors, 'UTC', samples)).toEqual([]);
    // Control: with idle instead of cooling the same rise is inferred.
    const idle = samples.map((s) => ({ ...s, hvacAction: 'idle' }));
    expect(inferMorningEvents(sensors, 'UTC', idle)).toHaveLength(5);
  });

  it('does not infer a warm-up inside a gap at the start of history', () => {
    // The first returned row is unavailable until 09:30 on the first day: no
    // inferred warm-up may start inside it. Later days still infer one.
    const samples = [gap(START), state(at(0, 9.5), 'idle', { presetMode: null, setpoint: 20 })];
    const sensors = series({ living_temperature: 0, bedroom_temperature: 0 }, 5);
    const events = inferMorningEvents(sensors, 'UTC', samples);
    expect(events.some((e) => e.t < at(0, 9.5))).toBe(false);
    expect(events).toHaveLength(4);
  });

  it('infers mornings when the thermostat reports idle through a set point increase', () => {
    // As with an ecobee through homekit_controller: the 06:00 set point rise
    // is reported with hvac_action idle throughout, yet the rooms warm. Reported
    // idle is not evidence against heating, so the warm-ups are inferred.
    const samples = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 18.3 }),
      state(at(d, 1), 'idle', { presetMode: null, setpoint: 18.3 }),
      state(at(d, 6), 'idle', { presetMode: null, setpoint: 20.3 }),
      state(at(d, 22), 'idle', { presetMode: null, setpoint: 18.3 }),
    ]).flat();
    const result = analyzePlacement(input({ hvac: samples }));
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: true, morningEvents: 5, inferredMorningEvents: 5, returnEvents: 0,
    });
    expect(result.sensors.find((s) => s.id === 'office_temperature')).toMatchObject({ classification: 'cold', overshoot: null });
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

  it('treats a switch to off or cool as an interruption, not the thermostat being satisfied', () => {
    const offAt7 = mornings((d) => [state(at(d, 7), 'off', { hvacMode: 'off' })]);
    const coolAt7 = mornings((d) => [state(at(d, 7), 'idle', { hvacMode: 'cool' })]);
    [offAt7, coolAt7].forEach((samples) => {
      const result = analyzePlacement(input({ sensors: flatRooms(() => 23), hvac: samples }));
      expect(result.coverage.morningEvents).toBe(5);
      expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
    });
  });

  it('does not treat heating stopping with a simultaneous set point or preset change as satisfied', () => {
    const setback = mornings((d) => [state(at(d, 7), 'idle', { setpoint: 18 })]);
    const preset = mornings((d) => [state(at(d, 7), 'idle', { presetMode: 'away' })]);
    [setback, preset].forEach((samples) => {
      const result = analyzePlacement(input({ sensors: flatRooms(() => 21), hvac: samples }));
      expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
    });
  });

  it('treats a set point, preset or mode change while heating continues as an interruption', () => {
    // A 21 → 18 °C setback at 06:30 while heating continues, then idle at
    // 07:00: rooms at 20 °C would read as a false 2 °C overshoot of 18 °C.
    const setback = mornings((d) => [
      state(at(d, 6.5), 'heating', { setpoint: 18 }), state(at(d, 7), 'idle', { setpoint: 18 }),
    ]);
    const preset = mornings((d) => [
      state(at(d, 6.5), 'heating', { presetMode: 'sleep' }), state(at(d, 7), 'idle', { presetMode: 'sleep' }),
    ]);
    const mode = mornings((d) => [
      state(at(d, 6.5), 'heating', { hvacMode: 'heat_cool' }), state(at(d, 7), 'idle', { hvacMode: 'heat_cool' }),
    ]);
    [setback, preset, mode].forEach((samples) => {
      const result = analyzePlacement(input({ sensors: flatRooms(() => 20), hvac: samples }));
      expect(result.coverage.morningEvents).toBe(5);
      expect(result.sensors.map((s) => s.overshoot)).toEqual([null, null]);
    });
  });

  it('doesn\'t read the warmth just after heating stops as passive warmth', () => {
    // Heating runs an hour every 4 hours; the rooms then sit 1.5 °C over the
    // 21 °C set point for 2 hours (overshoot) and at it for the last hour.
    const cycles = Array.from({ length: 5 * 6 }, (_, k) => [
      state(START + k * 4 * HOUR, 'heating', { presetMode: null, setpoint: 21 }),
      state(START + (k * 4 + 1) * HOUR, 'idle', { presetMode: null, setpoint: 21 }),
    ]).flat();
    const sensors = rooms((_id, hour) => {
      const h = hour % 4;
      if (h <= 1) return 20;
      return h <= 3 ? 22.5 : 21;
    });
    const result = analyzePlacement(input({
      sensors,
      hvac: cycles,
      comfort: [{ t: START - HOUR, setting: 'home' }],
    }));
    expect(result.recommendations.some((r) => r.id === 'passive-warmth-heating')).toBe(false);
    // The overshoot still suggests adding rooms to Home.
    expect(result.recommendations.map((r) => r.id).sort()).toEqual(['add-bedroom', 'add-kitchen', 'add-living', 'add-office']);
    // Already in Home: nothing to suggest, but the overshoot isn't denied.
    const inHome = analyzePlacement(input({
      sensors,
      hvac: cycles,
      comfort: [{ t: START - HOUR, setting: 'home' }],
      participation: {
        ...FOLLOW_ME_OFF, home: ['office_temperature', 'kitchen_temperature', 'living_temperature', 'bedroom_temperature'],
      },
    }));
    expect(inHome.recommendations.map((r) => r.id)).toEqual(['no-changes']);
    expect(inHome.recommendations[0].title).toBe('No changes suggested');
    expect(inHome.recommendations[0].detail).toContain('peaked 1.0 °C or more above the set point on average after heating '
      + 'stopped, but no change is suggested');
    expect(inHome.recommendations[0].detail).not.toContain('None of them peaked');
  });

  it('describes rooms sitting above the set point with heating idle as passive warmth, not a rise', () => {
    // Rooms sit flat at 22 °C, above the 21 °C set point whenever heating is
    // idle. The Ecobee aggregate independently reports that same temperature.
    const samples = mornings((d) => [state(at(d, 7), 'idle')]);
    const sensors = flatRooms(() => 22);
    const aggregate = { id: 'home_current_temperature', name: 'Home', isThermostat: true, points: sensors[0].points };
    const result = analyzePlacement(input({ sensors: [...sensors, aggregate], hvac: samples }));
    expect(result.sensors.filter((s) => !s.isThermostat).map((s) => s.overshoot)).toEqual([1, 1]);
    const [rec] = result.recommendations;
    expect(rec).toMatchObject({ id: 'passive-warmth-heating', action: 'none', sensorId: null, mode: 'heating' });
    expect(rec.detail).toContain('the reported or approximated comfort reading sat 2.1 °C above the set point on average, and at least 1.0 °C above it 100% of the observed idle samples');
    expect(rec.detail).toContain('This does not establish the cause; sensor placement may still affect the comfort reading');
    expect(result.recommendations.every((r) => !/\brose\b/.test(r.detail))).toBe(true);
  });

  it('treats history with only unavailable or unknown states as unavailable', () => {
    const result = analyzePlacement(input({ hvac: [gap(at(0, 1)), gap(at(2, 1))] }));
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: false, hvacEarliestStateAt: null, returnHistoryAvailable: false,
    });
  });

  it('does not treat a prior known state as available after an outage', () => {
    const result = analyzePlacement(input({
      hvac: [state(START - DAY, 'idle'), gap(START - HOUR)],
    }));
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: false, hvacEarliestStateAt: null,
    });
  });

  it('reports the earliest recorded state as returned, even before the window', () => {
    const early = state(START - 3 * HOUR, 'idle', { presetMode: 'sleep', setpoint: 17 });
    const result = analyzePlacement(input({ hvac: [gap(START - 4 * HOUR), early, ...hvac(5)] }));
    expect(result.coverage.hvacEarliestStateAt).toBe('2026-01-04T21:00:00.000Z');
  });

  it('describes how closely a representative sensor tracks the house with the mean absolute difference', () => {
    // Living reads 2 °C warm in the mornings and 2 °C cold after returns; its
    // signed average is about 0 but it is about 1.3 °C off the house average.
    const hours = (t: number) => ((t - START) % DAY) / HOUR;
    const result = analyzePlacement(input({
      sensors: series({
        living_temperature: (t) => (hours(t) < 12 ? 2 : -2),
        bedroom_temperature: 0,
        kitchen_temperature: 0,
      }, 5),
      hvac: hvac(5, { setpoint: 19.5 }),
    }));
    const living = result.sensors.find((s) => s.id === 'living_temperature')!;
    expect(living).toMatchObject({ classification: 'representative', averageOffset: 0 });
    const rec = result.recommendations.find((r) => r.sensorId === 'living_temperature')!;
    expect(rec.detail).toContain('while reading 1.3 °C from the house average on average during heat-ups');
    expect(rec.detail).not.toContain('0.0 °C');
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

describe('separately sourced climate reference', () => {
  const quarter = 15 * 60_000;
  const room = (t: number): SensorSeriesInput => ({
    id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [{ t, v: 18 }],
  });
  const result = (
    roomTime: number,
    history: HvacSample[],
    reference: NonNullable<Parameters<typeof analyzePlacement>[0]['reportedTemperature']> = {
      points: [{ t: START, v: 20 }],
    },
  ) => analyzePlacement(input({
    start: new Date(START),
    end: new Date(START + HOUR),
    sensors: [room(roomTime)],
    primaryThermostatId: null,
    reportedTemperature: reference,
    hvac: history,
    comfort: [{ t: START - HOUR, setting: 'home' }],
    participation: { home: null, sleep: null, away: null, followMe: false, thermostat: { home: true } },
  })).sensors[0].periodOffsets.home;

  it('uses the reference only after its complete source bucket and while fresh', () => {
    const history = [state(START - HOUR, 'idle')];
    expect(result(START, history)).toBe(-2);
    expect(result(START + quarter, history)).toBe(-2);
    expect(result(START + 2 * quarter, history)).toBeNull();
  });

  it('keeps its internal reference separate even if a room has the same candidate id', () => {
    const analysis = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors: [{ ...room(START), id: '__climate_reported_temperature__' }],
      primaryThermostatId: null,
      reportedTemperature: { points: [{ t: START, v: 20 }] },
      hvac: [state(START - HOUR, 'idle')],
      comfort: [{ t: START - HOUR, setting: 'home' }],
    }));
    expect(analysis.sensors).toHaveLength(1);
    expect(analysis.sensors[0].periodOffsets.home).toBe(-2);
  });

  it('rejects source buckets crossing climate gaps and does not carry across a later gap', () => {
    const initial = state(START - HOUR, 'idle');
    expect(result(START, [initial, gap(START + 7 * 60_000), state(START + 10 * 60_000, 'idle')])).toBeNull();
    expect(result(START, [initial, gap(START + quarter)])).toBe(-2);
    expect(result(START + quarter, [initial, gap(START + quarter)])).toBeNull();
    expect(result(START, [initial, gap(START), state(START + 5 * 60_000, 'idle')])).toBeNull();
  });

  it('does not compare a newer reference with a room carried across a climate gap', () => {
    const history = [state(START - HOUR, 'idle'), gap(START + 7 * 60_000), state(START + quarter, 'idle')];
    expect(result(START, history, { points: [{ t: START + quarter, v: 20 }] })).toBeNull();
  });

  it('does not fit membership from room and reference windows separated by gaps', () => {
    const starts = Array.from({ length: 30 }, (_, i) => START + i * 2 * quarter);
    const biases: [string, number][] = [
      ['bedroom_temperature', 18], ['living_temperature', 20], ['kitchen_temperature', 22],
    ];
    const sensors = biases.map(([id, value]) => ({
      id, name: id, isThermostat: false,
      points: starts.map((t) => ({ t, v: value })),
    }));
    const history = [state(START - HOUR, 'idle'), ...starts.flatMap((t) => [
      gap(t + 7 * 60_000), state(t + quarter, 'idle'),
    ])];
    const analysis = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + 16 * HOUR),
      sensors,
      primaryThermostatId: null,
      reportedTemperature: { points: starts.map((t) => ({ t: t + quarter, v: 18 })) },
      hvac: history,
      comfort: [{ t: START - HOUR, setting: 'home' }],
      participation: { home: ['living_temperature'], sleep: null, away: null, followMe: false, thermostat: { home: false } },
    }));
    expect(analysis.recommendations.some((rec) => rec.id.startsWith('participation-mismatch'))).toBe(false);
  });

  it('does not carry a reference across invalid unit windows or unavailable attribute changes', () => {
    const history = [state(START - HOUR, 'idle')];
    expect(result(START + quarter, history, {
      points: [{ t: START, v: 20 }], invalidWindows: [START + quarter],
    })).toBeNull();
    expect(result(START + quarter, history, {
      points: [{ t: START, v: 20 }], invalidations: [START + quarter + 1],
    })).toBeNull();
    expect(result(START, history, {
      points: [{ t: START, v: 20 }], invalidations: [START + quarter],
    })).toBe(-2);
  });

  it('discards the ambiguous recovery bucket after an unavailable reference', () => {
    const history = [state(START - HOUR, 'idle')];
    // Unknown just before the bucket; its numeric value may not recover until
    // just before the bucket ends, so it cannot represent the whole bucket.
    const invalidations = [START + quarter - 60_000];
    const recovery = { t: START + quarter, v: 20 };
    expect(result(START + quarter, history, { points: [recovery], invalidations })).toBeNull();
    const points = [recovery, { t: START + 2 * quarter, v: 20 }];
    expect(result(START + quarter, history, { points, invalidations })).toBeNull();
    expect(result(START + 2 * quarter, history, { points, invalidations })).toBe(-2);

    // At an exact boundary the ordering of unknown and numeric is ambiguous.
    const boundary = {
      invalidations: [START + quarter],
      points: [
        { t: START + quarter, v: 20 }, { t: START + 2 * quarter, v: 20 }, { t: START + 3 * quarter, v: 20 },
      ],
    };
    expect(result(START + quarter, history, boundary)).toBeNull();
    expect(result(START + 2 * quarter, history, boundary)).toBeNull();
    expect(result(START + 3 * quarter, history, boundary)).toBe(-2);
  });

  it('does not use a recovery anchor that overlaps a climate outage', () => {
    const history = [
      state(START - HOUR, 'idle'),
      gap(START + quarter + 2_000),
      state(START + 2 * quarter, 'idle'),
    ];
    const reference = {
      invalidations: [START + 60_000],
      points: [
        { t: START + quarter, v: 20 }, { t: START + 2 * quarter, v: 20 }, { t: START + 3 * quarter, v: 20 },
      ],
    };
    // The 00:15 numeric value may arrive before the outage; the 00:30 one may
    // not arrive until 00:44. Only the next full bucket has a safe anchor.
    expect(result(START + 2 * quarter, history, reference)).toBeNull();
    expect(result(START + 3 * quarter, history, reference)).toBe(-2);
  });

  it('requires a new complete anchor after climate gaps and invalid unit windows', () => {
    const points = [{ t: START + quarter, v: 20 }, { t: START + 2 * quarter, v: 20 }];
    const gapHistory = [state(START - HOUR, 'idle'), gap(START + 2_000), state(START + quarter, 'idle')];
    expect(result(START + quarter, gapHistory, { points })).toBeNull();
    expect(result(START + 2 * quarter, gapHistory, { points })).toBe(-2);

    const history = [state(START - HOUR, 'idle')];
    const invalid = { points, invalidWindows: [START] };
    expect(result(START + quarter, history, invalid)).toBeNull();
    expect(result(START + 2 * quarter, history, invalid)).toBe(-2);
  });

  it('reports an assumed reference unit even with one room and no recommendations', () => {
    const analysis = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors: [room(START)],
      primaryThermostatId: null,
      reportedTemperature: { points: [{ t: START, v: 20 }], assumedUnit: true },
      hvac: [state(START - HOUR, 'idle')],
      comfort: [{ t: START - HOUR, setting: 'home' }],
    }));
    expect(analysis.sensors[0].periodOffsets.home).toBe(-2);
    expect(analysis.recommendations).toEqual([]);
    expect(analysis.coverage).toMatchObject({
      unitAssumptions: {
        reportedTemperature: true, setpoints: false, coolingReportedTemperature: false, coolingSetpoints: false,
      },
    });
  });

  it('requires both the climate and room source buckets to fit the active run and comfort setting', () => {
    const run = (referenceTime: number, comfort: ComfortSample[]) => analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors: [room(START + quarter)],
      primaryThermostatId: null,
      reportedTemperature: { points: [{ t: referenceTime, v: 20 }] },
      hvac: [state(START, 'idle'), state(START + quarter, 'heating'), state(START + 2 * quarter, 'idle')],
      comfort,
      participation: { home: null, sleep: null, away: null, followMe: false, thermostat: { home: true } },
    })).sensors[0].periodOffsets;
    const home = [{ t: START - HOUR, setting: 'home' }];
    expect(run(START, home).heatingRuns).toBeNull();
    expect(run(START + quarter, home).heatingRuns).toBe(-2);
    const changes = [{ t: START, setting: 'sleep' }, { t: START + quarter, setting: 'home' }];
    expect(run(START, changes).home).toBeNull();
    expect(run(START + quarter, changes).home).toBe(-2);
  });
});

// Flat rooms over `days` from `from`: `value(t)` plus each room's bias.
function rooms(
  biases: Record<string, number | ((t: number) => number)>,
  value: (t: number) => number,
  { from = START, days = 5 } = {},
): SensorSeriesInput[] {
  return Object.entries(biases).map(([id, bias]) => {
    const points = [];
    for (let t = from; t < from + days * DAY; t += 15 * 60 * 1000) {
      points.push({ t, v: value(t) + (typeof bias === 'number' ? bias : bias(t)) });
    }
    const name = id.replace(/_temperature$/, '').replace(/^\w/, (c) => c.toUpperCase());
    return {
      id, name, isThermostat: id === 'home_current_temperature', points,
    };
  });
}

// Ecobee comfort settings: Sleep 22:00–06:00, Home otherwise.
function comfortSchedule(days: number, from = START): ComfortSample[] {
  return Array.from({ length: days }, (_, d) => [
    { t: from + d * DAY, setting: 'sleep' },
    { t: from + d * DAY + 6 * HOUR, setting: 'home' },
    { t: from + d * DAY + 22 * HOUR, setting: 'sleep' },
  ]).flat();
}

// Smart Recovery: heating starts at 04:30 ahead of Home at 06:00 and runs to
// 07:00; Sleep is 17 °C, Home 21 °C. No presets: the comfort history is used.
function wakeHvac(days: number): HvacSample[] {
  return Array.from({ length: days }, (_, d) => [
    state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
    state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
    state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
    state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
  ]).flat();
}

// Rooms at 17 °C overnight, warming from 05:00 to 21 °C at 07:00.
function wakeBase(t: number): number {
  const h = ((t - START) % DAY) / HOUR;
  if (h >= 5 && h < 7) return 17 + 2 * (h - 5);
  if (h >= 7 && h < 22) return 21;
  return 17;
}

// Bedroom reads cold (an exterior wall); the rest sit a little above the house average.
const WAKE_BIASES = {
  bedroom_temperature: -1.5,
  living_temperature: 0.5,
  kitchen_temperature: 0.5,
  office_temperature: 0.5,
};

function wakeInput(overrides: Partial<Parameters<typeof analyzePlacement>[0]> = {}) {
  return input({
    // Fixture: the reported reference equals the model's four-room mean.
    sensors: rooms({ ...WAKE_BIASES, home_current_temperature: 0 }, wakeBase),
    hvac: wakeHvac(5),
    comfort: comfortSchedule(5),
    ...overrides,
  });
}

const SUMMER = START + 180 * DAY;

// A summer week in cool mode (24 °C): the AC runs 13:00–16:00 and the rooms
// cool from 25 °C to 23 °C, sitting at 25 °C otherwise.
function coolHvac(days: number): HvacSample[] {
  const sample = (t: number, action: string): HvacSample => ({
    ...state(t, action, { presetMode: null, setpoint: 24, hvacMode: 'cool' }), coolSetpoint: 24,
  });
  return Array.from({ length: days }, (_, d) => [
    sample(SUMMER + d * DAY, 'idle'),
    sample(SUMMER + d * DAY + 13 * HOUR, 'cooling'),
    sample(SUMMER + d * DAY + 16 * HOUR, 'idle'),
  ]).flat();
}

function coolBase(t: number): number {
  const h = ((t - SUMMER) % DAY) / HOUR;
  return h >= 13 && h < 16 ? 25 - ((2 * (h - 13)) / 3) : 25;
}

function coolingInput(biases: Record<string, number>): CoolingInput {
  return {
    start: new Date(SUMMER),
    end: new Date(SUMMER + 5 * DAY),
    sensors: rooms(biases, coolBase, { from: SUMMER }),
    hvac: coolHvac(5),
    comfort: [{ t: SUMMER, setting: 'home' }],
  };
}

// The owner's house: heating barely runs (15 minutes each morning) and the
// rooms sit about 3 °C over the 20 °C set point; the Kitchen reads 1 °C warm
// every day, the Bedroom and Living Room 0.45 °C cool. The thermostat reads
// the average of all three.
const PASSIVE_BIASES = {
  home_current_temperature: (1 - 0.45 - 0.45) / 3,
  kitchen_temperature: 1,
  bedroom_temperature: -0.45,
  living_temperature: -0.45,
};

function passiveHvac(days: number): HvacSample[] {
  return Array.from({ length: days }, (_, d) => [
    state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
    state(at(d, 6), 'heating', { presetMode: null, setpoint: 20 }),
    state(at(d, 6.25), 'idle', { presetMode: null, setpoint: 20 }),
    state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
  ]).flat();
}

function passiveInput(overrides: Partial<Parameters<typeof analyzePlacement>[0]> = {}) {
  return input({
    sensors: rooms(PASSIVE_BIASES, (t) => 23 + 0.5 * Math.sin((2 * Math.PI * (t - START)) / DAY)),
    hvac: passiveHvac(5),
    comfort: comfortSchedule(5),
    participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    ...overrides,
  });
}

const occupied = (value: boolean): OccupancySample[] => [{ t: START - DAY, occupied: value }];

const config = (home: string[] | null, followMe: boolean | null = false) => ({
  home, sleep: null, away: null, followMe, thermostat: THERMOSTAT_EXCLUDED,
});

describe('analyzePlacement (Ecobee comfort average)', () => {
  it('names the sensor holding the wake-up warm-up on and notes Smart Recovery', () => {
    const result = analyzePlacement(wakeInput());
    expect(result.coverage).toMatchObject({
      comfortScheduleAvailable: true, wakeEvents: 5, morningEvents: 5, returnEvents: 0,
    });
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom).toMatchObject({
      verdict: 'cold_outlier',
      wakeOffset: -1.5,
      wakeOvershoot: 0,
      periodOffsets: {
        sleep: -1.5, wake: -1.5, home: -1.5, heatingRuns: -1.5, cooling: null,
      },
      consistency: {
        days: 5, coldDays: 5, warmDays: 0, coolingDays: 0, coolingColdDays: 0, coolingWarmDays: 0,
      },
      recommendationIds: ['wake-bedroom'],
    });
    // One cold room pulls the house average down; the others aren't outliers.
    result.sensors.filter((s) => !s.isThermostat && s.id !== 'bedroom_temperature').forEach((s) => {
      expect(s).toMatchObject({ verdict: 'representative', wakeOvershoot: 0.5, recommendationIds: ['wake-bedroom'] });
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      id: 'wake-bedroom',
      severity: 'medium',
      action: 'move',
      sensorId: 'bedroom_temperature',
      mode: 'heating',
      period: 'wake',
      comfortSetting: 'home',
      affectedSensorIds: ['living_temperature', 'kitchen_temperature', 'office_temperature'],
      title: 'Bedroom may be holding the morning warm-up on',
    });
    expect(result.recommendations[0].detail).toBe(
      'In 5 of 5 wake-ups (Sleep → Home), Bedroom read 1.5 °C below the reported or approximated comfort reading. '
      + 'If it\'s in your Home comfort setting, a low reading could contribute to a longer warm-up. Living, Kitchen and Office '
      + 'peaked 0.5, 0.5 and 0.5 °C over the Home set point on average in the 2 hours after the corresponding heated wake-ups '
      + 'with sufficient readings. Move it to an interior wall at about chest height, away from windows, doors and vents, '
      + 'or remove it from Home. The Sleep '
      + 'set point averaged 4.0 °C below Home. The warm-up ran 150 minutes on average. Smart Recovery can start heating '
      + 'before Home; consider a smaller Sleep setback or reviewing Smart Recovery timing.',
    );
  });

  it('states participation plainly when the comfort settings are configured', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase),
      participation: config(['bedroom_temperature', 'living_temperature']),
    }));
    expect(result.coverage).toMatchObject({ participationConfigured: true, followMe: false });
    // The effective average is the participating sensors' mean (-0.5).
    expect(result.sensors.map((s) => [s.id, s.wakeOffset, s.participation.home])).toEqual([
      ['bedroom_temperature', -1, true],
      ['living_temperature', 1, true],
      ['kitchen_temperature', 1, false],
      ['office_temperature', 1, false],
    ]);
    const [rec] = result.recommendations;
    expect(rec).toMatchObject({ id: 'wake-bedroom', title: 'Bedroom may be holding the morning warm-up on' });
    expect(rec.detail).toContain('Because it\'s in your Home comfort setting, a low reading could contribute to a longer warm-up');
    expect(rec.detail).not.toContain('If it\'s in');
  });

  it('models occupied sensors with Follow Me without treating the model as proof', () => {
    const withOccupancy = (bedroomOccupied: boolean) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: occupied(r.id !== 'bedroom_temperature' || bedroomOccupied),
      })),
      // Sleep is configured too, so whether it counted during the Smart
      // Recovery preheat (in Sleep) is known.
      participation: { ...config(['bedroom_temperature', 'living_temperature'], true), sleep: ['bedroom_temperature', 'living_temperature'] },
    }));

    const empty = withOccupancy(false);
    expect(empty.coverage).toMatchObject({ followMe: true, occupancyAvailable: true });
    const bedroom = empty.sensors.find((s) => s.id === 'bedroom_temperature')!;
    // The model uses only the Living Room for this approximation.
    expect(bedroom).toMatchObject({ occupiedShare: { wake: 0, home: 0 }, wakeOffset: -2 });
    expect(empty.sensors.find((s) => s.id === 'living_temperature')).toMatchObject({
      occupiedShare: { wake: 1, home: 1 }, wakeOffset: 0,
    });
    // The modeled exclusion is not proof; a conditional tip remains.
    const emptyRec = empty.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(emptyRec).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    expect(emptyRec.detail).toContain('approximately 0% of comparable samples');

    const full = withOccupancy(true);
    expect(full.recommendations[0].id).toBe('wake-bedroom');
    expect(full.recommendations[0].detail).toContain(
      'the occupancy-based model estimates it would have counted in approximately 100% of comparable samples while the warm-ups heated in Home',
    );
  });

  it('falls back to all participating sensors when none is occupied', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({ ...r, occupancy: occupied(false) })),
      participation: config(['bedroom_temperature', 'living_temperature'], true),
    }));
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.wakeOffset).toBe(-1);
  });

  // The thermostat reads exactly the Bedroom and Living Room's mean.
  const EST_BIASES = {
    home_current_temperature: -1,
    bedroom_temperature: -2,
    living_temperature: 0,
    kitchen_temperature: 1.2,
    office_temperature: 0.8,
  };

  it.each(['home', 'sleep', 'away'] as const)('uses the aggregate and only reconstructs complete %s averages', (setting) => {
    const members = ['bedroom_temperature', 'living_temperature'];
    const sensors = rooms({
      home_current_temperature: 1, bedroom_temperature: -2, living_temperature: 0,
    }, () => 20);
    const result = (membership: boolean | null, fresh: boolean, selected: string[] | null = members) => {
      const participation = {
        home: members, sleep: members, away: members, followMe: false,
        [setting]: selected,
        thermostat: { home: null, sleep: null, away: null, [setting]: membership },
      };
      return analyzePlacement(wakeInput({
        sensors: sensors.map((s) => (s.isThermostat && !fresh ? { ...s, points: [] } : s)),
        comfort: [{ t: START - DAY, setting }],
        participation,
      })).sensors.find((s) => s.id === 'bedroom_temperature')!.periodOffsets.heatingRuns;
    };
    [true, false, null].forEach((membership) => {
      // The actual aggregate wins even when participation is unknown or incomplete.
      expect(result(membership, true, [...members, 'undiscovered_temperature'])).toBe(-3);
    });
    expect(result(true, false)).toBeNull();
    expect(result(null, false)).toBeNull();
    expect(result(false, false)).toBe(-1);
    expect(result(false, false, null)).toBeNull();
    expect(result(false, false, [...members, 'undiscovered_temperature'])).toBeNull();
  });

  it('reconstructs a Follow Me average only when the possible thermostat participant is provably left out', () => {
    const members = ['bedroom_temperature', 'living_temperature'];
    const result = (
      thermostatOccupancy: boolean | null,
      livingOccupancy: boolean | null,
      thermostatIncluded: boolean | null,
      selected = members,
      followMe: boolean | null = true,
    ) => {
      const sensors = rooms({
        home_current_temperature: 0, bedroom_temperature: -2, living_temperature: 0,
      }, () => 20).map((s) => ({
        ...s,
        points: s.isThermostat ? [] : s.points,
        occupancy: [{
          t: START - DAY,
          occupied: s.isThermostat ? thermostatOccupancy : s.id === 'living_temperature' ? livingOccupancy : false,
        }],
      }));
      return analyzePlacement(wakeInput({
        sensors,
        comfort: [{ t: START - DAY, setting: 'home' }],
        participation: {
          home: selected, sleep: null, away: null, followMe, thermostat: { home: thermostatIncluded },
        },
      })).sensors.find((s) => s.id === 'bedroom_temperature')!.periodOffsets.home;
    };
    expect(result(false, true, true)).toBe(-2);
    expect(result(false, true, null)).toBe(-2);
    expect(result(true, true, true)).toBeNull();
    expect(result(null, true, true)).toBeNull();
    expect(result(false, false, true)).toBeNull();
    expect(result(false, null, true)).toBeNull();
    expect(result(false, true, true, [...members, 'undiscovered_temperature'])).toBeNull();
    expect(result(true, true, false)).toBe(-2);
    expect(result(null, true, false)).toBe(-2);
    expect(result(false, true, true, members, null)).toBeNull();
  });

  it.each([
    ['at the source end', false, 15, true, -2],
    ['inside the source', true, 7.5, false, null],
    ['after the source', true, 20, false, null],
    ['at the source start', true, 0, false, -2],
  ] as const)('uses thermostat occupancy %s rather than the later grid state', (_where, before, minute, after, offset) => {
    const minuteMs = HOUR / 60;
    const sensors: SensorSeriesInput[] = [
      {
        id: 'home_current_temperature', name: 'Home', isThermostat: true, points: [],
        occupancy: [{ t: START - 1, occupied: before }, { t: START + minute * minuteMs, occupied: after }],
      },
      {
        id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [{ t: START, v: 18 }],
        occupancy: occupied(false),
      },
      {
        id: 'living_temperature', name: 'Living', isThermostat: false, points: [{ t: START, v: 20 }],
        occupancy: occupied(true),
      },
    ];
    const result = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors,
      hvac: [state(START, 'heating'), state(START + 15 * minuteMs, 'idle')],
      comfort: [{ t: START - 1, setting: 'home' }],
      participation: {
        home: ['bedroom_temperature', 'living_temperature'], sleep: null, away: null, followMe: true,
        thermostat: { home: true },
      },
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.periodOffsets.home).toBe(offset);
    expect(bedroom.periodOffsets.heatingRuns).toBe(offset);
  });

  it('uses each participating room’s occupancy over its source-temperature bucket', () => {
    const sensors: SensorSeriesInput[] = [
      {
        id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [{ t: START, v: 18 }],
        occupancy: occupied(false),
      },
      {
        id: 'living_temperature', name: 'Living', isThermostat: false, points: [{ t: START, v: 20 }],
        occupancy: [{ t: START - 1, occupied: true }, { t: START + HOUR / 4, occupied: false }],
      },
    ];
    const result = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors,
      hvac: [state(START, 'heating'), state(START + HOUR / 4, 'idle')],
      comfort: [{ t: START - 1, setting: 'home' }],
      participation: {
        home: ['bedroom_temperature', 'living_temperature'], sleep: null, away: null, followMe: true,
        thermostat: { home: false },
      },
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.periodOffsets.home).toBe(-2);
    expect(bedroom.periodOffsets.heatingRuns).toBe(-2);
  });

  it('requires stable occupancy across staggered temperature source buckets', () => {
    const sensors: SensorSeriesInput[] = [
      {
        id: 'home_current_temperature', name: 'Home', isThermostat: true, points: [],
        occupancy: [{ t: START - 1, occupied: true }, { t: START + HOUR / 4, occupied: false }],
      },
      {
        id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [{ t: START, v: 18 }],
        occupancy: occupied(false),
      },
      {
        id: 'living_temperature', name: 'Living', isThermostat: false, points: [{ t: START + HOUR / 4, v: 20 }],
        occupancy: occupied(true),
      },
    ];
    const result = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors,
      hvac: [state(START, 'heating'), state(START + HOUR / 2, 'idle')],
      comfort: [{ t: START - 1, setting: 'home' }],
      participation: {
        home: ['bedroom_temperature', 'living_temperature'], sleep: null, away: null, followMe: true,
        thermostat: { home: true },
      },
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.periodOffsets.home).toBeNull();
    expect(bedroom.periodOffsets.heatingRuns).toBeNull();
  });

  it('attributes a source bucket to its setting rather than a change at the grid boundary', () => {
    const sensors: SensorSeriesInput[] = [
      { id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [{ t: START, v: 18 }] },
      { id: 'living_temperature', name: 'Living', isThermostat: false, points: [{ t: START, v: 20 }] },
    ];
    const result = analyzePlacement(input({
      start: new Date(START),
      end: new Date(START + HOUR),
      sensors,
      hvac: [state(START, 'heating'), state(START + HOUR / 4, 'idle')],
      comfort: [{ t: START - 1, setting: 'sleep' }, { t: START + HOUR / 4, setting: 'home' }],
      participation: {
        home: ['living_temperature'], sleep: ['bedroom_temperature', 'living_temperature'], away: null,
        followMe: false, thermostat: { home: false, sleep: false },
      },
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.periodOffsets).toMatchObject({ sleep: -1, home: null, heatingRuns: -1 });
  });

  it('allows the sole configured room when the thermostat is excluded, even without occupancy', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms({ bedroom_temperature: -2, living_temperature: 0 }, () => 20),
      comfort: [{ t: START - DAY, setting: 'home' }],
      participation: {
        home: ['bedroom_temperature'], sleep: null, away: null, followMe: true, thermostat: { home: false },
      },
    }));
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.periodOffsets.home).toBe(0);
    expect(result.sensors.find((s) => s.id === 'living_temperature')!.periodOffsets.home).toBe(2);
    expect(result.recommendations.find((r) => r.id === 'move-bedroom')!.title).toBe('Bedroom may be keeping the heat on');
  });

  it('accounts for thermostat membership and occupancy when an unoccupied room may count', () => {
    const members = ['bedroom_temperature', 'living_temperature'];
    const run = (
      thermostatMember: boolean | null,
      thermostatOccupancy: boolean | null | undefined,
      bedroomOccupied = false,
      livingOccupied = false,
      selected = members,
    ) => analyzePlacement(wakeInput({
      sensors: rooms({ home_current_temperature: 0, ...WAKE_BIASES }, wakeBase).map((s) => ({
        ...s,
        occupancy: s.isThermostat
          ? thermostatOccupancy === undefined ? undefined : [{ t: START - DAY, occupied: thermostatOccupancy }]
          : occupied(s.id === 'bedroom_temperature' ? bedroomOccupied : livingOccupied),
      })),
      participation: {
        home: selected, sleep: selected, away: null, followMe: true,
        thermostat: { home: thermostatMember, sleep: thermostatMember },
      },
    }));
    const wake = (result: ReturnType<typeof run>) => result.recommendations.find((r) => r.id === 'wake-bedroom');
    const bedroom = (result: ReturnType<typeof run>) => result.sensors.find((s) => s.id === 'bedroom_temperature')!;

    const occupiedThermostat = run(true, true);
    expect(wake(occupiedThermostat)).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    expect(wake(occupiedThermostat)!.detail).toContain('approximately 0% of comparable samples');
    expect(bedroom(occupiedThermostat).verdictSummary).toContain('occupancy-based model suggests it may have been left out');
    const emptyThermostat = run(true, false);
    expect(wake(emptyThermostat)).toMatchObject({ title: 'Bedroom may be holding the morning warm-up on' });
    expect(wake(emptyThermostat)!.detail).toContain('approximately 100% of comparable samples');
    expect(wake(run(false, true))!.detail).toContain('approximately 100% of comparable samples');
    expect(wake(run(null, false))!.detail).toContain('approximately 100% of comparable samples');
    [run(true, null), run(true, undefined), run(null, true)].forEach((unknown) => {
      expect(wake(unknown)).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
      expect(wake(unknown)!.detail).toContain('If it counted');
    });
    // Own occupancy counts under the model, regardless of the thermostat.
    expect(wake(run(true, null, true))!.detail).toContain('approximately 100% of comparable samples');
    // Another occupied room excludes it under the model, even with unknown thermostat occupancy.
    const occupiedRoom = run(true, null, false, true);
    expect(wake(occupiedRoom)).toMatchObject({ severity: 'low' });
    expect(bedroom(occupiedRoom).verdictSummary).toContain('occupancy-based model suggests it may have been left out');
    // A configured but undiscovered participant may be occupied.
    const partial = run(false, false, false, false, ['bedroom_temperature', 'undiscovered_temperature']);
    expect(wake(partial)).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    const undiscovered = analyzePlacement(wakeInput({
      sensors: rooms({ home_current_temperature: 0, ...WAKE_BIASES }, wakeBase)
        .map((s) => ({ ...s, occupancy: occupied(false) })),
      participation: { home: null, sleep: null, away: null, followMe: true },
    }));
    expect(wake(undiscovered)).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
  });

  it('uses the source bucket for heating contribution when occupancy changes before the later grid time', () => {
    const thermostatOccupancy: OccupancySample[] = [{ t: START - DAY, occupied: false }];
    const states = Array.from({ length: 5 }, (_, d) => {
      thermostatOccupancy.push(
        { t: at(d, 6), occupied: false },
        { t: at(d, 6) + HOUR / 3, occupied: true },
      );
      return [
        state(at(d, 0), 'idle', { presetMode: 'sleep', setpoint: 17 }),
        state(at(d, 6), 'heating'),
        state(at(d, 6.5), 'idle'),
        state(at(d, 22), 'idle', { presetMode: 'sleep', setpoint: 17 }),
      ];
    }).flat();
    const sensors = rooms({ ...WAKE_BIASES, home_current_temperature: -0.5 }, wakeBase).map((sensor) => ({
      ...sensor,
      // Carry the 06:00 bucket through 06:30; keep the later readings so
      // wake-up overshoot still has enough coverage.
      points: sensor.points.filter((p) => ((p.t - START) % DAY) !== (6.25 * HOUR)),
      occupancy: sensor.isThermostat ? thermostatOccupancy : occupied(false),
    }));
    const result = analyzePlacement(wakeInput({
      sensors,
      hvac: states,
      participation: {
        home: ['bedroom_temperature', 'living_temperature'], sleep: null, away: null, followMe: true,
        thermostat: { home: true },
      },
    }));
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('approximately 100% of comparable samples while the warm-ups heated in Home');
  });

  it('does not apply an occupancy change at the end of cooling to the preceding bucket', () => {
    const thermostatOccupancy: OccupancySample[] = [{ t: SUMMER - DAY, occupied: false }];
    for (let d = 0; d < 5; d += 1) {
      thermostatOccupancy.push(
        { t: SUMMER + d * DAY + 13 * HOUR, occupied: false },
        { t: SUMMER + d * DAY + 16 * HOUR, occupied: true },
      );
    }
    const summer = { kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 };
    const result = analyzePlacement(wakeInput({
      sensors: rooms({ kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0 }, wakeBase),
      participation: {
        home: ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'], sleep: null, away: null,
        followMe: true, thermostat: { home: true },
      },
      cooling: {
        ...coolingInput(summer),
        sensors: rooms({ ...summer, home_current_temperature: 0 }, coolBase, { from: SUMMER }).map((sensor) => ({
          ...sensor,
          occupancy: sensor.isThermostat ? thermostatOccupancy : [{ t: SUMMER - DAY, occupied: false }],
        })),
      },
    }));
    const rec = result.recommendations.find((r) => r.id === 'cooling-kitchen')!;
    expect(rec.detail).toContain('approximately 100% of comparable samples while the AC ran in Home');
  });

  it('keeps cooling contribution conditional when thermostat occupancy changes inside source buckets', () => {
    const thermostatOccupancy: OccupancySample[] = [{ t: SUMMER - DAY, occupied: true }];
    for (let d = 0; d < 5; d += 1) {
      for (let t = SUMMER + d * DAY + 13 * HOUR; t < SUMMER + d * DAY + 16 * HOUR; t += HOUR / 4) {
        thermostatOccupancy.push({ t, occupied: true }, { t: t + HOUR / 8, occupied: false });
      }
      thermostatOccupancy.push({ t: SUMMER + d * DAY + 16 * HOUR, occupied: true });
    }
    const summer = { kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 };
    const result = analyzePlacement(wakeInput({
      sensors: rooms({ kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0 }, wakeBase),
      participation: {
        home: ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'], sleep: null, away: null,
        followMe: true, thermostat: { home: true },
      },
      cooling: {
        ...coolingInput(summer),
        sensors: rooms({ ...summer, home_current_temperature: 0 }, coolBase, { from: SUMMER }).map((sensor) => ({
          ...sensor,
          occupancy: sensor.isThermostat ? thermostatOccupancy : [{ t: SUMMER - DAY, occupied: false }],
        })),
      },
    }));
    const rec = result.recommendations.find((r) => r.id === 'cooling-kitchen')!;
    expect(rec).toMatchObject({ severity: 'low', title: 'Kitchen may be keeping the AC on' });
    expect(rec.detail).toContain('If it counted');
  });

  it('does not fit room-only membership when the physical thermostat could contribute', () => {
    const wrong = ['bedroom_temperature', 'kitchen_temperature'];
    const result = (home: boolean | null, sleep: boolean | null) => analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: {
        home: wrong, sleep: wrong, away: null, followMe: false, thermostat: { home, sleep },
      },
    }));
    const uncertain = result(null, true);
    expect(uncertain.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
    const legacy = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase), participation: FOLLOW_ME_OFF,
    }));
    const legacyWake = legacy.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(legacyWake.detail).toContain('If it\'s in your Home comfort setting');
    expect(legacyWake.detail).not.toContain('readings suggest');
    const knownHome = result(false, true);
    expect(knownHome.recommendations.map((r) => r.id)).toContain('participation-mismatch-home');
    expect(knownHome.recommendations.map((r) => r.id)).not.toContain('participation-mismatch-sleep');
    const missingRoom = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: {
        home: [...wrong, 'undiscovered_temperature'], sleep: null, away: null, followMe: false,
        thermostat: { home: false },
      },
    }));
    expect(missingRoom.recommendations.map((r) => r.id)).not.toContain('participation-mismatch-home');
    const missingReading = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase).map((s) => (
        s.id === 'kitchen_temperature' ? { ...s, points: [] } : s
      )),
      participation: { ...config(wrong), thermostat: { home: false } },
    }));
    expect(missingReading.recommendations.map((r) => r.id)).not.toContain('participation-mismatch-home');
  });

  it('fits a separately sourced reference only when the physical thermostat is explicitly excluded', () => {
    const sensors = rooms(EST_BIASES, wakeBase);
    const reference = sensors.find((s) => s.isThermostat)!.points;
    const physical = sensors.map((s) => (s.isThermostat
      ? { ...s, points: s.points.map((p) => ({ ...p, v: p.v + 4 })) }
      : s));
    const run = (included: boolean | null) => analyzePlacement(wakeInput({
      sensors: physical,
      primaryThermostatId: null,
      reportedTemperature: { points: reference, assumedUnit: true },
      participation: {
        home: ['bedroom_temperature', 'kitchen_temperature'], sleep: null, away: null, followMe: false,
        thermostat: { home: included },
      },
    }));
    [true, null].forEach((included) => {
      const result = run(included);
      expect(result.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
      expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.periodOffsets.home).toBe(-1);
      expect(result.recommendations[0].detail).toContain('assume Home Assistant\'s last known temperature unit applied historically');
    });
    expect(run(false).recommendations.map((r) => r.id)).toContain('participation-mismatch-home');
  });

  it('does not infer another room’s membership when a discovered room has no temperatures', () => {
    const sensors = rooms({ ...EST_BIASES, home_current_temperature: -2 }, wakeBase)
      .map((sensor) => (sensor.id === 'office_temperature' ? { ...sensor, points: [] } : sensor));
    const result = analyzePlacement(wakeInput({ sensors, participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED }));
    const bedroom = result.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(bedroom.title).toContain('may be');
    expect(bedroom.detail).toContain('If it\'s in your Home comfort setting');
    expect(bedroom.detail).not.toContain('readings suggest');

    const configured = analyzePlacement(wakeInput({
      sensors, participation: config(['living_temperature', 'kitchen_temperature']),
    }));
    expect(configured.recommendations.map((r) => r.id)).not.toContain('participation-mismatch-home');
  });

  it('does not fit membership when an unclassifiable discovered temperature was omitted', () => {
    const sensors = rooms(EST_BIASES, wakeBase).filter((sensor) => sensor.id !== 'office_temperature');
    const result = (incompleteSensorInventory: boolean) => analyzePlacement(wakeInput({
      sensors, incompleteSensorInventory, participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    })).recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(result(false).detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting');
    expect(result(true).title).toContain('may be');
    expect(result(true).detail).toContain('If it\'s in your Home comfort setting');
  });

  it.each([true, null])('does not fit subsets against incomparable occupancy evidence (Follow Me: %s)', (followMe) => {
    const sensors = rooms({ ...EST_BIASES, home_current_temperature: -2 }, wakeBase).map((sensor) => ({
      ...sensor, occupancy: sensor.id === 'office_temperature' ? undefined : occupied(true),
    }));
    const result = analyzePlacement(wakeInput({
      sensors, participation: { ...FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED, followMe },
    }));
    const bedroom = result.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(bedroom.title).toContain('may be');
    expect(bedroom.detail).not.toContain('readings suggest');
  });

  it('does not fit membership when an occupancy stream changes inside every source bucket', () => {
    const changes: OccupancySample[] = [{ t: START - DAY, occupied: true }];
    for (let t = START; t < START + 5 * DAY; t += HOUR / 4) {
      changes.push({ t, occupied: true }, { t: t + HOUR / 8, occupied: false });
    }
    const sensors = rooms({ ...EST_BIASES, home_current_temperature: -2 }, wakeBase).map((sensor) => ({
      ...sensor, occupancy: sensor.id === 'office_temperature' ? changes : occupied(true),
    }));
    const result = analyzePlacement(wakeInput({
      sensors, participation: { ...FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED, followMe: true },
    }));
    const bedroom = result.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(bedroom.title).toContain('may be');
    expect(bedroom.detail).not.toContain('readings suggest');
  });

  it.each(['home', 'sleep', 'away'] as const)('warns when empty %s also excludes the thermostat', (setting) => {
    const participation = {
      home: null, sleep: null, away: null, followMe: false,
      [setting]: [],
      thermostat: { [setting]: false },
    };
    const comfort = [{ t: START - DAY, setting }];
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation,
      comfort,
    }));
    const warning = result.recommendations.find((r) => r.id === `participation-empty-${setting}`)!;
    expect(warning).toMatchObject({ action: 'none', comfortSetting: setting });
    expect(warning.detail).toContain('thermostat sensor');
    expect(warning.detail).toContain('unknown');
    expect(result.sensors.find((s) => s.isThermostat)!.participation).toEqual({ home: null, sleep: null, away: null });
    result.sensors.filter((s) => !s.isThermostat).forEach((sensor) => {
      expect(sensor.participation[setting]).toBeNull();
      expect(sensor.verdictSummary).not.toContain('isn\'t in the');
    });
    result.recommendations.filter((r) => r.comfortSetting === setting && r.sensorId).forEach((rec) => {
      expect(rec.detail).not.toContain('It isn\'t in your');
      expect(rec.detail).not.toContain('Because it\'s in your');
    });
    const missing = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase),
      participation,
      comfort,
    }));
    expect(missing.sensors.every((s) => s.periodOffsets.heatingRuns === null)).toBe(true);
    expect(missing.recommendations.map((r) => r.id)).toContain(`participation-empty-${setting}`);
    const unknown = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase), participation: { ...participation, thermostat: {} }, comfort,
    }));
    expect(unknown.recommendations.map((r) => r.id)).not.toContain(`participation-empty-${setting}`);
  });

  it('keeps cooling advice conditional when an empty setting also excludes the thermostat', () => {
    const summer = { kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 };
    const result = analyzePlacement(wakeInput({
      participation: { home: [], sleep: null, away: null, followMe: false, thermostat: { home: false } },
      cooling: {
        ...coolingInput(summer),
        sensors: rooms({ ...summer, home_current_temperature: 0 }, coolBase, { from: SUMMER }),
      },
    }));
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen.participation.home).toBeNull();
    const rec = result.recommendations.find((r) => r.mode === 'cooling' && r.sensorId === 'kitchen_temperature')!;
    expect(rec.title).toBe('Kitchen may be keeping the AC on');
    expect(rec.detail).toContain('If it\'s in your Home comfort setting');
    expect(rec.detail).not.toContain('It isn\'t in your');
    expect(result.recommendations.map((r) => r.id)).toContain('participation-empty-home');
  });

  it('keeps Follow Me contribution conditional for an impossible empty setting', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms({ ...WAKE_BIASES, home_current_temperature: 0 }, wakeBase)
        .map((sensor) => ({ ...sensor, occupancy: occupied(false) })),
      participation: { home: [], sleep: null, away: null, followMe: true, thermostat: { home: false } },
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.participation.home).toBeNull();
    const rec = result.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(rec.title).toContain('may be');
    expect(rec.detail).toContain('If it\'s in your Home comfort setting and counted');
    expect(rec.detail).not.toContain('It isn\'t in your');
  });

  it('estimates which sensors Ecobee averages from the thermostat reading', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    }));
    // Bedroom and Living Room are estimated in Home; Kitchen and Office out.
    const recIds = result.recommendations.map((r) => r.id);
    expect(recIds).toContain('wake-bedroom');
    // Offsets are measured against the thermostat's reading.
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.wakeOffset).toBe(-1);
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting. A low reading could contribute');
    expect(result.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
  });

  it('flags a configured comfort setting that the thermostat reading contradicts', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: config(['bedroom_temperature', 'kitchen_temperature']),
    }));
    const mismatch = result.recommendations.find((r) => r.id === 'participation-mismatch-home')!;
    expect(mismatch).toMatchObject({ action: 'none', comfortSetting: 'home', sensorId: null });
    expect(mismatch.detail).toContain('under a simple averaging approximation');
    expect(mismatch.detail).toMatch(/Living/);
    expect(mismatch.detail).toMatch(/Kitchen/);
  });

  it('doesn\'t estimate membership when Follow Me may be on without occupancy history', () => {
    // 18/20/22 °C with the thermostat at 20 °C: Living alone and all three
    // rooms both match it exactly, so the fit can't tell them apart.
    const ambiguous = rooms({
      home_current_temperature: 0, bedroom_temperature: -2, living_temperature: 0, kitchen_temperature: 2,
    }, wakeBase);
    const all = ['bedroom_temperature', 'living_temperature', 'kitchen_temperature'];
    [null, true].forEach((followMe) => {
      const result = analyzePlacement(wakeInput({ sensors: ambiguous, participation: config(all, followMe) }));
      const caveat = followMe === null
        ? 'Follow Me wasn\'t specified; if it\'s on it may have left it out of the average while unoccupied'
        : 'with Follow Me on, the occupancy and comfort-setting history couldn\'t show whether it counted';
      // No false contradiction of the configured setting from a singleton fit.
      expect(result.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
      expect(result.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
        ['wake-bedroom', 'low', 'Bedroom may be holding the morning warm-up on'],
        ['remove-kitchen', 'low', 'Kitchen may be stopping the heat early'],
      ]);
      result.recommendations.forEach((r) => {
        expect(r.detail).toContain(caveat);
        expect(r.detail).toContain('If it counted, a ');
        expect(r.detail).not.toContain('readings suggest');
      });
      ['bedroom_temperature', 'kitchen_temperature'].forEach((id) => {
        expect(result.sensors.find((x) => x.id === id)!.verdictSummary).toContain('so it may or may not be');
      });
    });
    // Explicitly off: every member counts in the model, while causes remain hypothetical.
    const off = analyzePlacement(wakeInput({ sensors: ambiguous, participation: config(all, false) }));
    expect(off.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
    expect(off.recommendations.map((r) => [r.id, r.severity])).toEqual([
      ['wake-bedroom', 'high'], ['remove-kitchen', 'medium'],
    ]);
  });

  it('merges cooling runs only across known idle time, not a data gap', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    // Cooling 13:00–14:00 and 14:10–16:00; between them idle or a gap.
    const split = (between: (t: number) => HvacSample) => coolHvac(5).flatMap((s) => (
      ((s.t - SUMMER) % DAY) / HOUR === 13
        ? [s, between(s.t + HOUR), { ...s, t: s.t + HOUR + HOUR / 6 }]
        : [s]));
    const coolingEvents = (between: (t: number) => HvacSample) => analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      cooling: { ...coolingInput(flat), hvac: split(between) },
    })).coverage.coolingEvents;
    const idle = (t: number): HvacSample => ({
      ...state(t, 'idle', { presetMode: null, setpoint: 24, hvacMode: 'cool' }), coolSetpoint: 24,
    });
    expect(coolingEvents(idle)).toBe(5);
    expect(coolingEvents(gap)).toBe(10);
    expect(coolingEvents((t) => ({ ...idle(t), hvacAction: null }))).toBe(10);
    // Any other action (heating, off, fan) isn't idle either.
    expect(coolingEvents((t) => ({ ...idle(t), hvacMode: 'heat_cool', hvacAction: 'heating' }))).toBe(10);
    expect(coolingEvents((t) => ({ ...idle(t), hvacAction: 'off' }))).toBe(10);
    expect(coolingEvents((t) => ({ ...idle(t), hvacAction: 'fan' }))).toBe(10);
  });

  it('does not score idle buckets between short cooling bursts as cooling placement evidence', () => {
    const days = 6;
    const flat = { kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0 };
    const biased = { kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 };
    const sample = (t: number, action: string): HvacSample => ({
      ...state(t, action, { hvacMode: 'cool', setpoint: 24 }), coolSetpoint: 24,
    });
    const short = Array.from({ length: days }, (_, d) => {
      const start = SUMMER + d * DAY;
      return [
        sample(start, 'idle'),
        ...Array.from({ length: 8 }, (_, i) => [
          sample(start + 13 * HOUR + i * 15 * 60_000, 'cooling'),
          sample(start + 13 * HOUR + (i * 15 + 5) * 60_000, 'idle'),
        ]).flat(),
      ];
    }).flat();
    const continuous = Array.from({ length: days }, (_, d) => {
      const start = SUMMER + d * DAY;
      return [sample(start, 'idle'), sample(start + 13 * HOUR, 'cooling'), sample(start + 15 * HOUR, 'idle')];
    }).flat();
    const run = (history: HvacSample[], summerSensors = rooms(biased, () => 24, { from: SUMMER, days })) => analyzePlacement(input({
      end: new Date(START + days * DAY),
      windowDays: days,
      sensors: rooms(flat, () => 20, { days }),
      primaryThermostatId: null,
      hvac: [state(START, 'idle')],
      comfort: [{ t: START, setting: 'home' }],
      cooling: {
        start: new Date(SUMMER),
        end: new Date(SUMMER + days * DAY),
        sensors: summerSensors,
        hvac: history,
        comfort: [{ t: SUMMER, setting: 'home' }],
      },
    }));
    const result = run(short);
    expect(result.coverage.coolingEvents).toBe(days);
    expect(result.sensors.every((sensor) => sensor.coolingOffset === null && sensor.coolingUndershoot === null)).toBe(true);
    expect(result.sensors.every((sensor) => sensor.consistency?.coolingDays === 0)).toBe(true);
    expect(result.recommendations.filter((rec) => rec.id.startsWith('cooling-'))).toEqual([]);
    expect(run(continuous).recommendations.some((rec) => rec.id === 'cooling-kitchen')).toBe(true);

    const mixed = Array.from({ length: days }, (_, d) => {
      const start = SUMMER + d * DAY;
      return [
        sample(start, 'idle'), sample(start + 13 * HOUR, 'cooling'), sample(start + 13.5 * HOUR, 'idle'),
        sample(start + 13.75 * HOUR, 'cooling'), sample(start + 14.25 * HOUR, 'idle'),
      ];
    }).flat();
    const spike = (hour: number) => rooms({
      ...flat, kitchen_temperature: (t) => ((t - SUMMER) % DAY === hour * HOUR ? 9 : 0),
    }, () => 24, { from: SUMMER, days });
    expect(run(mixed, spike(13.5)).recommendations.some((rec) => rec.id === 'cooling-kitchen')).toBe(false);
    expect(run(mixed, spike(13.25)).recommendations.some((rec) => rec.id === 'cooling-kitchen')).toBe(true);
  });

  it('splits a heating run interrupted by cooling, as cooling runs are', () => {
    // Heating from Home (06:00) to 08:00 with a 10-minute spell at 07:00.
    const ramp = (between: string, mode: string) => analyzePlacement(wakeInput({
      // Other rooms exceed the heating target before the interruption, so
      // wake advice doesn't depend on temperatures recorded while cooling.
      sensors: rooms({ ...WAKE_BIASES, home_current_temperature: 0 }, (t) => {
        const hour = ((t - START) % DAY) / HOUR;
        return hour >= 6 && hour < 7 ? 22 : wakeBase(t);
      }),
      hvac: Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 6), 'heating', { presetMode: null, setpoint: 21, hvacMode: mode }),
        state(at(d, 7), between, { presetMode: null, setpoint: 21, hvacMode: mode }),
        state(at(d, 7 + 1 / 6), 'heating', { presetMode: null, setpoint: 21, hvacMode: mode }),
        state(at(d, 8), 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat(),
    })).recommendations.find((r) => r.id === 'wake-bedroom')!.detail;
    // Merged across idle: one 120-minute warm-up; split by cooling: the first run.
    expect(ramp('idle', 'heat')).toContain('The warm-up ran 110 minutes on average');
    expect(ramp('cooling', 'heat_cool')).toContain('The warm-up ran 60 minutes on average');
  });

  it('gives cooling advice for the comfort setting cooling ran in', () => {
    // Cooling only ran in Sleep; the Kitchen is only in Sleep.
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      participation: {
        home: ['living_temperature', 'bedroom_temperature'],
        sleep: ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'],
        away: null,
        followMe: false,
      },
      cooling: {
        ...coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 }),
        comfort: [{ t: SUMMER, setting: 'sleep' }],
      },
    }));
    const rec = result.recommendations.find((r) => r.mode === 'cooling')!;
    expect(rec).toMatchObject({ id: 'cooling-kitchen', action: 'move', comfortSetting: 'sleep' });
    expect(rec.detail).toContain('Because it\'s in your Sleep comfort setting, a higher reading could contribute to longer cooling');
    expect(rec.detail).not.toContain('Home');
    expect(result.recommendations.some((r) => r.action === 'include_in_comfort')).toBe(false);
  });

  it('only emits the existing recommendation actions', () => {
    const legacy = ['move', 'exclude_from_comfort', 'include_in_comfort', 'none'];
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const results = [
      analyzePlacement(input()),
      analyzePlacement(wakeInput()),
      analyzePlacement(wakeInput({
        sensors: rooms(flat, wakeBase),
        cooling: coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 }),
      })),
      analyzePlacement(input({ sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5), hvac: hvac(5, { setpoint: 19.5 }) })),
      analyzePlacement(passiveInput()),
    ];
    const actions = new Set(results.flatMap((r) => r.recommendations.map((rec) => rec.action)));
    expect([...actions].filter((a) => !legacy.includes(a))).toEqual([]);
    // Placement, exclusion and inclusion advice are all exercised.
    expect([...actions].sort()).toEqual([...legacy].sort());
  });

  it('finds a warm sensor keeping the AC on from the last cooling season', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const summer = { kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      cooling: {
        ...coolingInput(summer),
        sensors: rooms({ ...summer, home_current_temperature: 0.5 / 3 }, coolBase, { from: SUMMER }),
      },
    }));
    expect(result.coverage).toMatchObject({
      coolingFrom: '2026-07-04T00:00:00.000Z', coolingTo: '2026-07-09T00:00:00.000Z', coolingEvents: 5,
    });
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen).toMatchObject({ verdict: 'warm_outlier', coolingOffset: 1.3, coolingUndershoot: 0 });
    expect(kitchen.consistency).toMatchObject({ coolingDays: 5, coolingWarmDays: 5 });
    expect(result.sensors.find((s) => s.id === 'living_temperature')).toMatchObject({
      verdict: 'representative', coolingOffset: -0.7, coolingUndershoot: 1.3,
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      id: 'cooling-kitchen',
      action: 'move',
      mode: 'cooling',
      comfortSetting: 'home',
      affectedSensorIds: ['living_temperature', 'bedroom_temperature'],
      title: 'Kitchen may be keeping the AC on',
    });
    expect(result.recommendations[0].detail).toBe(
      'Kitchen read at least 1.0 °C above the house average in 5 of 5 cooling runs (1.3 °C above on average while '
      + 'cooling ran). If it\'s in your Home comfort setting, a higher reading could contribute to longer cooling and colder rooms. '
      + 'Living and Bedroom dipped 1.3 and 1.3 °C below the cool set point on average while it ran. Cooking and appliances could '
      + 'warm a nearby sensor; consider moving it away from the stove and appliances, or remove it from Home. '
      + 'Based on cooling from 2026-07-04 to 2026-07-09.',
    );
  });

  it('uses the cooling target in force when each reading was taken', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0, office_temperature: 0 };
    const coolState = (t: number, hvacAction: string, coolSetpoint: number): HvacSample => ({
      ...state(t, hvacAction, { presetMode: null, setpoint: coolSetpoint, hvacMode: 'cool' }),
      coolSetpoint,
    });
    const temperature = (t: number) => {
      const hour = ((t - SUMMER) % DAY) / HOUR;
      if (hour >= 13 && hour < 14.5) return 24.5;
      if (hour >= 14.5 && hour < 16) return 23;
      return 25;
    };
    const result = analyzePlacement(wakeInput({
      cooling: {
        start: new Date(SUMMER),
        end: new Date(SUMMER + DAY),
        sensors: rooms(flat, temperature, { from: SUMMER, days: 1 }),
        hvac: [
          coolState(SUMMER, 'idle', 24),
          coolState(SUMMER + 13 * HOUR, 'cooling', 24),
          coolState(SUMMER + 14.5 * HOUR, 'cooling', 22),
          coolState(SUMMER + 16 * HOUR, 'idle', 22),
        ],
        comfort: [{ t: SUMMER, setting: 'home' }],
      },
    }));
    expect(result.sensors
      .filter((sensor) => sensor.id !== 'home_current_temperature')
      .map((sensor) => sensor.coolingUndershoot)).toEqual([0, 0, 0, 0]);
  });

  it.each([[0, 4], [10, 0], [15, 0]])(
    'uses the target change at wake + %s minutes only for subsequent whole buckets',
    (minute, expected) => {
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
        state(at(d, 6) + minute * 60_000, 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
      ]).flat();
      const sensors = rooms({ bedroom_temperature: 0 }, (t) => (
        (t - START) % DAY === 6 * HOUR ? 25 : 21
      ));
      const result = analyzePlacement(wakeInput({ sensors, hvac: history }));
      expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.wakeOvershoot).toBe(expected);
    },
  );

  it('excludes idle and target-transition buckets from cooling undershoot', () => {
    const sample = (hour: number, action: string, target: number): HvacSample => ({
      ...state(SUMMER + hour * HOUR, action, { hvacMode: 'cool', setpoint: target }),
      coolSetpoint: target,
    });
    const run = (history: HvacSample[], dipHour: number) => analyzePlacement(wakeInput({
      cooling: {
        start: new Date(SUMMER),
        end: new Date(SUMMER + DAY),
        sensors: rooms({ bedroom_temperature: 0 }, (t) => (
          (t - SUMMER) / HOUR === dipHour ? 20 : 24.5
        ), { from: SUMMER, days: 1 }),
        hvac: history,
        comfort: [{ t: SUMMER, setting: 'home' }],
      },
    })).sensors.find((s) => s.id === 'bedroom_temperature')!.coolingUndershoot;
    expect(run([
      sample(0, 'idle', 24), sample(13, 'cooling', 24), sample(13.5, 'idle', 24),
      sample(13.75, 'cooling', 24), sample(15, 'idle', 24),
    ], 13.5)).toBe(0);
    expect(run([
      sample(0, 'idle', 24), sample(13, 'cooling', 24),
      sample(13 + 40 / 60, 'cooling', 23), sample(15, 'idle', 23),
    ], 13.5)).toBe(0);
  });

  it('does not describe an idle-only dip as occurring while cooling ran', () => {
    const sample = (t: number, action: string): HvacSample => ({
      ...state(t, action, { hvacMode: 'cool', setpoint: 24 }), coolSetpoint: 24,
    });
    const history = Array.from({ length: 5 }, (_, d) => [
      sample(SUMMER + d * DAY, 'idle'),
      sample(SUMMER + d * DAY + 13 * HOUR, 'cooling'),
      sample(SUMMER + d * DAY + 13.5 * HOUR, 'idle'),
      sample(SUMMER + d * DAY + 13.75 * HOUR, 'cooling'),
      sample(SUMMER + d * DAY + 16 * HOUR, 'idle'),
    ]).flat();
    const sensors = rooms({
      kitchen_temperature: 3,
      living_temperature: 0,
      bedroom_temperature: (t) => ((t - SUMMER) % DAY === 13.5 * HOUR ? -4.5 : 0),
    }, () => 24.5, { from: SUMMER });
    const result = analyzePlacement(wakeInput({
      cooling: { ...coolingInput({}), sensors, hvac: history },
    }));
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.coolingUndershoot).toBe(0);
    const tip = result.recommendations.find((r) => r.id === 'cooling-kitchen')!;
    expect(tip).toBeDefined();
    expect(tip.detail).not.toContain('dipped');
  });

  it('discloses when no cooling was recorded in the past year', () => {
    const result = analyzePlacement(wakeInput({ cooling: null }));
    expect(result.coverage).toMatchObject({
      coolingFrom: null, coolingTo: null, coolingEvents: 0,
    });
    expect(result.sensors.every((s) => s.coolingOffset === null && s.coolingUndershoot === null)).toBe(true);
  });

  it('does not rule out sensor placement when the comfort reading stays warm with heating idle', () => {
    const result = analyzePlacement(passiveInput());
    expect(result.sensors.map((s) => [s.id, s.verdict])).toEqual([
      ['home_current_temperature', null],
      ['kitchen_temperature', 'warm_outlier'],
      ['bedroom_temperature', 'representative'],
      ['living_temperature', 'representative'],
    ]);
    expect(result.sensors.find((s) => s.id === 'kitchen_temperature')!.consistency)
      .toMatchObject({ days: 5, warmDays: 5, coldDays: 0 });
    expect(result.recommendations.map((r) => [r.id, r.severity, r.action])).toEqual([
      ['passive-warmth-heating', 'medium', 'none'],
      ['remove-kitchen', 'low', 'exclude_from_comfort'],
    ]);
    const [passive, kitchen] = result.recommendations;
    expect(passive.likelyCauses).toEqual([
      'set point lower than the house naturally holds', 'sun through windows', 'cooking and appliance heat',
    ]);
    expect(passive.detail).toContain('This does not establish the cause; sensor placement may still affect the comfort reading');
    expect(passive.detail).toContain('in the 2 hours after Sleep ended, rooms peaked 3.6 °C over the Home set point');
    expect(kitchen.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting.');
    expect(kitchen.detail).toContain('so this may matter more on colder days.');
    expect(result.recommendations.some((r) => r.sensorId === 'bedroom_temperature' || r.sensorId === 'living_temperature'))
      .toBe(false);
  });

  // Smart Recovery that finishes before Home: heating 04:00–05:30, Home at 06:00.
  function preheatHvac(days: number): HvacSample[] {
    return Array.from({ length: days }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
      state(at(d, 4), 'heating', { presetMode: null, setpoint: 21 }),
      state(at(d, 5.5), 'idle', { presetMode: null, setpoint: 21 }),
      state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
    ]).flat();
  }

  it('includes a Smart Recovery preheat that finishes before Home', () => {
    const result = analyzePlacement(wakeInput({ hvac: preheatHvac(5) }));
    expect(result.coverage).toMatchObject({ wakeEvents: 5, morningEvents: 5 });
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    // It only heated in Sleep, so that's the setting it's blamed for.
    expect(wake).toMatchObject({
      action: 'move', period: 'wake', sensorId: 'bedroom_temperature', comfortSetting: 'sleep',
    });
    expect(wake.detail).toContain('The warm-up ran 90 minutes on average');
  });

  it('measures a wake-up crossing Home per comfort setting, over its heating', () => {
    // Sleep averages Bedroom and Living Room (-0.5), Home averages Bedroom,
    // Kitchen and Office (-0.17): Bedroom is 1.0 °C below while heating in
    // Sleep before Home and 1.3 °C below while heating in Home.
    const participation = {
      home: ['bedroom_temperature', 'kitchen_temperature', 'office_temperature'],
      sleep: ['bedroom_temperature', 'living_temperature'],
      away: null,
      followMe: false,
      thermostat: THERMOSTAT_EXCLUDED,
    };
    const sensors = rooms(WAKE_BIASES, wakeBase);
    const result = analyzePlacement(wakeInput({ sensors, participation }));
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    // Home's own offset, not a blend with the preheat in Sleep.
    expect(wake).toMatchObject({ comfortSetting: 'home' });
    expect(wake.detail).toMatch(/^In 5 of 5 wake-ups \(Sleep → Home\), Bedroom read 1\.3 °C below the reported or approximated comfort reading\. /);
    // In Sleep only: the preheat's setting is the one blamed, from its offset.
    const sleepOnly = analyzePlacement(wakeInput({
      sensors, participation: { ...participation, home: ['kitchen_temperature', 'office_temperature'] },
    }));
    const sleepWake = sleepOnly.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(sleepWake).toMatchObject({ comfortSetting: 'sleep', title: 'Bedroom may be holding the morning warm-up on' });
    expect(sleepWake.detail).toContain('Bedroom read 1.0 °C below the reported or approximated comfort reading while heating in '
      + 'Sleep before Home. Because it\'s in your Sleep comfort setting, a low reading could contribute');
    expect(sleepWake.detail).toContain('or remove it from Sleep.');
    expect(sleepOnly.recommendations.some((r) => r.sensorId === 'bedroom_temperature' && r.comfortSetting === 'home'))
      .toBe(false);
  });

  it('times the warm-up from its heating runs, not their span', () => {
    // Heating 03:00–04:00 and 05:00–06:30 with cooling between them.
    const split = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
      state(at(d, 3), 'heating', { presetMode: null, setpoint: 21 }),
      { ...state(at(d, 4), 'cooling', { presetMode: null, setpoint: 21 }), hvacMode: 'heat_cool' },
      state(at(d, 5), 'heating', { presetMode: null, setpoint: 21 }),
      state(at(d, 6.5), 'idle', { presetMode: null, setpoint: 21 }),
      state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
    ]).flat();
    const wake = analyzePlacement(wakeInput({ hvac: split })).recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('The warm-up ran 150 minutes on average');
  });

  it('uses sensor buckets, not grid boundaries, for heating evidence across idle gaps', () => {
    const hvac = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
      state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
      state(at(d, 5.5), 'idle', { presetMode: null, setpoint: 21 }),
      state(at(d, 5.75), 'heating', { presetMode: null, setpoint: 21 }),
      state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
      state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
    ]).flat();
    const participation = {
      home: ['kitchen_temperature', 'office_temperature'],
      sleep: ['bedroom_temperature', 'living_temperature'],
      away: null,
      followMe: false,
      thermostat: THERMOSTAT_EXCLUDED,
    };
    const wake = (anomalyHour: number | null) => {
      const sensors = rooms({
        ...WAKE_BIASES,
        bedroom_temperature: (t) => {
          const hour = ((t - START) % DAY) / HOUR;
          return hour === anomalyHour ? 10 : -1.5;
        },
      }, wakeBase);
      return analyzePlacement(wakeInput({ sensors, hvac, participation }))
        .recommendations.find((r) => r.id === 'wake-bedroom')!;
    };
    const baseline = wake(null);
    const idleBucket = wake(5.5);
    const heatingEndBucket = wake(5.25);
    const heatingStartBucket = wake(4.5);

    expect(idleBucket.detail).toBe(baseline.detail);
    expect(heatingEndBucket).toBeUndefined();
    expect(heatingStartBucket).toBeUndefined();
    expect(idleBucket.detail).toContain('The warm-up ran 135 minutes on average');
  });

  it('stops measuring wake overshoot at a later set point change', () => {
    // At 07:00 the set point is raised to 23 °C and the rooms follow it.
    const raised = (t: number) => {
      const h = ((t - START) % DAY) / HOUR;
      return h >= 7 && h < 22 ? 23 : wakeBase(t);
    };
    const hvacRaised = wakeHvac(5).map((x) => (((x.t - START) % DAY) / HOUR === 7 ? { ...x, setpoint: 23 } : x));
    const result = analyzePlacement(wakeInput({ sensors: rooms(WAKE_BIASES, raised), hvac: hvacRaised }));
    // Only 06:00–07:00 is measured against Home's 21 °C, not the raised hour.
    expect(result.sensors.find((x) => x.id === 'living_temperature')!.wakeOvershoot).toBe(0);
    expect(result.recommendations.some((r) => r.id === 'wake-bedroom')).toBe(false);
  });

  it('judges Home heating only from Home: overnight cold readings aren\'t Home\'s', () => {
    const hourOf = (t: number) => ((t - START) % DAY) / HOUR;
    const night = (t: number) => hourOf(t) < 6 || hourOf(t) >= 22;
    const withBedroom = (bias: (t: number) => number) => rooms({ ...WAKE_BIASES, bedroom_temperature: bias }, wakeBase);
    const all = Object.keys(WAKE_BIASES);
    const recsFor = (bias: (t: number) => number) => analyzePlacement(wakeInput({
      sensors: withBedroom(bias),
      participation: { ...config(all), sleep: all },
    })).recommendations.filter((r) => r.sensorId === 'bedroom_temperature');
    // Cold only in Sleep: no Home tip; the preheat in Sleep is what it affects.
    const sleepCold = recsFor((t) => (night(t) ? -2 : 0.5));
    expect(sleepCold.some((r) => r.comfortSetting === 'home')).toBe(false);
    expect(sleepCold.map((r) => [r.id, r.comfortSetting])).toEqual([['wake-bedroom', 'sleep']]);
    // Cold in Home: blamed for Home.
    const homeCold = recsFor((t) => (night(t) ? 0.5 : -2));
    expect(homeCold.some((r) => r.comfortSetting === 'home')).toBe(true);
  });

  it('doesn\'t blame Home membership for a preheat that only ran in Sleep', () => {
    // The preheat (04:00–05:30) finishes before Home: no heating in Home.
    const participation = {
      home: ['bedroom_temperature', 'living_temperature'],
      sleep: ['living_temperature', 'kitchen_temperature', 'office_temperature'],
      away: null,
      followMe: false,
      thermostat: THERMOSTAT_EXCLUDED,
    };
    const sensors = rooms(WAKE_BIASES, wakeBase);
    const result = analyzePlacement(wakeInput({ sensors, hvac: preheatHvac(5), participation }));
    expect(result.recommendations.some((r) => r.id === 'wake-bedroom')).toBe(false);
    // In Sleep, it is blamed for Sleep.
    const inSleep = analyzePlacement(wakeInput({
      sensors, hvac: preheatHvac(5), participation: { ...participation, sleep: [...participation.sleep, 'bedroom_temperature'] },
    }));
    expect(inSleep.recommendations.find((r) => r.id === 'wake-bedroom')).toMatchObject({ comfortSetting: 'sleep' });
  });

  it('falls back to the thermostat preset when the comfort setting is unavailable', () => {
    const unavailable = analyzePlacement(input({ hvac: hvac(5), comfort: [{ t: START, setting: null }] }));
    expect(unavailable.coverage).toMatchObject({ returnHistoryAvailable: true, returnEvents: 5 });
    // A known Ecobee comfort setting takes precedence over the preset.
    const ecobee = analyzePlacement(input({ hvac: hvac(5), comfort: [{ t: START - DAY, setting: 'home' }] }));
    expect(ecobee.coverage.returnEvents).toBe(0);
  });

  it('doesn\'t carry a preset past an explicit unknown preset', () => {
    // Away, then the preset turns unknown at 01:00; the comfort select is
    // Home until it becomes unavailable at 12:00; Home (heating) at 17:00.
    const states = (unknown: boolean) => [
      state(at(0, 0), 'idle', { presetMode: 'away', setpoint: 17 }),
      ...(unknown ? [state(at(0, 1), 'idle', { presetMode: null, setpoint: 17 })] : []),
      state(at(0, 17), 'heating'),
      state(at(0, 19), 'idle'),
    ];
    const comfort = [{ t: START - DAY, setting: 'home' }, { t: at(0, 12), setting: null }];
    expect(analyzePlacement(input({ hvac: states(false), comfort })).coverage.returnEvents).toBe(1);
    expect(analyzePlacement(input({ hvac: states(true), comfort })).coverage.returnEvents).toBe(0);
  });

  it('falls back to the preset only while the comfort setting is unknown', () => {
    // Known (Home) until day 2, unavailable through days 2–3, known again from
    // day 4: only the preset's returns from Away on days 2 and 3 are read.
    const comfort = [
      { t: START - DAY, setting: 'home' },
      { t: at(2, 0), setting: null },
      { t: at(4, 0), setting: 'home' },
    ];
    const result = analyzePlacement(input({ hvac: hvac(5), comfort }));
    expect(result.coverage).toMatchObject({ returnHistoryAvailable: true, returnEvents: 2 });
    // Before the first comfort value the preset is used too.
    const late = analyzePlacement(input({ hvac: hvac(5), comfort: [{ t: at(3, 0), setting: 'home' }] }));
    expect(late.coverage.returnEvents).toBe(3);
  });

  it('doesn\'t assume occupancy across an outage with Follow Me', () => {
    // Occupied, then the Bedroom's occupancy sensor goes unavailable.
    const result = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r,
        occupancy: r.id === 'bedroom_temperature'
          ? [{ t: START - DAY, occupied: true }, { t: START, occupied: null }]
          : occupied(true),
      })),
      participation: config(['bedroom_temperature', 'living_temperature'], true),
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom).toMatchObject({ occupiedShare: { wake: null, home: null }, wakeOffset: null });
    expect(result.recommendations.some((r) => r.id === 'wake-bedroom')).toBe(false);
    expect(result.sensors.find((s) => s.id === 'living_temperature')!.occupiedShare).toEqual({ wake: 1, home: 1 });
  });

  it('treats a room without an occupancy stream as unknown with Follow Me', () => {
    const withBedroom = (bedroom: OccupancySample[] | undefined) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: r.id === 'bedroom_temperature' ? bedroom : occupied(true),
      })),
      participation: config(['bedroom_temperature', 'living_temperature'], true),
    })).sensors.find((s) => s.id === 'bedroom_temperature')!;
    // Explicitly unoccupied: only the Living Room counts.
    expect(withBedroom(occupied(false))).toMatchObject({ occupiedShare: { wake: 0, home: 0 }, wakeOffset: -2 });
    // No stream, or an outage: unknown, so it isn't read as unoccupied.
    expect(withBedroom(undefined)).toMatchObject({ occupiedShare: { wake: null, home: null }, wakeOffset: null });
    expect(withBedroom([])).toMatchObject({ occupiedShare: { wake: null, home: null }, wakeOffset: null });
    expect(withBedroom([{ t: START - DAY, occupied: null }])).toMatchObject({
      occupiedShare: { wake: null, home: null }, wakeOffset: null,
    });
  });

  it('doesn\'t infer a room without an occupancy stream is out when fitting Follow Me', () => {
    // The thermostat reads the Bedroom and Living Room's mean (-1). Read as
    // unoccupied, the Bedroom would drop out and the unoccupied Kitchen (-1)
    // alone would fit, estimating the Bedroom out of Home.
    const biases = {
      home_current_temperature: -1,
      bedroom_temperature: -2,
      living_temperature: 0,
      kitchen_temperature: -1,
      office_temperature: 0.8,
    };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(biases, wakeBase).map((r) => {
        if (r.id === 'living_temperature') return { ...r, occupancy: occupied(true) };
        if (r.id === 'kitchen_temperature' || r.id === 'office_temperature') return { ...r, occupancy: occupied(false) };
        return r;
      }),
      participation: config(null, true),
    }));
    const bedroom = result.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.occupiedShare).toEqual({ wake: null, home: null });
    expect(bedroom.verdictSummary).not.toContain('isn\'t in');
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('If it\'s in your Home comfort setting');
  });

  it('leaves the average unknown when a configured member has no fresh reading', () => {
    // No thermostat reading; Home is the Bedroom (18 °C) and Living Room
    // (22 °C), and the Bedroom only reported before the window.
    const sensors = rooms({
      bedroom_temperature: -2, living_temperature: 2, kitchen_temperature: 0, office_temperature: 0,
    }, wakeBase).map((r) => (r.id === 'bedroom_temperature' ? { ...r, points: [{ t: START - DAY, v: 15 }] } : r));
    const result = analyzePlacement(wakeInput({ sensors, participation: config(['bedroom_temperature', 'living_temperature']) }));
    result.sensors.forEach((sensor) => {
      expect(sensor.wakeOffset).toBeNull();
      expect(sensor.periodOffsets.home).toBeNull();
    });
    expect(result.recommendations.some((r) => r.period === 'wake')).toBe(false);
  });

  it('gives no heating verdict from a window the thermostat spent cooling', () => {
    const cooling = Array.from({ length: 5 }, (_, d) => [
      state(at(d, 0), 'cooling', { presetMode: null, setpoint: 24, hvacMode: 'cool' }),
      state(at(d, 12), 'idle', { presetMode: null, setpoint: 24, hvacMode: 'cool' }),
    ]).flat();
    const result = analyzePlacement(input({
      sensors: series({ kitchen_temperature: 1.5, living_temperature: 0, bedroom_temperature: 0 }, 5),
      hvac: cooling,
    }));
    const kitchen = result.sensors.find((s) => s.id === 'kitchen_temperature')!;
    expect(kitchen.consistency).toMatchObject({ days: 0, warmDays: 0 });
    expect(kitchen.verdict).not.toBe('warm_outlier');
    expect(result.recommendations.some((r) => r.mode === 'heating' && r.sensorId === 'kitchen_temperature')).toBe(false);
  });

  it('models cooling contribution from occupancy during cooling, not current occupancy', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const all = ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'];
    const run = (kitchenNow: boolean, kitchenThen: boolean, setting: 'home' | 'sleep') => {
      const summer = coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 });
      return analyzePlacement(wakeInput({
        sensors: rooms(flat, wakeBase).map((r) => ({
          ...r, occupancy: occupied(r.id !== 'kitchen_temperature' || kitchenNow),
        })),
        participation: {
          home: all, sleep: all, away: null, followMe: true,
        },
        cooling: {
          ...summer,
          comfort: [{ t: SUMMER, setting }],
          sensors: summer.sensors!.map((r) => ({
            ...r, occupancy: [{ t: SUMMER - DAY, occupied: r.id !== 'kitchen_temperature' || kitchenThen }],
          })),
        },
      })).recommendations.find((r) => r.mode === 'cooling' && r.sensorId === 'kitchen_temperature');
    };
    // Occupied now but empty while cooling ran: modeled exclusion, not proof.
    ['home', 'sleep'].forEach((setting) => {
      const rec = run(true, false, setting as 'home' | 'sleep')!;
      expect(rec).toMatchObject({ id: 'cooling-kitchen', comfortSetting: setting, severity: 'low' });
      expect(rec.detail).toContain('approximately 0% of comparable samples');
    });
    // Empty now but occupied while cooling ran: modeled contribution.
    ['home', 'sleep'].forEach((setting) => {
      const rec = run(false, true, setting as 'home' | 'sleep')!;
      expect(rec).toMatchObject({ id: 'cooling-kitchen', comfortSetting: setting });
      expect(rec.detail).toContain('approximately 100% of comparable samples');
    });
  });

  it('models the all-unoccupied fallback without treating modeled exclusion as conclusive', () => {
    const withBedroom = (bedroomOccupied: boolean, othersOccupied: boolean) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: occupied(r.id === 'bedroom_temperature' ? bedroomOccupied : othersOccupied),
      })),
      participation: { ...config(['bedroom_temperature', 'living_temperature'], true), sleep: ['bedroom_temperature', 'living_temperature'] },
    }));
    // Nobody occupied: the model averages both, including the cold Bedroom.
    const fallback = withBedroom(false, false);
    const wake = fallback.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('approximately 100% of comparable samples while the warm-ups heated in Home');
    expect(fallback.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— it may be');
    // Living Room occupied: the model leaves Bedroom out, but the tip remains conditional.
    const excluded = withBedroom(false, true);
    const excludedRec = excluded.recommendations.find((r) => r.sensorId === 'bedroom_temperature')!;
    expect(excludedRec).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    expect(excludedRec.detail).toContain('approximately 0% of comparable samples');
    const summary = excluded.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
    expect(summary).toContain('occupancy-based model suggests it may have been left out');
    expect(summary).not.toContain('never counted');
  });

  it('qualifies heating advice when Follow Me contribution is unknown', () => {
    const all = ['office_temperature', 'kitchen_temperature', 'living_temperature', 'bedroom_temperature'];
    const withOccupancy = (value: boolean | null) => analyzePlacement(input({
      sensors: series(BIASES, 5).map((r) => ({ ...r, occupancy: [{ t: START - DAY, occupied: value }] })),
      participation: config(all, true),
    }));
    // Occupancy unavailable throughout: whether the Kitchen counted is unknown.
    const unknown = withOccupancy(null);
    const rec = unknown.recommendations.find((r) => r.id === 'remove-kitchen')!;
    expect(rec).toMatchObject({ severity: 'low', title: 'Kitchen may be stopping the heat early' });
    expect(rec.detail).toContain('It\'s in your Home comfort setting, but with Follow Me on, the occupancy and '
      + 'comfort-setting history couldn\'t show whether it counted toward the average for enough of the time. '
      + 'If it counted, a higher reading could contribute to heating stopping sooner');
    expect(rec.detail).not.toContain('Because it\'s in');
    expect(rec.detail).not.toContain('it counted 1');
    const summary = unknown.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary!;
    expect(summary).toContain('with Follow Me on, the occupancy and comfort-setting history couldn\'t show');
    expect(summary).toContain('so it may or may not be pushing the comfort reading up');
    expect(summary).not.toContain('likely');
    // The wake-up tip is qualified the same way.
    const wake = unknown.recommendations.find((r) => r.id === 'wake-office')!;
    expect(wake).toMatchObject({ severity: 'low', title: 'Office may be holding the morning warm-up on' });
    expect(wake.detail).toContain('couldn\'t show whether it counted toward the average for enough of the time. '
      + 'If it counted, a low reading could contribute to a longer warm-up');
    // Occupied throughout: the model estimates contribution, not causation.
    const known = withOccupancy(true).recommendations.find((r) => r.id === 'remove-kitchen')!;
    expect(known.title).toBe('Kitchen may be stopping the heat early');
    expect(known.detail).toContain('Because it\'s in your Home comfort setting, a higher reading could contribute');
    expect(known.detail).toContain('the occupancy-based model estimates it would have counted in approximately 100% of comparable samples in Home');
  });

  it('treats an omitted Follow Me as unknown, not off', () => {
    const both = ['bedroom_temperature', 'living_temperature'];
    const run = (followMe: boolean | null, othersOccupied: boolean) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: occupied(r.id !== 'bedroom_temperature' && othersOccupied),
      })),
      participation: { home: both, sleep: both, away: null, followMe, thermostat: THERMOSTAT_EXCLUDED },
    }));
    const caveat = 'Follow Me wasn\'t specified; if it\'s on it may have left it out of the average while '
      + 'unoccupied, and whether it counted isn\'t known';
    // The Bedroom is empty while the Living Room is occupied: with Follow Me
    // on it would be left out, so it isn't blamed outright.
    const mixed = run(null, true);
    expect(mixed.coverage.followMe).toBeNull();
    const bedroom = mixed.sensors.find((s) => s.id === 'bedroom_temperature')!;
    // Which average Ecobee used depends on Follow Me, so it isn't assumed.
    expect(bedroom.wakeOffset).toBeNull();
    expect(mixed.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
      ['move-bedroom', 'low', 'Bedroom may be keeping the heat on'],
    ]);
    expect(mixed.recommendations[0].detail).toContain(`It's in your Home comfort setting, but ${caveat}. If it counted, `);
    expect(mixed.recommendations[0].detail).not.toContain('Because it\'s in');
    expect(bedroom.verdictSummary).toContain(`— ${caveat}, so it may or may not be pulling the comfort reading down`);
    expect(bedroom.verdictSummary).not.toContain('likely');
    // Nobody occupied: it counts whether Follow Me is on or off.
    const none = run(null, false);
    expect(none.recommendations[0]).toMatchObject({
      id: 'wake-bedroom', severity: 'medium', title: 'Bedroom may be holding the morning warm-up on',
    });
    expect(none.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— it may be');
    // Follow Me explicitly off: occupancy doesn't matter.
    expect(run(false, true).recommendations[0]).toMatchObject({ id: 'wake-bedroom', severity: 'medium' });
  });

  it('doesn\'t estimate membership from times an omitted Follow Me would matter', () => {
    // The thermostat reads the Bedroom and Living Room's mean; the Bedroom is
    // always empty, the others occupied. With Follow Me off that fits
    // {Bedroom, Living}; with it on, Ecobee would average the Living Room
    // alone. Neither is assumed.
    const withConfig = (participation: Parameters<typeof analyzePlacement>[0]['participation']) => analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase).map((r) => ({ ...r, occupancy: occupied(r.id !== 'bedroom_temperature') })),
      participation,
    }));
    const omitted = withConfig(undefined).recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(omitted.severity).toBe('low');
    expect(omitted.detail).not.toContain('readings suggest');
    expect(omitted.detail).toContain('If it\'s in your Home comfort setting and counted toward the average (Follow Me '
      + 'wasn\'t specified');
    const off = withConfig({
      ...FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    }).recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(off.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting. A low reading could contribute');
  });

  it('doesn\'t treat no observed contribution over part of the time as none', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const summer = coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 });
    // The others are always occupied. The Kitchen is empty (so left out),
    // except optionally for the first half hour of cooling; its occupancy is
    // unknown from day 3 until 13:45 on day 4: exactly 75% of the cooling
    // time is known.
    const run = (occupiedOnce: boolean, outage: boolean) => {
      const kitchen: OccupancySample[] = [
        { t: SUMMER - DAY, occupied: false },
        ...(occupiedOnce
          ? [{ t: SUMMER + 13 * HOUR, occupied: true }, { t: SUMMER + 13.5 * HOUR, occupied: false }]
          : []),
        ...(outage ? [{
          t: SUMMER + 3 * DAY, occupied: null,
        }, { t: SUMMER + 4 * DAY + 13.75 * HOUR, occupied: false }] : []),
      ];
      const result = analyzePlacement(wakeInput({
        sensors: rooms(flat, wakeBase),
        participation: config(['kitchen_temperature', 'living_temperature', 'bedroom_temperature'], true),
        cooling: {
          ...summer,
          sensors: summer.sensors!.map((r) => ({
            ...r, occupancy: r.id === 'kitchen_temperature' ? kitchen : [{ t: SUMMER - DAY, occupied: true }],
          })),
        },
      }));
      return {
        rec: result.recommendations.find((r) => r.mode === 'cooling'),
        summary: result.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary!,
      };
    };
    // Never counted in the known 75%: it may have counted in the rest, so the
    // tip stays, conditional and low.
    const partial = run(false, true);
    expect(partial.rec).toMatchObject({ id: 'cooling-kitchen', severity: 'low', title: 'Kitchen may be keeping the AC on' });
    expect(partial.rec!.detail).toContain('but with Follow Me on, the occupancy and comfort-setting history couldn\'t '
      + 'show whether it counted toward the average for enough of the time. If it counted, a higher reading could contribute');
    expect(partial.summary).toContain('so it may or may not be pushing the comfort reading up');
    expect(partial.summary).not.toContain('never counted');
    // Zero modeled contribution with occupancy known throughout is not proof.
    const none = run(false, false);
    expect(none.rec).toMatchObject({ id: 'cooling-kitchen', severity: 'low' });
    expect(none.rec!.detail).toContain('approximately 0% of comparable samples while the AC ran in Home');
    expect(none.summary).toContain('occupancy-based model suggests it may have been left out');
    expect(none.summary).not.toContain('never counted');
    // An approximate modeled share over part of the samples says so.
    const some = run(true, true);
    expect(some.rec).toMatchObject({ title: 'Kitchen may be keeping the AC on' });
    expect(some.rec!.detail).toContain('the occupancy-based model estimates it would have counted in approximately 4% '
      + 'of comparable samples while the AC ran in Home');
    expect(some.rec!.detail).toContain('About 75% of samples had enough data for this estimate; the rest are unknown.');
    expect(some.summary).toContain('occupancy-based model estimates it would have counted in approximately 4% of comparable samples while the AC ran '
      + 'in Home; about 75% of samples had enough data; actual timing and weighting may differ');
  });

  it('doesn\'t assume who counted when Follow Me is on or omitted and there\'s no occupancy history', () => {
    const both = ['bedroom_temperature', 'living_temperature'];
    const omittedCaveat = 'Follow Me wasn\'t specified; if it\'s on it may have left it out of the average while '
      + 'unoccupied, and whether it counted isn\'t known';
    // Omitted, nothing configured, no thermostat reading: the average Ecobee
    // used isn't assumed, so there are no wake offsets or wake-up tip.
    const withoutAggregate = rooms(WAKE_BIASES, wakeBase);
    const omitted = analyzePlacement(wakeInput({ sensors: withoutAggregate, participation: undefined }));
    expect(omitted.coverage).toMatchObject({ followMe: null, occupancyAvailable: false });
    expect(omitted.sensors.every((s) => s.wakeOffset === null)).toBe(true);
    expect(omitted.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
      ['move-bedroom', 'low', 'Bedroom may be keeping the heat on'],
    ]);
    expect(omitted.recommendations[0].detail).toContain(
      `If it's in your Home comfort setting and counted toward the average (${omittedCaveat}), a lower reading could contribute`,
    );
    const summary = omitted.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
    expect(summary).toContain(`— ${omittedCaveat}, so it may or may not be pulling the comfort reading down`);
    expect(summary).not.toContain('likely');
    // Omitted, with the thermostat's reading: membership isn't estimated from
    // an all-members assumption, and tips stay conditional.
    const estimated = analyzePlacement(wakeInput({ participation: undefined, sensors: rooms(EST_BIASES, wakeBase) }));
    const wake = estimated.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    expect(wake.detail).toContain(`(${omittedCaveat})`);
    expect(estimated.recommendations.every((r) => !r.detail.includes('readings suggest'))).toBe(true);
    // Explicitly on: the same, worded for Follow Me on.
    const on = analyzePlacement(wakeInput({
      sensors: withoutAggregate, participation: { home: both, sleep: both, away: null, followMe: true },
    }));
    const bedroom = on.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.wakeOffset).toBeNull();
    expect(on.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
      ['move-bedroom', 'low', 'Bedroom may be keeping the heat on'],
    ]);
    expect(on.recommendations[0].detail).toContain('It\'s in your Home comfort setting, but with Follow Me on, the '
      + 'occupancy and comfort-setting history couldn\'t show whether it counted toward the average for enough of the '
      + 'time. If it counted, a lower reading could contribute');
    expect(bedroom.verdictSummary).toContain('so it may or may not be pulling the comfort reading down');
    // Explicitly off: all members count, as before.
    const off = analyzePlacement(wakeInput({
      sensors: withoutAggregate,
      participation: { home: both, sleep: both, away: null, followMe: false, thermostat: THERMOSTAT_EXCLUDED },
    }));
    expect(off.recommendations[0]).toMatchObject({
      id: 'wake-bedroom', severity: 'medium', title: 'Bedroom may be holding the morning warm-up on',
    });
    expect(off.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— it may be');
    // With the thermostat's reading and Follow Me off, membership is estimated.
    const offEstimated = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase), participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    }));
    expect(offEstimated.recommendations.find((r) => r.id === 'wake-bedroom')!.detail).toContain('readings suggest');
  });

  it('qualifies cooling advice when Follow Me contribution is unknown', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const summer = coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 });
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      participation: config(['kitchen_temperature', 'living_temperature', 'bedroom_temperature'], true),
      cooling: {
        ...summer,
        sensors: summer.sensors!.map((r) => ({ ...r, occupancy: [{ t: SUMMER - DAY, occupied: null }] })),
      },
    }));
    const rec = result.recommendations.find((r) => r.mode === 'cooling')!;
    expect(rec).toMatchObject({
      id: 'cooling-kitchen', action: 'move', severity: 'low', title: 'Kitchen may be keeping the AC on',
    });
    expect(rec.detail).toContain('It\'s in your Home comfort setting, but with Follow Me on, the occupancy and '
      + 'comfort-setting history couldn\'t show whether it counted toward the average for enough of the time. '
      + 'If it counted, a higher reading could contribute');
    expect(rec.detail).not.toContain('Because it\'s in');
    expect(result.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary)
      .toContain('so it may or may not be pushing the comfort reading up and contributing to colder rooms');
  });

  it('states a small modeled Follow Me share instead of hiding it', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const summer = coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 });
    // The others are always occupied; the Kitchen only for the first hour of
    // the first day's cooling.
    const kitchen: OccupancySample[] = [
      { t: SUMMER - DAY, occupied: false },
      { t: SUMMER + 13 * HOUR, occupied: true },
      { t: SUMMER + 14 * HOUR, occupied: false },
    ];
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      participation: config(['kitchen_temperature', 'living_temperature', 'bedroom_temperature'], true),
      cooling: {
        ...summer,
        sensors: summer.sensors!.map((r) => ({
          ...r, occupancy: r.id === 'kitchen_temperature' ? kitchen : [{ t: SUMMER - DAY, occupied: true }],
        })),
      },
    }));
    const rec = result.recommendations.find((r) => r.mode === 'cooling')!;
    expect(rec).toMatchObject({ id: 'cooling-kitchen', title: 'Kitchen may be keeping the AC on' });
    const share = Number(/occupancy-based model estimates it would have counted in approximately (\d+)% of comparable samples while the AC ran in Home/.exec(rec.detail)![1]);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(20);
  });

  it('judges a cooling run spanning Home and Sleep per setting, without blending', () => {
    // Cooling 13:00–16:00; Home until 14:30, then Sleep. The Kitchen is only in
    // Sleep and reads 2.0 °C warm in Home, 1.2 °C in Sleep.
    const switchAt = 14.5;
    const inSleep = (t: number) => ((t - SUMMER) % DAY) / HOUR >= switchAt;
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const all = ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'];
    const run = (home: string[]) => analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      participation: {
        home, sleep: all, away: null, followMe: false,
      },
      cooling: {
        ...coolingInput({}),
        sensors: rooms({
          kitchen_temperature: (t) => (inSleep(t) ? 1.2 : 2),
          living_temperature: (t) => (inSleep(t) ? -0.6 : -1),
          bedroom_temperature: (t) => (inSleep(t) ? -0.6 : -1),
        }, coolBase, { from: SUMMER }),
        comfort: Array.from({ length: 5 }, (_, d) => [
          { t: SUMMER + d * DAY, setting: 'home' },
          { t: SUMMER + d * DAY + switchAt * HOUR, setting: 'sleep' },
        ]).flat(),
      },
    }));
    const result = run(['living_temperature', 'bedroom_temperature']);
    expect(result.coverage.coolingEvents).toBe(5);
    const cooling = result.recommendations.filter((r) => r.mode === 'cooling');
    expect(cooling.map((r) => [r.id, r.action, r.comfortSetting]).sort()).toEqual([
      ['add-cooling-kitchen', 'include_in_comfort', 'home'],
      ['cooling-kitchen', 'move', 'sleep'],
    ]);
    const home = cooling.find((r) => r.comfortSetting === 'home')!;
    const sleep = cooling.find((r) => r.comfortSetting === 'sleep')!;
    // Each tip quotes only its own setting's offset.
    expect(home.detail).toContain('2.0 °C above on average while cooling ran in Home');
    expect(home.detail).toContain('It isn\'t in your Home comfort setting');
    expect(home.detail).not.toContain('Sleep');
    expect(sleep.detail).toContain('1.2 °C above on average while cooling ran in Sleep');
    expect(sleep.detail).toContain('Because it\'s in your Sleep comfort setting, a higher reading could contribute');
    expect(sleep.detail).not.toContain('Home');
    // In both settings: two placement tips, told apart by setting.
    const both = run(all).recommendations.filter((r) => r.mode === 'cooling');
    expect(both.map((r) => [r.id, r.action, r.comfortSetting]).sort()).toEqual([
      ['cooling-kitchen-home', 'move', 'home'],
      ['cooling-kitchen-sleep', 'move', 'sleep'],
    ]);
    expect(both.find((r) => r.comfortSetting === 'home')!.detail).toContain('2.0 °C above on average while cooling ran in Home');
    expect(both.find((r) => r.comfortSetting === 'sleep')!.detail).toContain('1.2 °C above on average while cooling ran in Sleep');
  });

  it('names rooms the AC overcooled only from that setting\'s cooling', () => {
    // Cooling 13:00–16:00 at 24 °C; Home until 14:30, then Sleep. The Kitchen
    // is warm throughout; the Bedroom dips to 23 °C only in Sleep.
    const inSleep = (t: number) => ((t - SUMMER) % DAY) / HOUR >= 14.5;
    const all = ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'];
    const result = analyzePlacement(wakeInput({
      participation: {
        home: all, sleep: all, away: null, followMe: false,
      },
      cooling: {
        ...coolingInput({}),
        sensors: rooms({
          kitchen_temperature: 2,
          living_temperature: 0,
          bedroom_temperature: (t) => (inSleep(t) ? -1.5 : 0),
        }, () => 24.5, { from: SUMMER }),
        comfort: Array.from({ length: 5 }, (_, d) => [
          { t: SUMMER + d * DAY, setting: 'home' },
          { t: SUMMER + d * DAY + 14.5 * HOUR, setting: 'sleep' },
        ]).flat(),
      },
    }));
    const home = result.recommendations.find((r) => r.id === 'cooling-kitchen-home')!;
    const sleep = result.recommendations.find((r) => r.id === 'cooling-kitchen-sleep')!;
    expect(home.detail).not.toContain('dipped');
    expect(sleep.detail).toContain('Bedroom dipped 1.0 °C below the cool set point on average while it ran.');
    // The drill-down keeps all cooling.
    expect(result.sensors.find((x) => x.id === 'bedroom_temperature')!.coolingUndershoot).toBe(1);
  });

  it('estimates cooling membership from the cooling data', () => {
    // Fixture: the winter reference matches Bedroom and Living Room; the
    // summer reference matches all three, and Kitchen reads warm.
    const summer = {
      kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5,
    };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
      cooling: {
        ...coolingInput(summer),
        sensors: rooms({ ...summer, home_current_temperature: 0.5 / 3 }, coolBase, { from: SUMMER }),
      },
    }));
    const rec = result.recommendations.find((r) => r.mode === 'cooling')!;
    expect(rec).toMatchObject({ id: 'cooling-kitchen', action: 'move', comfortSetting: 'home' });
    expect(rec.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting.');
    expect(result.recommendations.some((r) => r.action === 'include_in_comfort' && r.mode === 'cooling')).toBe(false);
  });

  it('doesn\'t report an occupied share from mostly unknown occupancy', () => {
    // Known (occupied) for only the first of five days.
    const result = analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: [{ t: START - DAY, occupied: true }, { t: START + DAY, occupied: null }],
      })),
      participation: config(['bedroom_temperature', 'living_temperature'], true),
    }));
    expect(result.sensors.every((s) => s.occupiedShare.wake === null && s.occupiedShare.home === null)).toBe(true);
  });

  it('requires comparable temperatures for all subsets, but can fit intermittent complete samples', () => {
    const withOffice = (keep: (t: number) => boolean) => analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase).map((r) => (r.id === 'office_temperature'
        ? { ...r, points: r.points.filter((p) => keep(p.t)) }
        : r)),
      participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
    }));
    const estimated = 'The thermostat\'s readings suggest it\'s in your Home comfort setting. A low reading could contribute';
    // Absent: subsets including the Office remain plausible.
    const absent = withOffice(() => false);
    const absentWake = absent.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(absentWake.detail).toContain('If it\'s in your Home comfort setting');
    expect(absentWake.detail).not.toContain('readings suggest');
    // Intermittent: readings every other hour.
    const intermittent = withOffice((t) => Math.floor((t - START) / HOUR) % 2 === 0);
    expect(intermittent.recommendations.find((r) => r.id === 'wake-bedroom')!.detail).toContain(estimated);
  });

  it('recommends moving, not removing, a participating warm Kitchen in cooling', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      participation: config(['kitchen_temperature', 'living_temperature', 'bedroom_temperature']),
      cooling: coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 }),
    }));
    const rec = result.recommendations.find((r) => r.mode === 'cooling')!;
    expect(rec).toMatchObject({ id: 'cooling-kitchen', action: 'move', title: 'Kitchen may be keeping the AC on' });
    expect(rec.detail).toContain('Because it\'s in your Home comfort setting, a higher reading could contribute');
    expect(rec.detail).toContain('consider moving it away from the stove and appliances, or remove it from Home.');
  });

  it('keeps the original response without comfort history or configuration', () => {
    const result = analyzePlacement(input({ hvac: hvac(5), comfort: undefined, participation: undefined }));
    expect(result.coverage).toMatchObject({
      participationConfigured: false, followMe: null, occupancyAvailable: false, morningEvents: 5, returnEvents: 5,
    });
    result.sensors.forEach((s) => {
      expect(s.participation).toEqual({ home: null, sleep: null, away: null });
      expect(s.occupiedShare).toEqual({ wake: null, home: null });
    });
  });

  describe('placement evidence and wording regressions', () => {
    const flat = { bedroom_temperature: -2, living_temperature: 0, kitchen_temperature: 0 };
    const home = [{ t: START, setting: 'home' }];
    const excludedBedroom = config(['living_temperature', 'kitchen_temperature']);

    const activeHistory = (mode: 'heating' | 'cooling', days: number) => Array.from({ length: days }, (_, d) => {
      const options = { presetMode: null, hvacMode: mode === 'heating' ? 'heat' : 'cool', setpoint: 21 };
      const from = mode === 'heating' ? 6 : 12;
      return [
        state(at(d, 0), 'idle', options),
        state(at(d, from), mode, options),
        state(at(d, from + 3), 'idle', options),
      ];
    }).flat();

    it.each(['heating', 'cooling'] as const)(
      'review d29c8d1: does not assess %s verdicts from events in different scopes',
      (mode) => {
        const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22, { days: 3 });
        const end = new Date(START + 3 * DAY);
        const run = (comfort: ComfortSample[]) => analyzePlacement(input({
          sensors,
          primaryThermostatId: null,
          hvac: activeHistory(mode, 3).map((sample) => ({ ...sample, setpoint: 23 })),
          comfort,
          participation: config(sensors.map((sensor) => sensor.id)),
          end,
          windowDays: 3,
          cooling: mode === 'cooling' ? { start: new Date(START), end } : undefined,
        }));
        // Two Home events and one Sleep/unknown event do not give enough
        // evidence for any of the separately judged scopes.
        const split = run([...home, { t: at(2, 0), setting: mode === 'heating' ? 'sleep' : null }]);
        const kitchen = split.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
        expect(kitchen.verdict).toBe('insufficient');
        expect(kitchen.verdictSummary).toContain('enough data');
        expect(kitchen.verdictSummary).not.toMatch(/tracks|stays close/);
        expect(split.recommendations.some((rec) => rec.id === 'no-changes')).toBe(false);

        const complete = run(home);
        expect(complete.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.verdict).toBe('warm_outlier');
        expect(complete.recommendations.some((rec) => rec.sensorId === 'kitchen_temperature' && rec.mode === mode)).toBe(true);
      },
    );

    it('review d29c8d1: limits a representative verdict to the assessed cooling setting', () => {
      const end = new Date(START + 4 * DAY);
      const sensors = rooms({
        kitchen_temperature: (t) => (t >= at(3, 0) ? 3 : 0), living_temperature: 0, bedroom_temperature: 0,
      }, () => 22, { days: 4 });
      const result = analyzePlacement(input({
        sensors, primaryThermostatId: null,
        hvac: activeHistory('cooling', 4).map((sample) => ({ ...sample, setpoint: 22 })),
        comfort: [...home, { t: at(3, 0), setting: null }],
        participation: config(sensors.map((sensor) => sensor.id)),
        end, windowDays: 4, cooling: { start: new Date(START), end },
      }));
      const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
      expect(kitchen.verdict).toBe('representative');
      expect(kitchen.verdictSummary).toContain('assessed Home cooling data');
      expect(kitchen.verdictSummary).toContain('did not stand out consistently');
      const summary = result.recommendations.find((rec) => rec.id === 'no-changes')!;
      expect(summary.detail).toContain('Some settings or periods lacked enough comparable data');
    });

    it('review d29c8d1: does not call cancelling representative offsets close tracking', () => {
      const end = new Date(START + 3 * DAY);
      const sensors = rooms({
        kitchen_temperature: (t) => [3, -3, 0][Math.floor((t - START) / DAY)],
        living_temperature: 0,
        bedroom_temperature: 0,
      }, () => 22, { days: 3 });
      const result = analyzePlacement(input({
        sensors, primaryThermostatId: null,
        hvac: activeHistory('cooling', 3).map((sample) => ({ ...sample, setpoint: 22 })),
        comfort: home, participation: config(sensors.map((sensor) => sensor.id)),
        end, windowDays: 3, cooling: { start: new Date(START), end },
      }));
      const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
      expect(kitchen.verdict).toBe('representative');
      expect(kitchen.verdictSummary).toContain('did not stand out consistently');
      expect(kitchen.verdictSummary).not.toMatch(/tracks|stays close/);
    });

    const alternatingCooling = (days: number) => {
      const end = new Date(START + days * DAY);
      const sensors = rooms({
        kitchen_temperature: 3,
        living_temperature: 0,
        bedroom_temperature: (t) => (t === at(0, 1.25) ? -4 : 0),
      }, () => 24, { days });
      const history = Array.from({ length: days }, (_, d) => [
        state(at(d, 0), 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        state(at(d, 1), 'cooling', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        state(at(d, 10), 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
      ]).flat();
      const schedule = Array.from({ length: days }, (_, d) => [
        { t: at(d, 0), setting: 'home' },
        { t: at(d, 2.5), setting: 'sleep' },
        { t: at(d, 4), setting: 'home' },
        { t: at(d, 5.5), setting: 'sleep' },
        { t: at(d, 7), setting: 'home' },
        { t: at(d, 8.5), setting: 'sleep' },
      ]).flat();
      const all = sensors.map((sensor) => sensor.id);
      return analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac: history, comfort: schedule,
        participation: { ...config(all), sleep: all },
        end, windowDays: days, cooling: { start: new Date(START), end },
      }));
    };

    it('review d29c8d1: does not count setting fragments as distinct cooling runs', () => {
      const result = alternatingCooling(1);
      expect(result.coverage.coolingEvents).toBe(1);
      expect(result.recommendations.filter((rec) => rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature'))
        .toEqual([]);
      expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.verdict).toBe('insufficient');
    });

    it('review d29c8d1: counts and measures distinct cooling runs even when each has repeated setting fragments', () => {
      const result = alternatingCooling(3);
      expect(result.coverage.coolingEvents).toBe(3);
      const homeTip = result.recommendations.find((rec) => rec.id === 'cooling-kitchen-home')!;
      const sleepTip = result.recommendations.find((rec) => rec.id === 'cooling-kitchen-sleep')!;
      expect(homeTip.detail).toContain('3 of 3 cooling runs in Home');
      expect(sleepTip.detail).toContain('3 of 3 cooling runs in Sleep');
      // One 4 °C dip in one of the three runs is 1.3 °C per run, not 4/9.
      expect(homeTip.detail).toContain('Bedroom dipped 1.3 °C below the cool set point on average');
      expect(sleepTip.detail).not.toContain('Bedroom dipped');
      expect(result.sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.coolingUndershoot).toBe(1.3);
    });

    it('review d29c8d1: weights repeated cooling fragments by their comparable samples within each run', () => {
      const end = new Date(START + 3 * DAY);
      const sensors = rooms({
        kitchen_temperature: (t) => {
          const hour = ((t - START) % DAY) / HOUR;
          return (hour >= 1 && hour < 1.5) || (hour >= 5 && hour < 5.5) ? 6 : 0;
        },
        living_temperature: 0,
        bedroom_temperature: 0,
      }, () => 24, { days: 3 });
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        state(at(d, 1), 'cooling', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        state(at(d, 10), 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
      ]).flat();
      const schedule = Array.from({ length: 3 }, (_, d) => [
        { t: at(d, 0), setting: 'home' }, { t: at(d, 1.5), setting: 'sleep' },
        { t: at(d, 2), setting: 'home' }, { t: at(d, 4), setting: 'sleep' },
        { t: at(d, 5), setting: 'home' }, { t: at(d, 5.5), setting: 'sleep' },
      ]).flat();
      const all = sensors.map((sensor) => sensor.id);
      const result = analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac: history, comfort: schedule,
        participation: { ...config(all), sleep: all }, end, windowDays: 3,
        cooling: { start: new Date(START), end },
      }));
      const tip = result.recommendations.find((rec) => rec.id === 'cooling-kitchen')!;
      expect(tip.detail).toContain('3 of 3 cooling runs in Home');
      // Four 4 °C offsets and eight zero offsets make 1.3 °C per run.
      expect(tip.detail).toContain('1.3 °C above on average while cooling ran in Home');
    });

    const preheatThen = (mode: string, action: string, anomaly = false) => {
      const sensors = rooms({
        bedroom_temperature: (t) => {
          const hour = ((t - START) % DAY) / HOUR;
          return anomaly ? (hour === 6 ? -9 : 0) : (hour >= 6 && hour < 22 ? -3 : 0);
        },
        living_temperature: 0,
        kitchen_temperature: 0,
      }, () => 27, { days: 3 });
      const all = sensors.map((sensor) => sensor.id);
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
        state(at(d, 5.75), 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 6), action, { presetMode: null, hvacMode: mode, setpoint: mode === 'cool' ? 24 : 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat();
      return analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac: history, comfort: comfortSchedule(3),
        participation: { ...config(all), sleep: all },
        end: new Date(START + 3 * DAY), windowDays: 3,
      }));
    };

    it.each([
      ['cool', 'cooling'],
      ['heat_cool', 'cooling'],
    ])('review 22241a2: excludes Home %s/%s after a Sleep preheat from heating evidence', (mode, action) => {
      const result = preheatThen(mode, action);
      const bedroom = result.sensors.find((sensor) => sensor.id === 'bedroom_temperature')!;
      expect(result.coverage.wakeEvents).toBe(3);
      expect(bedroom.classification).toBe('representative');
      expect(result.recommendations.filter((rec) => rec.mode === 'heating' && rec.sensorId === bedroom.id)).toEqual([]);

      // A reported idle action in heat mode can still support the warm-up
      // comparison; some integrations continue to report idle during a rise.
      const heat = preheatThen('heat', 'idle');
      expect(heat.recommendations.some((rec) => rec.mode === 'heating' && rec.sensorId === bedroom.id)).toBe(true);
    });

    it.each(['cooling', 'gap'] as const)(
      'review 22241a2: excludes a heating source bucket spanning a brief %s interruption',
      (interruption) => {
        const history = Array.from({ length: 3 }, (_, d) => [
          state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
          state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
          state(at(d, 5.75), 'idle', { presetMode: null, setpoint: 21 }),
          interruption === 'gap'
            ? gap(at(d, 6) + 7 * 60_000)
            : state(at(d, 6) + 7 * 60_000, 'cooling', { presetMode: null, hvacMode: 'heat_cool' }),
          state(at(d, 6) + 10 * 60_000, 'idle', { presetMode: null, setpoint: 21 }),
          state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
        ]).flat();
        const result = (anomaly: boolean) => {
          const sensors = rooms({
            bedroom_temperature: (t) => (anomaly && ((t - START) % DAY) / HOUR === 6 ? -9 : 0),
            living_temperature: 0, kitchen_temperature: 0,
          }, () => 24, { days: 3 });
          const all = sensors.map((sensor) => sensor.id);
          return analyzePlacement(input({
            sensors, primaryThermostatId: null, hvac: history, comfort: comfortSchedule(3),
            participation: { ...config(all), sleep: all },
            end: new Date(START + 3 * DAY), windowDays: 3,
          })).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!;
        };
        expect(result(true).morningOffset).toBe(result(false).morningOffset);
        expect(result(true).periodOffsets.home).toBe(result(false).periodOffsets.home);
      },
    );

    it('review 22241a2: does not compare staggered heating sources across an action boundary', () => {
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 4.5), 'heating', { presetMode: null }),
        state(at(d, 6.25), 'idle', { presetMode: null }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat();
      const bedroom = (anomaly: boolean, staggered: boolean, reported: boolean) => {
        const sensors = rooms({
          bedroom_temperature: (t) => (anomaly && ((t - START) % DAY) / HOUR === 6 ? -12 : 0),
          living_temperature: 0, kitchen_temperature: 0,
        }, () => 24, { days: 3 }).map((sensor) => ({
          ...sensor,
          points: staggered ? sensor.points.filter((point) => {
            const hour = ((point.t - START) % DAY) / HOUR;
            return sensor.id === 'bedroom_temperature' ? hour !== 6.25 : hour !== 6;
          }) : sensor.points,
        }));
        const all = sensors.map((sensor) => sensor.id);
        const reference = rooms({ reference_temperature: 0 }, () => 24, { days: 3 })[0].points
          .filter((point) => !staggered || ((point.t - START) % DAY) / HOUR !== 6);
        return analyzePlacement(input({
          sensors, primaryThermostatId: null, hvac: history, comfort: comfortSchedule(3),
          reportedTemperature: reported ? { points: reference } : undefined,
          participation: { ...config(all), sleep: all },
          end: new Date(START + 3 * DAY), windowDays: 3,
        })).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!;
      };
      [false, true].forEach((reported) => {
        expect(bedroom(true, true, reported).morningOffset).toBe(bedroom(false, true, reported).morningOffset);
        expect(bedroom(true, true, reported).periodOffsets.home).toBe(bedroom(false, true, reported).periodOffsets.home);
        expect(bedroom(true, false, reported).morningOffset).toBeLessThan(0);
      });
    });

    it('review 22241a2: does not treat the Home cooling target as a heating wake target', () => {
      const cool = preheatThen('cool', 'cooling');
      expect(cool.sensors.filter((sensor) => !sensor.isThermostat).map((sensor) => sensor.wakeOvershoot))
        .toEqual([null, null, null]);
      expect(cool.recommendations.some((rec) => /Sleep set point|Sleep setback/.test(rec.detail))).toBe(false);

      const heat = preheatThen('heat', 'idle');
      expect(heat.sensors.find((sensor) => sensor.id === 'living_temperature')!.wakeOvershoot).toBe(6);
    });

    it('review 22241a2: does not quote a cool-mode Sleep target as a heating setback', () => {
      const inCool = wakeHvac(5).map((sample) => (
        ((sample.t - START) % DAY) / HOUR === 0 ? { ...sample, hvacMode: 'cool' } : sample
      ));
      const tip = analyzePlacement(wakeInput({ hvac: inCool })).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(tip).toBeDefined();
      expect(tip.detail).not.toMatch(/Sleep set point|Sleep setback/);
      const heat = analyzePlacement(wakeInput()).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(heat.detail).toContain('The Sleep set point averaged 4.0 °C below Home');
    });

    it('review 22241a2: requires the earlier heating target to belong to Sleep and not cross a gap', () => {
      const awayFirst = Array.from({ length: 5 }, (_, d) => [
        { t: at(d, 0), setting: 'away' }, { t: at(d, 5), setting: 'sleep' },
        { t: at(d, 6), setting: 'home' }, { t: at(d, 22), setting: 'sleep' },
      ]).flat();
      const interrupted = wakeHvac(5).flatMap((sample) => (
        ((sample.t - START) % DAY) / HOUR === 4.5
          ? [sample, gap(sample.t + 0.5 * HOUR), state(sample.t + (2 / 3) * HOUR, 'heating', { presetMode: null })]
          : [sample]
      ));
      [wakeInput({ comfort: awayFirst }), wakeInput({ hvac: interrupted })].forEach((fixture) => {
        const tip = analyzePlacement(fixture).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
        expect(tip).toBeDefined();
        expect(tip.detail).not.toMatch(/Sleep set point|Sleep setback/);
      });
    });

    it('review 8c5e5d2: treats an incompatible action in direct climate samples as unknown', () => {
      const sensors = rooms({
        bedroom_temperature: 0,
        living_temperature: 0,
        kitchen_temperature: (t) => {
          const hour = ((t - START) % DAY) / HOUR;
          return hour >= 2 && hour < 4 ? 3 : 0;
        },
      }, () => 20, { days: 3 });
      const all = sensors.map((sensor) => sensor.id);
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { hvacMode: 'cool', presetMode: null }),
        state(at(d, 1), 'cooling', { hvacMode: 'cool', presetMode: null }),
        state(at(d, 2), 'cooling', { hvacMode: 'heat', presetMode: null }),
        state(at(d, 4), 'idle', { hvacMode: 'heat', presetMode: null }),
      ]).flat();
      const end = new Date(START + 3 * DAY);
      const result = analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac: history, comfort: [{ t: START, setting: 'home' }],
        participation: config(all), end, windowDays: 3, cooling: { start: new Date(START), end },
      }));
      expect(result.coverage.coolingEvents).toBe(3);
      expect(result.recommendations.filter((rec) => rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature')).toEqual([]);
    });

    it('review 8c5e5d2: does not treat an unknown action after heating as satisfaction', () => {
      const result = (interrupted: boolean) => {
        const history = Array.from({ length: 3 }, (_, d) => [
          state(at(d, 0), 'idle', { presetMode: null }),
          state(at(d, 6), 'heating', { presetMode: null }),
          ...(interrupted
            ? [
              state(at(d, 7), null, { hvacMode: 'cool', presetMode: null }),
              state(at(d, 8), 'idle', { presetMode: null }),
            ]
            : [state(at(d, 7), 'idle', { presetMode: null })]),
        ]).flat();
        return analyzePlacement(input({
          sensors: rooms({ bedroom_temperature: 0, living_temperature: 0 }, () => 23, { days: 3 }),
          primaryThermostatId: null,
          hvac: history,
          comfort: [{ t: START, setting: 'home' }],
          participation: config(['bedroom_temperature', 'living_temperature']),
          end: new Date(START + 3 * DAY),
          windowDays: 3,
        }));
      };
      expect(result(true).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.overshoot).toBeNull();
      expect(result(false).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.overshoot).toBe(2);
    });

    it('review 8c5e5d2: selects Home heating cohorts from Home rather than a longer Sleep preheat', () => {
      const result = (coverage: 'sparse' | 'normal' | 'persistent') => {
        const sensors = rooms({
          bedroom_temperature: 0,
          living_temperature: 0,
          kitchen_temperature: (t) => {
            const hour = ((t - START) % DAY) / HOUR;
            return hour >= 6 && (coverage === 'persistent' ? hour < 22 : hour < 7) ? 2 : 0;
          },
        }, () => 20, { days: 3 }).map((sensor) => (
          coverage === 'sparse' && sensor.id === 'kitchen_temperature'
            ? {
              ...sensor,
              points: sensor.points.filter((point) => {
                const hour = ((point.t - START) % DAY) / HOUR;
                return hour < 7 || hour >= 22;
              }),
            }
            : sensor
        ));
        const all = sensors.map((sensor) => sensor.id);
        const history = Array.from({ length: 3 }, (_, d) => [
          state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
          state(at(d, 3.25), 'heating', { presetMode: null, setpoint: 21 }),
          state(at(d, 8), 'idle', { presetMode: null, setpoint: 21 }),
          state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
        ]).flat();
        return analyzePlacement(input({
          sensors,
          primaryThermostatId: null,
          hvac: history,
          comfort: comfortSchedule(3),
          participation: { ...config(all), sleep: all },
          end: new Date(START + 3 * DAY),
          windowDays: 3,
        }));
      };
      const homeTips = (coverage: 'sparse' | 'normal' | 'persistent') => result(coverage).recommendations
        .filter((rec) => rec.sensorId === 'kitchen_temperature' && rec.mode === 'heating' && rec.comfortSetting === 'home');
      expect(homeTips('sparse')).toEqual([]);
      expect(homeTips('normal')).toEqual([]);
      expect(homeTips('persistent').some((rec) => rec.id === 'remove-kitchen')).toBe(true);
      const sparse = result('sparse');
      expect(sparse.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.verdict).toBe('insufficient');
      expect(sparse.recommendations.find((rec) => rec.id === 'no-changes')!.detail).toContain('Not enough data for Kitchen');
    });

    it('review 8c5e5d2: requires Home coverage for Home wake advice even with complete Sleep readings', () => {
      const result = (coverage: 'sparse' | 'normal' | 'persistent') => {
        const sensors = rooms({
          bedroom_temperature: (t) => {
            const hour = ((t - START) % DAY) / HOUR;
            return hour >= 6 && (coverage === 'persistent' ? hour < 22 : hour < 7) ? -1.4 : 0;
          },
          living_temperature: 0,
          kitchen_temperature: 0,
        }, (t) => {
          const hour = ((t - START) % DAY) / HOUR;
          return hour >= 6 && hour < 22 ? 22 : 17;
        }, { days: 3 }).map((sensor) => (
          coverage === 'sparse' && sensor.id === 'bedroom_temperature'
            ? {
              ...sensor,
              points: sensor.points.filter((point) => {
                const hour = ((point.t - START) % DAY) / HOUR;
                return hour < 7 || hour >= 22;
              }),
            }
            : sensor
        ));
        const all = sensors.map((sensor) => sensor.id);
        const history = Array.from({ length: 3 }, (_, d) => [
          state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
          state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
          state(at(d, 8), 'idle', { presetMode: null, setpoint: 21 }),
          state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
        ]).flat();
        return analyzePlacement(input({
          sensors,
          primaryThermostatId: null,
          hvac: history,
          comfort: comfortSchedule(3),
          participation: { ...config(all), sleep: all },
          end: new Date(START + 3 * DAY),
          windowDays: 3,
        }));
      };
      const wake = (coverage: 'sparse' | 'normal' | 'persistent') => result(coverage).recommendations
        .find((rec) => rec.id === 'wake-bedroom');
      expect(wake('sparse')).toBeUndefined();
      expect(wake('normal')).toBeUndefined();
      expect(wake('persistent')).toMatchObject({ comfortSetting: 'home', period: 'wake' });
    });

    it('review 8c5e5d2: retains Sleep wake guidance when the room has no Home readings', () => {
      const sensors = rooms({
        bedroom_temperature: (t) => ((((t - START) % DAY) / HOUR < 6) ? -2 : 0),
        living_temperature: 0,
        kitchen_temperature: 0,
      }, (t) => {
        const hour = ((t - START) % DAY) / HOUR;
        return hour >= 6 && hour < 22 ? 22 : 17;
      }, { days: 3 }).map((sensor) => (
        sensor.id === 'bedroom_temperature'
          ? {
            ...sensor,
            points: sensor.points.filter((point) => {
              const hour = ((point.t - START) % DAY) / HOUR;
              return hour < 6 || hour >= 22;
            }),
          }
          : sensor
      ));
      const all = sensors.map((sensor) => sensor.id);
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 5), 'heating', { presetMode: null, setpoint: 21 }),
        state(at(d, 6.5), 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat();
      const result = analyzePlacement(input({
        sensors,
        primaryThermostatId: null,
        hvac: history,
        comfort: comfortSchedule(3),
        participation: { ...config(['living_temperature', 'kitchen_temperature']), sleep: all },
        end: new Date(START + 3 * DAY),
        windowDays: 3,
      }));
      expect(result.recommendations.find((rec) => rec.id === 'wake-bedroom')).toMatchObject({
        comfortSetting: 'sleep',
        period: 'wake',
      });
    });

    it.each(['away', 'unknown', 'gap'] as const)(
      'review 8c5e5d2: does not attribute an older Sleep target across %s to the next Sleep interval',
      (interruption) => {
        const comfort = Array.from({ length: 5 }, (_, d) => [
          { t: at(d, 0), setting: 'sleep' },
          { t: at(d, 4.75), setting: interruption === 'unknown' ? null : 'away' },
          { t: at(d, 5), setting: 'sleep' },
          { t: at(d, 6), setting: 'home' },
          { t: at(d, 22), setting: 'sleep' },
        ]).flat();
        const history = Array.from({ length: 5 }, (_, d) => [
          state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
          state(at(d, 4.5), 'heating', { presetMode: null, setpoint: 21 }),
          ...(interruption === 'gap' ? [gap(at(d, 4.75))] : []),
          state(at(d, 5), 'heating', { presetMode: null, setpoint: 20 }),
          state(at(d, 6), 'heating', { presetMode: null, setpoint: 21 }),
          state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
          state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
        ]).flat();
        const tip = analyzePlacement(wakeInput({ comfort, hvac: history })).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
        expect(tip).toBeDefined();
        expect(tip.detail).not.toMatch(/Sleep set point|smaller Sleep setback/);
      },
    );

    it('review 8c5e5d2: uses the target from an immediately preceding Sleep interval', () => {
      const comfort = Array.from({ length: 5 }, (_, d) => [
        { t: at(d, 0), setting: 'sleep' },
        { t: at(d, 4.75), setting: 'away' },
        { t: at(d, 5), setting: 'sleep' },
        { t: at(d, 6), setting: 'home' },
        { t: at(d, 22), setting: 'sleep' },
      ]).flat();
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 5), 'idle', { presetMode: null, setpoint: 20 }),
        state(at(d, 5.5), 'heating', { presetMode: null, setpoint: 21 }),
        state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat();
      const tip = analyzePlacement(wakeInput({ comfort, hvac: history })).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(tip.detail).toContain('The Sleep set point averaged 1.0 °C below Home');
      expect(tip.detail).not.toContain('smaller Sleep setback');
      const continuous = analyzePlacement(wakeInput()).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(continuous.detail).toContain('The Sleep set point averaged 4.0 °C below Home');
    });

    it('review 8c5e5d2: does not treat a synthetic Sleep transition as a fresh target', () => {
      const comfort = Array.from({ length: 5 }, (_, d) => [
        { t: at(d, 0), setting: 'sleep' },
        { t: at(d, 4.75), setting: 'away' },
        { t: at(d, 5), setting: 'sleep' },
        { t: at(d, 6), setting: 'home' },
        { t: at(d, 22), setting: 'sleep' },
      ]).flat();
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 4), 'idle', { presetMode: null, setpoint: 17 }),
        state(at(d, 5.5), 'heating', { presetMode: null, setpoint: 21 }),
        state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 17 }),
      ]).flat();
      const tip = analyzePlacement(wakeInput({ comfort, hvac: history })).recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(tip).toBeDefined();
      expect(tip.detail).not.toMatch(/Sleep set point|smaller Sleep setback/);
    });

    it('review 22241a2: excludes the first bucket if a valid heating target only returns after wake', () => {
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
        state(at(d, 6) + 10 * 60_000, 'idle', { presetMode: null, setpoint: 21 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
      ]).flat();
      const sensors = rooms({ bedroom_temperature: 0 }, (t) => (
        ((t - START) % DAY) / HOUR === 6 ? 27 : 21
      ));
      const result = analyzePlacement(wakeInput({ sensors, hvac: history }));
      expect(result.sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.wakeOvershoot).toBe(0);
    });

    const fragmentedCooling = (short: boolean, missing: boolean, outsideHome = false) => {
      const starts = [1, 8, 15];
      const length = short ? 2 : 4.5;
      const isHome = (hour: number) => starts.some((start) => (
        short ? hour >= start && hour < start + length && Math.floor((hour - start) * 4) % 2 === 0
          : (hour >= start && hour < start + 1.5) || (hour >= start + 3 && hour < start + 4.5)
      ));
      const sensors = rooms({
        kitchen_temperature: (t) => (outsideHome ? (isHome(((t - START) % DAY) / HOUR) ? 0 : 6) : 3),
        living_temperature: 0, bedroom_temperature: 0,
      }, () => 24, { days: 1 }).map((sensor) => (missing && sensor.id === 'kitchen_temperature'
        ? { ...sensor, points: sensor.points.filter((point) => starts.some((start) => (
          point.t >= at(0, start) && point.t < at(0, start + 1.5)
        ))) }
        : sensor));
      const history = [
        state(START, 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        ...starts.flatMap((start) => [
          state(at(0, start), 'cooling', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
          state(at(0, start + length), 'idle', { hvacMode: 'cool', setpoint: 24, presetMode: null }),
        ]),
      ];
      const schedule: ComfortSample[] = [{ t: START, setting: 'sleep' }];
      starts.forEach((start) => {
        if (short) {
          for (let quarter = 0; quarter < 8; quarter += 1) {
            schedule.push({ t: at(0, start + quarter / 4), setting: isHome(start + quarter / 4) ? 'home' : 'sleep' });
          }
        } else {
          schedule.push(
            { t: at(0, start), setting: 'home' }, { t: at(0, start + 1.5), setting: 'sleep' },
            { t: at(0, start + 3), setting: 'home' }, { t: at(0, start + 4.5), setting: 'sleep' },
          );
        }
      });
      const all = sensors.map((sensor) => sensor.id);
      const end = new Date(START + DAY);
      return analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac: history, comfort: schedule,
        participation: { ...config(all), sleep: all }, end, windowDays: 1, cooling: { start: new Date(START), end },
      }));
    };

    it('review 22241a2: selects each cooling cohort over all parts of one run and setting', () => {
      const sparse = fragmentedCooling(false, true);
      expect(sparse.coverage.coolingEvents).toBe(3);
      expect(sparse.recommendations.filter((rec) => rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature'))
        .toEqual([]);
      expect(sparse.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.verdict).toBe('insufficient');

      const complete = fragmentedCooling(false, false);
      const tip = complete.recommendations.find((rec) => rec.sensorId === 'kitchen_temperature' && rec.comfortSetting === 'home')!;
      expect(tip.detail).toContain('3 of 3 cooling runs in Home');
    });

    it('review 22241a2: combines individually short cooling parts before the per-run sample minimum', () => {
      const result = fragmentedCooling(true, false);
      expect(result.coverage.coolingEvents).toBe(3);
      const tip = result.recommendations.find((rec) => rec.sensorId === 'kitchen_temperature' && rec.comfortSetting === 'home')!;
      expect(tip.detail).toContain('3 of 3 cooling runs in Home');
    });

    it('review 22241a2: keeps other-setting readings out when combining short cooling parts', () => {
      const result = fragmentedCooling(true, false, true);
      expect(result.recommendations.some((rec) => (
        rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature' && rec.comfortSetting === 'home'
      ))).toBe(false);
      expect(result.recommendations.some((rec) => (
        rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature' && rec.comfortSetting === 'sleep'
      ))).toBe(true);
    });

    it.each(['idle', 'gap'] as const)(
      'review 22241a2: keeps %s buckets out of grouped cooling fragments',
      (interruption) => {
        const starts = [1, 8, 15];
        const history = [
          state(START, 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
          ...starts.flatMap((start) => [
            state(at(0, start), 'cooling', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
            interruption === 'gap'
              ? gap(at(0, start + 0.5))
              : state(at(0, start + 0.5), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
            state(at(0, start + 0.75), 'cooling', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
            state(at(0, start + 3), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 24 }),
          ]),
        ];
        const schedule: ComfortSample[] = [{ t: START, setting: 'sleep' }];
        starts.forEach((start) => {
          for (let quarter = 0; quarter < 12; quarter += 1) {
            schedule.push({ t: at(0, start + quarter / 4), setting: quarter % 2 === 0 ? 'home' : 'sleep' });
          }
        });
        const run = (spikeAtStart: boolean) => {
          const sensors = rooms({
            kitchen_temperature: (t) => {
              const hour = ((t - START) % DAY) / HOUR;
              return starts.some((start) => hour === start + (spikeAtStart ? 0 : 0.5)) ? 9 : 0;
            },
            living_temperature: 0, bedroom_temperature: 0,
          }, () => 24, { days: 1 });
          const all = sensors.map((sensor) => sensor.id);
          const end = new Date(START + DAY);
          return analyzePlacement(input({
            sensors, primaryThermostatId: null, hvac: history, comfort: schedule,
            participation: { ...config(all), sleep: all }, end, windowDays: 1, cooling: { start: new Date(START), end },
          }));
        };
        expect(run(false).recommendations.some((rec) => (
          rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature'
        ))).toBe(false);
        if (interruption === 'idle') {
          const tip = run(true).recommendations.find((rec) => (
            rec.mode === 'cooling' && rec.sensorId === 'kitchen_temperature' && rec.comfortSetting === 'home'
          ))!;
          expect(tip.detail).toContain('3 of 3 cooling runs in Home');
        }
      },
    );

    it('review 22241a2: discloses Sleep-only heating when Home cooling is representative', () => {
      const sensors = rooms({ bedroom_temperature: 0, living_temperature: 0, kitchen_temperature: 0 }, () => 22, { days: 3 });
      const history = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null }),
        state(at(d, 3), 'heating', { presetMode: null }),
        state(at(d, 5.75), 'idle', { presetMode: null }),
        state(at(d, 6), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
        state(at(d, 12), 'cooling', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
        state(at(d, 15), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
      ]).flat();
      const end = new Date(START + 3 * DAY);
      const run = (hvac: HvacSample[], comfort: ComfortSample[] | null = comfortSchedule(3)) => analyzePlacement(input({
        sensors, primaryThermostatId: null, hvac, comfort,
        participation: { ...config(sensors.map((sensor) => sensor.id)), sleep: sensors.map((sensor) => sensor.id) },
        end, windowDays: 3, cooling: { start: new Date(START), end },
      }));
      const result = run(history);
      expect(result.coverage).toMatchObject({ wakeEvents: 3, coolingEvents: 3 });
      expect(result.sensors.every((sensor) => sensor.verdict === 'representative')).toBe(true);
      const summary = result.recommendations.find((rec) => rec.id === 'no-changes')!;
      expect(summary).toBeDefined();
      expect(summary.detail).toMatch(/heating placement.*not assessed/i);

      const both = history.flatMap((sample) => (
        ((sample.t - START) % DAY) / HOUR === 6
          ? [
            state(sample.t, 'heating', { presetMode: null, setpoint: 22 }),
            state(sample.t + 2 * HOUR, 'idle', { presetMode: null, setpoint: 22 }),
          ] : [sample]
      ));
      const assessedHome = run(both);
      expect(assessedHome.sensors.every((sensor) => sensor.verdict === 'representative')).toBe(true);
      const scoped = assessedHome.recommendations.find((rec) => rec.id === 'no-changes')!;
      expect(scoped.detail).toMatch(/heating placement.*not assessed/i);
      expect(scoped.detail).not.toContain('lacked enough comparable data');

      // When the Sleep heat-up is far enough before Home, its post-stop
      // overshoot is measurable; this previously produced the unqualified
      // "No placement issues found" title despite never assessing Sleep heat.
      const lateHome = Array.from({ length: 3 }, (_, d) => [
        { t: at(d, 0), setting: 'sleep' }, { t: at(d, 9), setting: 'home' },
        { t: at(d, 22), setting: 'sleep' },
      ]).flat();
      const earlyHeat = Array.from({ length: 3 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 22 }),
        state(at(d, 4), 'heating', { presetMode: null, setpoint: 22 }),
        state(at(d, 5), 'idle', { presetMode: null, setpoint: 22 }),
        state(at(d, 9), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
        state(at(d, 12), 'cooling', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
        state(at(d, 15), 'idle', { presetMode: null, hvacMode: 'cool', setpoint: 22 }),
      ]).flat();
      const observed = run(earlyHeat, lateHome);
      expect(observed.sensors.map((sensor) => sensor.overshoot)).toEqual([0, 0, 0]);
      expect(observed.recommendations.find((rec) => rec.id === 'no-changes')).toMatchObject({
        title: 'No placement issues found in the available data',
        detail: expect.stringMatching(/heating placement.*not assessed/i),
      });

      // With no heat observed, representative cooling doesn't imply missing
      // heating evidence. Unknown-setting heating remains a valid neutral scope.
      const coolOnly = run(history.map((sample) => (
        sample.hvacMode === 'heat' ? { ...sample, hvacMode: 'cool', hvacAction: 'idle', setpoint: 24 } : sample
      )));
      expect(coolOnly.recommendations.find((rec) => rec.id === 'no-changes')!.detail)
        .not.toMatch(/heating placement.*not assessed/i);
      const unknown = run(activeHistory('heating', 3), null);
      expect(unknown.sensors.every((sensor) => sensor.verdict === 'representative')).toBe(true);
      expect(unknown.recommendations.find((rec) => rec.id === 'no-changes')!.detail)
        .not.toMatch(/heating placement.*not assessed/i);
    });

    const wakePairing = (heatedDays: number[], peakDays: number[], referenceDays: number[], peak = 2) => {
      const days = 5;
      const value = (t: number) => {
        const d = Math.floor((t - START) / DAY);
        const hour = ((t - START) % DAY) / HOUR;
        return 21 + (peakDays.includes(d) && (!heatedDays.includes(d) || hour >= 7) ? peak : 0);
      };
      const sensors = rooms({
        home_current_temperature: 0, bedroom_temperature: -2, living_temperature: 0, kitchen_temperature: 0,
      }, value, { days }).map((sensor) => (sensor.isThermostat
        ? { ...sensor, points: sensor.points.filter((point) => referenceDays.includes(Math.floor((point.t - START) / DAY))) }
        : sensor));
      const history = Array.from({ length: days }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 21 }),
        ...(heatedDays.includes(d) ? [
          state(at(d, 6), 'heating', { presetMode: null, setpoint: 21 }),
          state(at(d, 7), 'idle', { presetMode: null, setpoint: 21 }),
        ] : []),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 21 }),
      ]).flat();
      return analyzePlacement(wakeInput({
        sensors, hvac: history, comfort: comfortSchedule(days),
        // Missing references cannot be reconstructed from rooms.
        participation: { ...config(['bedroom_temperature', 'living_temperature', 'kitchen_temperature']), thermostat: { home: true } },
      }));
    };

    it('review d29c8d1: pairs wake advice with the heated wakes, not unrelated idle wake overshoots', () => {
      const idlePeaks = wakePairing([0, 1], [2, 3, 4], [0, 1, 2, 3, 4]);
      expect(idlePeaks.coverage.wakeEvents).toBe(5);
      expect(idlePeaks.sensors.find((sensor) => sensor.id === 'living_temperature')!.wakeOvershoot).toBe(1.2);
      expect(idlePeaks.recommendations.some((rec) => rec.id === 'wake-bedroom')).toBe(false);

      const pairedPeak = wakePairing([0, 1], [0, 2, 3, 4], [0, 1, 2, 3, 4]);
      const tip = pairedPeak.recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(tip).toBeDefined();
      expect(tip.detail).toContain('peaked 1.0 and 1.0 °C over the Home set point');
      expect(pairedPeak.sensors.find((sensor) => sensor.id === 'living_temperature')!.wakeOvershoot).toBe(1.6);
    });

    it('review d29c8d1: excludes heated wakes without a qualifying reference from wake overshoot advice', () => {
      const missingReference = wakePairing([0, 1, 2], [2], [0, 1], 4);
      expect(missingReference.sensors.find((sensor) => sensor.id === 'living_temperature')!.wakeOvershoot).toBe(0.8);
      expect(missingReference.recommendations.some((rec) => rec.id === 'wake-bedroom')).toBe(false);

      const complete = wakePairing([0, 1, 2], [2], [0, 1, 2, 3, 4], 4);
      const tip = complete.recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      expect(tip).toBeDefined();
      expect(tip.detail).toContain('peaked 1.3 and 1.3 °C over the Home set point');
    });

    it.each(['heating', 'cooling'] as const)(
      'review d29c8d1: describes the signed passive %s mean independently of the threshold share',
      (mode) => {
        const direction = mode === 'heating' ? 1 : -1;
        const target = 22;
        const end = new Date(START + 2 * DAY);
        const run = (secondHalf: number) => {
          const sensors = rooms({ bedroom_temperature: 0, living_temperature: 0 }, (t) => (
            target + direction * (t < START + DAY ? 1 : secondHalf)
          ), { days: 2 });
          return analyzePlacement(input({
            sensors, primaryThermostatId: null, reportedTemperature: { points: sensors[0].points },
            hvac: [state(START, 'idle', { hvacMode: mode === 'heating' ? 'heat' : 'cool', setpoint: target })],
            comfort: home, participation: config(sensors.map((sensor) => sensor.id)),
            end, windowDays: 2, cooling: mode === 'cooling' ? { start: new Date(START), end } : undefined,
          })).recommendations.find((rec) => rec.id === (mode === 'heating' ? 'passive-warmth-heating' : 'passive-cooling'))!;
        };
        const point = mode === 'heating' ? 'the set point' : 'the cool set point';
        const preferred = mode === 'heating' ? 'above' : 'below';
        const opposite = mode === 'heating' ? 'below' : 'above';
        const negative = run(-3);
        expect(negative.detail).toContain(`sat 1.0 °C ${opposite} ${point} on average`);
        expect(negative.detail).toContain(`at least 1.0 °C ${preferred} it 50% of the observed idle samples`);
        expect(run(-1).detail).toContain(`sat at ${point} on average`);
        expect(run(0).detail).toContain(`sat 0.5 °C ${preferred} ${point} on average`);
      },
    );

    it.each([
      ['heating', 'cold'], ['heating', 'warm'], ['cooling', 'cold'], ['cooling', 'warm'],
    ] as const)(
      'review d29c8d1: does not describe an opposite-sign %s event mean in the %s direction',
      (mode, classification) => {
        const from = mode === 'heating' ? 6 : 12;
        const sign = classification === 'cold' ? -1 : 1;
        const sensorSeries = (mixed: boolean) => rooms({
          bedroom_temperature: (t) => {
            const d = Math.floor((t - START) / DAY);
            const hour = ((t - START) % DAY) / HOUR;
            return mixed && d === 2 && hour >= from && hour < from + 1 ? -4.5 * sign : 1.5 * sign;
          },
          living_temperature: 0,
          kitchen_temperature: 0,
        }, () => 20, { days: 3 });
        const history = Array.from({ length: 3 }, (_, d) => {
          const options = { hvacMode: mode === 'heating' ? 'heat' : 'cool', setpoint: 20, presetMode: null };
          return [
            state(at(d, 0), 'idle', options),
            state(at(d, from), mode, options),
            state(at(d, from + (d === 2 ? 1 : 3)), 'idle', options),
          ];
        }).flat();
        const end = new Date(START + 3 * DAY);
        const run = (mixed: boolean) => {
          const sensors = sensorSeries(mixed);
          return analyzePlacement(input({
            sensors, primaryThermostatId: null, hvac: history, comfort: home,
            participation: config(sensors.map((sensor) => sensor.id)), end, windowDays: 3,
            cooling: mode === 'cooling' ? { start: new Date(START), end } : undefined,
          }));
        };
        const result = run(true);
        const bedroom = result.sensors.find((sensor) => sensor.id === 'bedroom_temperature')!;
        expect(bedroom.verdict).toBe(`${classification}_outlier`);
        expect(bedroom.verdictSummary).toContain(`2 of 3 ${mode === 'heating' ? 'heat-ups' : 'cooling runs'}`);
        const direction = classification === 'cold' ? 'below' : 'above';
        expect(bedroom.verdictSummary).not.toContain(`0.3 °C ${direction}`);
        const tip = result.recommendations.find((rec) => rec.sensorId === bedroom.id && rec.mode === mode)!;
        expect(tip.detail).toContain('2 of 3');
        expect(tip.detail).not.toContain(`0.3 °C ${direction}`);
        const consistent = run(false).sensors.find((sensor) => sensor.id === 'bedroom_temperature')!;
        expect(consistent.verdictSummary).toContain(`1.0 °C ${direction} the house average`);
      },
    );

    it.each(['heating', 'cooling'] as const)(
      'keeps %s advice setting-neutral when comfort and preset history are unknown',
      (mode) => {
        const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22, { days: 3 });
        const end = new Date(START + 3 * DAY);
        const participation = {
          home: ['living_temperature', 'bedroom_temperature'],
          sleep: ['kitchen_temperature', 'living_temperature', 'bedroom_temperature'],
          away: null,
          followMe: false,
          thermostat: THERMOSTAT_EXCLUDED,
        };
        const run = (comfort: ComfortSample[] | null) => analyzePlacement(input({
          sensors,
          primaryThermostatId: null,
          hvac: activeHistory(mode, 3),
          comfort,
          participation,
          end,
          windowDays: 3,
          cooling: mode === 'cooling' ? { start: new Date(START), end } : undefined,
        }));
        const result = run(null);
        const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
        expect(kitchen.participation).toMatchObject({ home: false, sleep: true });
        const tip = result.recommendations.find((rec) => rec.mode === mode && rec.sensorId === kitchen.id)!;
        expect(tip).toMatchObject({
          id: mode === 'heating' ? 'move-kitchen' : 'cooling-kitchen', action: 'move', severity: 'low', comfortSetting: null,
        });
        expect(tip.detail).toContain('If it participates in the comfort setting active at that time');
        expect(tip.detail).not.toMatch(/\bHome\b|\bSleep\b/);
        expect(kitchen.verdictSummary).toContain('if');
        expect(result.recommendations.some((rec) => rec.action === 'include_in_comfort')).toBe(false);

        // Known Home still supports the configured exclusion, and known Sleep
        // still supports cooling guidance for its participating sensor.
        expect(run(home).recommendations.some((rec) => rec.id === (mode === 'heating' ? 'add-kitchen' : 'add-cooling-kitchen')))
          .toBe(true);
        if (mode === 'cooling') {
          expect(run([{ t: START, setting: 'sleep' }]).recommendations.find((rec) => rec.id === 'cooling-kitchen'))
            .toMatchObject({ comfortSetting: 'sleep', action: 'move' });
        }
      },
    );

    it.each([true, null])('keeps unknown-setting Follow Me advice conditional when followMe is %s', (followMe) => {
      (['heating', 'cooling'] as const).forEach((mode) => {
        const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22, { days: 3 });
        const end = new Date(START + 3 * DAY);
        const result = analyzePlacement(input({
          sensors,
          hvac: activeHistory(mode, 3),
          comfort: null,
          participation: { ...config(['living_temperature', 'bedroom_temperature'], followMe), sleep: sensors.map((s) => s.id) },
          end,
          windowDays: 3,
          cooling: mode === 'cooling' ? { start: new Date(START), end } : undefined,
        }));
        const tip = result.recommendations.find((rec) => rec.mode === mode && rec.sensorId === 'kitchen_temperature')!;
        expect(tip).toMatchObject({ comfortSetting: null, severity: 'low', action: 'move' });
        expect(tip.detail).toContain('If it participates in the comfort setting active at that time and counted toward the average');
        expect(tip.detail).toContain(followMe === true ? 'with Follow Me on' : 'Follow Me wasn\'t specified');
        expect(tip.detail).not.toMatch(/\bHome\b|\bSleep\b|% of comparable samples/);
        expect(result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!.verdictSummary)
          .toContain('and counted toward the average');
      });
    });

    it('does not turn a setting-unknown overshoot into Home inclusion advice', () => {
      const sensors = rooms({ kitchen_temperature: 0, living_temperature: 0, bedroom_temperature: 0 }, () => 25, { days: 3 });
      const run = (comfort: ComfortSample[] | null) => analyzePlacement(input({
        sensors,
        hvac: activeHistory('heating', 3),
        comfort,
        participation: config(['living_temperature', 'bedroom_temperature']),
        end: new Date(START + 3 * DAY),
        windowDays: 3,
      }));
      expect(run(null).recommendations.some((rec) => rec.action === 'include_in_comfort')).toBe(false);
      expect(run(home).recommendations.find((rec) => rec.id === 'add-kitchen'))
        .toMatchObject({ action: 'include_in_comfort', comfortSetting: 'home' });
    });

    it('keeps unknown cooling runs separate from known-setting runs', () => {
      const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22, { days: 6 });
      const end = new Date(START + 6 * DAY);
      const result = analyzePlacement(input({
        sensors,
        hvac: activeHistory('cooling', 6),
        comfort: [{ t: START, setting: 'home' }, { t: at(3, 0), setting: null }],
        participation: config(sensors.map((sensor) => sensor.id)),
        end,
        windowDays: 6,
        cooling: { start: new Date(START), end },
      }));
      const tips = result.recommendations.filter((rec) => rec.sensorId === 'kitchen_temperature' && rec.mode === 'cooling');
      expect(tips.map((tip) => [tip.id, tip.comfortSetting])).toEqual([
        ['cooling-kitchen-home', 'home'], ['cooling-kitchen-unknown', null],
      ]);
      expect(tips[1].detail).toContain('comfort setting unknown');
      expect(tips[1].detail).toContain('If it participates in the comfort setting active at that time');
    });

    it('labels partial and sparse heating dates as sampled calendar dates', () => {
      const start = START + 12 * HOUR;
      const end = start + 14 * DAY;
      const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22, { days: 15 });
      const result = analyzePlacement(input({
        start: new Date(start),
        end: new Date(end),
        windowDays: 14,
        sensors,
        hvac: [state(START - HOUR, 'idle')],
        comfort: home,
        participation: config(sensors.map((sensor) => sensor.id)),
      }));
      const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
      expect(kitchen.consistency).toMatchObject({ days: 15, warmDays: 15 });
      const tip = result.recommendations.find((rec) => rec.sensorId === kitchen.id && rec.mode === 'heating')!;
      expect(tip.detail).toContain('15 of 15 sampled calendar dates (available samples, not full days or continuous coverage)');
      expect(kitchen.verdictSummary).toContain('15 of 15 sampled calendar dates (available samples, not full days or continuous coverage)');
    });

    it('does not imply continuous heating evidence from scattered samples', () => {
      const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22)
        .map((sensor) => ({
          ...sensor, points: sensor.points.filter((point) => (point.t - START) % (3 * HOUR) === 0),
        }));
      const result = analyzePlacement(input({
        sensors, hvac: [state(START - HOUR, 'idle')], comfort: home,
        participation: config(sensors.map((sensor) => sensor.id)),
      }));
      const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
      expect(kitchen.consistency).toMatchObject({ days: 5, warmDays: 5 });
      expect(result.recommendations.find((rec) => rec.sensorId === kitchen.id && rec.mode === 'heating')!.detail)
        .toContain('5 of 5 sampled calendar dates (available samples, not full days or continuous coverage)');
      expect(kitchen.verdictSummary).toContain('not full days or continuous coverage');
    });

    it('labels sparse cooling dates as sampled calendar dates', () => {
      const sensors = rooms({ kitchen_temperature: 3, living_temperature: 0, bedroom_temperature: 0 }, () => 22);
      const history = activeHistory('cooling', 5).map((sample) => (
        sample.hvacAction === 'idle' && sample.t % DAY === at(0, 15) % DAY
          ? { ...sample, t: sample.t - 2.5 * HOUR } : sample
      ));
      const end = new Date(START + 5 * DAY);
      const result = analyzePlacement(input({
        sensors, hvac: history, comfort: home, participation: config(sensors.map((sensor) => sensor.id)),
        end, cooling: { start: new Date(START), end },
      }));
      const kitchen = result.sensors.find((sensor) => sensor.id === 'kitchen_temperature')!;
      expect(kitchen.consistency).toMatchObject({ coolingDays: 5, coolingWarmDays: 5 });
      const tip = result.recommendations.find((rec) => rec.sensorId === kitchen.id && rec.mode === 'cooling')!;
      expect(tip.detail).toContain('5 of 5 sampled calendar dates with cooling (available samples, not full days or continuous coverage)');
      expect(kitchen.verdictSummary)
        .toContain('5 of 5 sampled calendar dates with cooling (available samples, not full days or continuous coverage)');
    });

    it.each([
      ['a late first observation', [state(at(4, 23), 'idle')]],
      ['a history gap', [state(START, 'idle'), gap(at(1, 0)), state(at(1, 1), 'idle')]],
      ['an unknown action', [state(START, 'idle'), state(at(1, 0), null), state(at(1, 1), 'idle')]],
      ['an unsupported action', [state(START, 'idle'), state(at(1, 0), 'vendor_wait'), state(at(1, 1), 'idle')]],
    ])('does not infer rare heating or suppress useful advice from %s', (_description, history) => {
      const result = analyzePlacement(input({
        sensors: rooms(flat, () => 20),
        hvac: history,
        comfort: home,
        participation: excludedBedroom,
      }));
      expect(result.recommendations.find((r) => r.id === 'add-bedroom')).toBeDefined();
      const details = result.recommendations.map((r) => r.detail).join(' ');
      expect(details).not.toMatch(/heating.{0,30}0\.0 h/i);
      expect(details).not.toMatch(/heating.{0,30}rare/i);
      expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).not.toMatch(/heating.{0,30}rare/i);
    });

    it.each([gap(START), state(START, null), state(START, 'vendor_wait')])(
      'review 22241a2: does not use unknown HVAC states as heating placement evidence',
      (unknown) => {
        const result = analyzePlacement(input({
          sensors: rooms(flat, () => 20),
          hvac: [unknown],
          comfort: home,
          participation: excludedBedroom,
        }));
        expect(result.recommendations.some((rec) => rec.mode === 'heating')).toBe(false);
        expect(result.sensors.find((sensor) => sensor.id === 'bedroom_temperature')!.consistency!.days).toBe(0);
      },
    );

    it('can still describe rare heating when the whole window has observed actions', () => {
      const result = analyzePlacement(input({
        sensors: rooms(flat, () => 20),
        hvac: [state(START, 'idle')],
        comfort: home,
        participation: config(Object.keys(flat)),
      }));
      expect(result.recommendations.find((r) => r.id === 'move-bedroom')!.detail)
        .toContain('0.0 h over 5 days');
    });

    it('does not report zero wake minutes when the wake-up lead contains a history gap', () => {
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
        gap(at(d, 4)),
        state(at(d, 6), 'idle', { presetMode: null, setpoint: 20 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
      ]).flat();
      const result = analyzePlacement(passiveInput({ hvac: history }));
      const passive = result.recommendations.find((r) => r.id === 'passive-warmth-heating')!;
      expect(passive).toBeDefined();
      expect(passive.detail).not.toMatch(/heating running 0 minutes?/);
      expect(passive.detail).not.toMatch(/heating.{0,30}0\.0 h/i);
    });

    it('does not report zero wake minutes across an unsupported action', () => {
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
        state(at(d, 4), 'vendor_wait', { presetMode: null, setpoint: 18 }),
        state(at(d, 6), 'idle', { presetMode: null, setpoint: 20 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
      ]).flat();
      const passive = analyzePlacement(passiveInput({ hvac: history }))
        .recommendations.find((r) => r.id === 'passive-warmth-heating')!;
      expect(passive.detail).not.toMatch(/heating running 0 minutes?/);
      expect(passive.detail).not.toMatch(/heating.{0,30}0\.0 h/i);
    });

    it('does not average an incomplete wake together with observed wake durations', () => {
      const history = wakeHvac(5).flatMap((sample) => (
        sample.t === at(2, 4.5) ? [gap(at(2, 3)), sample] : [sample]
      ));
      const result = analyzePlacement(wakeInput({ hvac: history }));
      const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
      expect(wake).toBeDefined();
      expect(wake.detail).not.toMatch(/warm-up ran \d+ minutes? on average/);
    });

    it('uses singular wake-minute wording for an observed one-minute warm-up', () => {
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle', { presetMode: null, setpoint: 18 }),
        state(at(d, 6), 'heating', { presetMode: null, setpoint: 20 }),
        state(at(d, 6) + 60_000, 'idle', { presetMode: null, setpoint: 20 }),
        state(at(d, 22), 'idle', { presetMode: null, setpoint: 18 }),
      ]).flat();
      const passive = analyzePlacement(passiveInput({ hvac: history }))
        .recommendations.find((r) => r.id === 'passive-warmth-heating')!;
      expect(passive.detail).toContain('heating running 1 minute on average');
      expect(passive.detail).not.toContain('1 minutes');
    });

    it('uses Home source windows for every room in a daily reference', () => {
      const schedule = Array.from({ length: 5 }, (_, d) => [
        { t: at(d, 0), setting: 'sleep' },
        { t: at(d, 6), setting: 'home' },
        { t: at(d, 8), setting: 'sleep' },
      ]).flat();
      // Report a morning run so the isolated Sleep spike doesn't independently
      // create an inferred warm-up. Heating remains possible during the spike,
      // so this specifically tests the setting of every reference room.
      const history = [
        state(START - HOUR, 'idle'),
        ...Array.from({ length: 5 }, (_, d) => [
          state(at(d, 0), 'idle'),
          state(at(d, 4), 'heating'),
          state(at(d, 4.25), 'idle'),
          state(at(d, 6), 'idle'),
          state(at(d, 8), 'idle'),
        ]).flat(),
      ];
      const run = (outlier: boolean) => {
        const sensors = rooms({
          bedroom_temperature: (t) => (((t - START) % DAY === 5.75 * HOUR && outlier) ? 30 : 0),
          living_temperature: 0,
          kitchen_temperature: 0,
        }, () => 20).map((s) => (s.id === 'bedroom_temperature'
          ? { ...s, points: s.points.filter((p) => (p.t - START) % DAY !== 6 * HOUR) }
          : s));
        return analyzePlacement(input({
          sensors, hvac: history, comfort: schedule, participation: config(Object.keys(flat)),
        }));
      };
      const baseline = run(false);
      const sleepOutlier = run(true);
      expect(baseline.sensors.find((s) => s.id === 'living_temperature')!.consistency?.days).toBe(5);
      sleepOutlier.sensors.forEach((sensor, i) => {
        expect(sensor.consistency).toEqual(baseline.sensors[i].consistency);
        expect(sensor.verdict).toBe(baseline.sensors[i].verdict);
        expect(sensor.consistency?.warmDays).toBe(0);
        expect(sensor.consistency?.coldDays).toBe(0);
      });
    });

    it('uses heating possibility during each source bucket rather than its later grid state', () => {
      const schedule = Array.from({ length: 5 }, (_, d) => [
        { t: at(d, 0), setting: 'sleep' },
        { t: at(d, 5), setting: 'home' },
        { t: at(d, 8), setting: 'sleep' },
      ]).flat();
      const history = Array.from({ length: 5 }, (_, d) => [
        state(at(d, 0), 'idle'),
        state(at(d, 5), 'off', { hvacMode: 'off' }),
        state(at(d, 6), 'idle'),
        state(at(d, 8), 'off', { hvacMode: 'off' }),
      ]).flat();
      const run = (outlier: boolean) => analyzePlacement(input({
        sensors: rooms({
          bedroom_temperature: (t) => (((t - START) % DAY === 5.75 * HOUR && outlier) ? 30 : 0),
          living_temperature: 0,
          kitchen_temperature: 0,
        }, () => 20),
        hvac: history,
        comfort: schedule,
        participation: config(Object.keys(flat)),
      }));
      const baseline = run(false);
      const afterOff = run(true);
      expect(baseline.sensors.find((s) => s.id === 'bedroom_temperature')!.consistency?.days).toBe(5);
      afterOff.sensors.forEach((sensor, i) => {
        expect(sensor.consistency).toEqual(baseline.sensors[i].consistency);
        expect(sensor.verdict).toBe(baseline.sensors[i].verdict);
      });
    });

    it('does not use a Sleep source bucket in Home heat-up references', () => {
      const run = (outlier: boolean) => {
        const sensors = rooms({
          bedroom_temperature: (t) => {
            const hour = ((t - START) % DAY) / HOUR;
            if (hour === 5.75 && outlier) return 30;
            return hour >= 6 && hour < 22 ? 2 : 0;
          },
          living_temperature: 0,
          kitchen_temperature: 0,
          office_temperature: 0,
        }, wakeBase);
        return analyzePlacement(wakeInput({
          sensors,
          participation: { ...config(sensors.map((s) => s.id)), sleep: ['living_temperature', 'kitchen_temperature', 'office_temperature'] },
        })).recommendations.find((r) => r.id === 'move-bedroom')!;
      };
      const baseline = run(false);
      expect(baseline).toBeDefined();
      expect(run(true).detail).toBe(baseline.detail);
    });

    it('keeps a conditional tip when the Follow Me model estimates zero contribution', () => {
      const members = ['bedroom_temperature', 'living_temperature'];
      const result = analyzePlacement(wakeInput({
        sensors: rooms({ ...WAKE_BIASES, home_current_temperature: 0 }, wakeBase).map((s) => ({
          ...s, occupancy: occupied(s.id !== 'bedroom_temperature'),
        })),
        participation: { ...config(members, true), sleep: members },
      }));
      const rec = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
      expect(rec).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
      expect(rec.detail).toContain('occupancy-based model');
      expect(rec.detail).toContain('0%');
      expect(rec.detail).toContain('timing and weighting');
      const summary = result.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
      expect(summary).not.toContain('never counted');
      expect(summary).toContain('may');
    });

    it('describes heating, cooling, kitchen and passive causes as hypotheses', () => {
      const wake = analyzePlacement(wakeInput({
        participation: { ...config(Object.keys(WAKE_BIASES)), sleep: Object.keys(WAKE_BIASES) },
      })).recommendations.find((r) => r.id === 'wake-bedroom')!;
      expect(wake.title).toContain('may be');
      expect(wake.detail).toContain('could contribute');
      expect(wake.detail).not.toContain('keeps heating until it warms up');
      expect(wake.detail).not.toContain('turning Smart Recovery off would shorten');

      const heating = analyzePlacement(input({ participation: config(Object.keys(BIASES).filter((id) => id !== 'home_current_temperature')) }));
      const kitchen = heating.recommendations.find((r) => r.id === 'remove-kitchen')!;
      expect(kitchen.title).toContain('may be');
      expect(kitchen.detail).toContain('could');
      expect(kitchen.detail).not.toContain('will keep warming');

      const cooling = analyzePlacement(wakeInput({
        sensors: rooms(flat, () => 20),
        participation: config(Object.keys(flat)),
        cooling: coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 }),
      })).recommendations.find((r) => r.id === 'cooling-kitchen')!;
      expect(cooling.title).toContain('may be');
      expect(cooling.detail).toContain('could');
      expect(cooling.detail).not.toContain('the AC keeps running to cool it');

      const passive = analyzePlacement(passiveInput()).recommendations.find((r) => r.id === 'passive-warmth-heating')!;
      expect(passive.detail).not.toContain('Sensor placement isn\'t causing');
      expect(passive.detail).toContain('does not establish');

      const passiveCooling = analyzePlacement(wakeInput({
        participation: config(Object.keys(flat)),
        cooling: {
          ...coolingInput(flat),
          sensors: rooms({ ...flat, home_current_temperature: 0 }, () => 22, { from: SUMMER }),
        },
      })).recommendations.find((r) => r.id === 'passive-cooling')!;
      expect(passiveCooling).toBeDefined();
      expect(passiveCooling.detail).toContain('does not establish the cause');
      expect(passiveCooling.detail).toContain('sensor placement may still affect');
    });

    it('labels passive notes as approximations when no reported reference is identified', () => {
      const history = passiveHvac(5).flatMap((sample) => (
        sample.t === at(2, 6) ? [gap(at(2, 4)), sample] : [sample]
      ));
      const result = analyzePlacement(passiveInput({
        sensors: rooms({
          kitchen_temperature: 1, bedroom_temperature: -0.45, living_temperature: -0.45,
        }, (t) => 23 + 0.5 * Math.sin((2 * Math.PI * (t - START)) / DAY)),
        primaryThermostatId: null,
        hvac: history,
        participation: config(['kitchen_temperature', 'bedroom_temperature', 'living_temperature']),
      }));
      const passive = result.recommendations.find((r) => r.id === 'passive-warmth-heating')!;
      expect(passive.detail).toContain('the approximated comfort reading');
      const kitchen = result.recommendations.find((r) => r.sensorId === 'kitchen_temperature')!;
      expect(kitchen.detail).toContain('The approximated comfort reading was often above the set point in observed idle samples');
      expect(result.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary)
        .toContain('the approximated comfort reading was often above the set point in observed idle samples');
    });

    it('uses the cooling dataset to describe the passive cooling reference', () => {
      const flat = { bedroom_temperature: 0, living_temperature: 0 };
      const coolSensors = rooms(flat, () => 22, { from: SUMMER });
      const cooling = {
        ...coolingInput({}),
        sensors: coolSensors,
        hvac: [{
          ...state(SUMMER, 'idle', { hvacMode: 'cool', setpoint: 24 }), coolSetpoint: 24,
        }],
      };
      const withReportedCooling = analyzePlacement(wakeInput({
        sensors: rooms(flat, () => 20),
        primaryThermostatId: null,
        participation: config(Object.keys(flat)),
        cooling: { ...cooling, reportedTemperature: { points: coolSensors[0].points } },
      })).recommendations.find((rec) => rec.id === 'passive-cooling')!;
      expect(withReportedCooling.detail).toContain('the reported or approximated comfort reading');

      const withApproximateCooling = analyzePlacement(wakeInput({
        sensors: rooms({ ...flat, home_current_temperature: 0 }, () => 20),
        participation: config(Object.keys(flat)),
        cooling: { ...cooling, reportedTemperature: null },
      })).recommendations.find((rec) => rec.id === 'passive-cooling')!;
      expect(withApproximateCooling.detail).toContain('the approximated comfort reading');
      expect(withApproximateCooling.detail).not.toContain('the reported or approximated comfort reading');
    });

    it('keeps cooling-only unit assumption notes out of heating recommendations', () => {
      const coolSensors = rooms({ bedroom_temperature: 0, living_temperature: 0 }, () => 22, { from: SUMMER });
      const result = analyzePlacement(wakeInput({
        cooling: {
          ...coolingInput({}),
          sensors: coolSensors,
          hvac: [{ ...state(SUMMER, 'idle', { hvacMode: 'cool', setpoint: 24 }), coolSetpoint: 24 }],
          reportedTemperature: { points: coolSensors[0].points, assumedUnit: true },
          targetUnitAssumed: true,
        },
      }));
      const heat = result.recommendations.find((rec) => rec.id === 'wake-bedroom')!;
      const cooling = result.recommendations.find((rec) => rec.id === 'passive-cooling')!;
      expect(heat.detail).not.toContain('assume Home Assistant\'s last known temperature unit');
      expect(cooling.detail).toContain('Climate-reference temperatures assume Home Assistant\'s last known temperature unit');
      expect(cooling.detail).toContain('Historical thermostat set points assume Home Assistant\'s last known temperature unit');
      expect(result.coverage.unitAssumptions).toEqual({
        reportedTemperature: false, setpoints: false, coolingReportedTemperature: true, coolingSetpoints: true,
      });
    });

    it.each(['a history gap', 'a set point change'])(
      'does not treat a temperature bucket containing %s as an observed passive idle sample',
      (kind) => {
        const bucket = 15 * 60_000;
        const history = [
          state(START, 'idle', { setpoint: 21 }),
          ...Array.from({ length: 5 * 96 }, (_, i) => [
            kind === 'a history gap'
              ? gap(START + i * bucket + 1)
              : state(START + i * bucket + 1, 'idle', { setpoint: 20 }),
            state(START + (i + 1) * bucket - 1, 'idle', { setpoint: 21 }),
          ]).flat(),
        ];
        const sensors = rooms({ home_current_temperature: 0, bedroom_temperature: 0, living_temperature: 0 }, () => 23);
        const run = (hvac: HvacSample[]) => analyzePlacement(input({
          sensors, hvac, comfort: home, participation: config(['bedroom_temperature', 'living_temperature']),
        }));
        expect(run(history).recommendations.some((r) => r.id === 'passive-warmth-heating')).toBe(false);
        expect(run([state(START, 'idle', { setpoint: 21 })]).recommendations
          .some((r) => r.id === 'passive-warmth-heating')).toBe(true);
      },
    );

    it('requires known idle and a stable cool set point across passive cooling source buckets', () => {
      const bucket = 15 * 60_000;
      const idle = (t: number, setpoint: number): HvacSample => ({
        ...state(t, 'idle', { setpoint, hvacMode: 'cool' }), coolSetpoint: setpoint,
      });
      const sensors = rooms({ home_current_temperature: 0, bedroom_temperature: 0, living_temperature: 0 }, () => 21, { from: SUMMER });
      const run = (hvac: HvacSample[]) => analyzePlacement(wakeInput({
        participation: config(['bedroom_temperature', 'living_temperature']),
        cooling: { ...coolingInput({}), sensors, hvac },
      })).recommendations.some((r) => r.id === 'passive-cooling');
      expect(run([idle(SUMMER, 24)])).toBe(true);
      [true, false].forEach((useGap) => {
        const history = [
          idle(SUMMER, 24),
          ...Array.from({ length: 5 * 96 }, (_, i) => [
            useGap ? gap(SUMMER + i * bucket + 1) : idle(SUMMER + i * bucket + 1, 23),
            idle(SUMMER + (i + 1) * bucket - 1, 24),
          ]).flat(),
        ];
        expect(run(history)).toBe(false);
      });
    });

    it('describes configured and estimated exclusions without claiming a room did not steer a wake', () => {
      const configured = analyzePlacement(input({
        sensors: rooms(flat, () => 20),
        hvac: [state(START, 'idle'), gap(at(1, 0)), state(at(1, 1), 'idle')],
        comfort: home,
        participation: excludedBedroom,
      })).sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
      expect(configured).toContain("isn't configured in the Home comfort setting");
      expect(configured).not.toContain("doesn't steer");

      const estimated = analyzePlacement(wakeInput({
        sensors: rooms(EST_BIASES, wakeBase),
        participation: FOLLOW_ME_OFF_THERMOSTAT_EXCLUDED,
      })).sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary!;
      expect(estimated).toContain("readings suggest it may not be in the Home comfort setting");
      expect(estimated).not.toContain("doesn't steer");
    });

    it('qualifies no cooling as a finding in available history, not proof for the year', () => {
      const settings = {
        sensors: series({ living_temperature: 0, bedroom_temperature: 0 }, 5),
      };
      const result = analyzePlacement(input({ ...settings, cooling: null }));
      const noChanges = result.recommendations.find((r) => r.id === 'no-changes')!;
      expect(noChanges.detail).toContain('No cooling was found in the available history');
      expect(noChanges.detail).not.toContain('No cooling was recorded in the past year.');

      const unchecked = analyzePlacement(input({ ...settings, cooling: undefined }))
        .recommendations.find((r) => r.id === 'no-changes')!;
      expect(unchecked).toBeDefined();
      expect(unchecked.detail).not.toContain('No cooling');
    });
  });
});
