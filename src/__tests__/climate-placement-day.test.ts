import { analyzePlacementDay, resolvePlacementDay } from '../climate-placement-day';
import type { HvacSample, SensorSeriesInput } from '../climate-placement';

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
  insideChange = false,
  partialDay = false,
  occupancyEdge = false,
  fractionalState = false,
}: {
  baselineDays?: number;
  selectedSamples?: number;
  selectedShift?: number;
  mode?: 'heating' | 'cooling';
  insideChange?: boolean;
  partialDay?: boolean;
  occupancyEdge?: boolean;
  fractionalState?: boolean;
} = {}) {
  const firstDay = START - 14 * DAY;
  const sensors: SensorSeriesInput[] = [
    { id: 'living_temperature', name: 'Living', isThermostat: false, points: [] },
    { id: 'bedroom_temperature', name: 'Bedroom', isThermostat: false, points: [] },
  ];
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
          setpoint: 21,
          coolSetpoint: 24,
          presetMode: 'home',
          ...(fractionalState && day === 14 ? { subMillisecondFields: { hvacAction: '1' } } : {}),
        });
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
    participation: null,
    unknownUnitWindows: 0,
    unitAssumptions: { setpoints: false, reportedTemperature: false },
  });
  return result;
}

describe('daily placement analysis', () => {
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
    });
    expect(result.wake).toMatchObject({
      at: new Date(time(6)).toISOString(),
      setpointBefore: 17,
      setpointAfter: 21,
      heatingMinutes: 30,
      coolingMinutes: 0,
      context: { from: new Date(time(4)).toISOString(), to: new Date(time(8)).toISOString() },
    });
    expect((result.wake as { rooms: { sensorId: string; atSwitch: number | null; peak: number | null; overSetpoint: number | null }[] })
      .rooms[0]).toMatchObject({ atSwitch: 22, peak: 22, overSetpoint: 1 });
  });
});
