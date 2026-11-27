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

// The thermostat's reading is Ecobee's average, not a room, so the rooms'
// mean (office, kitchen, living, bedroom) is the house average: 0. It swings
// hour to hour (as if it also averaged sensors not modelled here), so it fits
// no subset of rooms and which ones it averages stays unknown.
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

function input(overrides: Partial<Parameters<typeof analyzePlacement>[0]> = {}) {
  return {
    participation: FOLLOW_ME_OFF,
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
      'participationConfigured', 'returnEvents', 'returnHistoryAvailable', 'start', 'unknownUnitWindows', 'wakeEvents',
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
      'In 5 of 5 wake-ups (Sleep → Home), Office read 2.4 °C below the comfort average Ecobee heats to. '
      + 'If it\'s in your Home comfort setting, Ecobee keeps heating until it warms up, so Kitchen ended up 1.0 °C over '
      + 'the Home set point on average in the 2 hours after waking. Move it to an interior wall at about chest height, '
      + 'away from windows, doors and vents, or remove it from Home. The Sleep set point averaged 4.0 °C below Home, '
      + 'and the warm-up ran 120 minutes on average (Smart Recovery can start it before Home); a smaller Sleep setback '
      + 'or turning Smart Recovery off would shorten it.',
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
      + 'the house average during heat-ups. If it isn\'t in your Home comfort setting, adding it would help Ecobee stop heating sooner.',
    );
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

  it('treats the thermostat reading as Ecobee\'s average and never flags it as an outlier', () => {
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
    expect(thermostat.verdictSummary).toContain('Ecobee\'s average');
    // The rooms' average excludes it, so both rooms are representative.
    expect(result.sensors.filter((s) => !s.isThermostat).map((s) => s.averageOffset)).toEqual([0, 0]);
    expect(result.recommendations.map((r) => r.id)).toEqual(['no-changes']);
  });

  it('words a cold sensor only from its offset when no room has overshoot evidence', () => {
    // Heating is never reported as stopping, so overshoot is unknown for every
    // room: the text must not claim other rooms are warm or overshoot.
    const neverIdle = hvac(5).map((s) => ({ ...s, hvacAction: 'heating' }));
    const result = analyzePlacement(input({ hvac: neverIdle }));
    expect(result.sensors.every((s) => s.overshoot === null)).toBe(true);
    const office = result.recommendations.find((r) => r.sensorId === 'office_temperature')!;
    expect(office.detail).toContain('If it\'s in your Home comfort setting, Ecobee keeps heating until it warms up');
    expect(result.recommendations.every((r) => !/overshoot|peaked/.test(r.detail))).toBe(true);
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
      comfort: undefined,
    }));
    expect(result.recommendations.some((r) => r.id === 'passive-warmth-heating')).toBe(false);
    // The overshoot still suggests adding rooms to Home.
    expect(result.recommendations.map((r) => r.id).sort()).toEqual(['add-bedroom', 'add-kitchen', 'add-living', 'add-office']);
    // Already in Home: nothing to suggest, but the overshoot isn't denied.
    const inHome = analyzePlacement(input({
      sensors,
      hvac: cycles,
      comfort: undefined,
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
    // idle: sensors aren't the cause, and the text must not say they rose.
    const samples = mornings((d) => [state(at(d, 7), 'idle')]);
    const result = analyzePlacement(input({ sensors: flatRooms(() => 22), hvac: samples }));
    expect(result.sensors.map((s) => s.overshoot)).toEqual([1, 1]);
    const [rec] = result.recommendations;
    expect(rec).toMatchObject({ id: 'passive-warmth-heating', action: 'none', sensorId: null, mode: 'heating' });
    expect(rec.detail).toContain('the rooms sat 2.1 °C above the set point on average, and at least 1.0 °C above it 100% of the time');
    expect(rec.detail).toContain('Sensor placement isn\'t causing this');
    expect(result.recommendations.every((r) => !/\brose\b/.test(r.detail))).toBe(true);
  });

  it('treats history with only unavailable or unknown states as unavailable', () => {
    const result = analyzePlacement(input({ hvac: [gap(at(0, 1)), gap(at(2, 1))] }));
    expect(result.coverage).toMatchObject({
      hvacHistoryAvailable: false, hvacEarliestStateAt: null, returnHistoryAvailable: false,
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
    sensors: rooms(WAKE_BIASES, wakeBase),
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
    ...overrides,
  });
}

const occupied = (value: boolean): OccupancySample[] => [{ t: START - DAY, occupied: value }];

const config = (home: string[] | null, followMe: boolean | null = false) => ({
  home, sleep: null, away: null, followMe,
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
    result.sensors.filter((s) => s.id !== 'bedroom_temperature').forEach((s) => {
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
      'In 5 of 5 wake-ups (Sleep → Home), Bedroom read 1.5 °C below the comfort average Ecobee heats to. '
      + 'If it\'s in your Home comfort setting, Ecobee keeps heating until it warms up, so Living, Kitchen and Office '
      + 'ended up 0.5, 0.5 and 0.5 °C over the Home set point on average in the 2 hours after waking. Move it to an '
      + 'interior wall at about chest height, away from windows, doors and vents, or remove it from Home. The Sleep '
      + 'set point averaged 4.0 °C below Home, and the warm-up ran 150 minutes on average (Smart Recovery can start '
      + 'it before Home); a smaller Sleep setback or turning Smart Recovery off would shorten it.',
    );
  });

  it('states participation plainly when the comfort settings are configured', () => {
    const result = analyzePlacement(wakeInput({ participation: config(['bedroom_temperature', 'living_temperature']) }));
    expect(result.coverage).toMatchObject({ participationConfigured: true, followMe: false });
    // The effective average is the participating sensors' mean (-0.5).
    expect(result.sensors.map((s) => [s.id, s.wakeOffset, s.participation.home])).toEqual([
      ['bedroom_temperature', -1, true],
      ['living_temperature', 1, true],
      ['kitchen_temperature', 1, false],
      ['office_temperature', 1, false],
    ]);
    const [rec] = result.recommendations;
    expect(rec).toMatchObject({ id: 'wake-bedroom', title: 'Bedroom is holding the morning warm-up on' });
    expect(rec.detail).toContain('Because it\'s in your Home comfort setting, Ecobee keeps heating until it warms up');
    expect(rec.detail).not.toContain('If it\'s in');
  });

  it('only counts occupied sensors with Follow Me', () => {
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
    // Only the Living Room counts, so it is the average.
    expect(bedroom).toMatchObject({ occupiedShare: { wake: 0, home: 0 }, wakeOffset: -2 });
    expect(empty.sensors.find((s) => s.id === 'living_temperature')).toMatchObject({
      occupiedShare: { wake: 1, home: 1 }, wakeOffset: 0,
    });
    // An empty bedroom doesn't steer Ecobee, so it isn't blamed.
    expect(empty.recommendations.some((r) => r.sensorId === 'bedroom_temperature')).toBe(false);

    const full = withOccupancy(true);
    expect(full.recommendations[0].id).toBe('wake-bedroom');
    expect(full.recommendations[0].detail).toContain(
      'With Follow Me on, it counted 100% of the time while the warm-ups heated in Home (while occupied, or when no participating room was).',
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

  it('estimates which sensors Ecobee averages from the thermostat reading', () => {
    const result = analyzePlacement(wakeInput({ sensors: rooms(EST_BIASES, wakeBase) }));
    // Bedroom and Living Room are estimated in Home; Kitchen and Office out.
    const recIds = result.recommendations.map((r) => r.id);
    expect(recIds).toContain('wake-bedroom');
    // Offsets are measured against the thermostat's reading.
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.wakeOffset).toBe(-1);
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting. Ecobee keeps heating');
    expect(result.recommendations.some((r) => r.id.startsWith('participation-mismatch'))).toBe(false);
  });

  it('flags a configured comfort setting that the thermostat reading contradicts', () => {
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
      participation: config(['bedroom_temperature', 'kitchen_temperature']),
    }));
    const mismatch = result.recommendations.find((r) => r.id === 'participation-mismatch-home')!;
    expect(mismatch).toMatchObject({ action: 'none', comfortSetting: 'home', sensorId: null });
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
        expect(r.detail).toContain('If it counted, Ecobee');
        expect(r.detail).not.toContain('readings suggest');
      });
      ['bedroom_temperature', 'kitchen_temperature'].forEach((id) => {
        expect(result.sensors.find((x) => x.id === id)!.verdictSummary).toContain('so it may or may not be');
      });
    });
    // Explicitly off: every member counts, so the same rooms are categorical.
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

  it('splits a heating run interrupted by cooling, as cooling runs are', () => {
    // Heating from Home (06:00) to 08:00 with a 10-minute spell at 07:00.
    const ramp = (between: string, mode: string) => analyzePlacement(wakeInput({
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
    expect(ramp('idle', 'heat')).toContain('the warm-up ran 120 minutes on average');
    expect(ramp('cooling', 'heat_cool')).toContain('the warm-up ran 60 minutes on average');
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
    expect(rec.detail).toContain('Because it\'s in your Sleep comfort setting, the AC keeps running');
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
    const result = analyzePlacement(wakeInput({
      sensors: rooms(flat, wakeBase),
      cooling: coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 }),
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
      + 'cooling ran). If it\'s in your Home comfort setting, the AC keeps running to cool it, so the other rooms end up '
      + 'colder than the set point. Living and Bedroom dipped 1.3 and 1.3 °C below the cool set point on average while '
      + 'it ran. Cooking and appliances will keep warming it, so move it away from the stove and appliances, or remove it '
      + 'from Home. Based on cooling from 2026-07-04 to 2026-07-09.',
    );
  });

  it('discloses when no cooling was recorded in the past year', () => {
    const result = analyzePlacement(wakeInput({ cooling: null }));
    expect(result.coverage).toMatchObject({
      coolingFrom: null, coolingTo: null, coolingEvents: 0,
    });
    expect(result.sensors.every((s) => s.coolingOffset === null && s.coolingUndershoot === null)).toBe(true);
  });

  it('says sensors aren\'t the cause when the house stays warm without heating', () => {
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
    expect(passive.detail).toContain('Sensor placement isn\'t causing this');
    expect(passive.detail).toContain('in the 2 hours after Sleep ended, rooms peaked 3.6 °C over the Home set point');
    expect(kitchen.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting.');
    expect(kitchen.detail).toContain('so this matters mainly on colder days.');
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
    expect(wake.detail).toContain('the warm-up ran 90 minutes on average');
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
    };
    const result = analyzePlacement(wakeInput({ participation }));
    const wake = result.recommendations.find((r) => r.id === 'wake-bedroom')!;
    // Home's own offset, not a blend with the preheat in Sleep.
    expect(wake).toMatchObject({ comfortSetting: 'home' });
    expect(wake.detail).toMatch(/^In 5 of 5 wake-ups \(Sleep → Home\), Bedroom read 1\.3 °C below the comfort average Ecobee heats to\. /);
    // In Sleep only: the preheat's setting is the one blamed, from its offset.
    const sleepOnly = analyzePlacement(wakeInput({
      participation: { ...participation, home: ['kitchen_temperature', 'office_temperature'] },
    }));
    const sleepWake = sleepOnly.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(sleepWake).toMatchObject({ comfortSetting: 'sleep', title: 'Bedroom is holding the morning warm-up on' });
    expect(sleepWake.detail).toContain('Bedroom read 1.0 °C below the comfort average Ecobee heats to while heating in '
      + 'Sleep before Home. Because it\'s in your Sleep comfort setting, Ecobee keeps heating');
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
    expect(wake.detail).toContain('the warm-up ran 150 minutes on average');
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
    const recsFor = (bias: (t: number) => number) => analyzePlacement(wakeInput({ sensors: withBedroom(bias) }))
      .recommendations.filter((r) => r.sensorId === 'bedroom_temperature');
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
    };
    const result = analyzePlacement(wakeInput({ hvac: preheatHvac(5), participation }));
    expect(result.recommendations.some((r) => r.id === 'wake-bedroom')).toBe(false);
    // In Sleep, it is blamed for Sleep.
    const inSleep = analyzePlacement(wakeInput({
      hvac: preheatHvac(5), participation: { ...participation, sleep: [...participation.sleep, 'bedroom_temperature'] },
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

  it('judges cooling by who counted during the cooling runs, not current occupancy', () => {
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
    // Occupied now but empty while cooling ran: it didn't steer the AC.
    expect(run(true, false, 'home')).toBeUndefined();
    expect(run(true, false, 'sleep')).toBeUndefined();
    // Empty now but occupied while cooling ran: it did.
    expect(run(false, true, 'home')).toMatchObject({ id: 'cooling-kitchen', comfortSetting: 'home' });
    expect(run(false, true, 'sleep')).toMatchObject({ id: 'cooling-kitchen', comfortSetting: 'sleep' });
  });

  it('blames rooms that counted through the all-unoccupied fallback, not rooms Follow Me left out', () => {
    const withBedroom = (bedroomOccupied: boolean, othersOccupied: boolean) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: occupied(r.id === 'bedroom_temperature' ? bedroomOccupied : othersOccupied),
      })),
      participation: { ...config(['bedroom_temperature', 'living_temperature'], true), sleep: ['bedroom_temperature', 'living_temperature'] },
    }));
    // Nobody occupied: Ecobee averages both, so the cold Bedroom counts.
    const fallback = withBedroom(false, false);
    const wake = fallback.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake.detail).toContain('it counted 100% of the time while the warm-ups heated in Home');
    expect(fallback.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— likely');
    // Living Room occupied: the empty Bedroom is left out, so it isn't blamed.
    const excluded = withBedroom(false, true);
    expect(excluded.recommendations.some((r) => r.sensorId === 'bedroom_temperature')).toBe(false);
    const summary = excluded.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
    expect(summary).toContain('with Follow Me it never counted toward the thermostat\'s average in Home, so it didn\'t steer it');
    expect(summary).not.toContain('likely');
     // With nothing to suggest, the summary doesn't deny the measured outlier.
    expect(excluded.recommendations.map((r) => r.id)).toEqual(['no-changes']);
    const [none] = excluded.recommendations;
    expect(none.title).toBe('No changes suggested');
    expect(none.detail).toContain('Bedroom (below) read consistently off the house average, but no change is suggested');
    expect(none.detail).not.toContain('No room sensor read consistently');
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
      + 'If it counted, Ecobee stops heating');
    expect(rec.detail).not.toContain('Because it\'s in');
    expect(rec.detail).not.toContain('it counted 1');
    const summary = unknown.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary!;
    expect(summary).toContain('with Follow Me on, the occupancy and comfort-setting history couldn\'t show');
    expect(summary).toContain('so it may or may not be pushing the average up');
    expect(summary).not.toContain('likely');
    // The wake-up tip is qualified the same way.
    const wake = unknown.recommendations.find((r) => r.id === 'wake-office')!;
    expect(wake).toMatchObject({ severity: 'low', title: 'Office may be holding the morning warm-up on' });
    expect(wake.detail).toContain('couldn\'t show whether it counted toward the average for enough of the time. '
      + 'If it counted, Ecobee keeps heating until it warms up');
    // Occupied throughout: it counted, and that's stated.
    const known = withOccupancy(true).recommendations.find((r) => r.id === 'remove-kitchen')!;
    expect(known.title).toBe('Kitchen is stopping the heat early');
    expect(known.detail).toContain('Because it\'s in your Home comfort setting, Ecobee stops heating');
    expect(known.detail).toContain('With Follow Me on, it counted 100% of the time in Home');
  });

  it('treats an omitted Follow Me as unknown, not off', () => {
    const both = ['bedroom_temperature', 'living_temperature'];
    const run = (followMe: boolean | null, othersOccupied: boolean) => analyzePlacement(wakeInput({
      sensors: rooms(WAKE_BIASES, wakeBase).map((r) => ({
        ...r, occupancy: occupied(r.id !== 'bedroom_temperature' && othersOccupied),
      })),
      participation: { home: both, sleep: both, away: null, followMe },
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
    expect(bedroom.verdictSummary).toContain(`— ${caveat}, so it may or may not be pulling the average down`);
    expect(bedroom.verdictSummary).not.toContain('likely');
    // Nobody occupied: it counts whether Follow Me is on or off.
    const none = run(null, false);
    expect(none.recommendations[0]).toMatchObject({
      id: 'wake-bedroom', severity: 'medium', title: 'Bedroom is holding the morning warm-up on',
    });
    expect(none.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— likely');
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
      home: null, sleep: null, away: null, followMe: false,
    }).recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(off.detail).toContain('The thermostat\'s readings suggest it\'s in your Home comfort setting. Ecobee keeps heating');
  });

  it('doesn\'t treat no observed contribution over part of the time as none', () => {
    const flat = { living_temperature: 0, kitchen_temperature: 0, bedroom_temperature: 0 };
    const summer = coolingInput({ kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5 });
    // The others are always occupied. The Kitchen is empty (so left out),
    // except optionally for the first half hour of cooling; its occupancy is
    // unknown from day 3 until 14:00 on day 4: exactly 75% of the cooling
    // time is known.
    const run = (occupiedOnce: boolean, outage: boolean) => {
      const kitchen: OccupancySample[] = [
        { t: SUMMER - DAY, occupied: false },
        ...(occupiedOnce
          ? [{ t: SUMMER + 13 * HOUR, occupied: true }, { t: SUMMER + 13.5 * HOUR, occupied: false }]
          : []),
        ...(outage ? [{ t: SUMMER + 3 * DAY, occupied: null }, { t: SUMMER + 4 * DAY + 14 * HOUR, occupied: false }] : []),
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
      + 'show whether it counted toward the average for enough of the time. If it counted, the AC keeps running');
    expect(partial.summary).toContain('so it may or may not be pushing the average up');
    expect(partial.summary).not.toContain('never counted');
    // Never counted with occupancy known throughout: it didn't steer the AC.
    const none = run(false, false);
    expect(none.rec).toBeUndefined();
    expect(none.summary).toContain('with Follow Me it never counted toward the thermostat\'s average while the AC ran in Home');
    // A measured share over part of the time says so.
    const some = run(true, true);
    expect(some.rec).toMatchObject({ title: 'Kitchen is keeping the AC on' });
    expect(some.rec!.detail).toContain('With Follow Me on, it counted 2% of the time while the AC ran in Home (while '
      + 'occupied, or when no participating room was). Whether it counted could only be told for 75% of that time; '
      + 'the share is of that part.');
    expect(some.summary).toContain('(with Follow Me it counted 2% of the time while the AC ran in Home, of the 75% of '
      + 'that time it could be told)');
  });

  it('doesn\'t assume who counted when Follow Me is on or omitted and there\'s no occupancy history', () => {
    const both = ['bedroom_temperature', 'living_temperature'];
    const omittedCaveat = 'Follow Me wasn\'t specified; if it\'s on it may have left it out of the average while '
      + 'unoccupied, and whether it counted isn\'t known';
    // Omitted, nothing configured, no thermostat reading: the average Ecobee
    // used isn't assumed, so there are no wake offsets or wake-up tip.
    const omitted = analyzePlacement(wakeInput({ participation: undefined }));
    expect(omitted.coverage).toMatchObject({ followMe: null, occupancyAvailable: false });
    expect(omitted.sensors.every((s) => s.wakeOffset === null)).toBe(true);
    expect(omitted.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
      ['move-bedroom', 'low', 'Bedroom may be keeping the heat on'],
    ]);
    expect(omitted.recommendations[0].detail).toContain(
      `If it's in your Home comfort setting and counted toward the average (${omittedCaveat}), Ecobee keeps heating`,
    );
    const summary = omitted.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary!;
    expect(summary).toContain(`— ${omittedCaveat}, so it may or may not be pulling the average down`);
    expect(summary).not.toContain('likely');
    // Omitted, with the thermostat's reading: membership isn't estimated from
    // an all-members assumption, and tips stay conditional.
    const estimated = analyzePlacement(wakeInput({ participation: undefined, sensors: rooms(EST_BIASES, wakeBase) }));
    const wake = estimated.recommendations.find((r) => r.id === 'wake-bedroom')!;
    expect(wake).toMatchObject({ severity: 'low', title: 'Bedroom may be holding the morning warm-up on' });
    expect(wake.detail).toContain(`(${omittedCaveat})`);
    expect(estimated.recommendations.every((r) => !r.detail.includes('readings suggest'))).toBe(true);
    // Explicitly on: the same, worded for Follow Me on.
    const on = analyzePlacement(wakeInput({ participation: { home: both, sleep: both, away: null, followMe: true } }));
    const bedroom = on.sensors.find((s) => s.id === 'bedroom_temperature')!;
    expect(bedroom.wakeOffset).toBeNull();
    expect(on.recommendations.map((r) => [r.id, r.severity, r.title])).toEqual([
      ['move-bedroom', 'low', 'Bedroom may be keeping the heat on'],
    ]);
    expect(on.recommendations[0].detail).toContain('It\'s in your Home comfort setting, but with Follow Me on, the '
      + 'occupancy and comfort-setting history couldn\'t show whether it counted toward the average for enough of the '
      + 'time. If it counted, Ecobee keeps heating');
    expect(bedroom.verdictSummary).toContain('so it may or may not be pulling the average down');
    // Explicitly off: all members count, as before.
    const off = analyzePlacement(wakeInput({ participation: { home: both, sleep: both, away: null, followMe: false } }));
    expect(off.recommendations[0]).toMatchObject({
      id: 'wake-bedroom', severity: 'medium', title: 'Bedroom is holding the morning warm-up on',
    });
    expect(off.sensors.find((s) => s.id === 'bedroom_temperature')!.verdictSummary).toContain('— likely');
    // With the thermostat's reading and Follow Me off, membership is estimated.
    const offEstimated = analyzePlacement(wakeInput({ sensors: rooms(EST_BIASES, wakeBase) }));
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
      + 'If it counted, the AC keeps running');
    expect(rec.detail).not.toContain('Because it\'s in');
    expect(result.sensors.find((s) => s.id === 'kitchen_temperature')!.verdictSummary)
      .toContain('so it may or may not be pushing the average up so the AC overcools other rooms');
  });

  it('states a small measured Follow Me share instead of hiding it', () => {
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
    expect(rec).toMatchObject({ id: 'cooling-kitchen', title: 'Kitchen is keeping the AC on' });
    const share = Number(/it counted (\d+)% of the time while the AC ran in Home/.exec(rec.detail)![1]);
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
    expect(sleep.detail).toContain('Because it\'s in your Sleep comfort setting, the AC keeps running');
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
    // Winter: the thermostat averages the Bedroom and Living Room, not the
    // Kitchen. Summer: it averages all three, and the Kitchen reads warm.
    const summer = {
      kitchen_temperature: 1.5, living_temperature: -0.5, bedroom_temperature: -0.5,
    };
    const result = analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase),
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

  it('estimates participation when an unrelated sensor is absent or intermittent', () => {
    const withOffice = (keep: (t: number) => boolean) => analyzePlacement(wakeInput({
      sensors: rooms(EST_BIASES, wakeBase).map((r) => (r.id === 'office_temperature'
        ? { ...r, points: r.points.filter((p) => keep(p.t)) }
        : r)),
    }));
    const estimated = 'The thermostat\'s readings suggest it\'s in your Home comfort setting. Ecobee keeps heating';
    // Absent: no subset with the Office can be scored, so it doesn't block the others.
    const absent = withOffice(() => false);
    expect(absent.recommendations.find((r) => r.id === 'wake-bedroom')!.detail).toContain(estimated);
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
    expect(rec).toMatchObject({ id: 'cooling-kitchen', action: 'move', title: 'Kitchen is keeping the AC on' });
    expect(rec.detail).toContain('Because it\'s in your Home comfort setting, the AC keeps running');
    expect(rec.detail).toContain('so move it away from the stove and appliances, or remove it from Home.');
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
});
