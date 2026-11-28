import { analyzePlacementDay, placementDateBounds, resolvePlacementDay } from '../climate-placement-day';
import type { HvacSample, ParticipationConfig, SensorSeriesInput } from '../climate-placement';

const QUARTER = 15 * 60_000;
const DAY = 24 * 60 * 60_000;
const DATE = '2026-01-15';
const START = Date.parse(`${DATE}T00:00:00Z`);

describe('house-calendar day resolution', () => {
  it('uses 23-hour and 25-hour local calendar days', () => {
    const spring = resolvePlacementDay(
      '2026-03-08', 'America/Toronto', new Date('2026-03-09T12:00:00Z'),
    );
    const fall = resolvePlacementDay(
      '2026-11-01', 'America/Toronto', new Date('2026-11-02T12:00:00Z'),
    );
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 60 * 60_000);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 60 * 60_000);
  });

  it('uses the first instant of dates with skipped or ambiguous local midnight', () => {
    const santiago = resolvePlacementDay(
      '2026-09-06', 'America/Santiago', new Date('2026-09-07T12:00:00Z'),
    );
    const havanaSpring = resolvePlacementDay(
      '2026-03-08', 'America/Havana', new Date('2026-03-09T12:00:00Z'),
    );
    const havanaFall = resolvePlacementDay(
      '2026-11-01', 'America/Havana', new Date('2026-11-02T12:00:00Z'),
    );
    expect(santiago.start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(santiago.end.getTime() - santiago.start.getTime()).toBe(23 * 60 * 60_000);
    expect(havanaSpring.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(havanaSpring.end.getTime() - havanaSpring.start.getTime()).toBe(23 * 60 * 60_000);
    // Havana's midnight occurs twice on the fall-back date; choose the earlier one.
    expect(havanaFall.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(havanaFall.end.getTime() - havanaFall.start.getTime()).toBe(25 * 60 * 60_000);
  });

  it('resolves baseline calendar boundaries across a skipped-midnight date', () => {
    const selected = resolvePlacementDay(
      '2026-09-07', 'America/Santiago', new Date('2026-09-08T12:00:00Z'),
    );
    const result = analyzePlacementDay({
      date: selected.date,
      timeZone: 'America/Santiago',
      start: selected.start.getTime(),
      end: selected.end.getTime(),
      historyEnd: selected.end.getTime(),
      now: selected.end.getTime(),
      sensors: [],
      hvac: null,
      comfort: null,
      reportedTemperature: null,
      participation: null,
      unknownUnitWindows: 0,
      unitAssumptions: { setpoints: false, reportedTemperature: false },
      incompleteSensorInventory: false,
    });
    expect(result.timeline).toHaveLength(96);
  });

  it('uses the earliest date occurrence when a timezone rolls back across midnight', () => {
    const bounds = placementDateBounds('2010-03-05', 'Antarctica/Casey');
    expect(bounds.start.toISOString()).toBe('2010-03-04T13:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2010-03-05T16:00:00.000Z');
    expect(bounds.end.getTime() - bounds.start.getTime()).toBe(27 * 60 * 60_000);

    const selected = placementDateBounds('2010-03-06', 'Antarctica/Casey');
    const result = analyzePlacementDay({
      date: '2010-03-06',
      timeZone: 'Antarctica/Casey',
      start: selected.start.getTime(),
      end: selected.end.getTime(),
      historyEnd: selected.end.getTime(),
      now: selected.end.getTime(),
      sensors: [],
      hvac: null,
      comfort: null,
      reportedTemperature: null,
      participation: null,
      unknownUnitWindows: 0,
      unitAssumptions: { setpoints: false, reportedTemperature: false },
      incompleteSensorInventory: false,
    });
    expect(result.coverage.baselineDays).toBe(14);
  });

  it.each(['2026-2-01', '2026-02-29', '2026-01-01junk', ['2026-01-01']])(
    'rejects malformed or impossible explicit date %j',
    (date) => {
      expect(() => resolvePlacementDay(date, 'UTC', new Date('2026-01-20T12:00:00Z'))).toThrow('valid YYYY-MM-DD');
    },
  );
});

function dayInput({
  baselineDays = 14,
  selectedSamples = 8,
  selectedShift = 4,
  mode = 'heating',
  participation = null,
  roomOccupancy,
  insideChange = false,
  partialDay = false,
  occupancyEdge = false,
  fractionalState = false,
  intermediateReversal = false,
  unknownSetpoint = false,
  thermostatSensors = false,
}: {
  baselineDays?: number;
  selectedSamples?: number;
  selectedShift?: number;
  mode?: 'heating' | 'cooling';
  participation?: ParticipationConfig | null;
  roomOccupancy?: boolean;
  insideChange?: boolean;
  partialDay?: boolean;
  occupancyEdge?: boolean;
  fractionalState?: boolean;
  intermediateReversal?: boolean;
  unknownSetpoint?: boolean;
  thermostatSensors?: boolean;
} = {}) {
  const firstDay = START - 14 * DAY;
  const sensors: SensorSeriesInput[] = [
    { id: 'living_temperature', name: 'Living', isThermostat: false, points: [] },
    { id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [] },
  ];
  if (thermostatSensors) {
    sensors.push(
      { id: 'home_current_temperature', name: 'Home', isThermostat: true, points: [] },
      { id: 'secondary_thermostat_temperature', name: 'Secondary', isThermostat: true, points: [] },
    );
  }
  if (roomOccupancy !== undefined) {
    sensors.forEach((sensor) => { sensor.occupancy = [{ t: firstDay, occupied: roomOccupancy }]; });
  }
  const hvac: HvacSample[] = [];
  for (let day = 0; day <= 14; day += 1) {
    const dayStart = firstDay + day * DAY;
    for (let quarter = 0; quarter < 96; quarter += 1) {
      const t = dayStart + quarter * QUARTER;
      const active = day === 14
        ? quarter >= 24 && quarter < 24 + selectedSamples
        : day < baselineDays && quarter >= 24 && quarter < 32;
      const shifted = day === 14;
      sensors[0].points.push({ t, v: shifted ? 20 + selectedShift : 20 });
      sensors[1].points.push({ t, v: 22 });
      sensors.slice(2).forEach((sensor) => sensor.points.push({
        t, v: sensor.id === 'home_current_temperature' ? 23 : 100,
      }));
      if (occupancyEdge && day === 14) {
        sensors.forEach((sensor) => {
          sensor.occupancy = [
            { t: START + 6 * 60 * 60_000, occupied: true },
            { t: START + 6 * 60 * 60_000 + 5 * 60_000, occupied: false },
          ];
        });
      }
      if (quarter === 24) {
        hvac.push({
          t,
          gap: false,
          hvacMode: mode === 'heating' ? 'heat' : 'cool',
          hvacAction: active ? mode : 'idle',
          setpoint: unknownSetpoint ? null : 21,
          coolSetpoint: unknownSetpoint ? null : 24,
          presetMode: 'home',
          ...(fractionalState && day === 14 ? { subMillisecondFields: { hvacAction: '1' } } : {}),
        });
        if (intermediateReversal && day === 14) {
          const heating = {
            t: t + 5 * 60_000, gap: false,
            hvacMode: mode === 'heating' ? 'heat' : 'cool',
            hvacAction: 'heating',
            setpoint: 21,
            coolSetpoint: 24,
            presetMode: 'home',
          };
          hvac.push({
            ...heating,
            orderedUpdates: [
              { subMillisecond: '1', sample: { ...heating, hvacAction: 'idle' } },
              { subMillisecond: '2', sample: heating },
            ],
          });
        }
        if (insideChange && day === 14) {
          hvac.push({
            t: t + 5 * 60_000, gap: false,
            hvacMode: mode === 'heating' ? 'heat' : 'cool',
            hvacAction: 'idle',
            setpoint: 21,
            coolSetpoint: 24,
            presetMode: 'home',
          });
        }
      } else if (quarter === 24 + (day === 14 ? selectedSamples : 8)) {
        hvac.push({
          t, gap: false, hvacMode: mode === 'heating' ? 'heat' : 'cool', hvacAction: 'idle',
          setpoint: 21, coolSetpoint: 24, presetMode: 'home',
        });
      }
    }
  }
  const comfort = Array.from({ length: 15 }, (_, day) => ({ t: firstDay + day * DAY, setting: 'home' }));
  const result = analyzePlacementDay({
    date: DATE,
    timeZone: 'UTC',
    start: START,
    end: START + DAY,
    historyEnd: START + DAY,
    now: START + DAY - (partialDay ? 5 * 60_000 : 0),
    sensors,
    hvac,
    comfort,
    reportedTemperature: null,
    participation,
    unknownUnitWindows: 0,
    unitAssumptions: { setpoints: false, reportedTemperature: false },
    incompleteSensorInventory: false,
    primaryThermostatId: thermostatSensors ? 'home_current_temperature' : null,
  });
  return result;
}

describe('daily placement analysis', () => {
  it.each([false, true])(
    'keeps the average unknown when the selected thermostat has no discovered sensor (Follow Me: %s)',
    (followMe) => {
      const participation: ParticipationConfig = {
        home: ['living_temperature', 'bedroom_temperature'],
        sleep: [],
        away: [],
        followMe,
        thermostat: { home: true, sleep: false, away: false },
      };
      const result = dayInput({ participation, roomOccupancy: true });
      expect(result.timeline[24].average).toBeNull();
    },
  );

  it('marks only a qualifying 0.5°C-or-more room-cohort-relative shift unusual', () => {
    const result = dayInput();
    expect(result.sensors.find((sensor) => sensor.id === 'living_temperature')).toMatchObject({
      dayOffset: 1, baselineOffset: -1, deviation: 2, unusual: true,
    });
    expect(result.findings).toHaveLength(2);
    const belowMinimum = dayInput({ selectedSamples: 7 });
    expect(belowMinimum.sensors.every((sensor) => sensor.dayOffset === null && sensor.unusual === null)).toBe(true);
    const insufficientBaseline = dayInput({ baselineDays: 2 });
    expect(insufficientBaseline.sensors.every((sensor) => sensor.baselineOffset === null && sensor.unusual === null)).toBe(true);
    expect(dayInput({ baselineDays: 3 }).sensors.find((sensor) => sensor.id === 'living_temperature'))
      .toMatchObject({ baselineOffset: -1, unusual: true });
    const threshold = dayInput({ selectedShift: 1 });
    expect(threshold.sensors.find((sensor) => sensor.id === 'living_temperature'))
      .toMatchObject({ dayOffset: -0.5, baselineOffset: -1, deviation: 0.5, unusual: true });
    const belowThreshold = dayInput({ selectedShift: 0.8 });
    expect(belowThreshold.sensors.find((sensor) => sensor.id === 'living_temperature')?.unusual).toBe(false);
    const coolingMinimum = dayInput({ mode: 'cooling', selectedSamples: 2 });
    expect(coolingMinimum.sensors.find((sensor) => sensor.id === 'living_temperature'))
      .toMatchObject({ dayOffset: 1, baselineOffset: -1, unusual: true });
    const belowCoolingMinimum = dayInput({ mode: 'cooling', selectedSamples: 1 });
    expect(belowCoolingMinimum.sensors.every((sensor) => sensor.dayOffset === null && sensor.unusual === null)).toBe(true);
    expect(dayInput({ unknownSetpoint: true, baselineDays: 3 }).sensors.find((sensor) => sensor.id === 'living_temperature'))
      .toMatchObject({ dayOffset: 1, baselineOffset: -1, unusual: true });
  });

  it('uses intermediate same-millisecond HVAC updates to invalidate only the changing bucket', () => {
    const result = dayInput({ intermediateReversal: true });
    expect(result.timeline.find((entry) => entry.t === '2026-01-15T06:00:00.000Z'))
      .toMatchObject({ hvacAction: null, setpoint: null });
    expect(result.timeline.find((entry) => entry.t === '2026-01-15T06:15:00.000Z'))
      .toMatchObject({ hvacAction: 'heating', setpoint: 21 });
  });

  it('uses only the selected thermostat sensor in the fallback average', () => {
    const participation: ParticipationConfig = {
      home: ['living_temperature', 'bedroom_temperature'],
      sleep: [],
      away: [],
      followMe: false,
      thermostat: { home: true, sleep: false, away: false },
    };
    const result = dayInput({ participation, thermostatSensors: true });
    expect(result.timeline[24].average).toBe(23);
    expect(result.timeline[24].rooms).not.toHaveProperty('home_current_temperature');
    expect(result.timeline[24].rooms).not.toHaveProperty('secondary_thermostat_temperature');
  });

  it('keeps state changes inside a source window from labeling the whole bucket', () => {
    const result = dayInput({ insideChange: true, occupancyEdge: true });
    const point = result.timeline.find((entry) => entry.t === '2026-01-15T06:00:00.000Z');
    expect(point).toMatchObject({
      hvacAction: null,
      setpoint: null,
      occupied: { living_temperature: null, bedroom_temperature: null },
    });
    const later = result.timeline.find((entry) => entry.t === '2026-01-15T06:15:00.000Z');
    expect(later).toMatchObject({ occupied: { living_temperature: false, bedroom_temperature: false } });
  });

  it('keeps sub-millisecond state changes at a source-window edge unknown', () => {
    const result = dayInput({ fractionalState: true });
    expect(result.timeline.find((entry) => entry.t === '2026-01-15T06:00:00.000Z'))
      .toMatchObject({ hvacAction: null, setpoint: null });
    expect(result.timeline.find((entry) => entry.t === '2026-01-15T06:15:00.000Z'))
      .toMatchObject({ hvacAction: 'heating', setpoint: 21 });
  });

  it('keeps incomplete windows and unknown readings null rather than zero', () => {
    const result = dayInput({ partialDay: true });
    const point = result.timeline.find((entry) => entry.t === '2026-01-15T23:45:00.000Z');
    expect(point).toMatchObject({
      setpoint: null,
      hvacAction: null,
      average: null,
      rooms: { living_temperature: null, bedroom_temperature: null },
      occupied: { living_temperature: null, bedroom_temperature: null },
    });
  });

  it('reports a recorded Sleep-to-Home wake with its evidence-qualified two-hour context', () => {
    const time = (hour: number, minute = 0) => START + hour * 60 * 60_000 + minute * 60_000;
    const sensors: SensorSeriesInput[] = ['living_temperature', 'bedroom_temperature'].map((id, index) => ({
      id,
      name: id.startsWith('living') ? 'Living' : 'Bedroom',
      isThermostat: false,
      points: Array.from({ length: 96 }, (_, quarter) => ({
        t: START + quarter * QUARTER,
        v: quarter < 24 ? 18 + index : 22 + index,
      })),
    }));
    const hvac: HvacSample[] = [
      { t: time(4), gap: false, hvacMode: 'heat', hvacAction: 'idle', setpoint: 17, presetMode: 'sleep' },
      { t: time(6), gap: false, hvacMode: 'heat', hvacAction: 'heating', setpoint: 21, presetMode: 'home' },
      { t: time(6, 30), gap: false, hvacMode: 'heat', hvacAction: 'idle', setpoint: 21, presetMode: 'home' },
    ];
    const result = analyzePlacementDay({
      date: DATE,
      timeZone: 'UTC',
      start: START,
      end: START + DAY,
      historyEnd: START + DAY,
      now: START + DAY,
      sensors,
      hvac,
      comfort: [{ t: time(0), setting: 'sleep' }, { t: time(6), setting: 'home' }],
      reportedTemperature: null,
      participation: null,
      unknownUnitWindows: 0,
      unitAssumptions: { setpoints: false, reportedTemperature: false },
      incompleteSensorInventory: false,
    });
    expect(result.wake).toMatchObject({
      at: new Date(time(6)).toISOString(),
      setpointBefore: 17,
      setpointAfter: 21,
      heatingMinutes: 30,
      coolingMinutes: 0,
      contextComplete: true,
      context: { from: new Date(time(4)).toISOString(), to: new Date(time(8)).toISOString() },
    });
    expect((result.wake as { rooms: { sensorId: string; atSwitch: number | null; peak: number | null; overSetpoint: number | null }[] })
      .rooms[0]).toMatchObject({ atSwitch: 22, peak: 22, overSetpoint: 1 });
  });
});
