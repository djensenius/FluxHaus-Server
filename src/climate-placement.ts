// Pure analysis behind GET /climate/placement-insights: finds morning warm-ups
// and returns from Away in recent history, measures how each room sensor reads
// against the house average while the house heats up, and suggests sensor
// placement / comfort-setting checks. No I/O here — see
// climate-placement-service.ts for data fetching and caching.

// Local hours (server time zone) in which a heat-up counts as a morning warm-up.
export const MORNING_START_HOUR = 4;
export const MORNING_END_HOUR = 10;
// Longest heat-up measured after an event (shorter if the thermostat stops
// heating sooner).
export const EVENT_WINDOW_MS = 2 * 60 * 60 * 1000;
// Readings are compared on a grid with this spacing.
export const BUCKET_MS = 15 * 60 * 1000;
// A sensor's latest reading is carried forward onto the grid for at most this
// long; older readings are stale and never compared.
export const MAX_READING_AGE_MS = 30 * 60 * 1000;
// Share of a heat-up's grid points a sensor needs fresh readings for to join
// that heat-up's house average. The average is only taken at points where
// every joined sensor is fresh, so its membership never changes mid-event.
export const COHORT_COVERAGE = 0.75;
// A sensor reading at least this far from the house mean counts as biased.
export const OFFSET_THRESHOLD = 1.0;
// A strongly biased sensor is a high-severity finding when a room also overshoots.
export const STRONG_OFFSET = 2.0;
// Share of events in which a sensor must be biased to be classified cold/warm.
export const CONSISTENCY_SHARE = 0.6;
// Fewer events (or samples) than this → insufficient.
export const MIN_EVENTS = 3;
export const MIN_SAMPLES = 12;
// Samples needed in one event window for it to count for a sensor.
export const MIN_EVENT_SAMPLES = 2;
// Sensors needed for a house mean.
export const MIN_SENSORS_FOR_MEAN = 2;
// A room rising this far above the set point counts as overshooting.
export const OVERSHOOT_THRESHOLD = 1.0;
// Overshoot is measured after the thermostat stops heating (reported
// hvac_action), for up to this long, ending early at the next set point or
// preset change or event. Heat-ups that don't stop within the limit aren't measured.
export const OVERSHOOT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SATISFACTION_LIMIT_MS = 4 * 60 * 60 * 1000;
// A set point increase of at least this much is a heat-up trigger.
export const SETPOINT_STEP = 0.5;
// Rise of the house mean within an hour that marks an inferred morning warm-up
// for periods without thermostat history.
export const INFERRED_RISE = 0.5;
const INFERRED_RISE_WINDOW_MS = 60 * 60 * 1000;

export type SensorClassification = 'cold' | 'warm' | 'representative' | 'insufficient';
export type RecommendationSeverity = 'high' | 'medium' | 'low';
export type RecommendationAction = 'move' | 'exclude_from_comfort' | 'include_in_comfort' | 'none';
export type PlacementEventType = 'morning' | 'return';

export interface SensorSeriesInput {
  id: string;
  name: string;
  isThermostat: boolean;
  // Epoch milliseconds and °C.
  points: { t: number; v: number }[];
}

export interface HvacSample {
  t: number;
  hvacAction: string | null;
  presetMode: string | null;
  // Heating set point in °C (`temperature`, else `target_temp_low`).
  setpoint: number | null;
}

export interface PlacementInput {
  start: Date;
  end: Date;
  windowDays: number;
  timeZone: string;
  sensors: SensorSeriesInput[];
  // null when Home Assistant history could not be read.
  hvac: HvacSample[] | null;
  generatedAt?: Date;
}

export interface PlacementEvent {
  type: PlacementEventType;
  t: number;
  // True for morning warm-ups inferred from room temperatures.
  inferred: boolean;
}

export interface PlacementSensor {
  id: string;
  name: string;
  isThermostat: boolean;
  averageOffset: number | null;
  morningOffset: number | null;
  returnOffset: number | null;
  overshoot: number | null;
  sampleCount: number;
  classification: SensorClassification;
}

export interface PlacementRecommendation {
  id: string;
  severity: RecommendationSeverity;
  sensorId: string | null;
  action: RecommendationAction;
  title: string;
  detail: string;
}

export interface PlacementInsights {
  generatedAt: string;
  windowDays: number;
  unit: '°C';
  coverage: {
    start: string;
    end: string;
    hvacHistoryAvailable: boolean;
    // Start of the thermostat history actually read (null without any). Before
    // it, morning warm-ups are inferred from room temperatures.
    hvacHistoryStart: string | null;
    // Whether the history reports presets; returns from Away need them.
    returnHistoryAvailable: boolean;
    morningEvents: number;
    // How many of morningEvents were inferred from room temperatures.
    inferredMorningEvents: number;
    returnEvents: number;
  };
  sensors: PlacementSensor[];
  recommendations: PlacementRecommendation[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : round1(value);
}

function fmt(value: number): string {
  return Math.abs(round1(value)).toFixed(1);
}

export function localClock(timeZone: string): (t: number) => { day: string; hour: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (t: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
  };
}

function isAway(preset: string | null): boolean {
  return !!preset && preset.toLowerCase().includes('away');
}

function isHomePreset(preset: string | null): boolean {
  return !!preset && /home|comfort/i.test(preset);
}

function isHeating(action: string | null): boolean {
  return !!action && /heat/i.test(action);
}

// Morning warm-ups and returns from Away found in thermostat history. A return
// is only an explicit preset change from Away to home/comfort; a morning
// warm-up is the earliest heating start, set point rise or preset change to
// home/comfort in the morning window, once per local day.
export function detectHvacEvents(samples: HvacSample[], timeZone: string): PlacementEvent[] {
  const clock = localClock(timeZone);
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const returns: PlacementEvent[] = [];
  const mornings = new Map<string, PlacementEvent>();

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const { day, hour } = clock(cur.t);
    const inMorning = hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
    const setpointRise = prev.setpoint !== null && cur.setpoint !== null
      ? cur.setpoint - prev.setpoint : 0;

    if (isAway(prev.presetMode) && isHomePreset(cur.presetMode)) {
      const last = returns[returns.length - 1];
      if (!last || cur.t - last.t >= EVENT_WINDOW_MS) returns.push({ type: 'return', t: cur.t, inferred: false });
    } else if (inMorning && !mornings.has(day) && !isAway(cur.presetMode)) {
      const presetToHome = isHomePreset(cur.presetMode) && !isHomePreset(prev.presetMode);
      const heatingStart = isHeating(cur.hvacAction) && !isHeating(prev.hvacAction);
      if (setpointRise >= SETPOINT_STEP || presetToHome || heatingStart) {
        mornings.set(day, { type: 'morning', t: cur.t, inferred: false });
      }
    }
  }

  const morningEvents = [...mornings.values()].filter(
    (m) => !returns.some((r) => Math.abs(r.t - m.t) < EVENT_WINDOW_MS),
  );
  return [...morningEvents, ...returns].sort((a, b) => a.t - b.t);
}

// Sensor readings carried forward onto a shared grid for at most
// MAX_READING_AGE_MS, so staggered sensors are compared at the same instants
// and stale readings are never used.
interface Grid {
  times: number[];
  values: Map<string, Map<number, number>>;
}

function align(sensors: SensorSeriesInput[]): Grid {
  const cleaned = sensors.map((sensor) => ({
    id: sensor.id,
    points: sensor.points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t),
  }));
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  cleaned.forEach(({ points }) => {
    if (points.length === 0) return;
    first = Math.min(first, points[0].t);
    last = Math.max(last, points[points.length - 1].t);
  });
  const times: number[] = [];
  if (Number.isFinite(first)) {
    for (let t = Math.ceil(first / BUCKET_MS) * BUCKET_MS; t <= last + MAX_READING_AGE_MS; t += BUCKET_MS) {
      times.push(t);
    }
  }
  const values = new Map<string, Map<number, number>>();
  cleaned.forEach(({ id, points }) => {
    const filled = new Map<number, number>();
    let index = -1;
    times.forEach((t) => {
      while (index + 1 < points.length && points[index + 1].t <= t) index += 1;
      if (index >= 0 && t - points[index].t <= MAX_READING_AGE_MS) filled.set(t, points[index].v);
    });
    values.set(id, filled);
  });
  return { times, values };
}

// Sensors fresh at enough of `times`, and the times at which all of them are fresh.
function cohortAt(grid: Grid, times: number[]): { cohort: string[]; times: number[] } {
  if (times.length === 0) return { cohort: [], times: [] };
  const cohort = [...grid.values.entries()]
    .filter(([, filled]) => times.filter((t) => filled.has(t)).length >= COHORT_COVERAGE * times.length)
    .map(([id]) => id);
  if (cohort.length < MIN_SENSORS_FOR_MEAN) return { cohort: [], times: [] };
  return { cohort, times: times.filter((t) => cohort.every((id) => grid.values.get(id)!.has(t))) };
}

function cohortMean(grid: Grid, cohort: string[], t: number): number {
  return mean(cohort.map((id) => grid.values.get(id)!.get(t)!))!;
}

// Morning warm-ups inferred from the house mean rising in the morning window,
// one per local day, for periods before (or without) thermostat history.
export function inferMorningEvents(
  sensors: SensorSeriesInput[],
  timeZone: string,
  before = Number.POSITIVE_INFINITY,
): PlacementEvent[] {
  const clock = localClock(timeZone);
  const grid = align(sensors);
  const events: PlacementEvent[] = [];
  const seenDays = new Set<string>();
  grid.times.forEach((t) => {
    if (t >= before) return;
    const { day, hour } = clock(t);
    if (seenDays.has(day) || hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return;
    const later = t + INFERRED_RISE_WINDOW_MS;
    // Same sensors at both instants, so membership can't fake a rise.
    const cohort = [...grid.values.entries()]
      .filter(([, filled]) => filled.has(t) && filled.has(later))
      .map(([id]) => id);
    if (cohort.length < MIN_SENSORS_FOR_MEAN) return;
    if (cohortMean(grid, cohort, later) - cohortMean(grid, cohort, t) >= INFERRED_RISE) {
      seenDays.add(day);
      events.push({ type: 'morning', t, inferred: true });
    }
  });
  return events;
}

interface EventContext {
  event: PlacementEvent;
  cohort: Set<string>;
  times: number[];
  // Post-satisfaction window and the set point in force; null when the
  // thermostat history can't establish it.
  overshoot: { times: number[]; setpoint: number } | null;
}

function stateAt(samples: HvacSample[], t: number): HvacSample | null {
  let found: HvacSample | null = null;
  for (const sample of samples) {
    if (sample.t > t) break;
    found = sample;
  }
  return found;
}

// When the thermostat stopped heating after the event, if it reported heating
// and then a non-heating action within SATISFACTION_LIMIT_MS.
function satisfiedAt(samples: HvacSample[], event: PlacementEvent): number | null {
  let heating = isHeating(stateAt(samples, event.t)?.hvacAction ?? null);
  for (const sample of samples) {
    if (sample.t <= event.t) continue;
    if (sample.t > event.t + SATISFACTION_LIMIT_MS) break;
    if (isHeating(sample.hvacAction)) heating = true;
    else if (heating && sample.hvacAction !== null) return sample.t;
  }
  return null;
}

function overshootWindow(
  grid: Grid,
  samples: HvacSample[],
  event: PlacementEvent,
  nextEvent: number,
): { times: number[]; setpoint: number } | null {
  if (event.inferred) return null;
  const from = satisfiedAt(samples, event);
  if (from === null) return null;
  const state = stateAt(samples, from);
  if (!state || state.setpoint === null) return null;
  const change = samples.find((s) => s.t > from
    && (s.setpoint !== state.setpoint || s.presetMode !== state.presetMode));
  const to = Math.min(from + OVERSHOOT_WINDOW_MS, nextEvent, change?.t ?? Number.POSITIVE_INFINITY);
  return { times: grid.times.filter((t) => t >= from && t < to), setpoint: state.setpoint };
}

function eventContexts(grid: Grid, events: PlacementEvent[], samples: HvacSample[]): EventContext[] {
  return events.map((event, index) => {
    const satisfied = event.inferred ? null : satisfiedAt(samples, event);
    const end = Math.min(event.t + EVENT_WINDOW_MS, satisfied ?? Number.POSITIVE_INFINITY);
    const { cohort, times } = cohortAt(grid, grid.times.filter((t) => t >= event.t && t <= end));
    const nextEvent = events[index + 1]?.t ?? Number.POSITIVE_INFINITY;
    return {
      event, cohort: new Set(cohort), times, overshoot: overshootWindow(grid, samples, event, nextEvent),
    };
  });
}

interface SensorStats {
  sensor: SensorSeriesInput;
  eventOffsets: { type: PlacementEventType; offset: number }[];
  overshoots: number[];
  sampleCount: number;
}

function measure(sensor: SensorSeriesInput, contexts: EventContext[], grid: Grid): SensorStats {
  const stats: SensorStats = {
    sensor, eventOffsets: [], overshoots: [], sampleCount: 0,
  };
  const filled = grid.values.get(sensor.id)!;
  contexts.forEach((ctx) => {
    if (ctx.cohort.has(sensor.id) && ctx.times.length >= MIN_EVENT_SAMPLES) {
      const members = [...ctx.cohort];
      const offsets = ctx.times.map((t) => filled.get(t)! - cohortMean(grid, members, t));
      stats.sampleCount += offsets.length;
      stats.eventOffsets.push({ type: ctx.event.type, offset: mean(offsets)! });
    }
    if (ctx.overshoot) {
      const readings = ctx.overshoot.times.filter((t) => filled.has(t)).map((t) => filled.get(t)!);
      if (readings.length > 0) stats.overshoots.push(Math.max(0, Math.max(...readings) - ctx.overshoot.setpoint));
    }
  });
  return stats;
}

function classify(stats: SensorStats): SensorClassification {
  const n = stats.eventOffsets.length;
  if (n < MIN_EVENTS || stats.sampleCount < MIN_SAMPLES) return 'insufficient';
  const cold = stats.eventOffsets.filter((e) => e.offset <= -OFFSET_THRESHOLD).length / n;
  const warm = stats.eventOffsets.filter((e) => e.offset >= OFFSET_THRESHOLD).length / n;
  if (cold >= CONSISTENCY_SHARE) return 'cold';
  if (warm >= CONSISTENCY_SHARE) return 'warm';
  return 'representative';
}

function slug(id: string): string {
  return id.replace(/_temperature$/, '').replace(/_/g, '-');
}

const SEVERITY_RANK: Record<RecommendationSeverity, number> = { high: 0, medium: 1, low: 2 };

interface Analyzed {
  out: PlacementSensor;
  stats: SensorStats;
}

type BiasDirection = 'below' | 'above';

// Plain-language summary of a cold/warm sensor's bias. Quotes the first period
// (morning, then returns, then all heat-ups) whose mean offset is on the
// classified side, so a mixed-sign period is never quoted against it.
function biasSummary(a: Analyzed, direction: BiasDirection): { text: string; magnitude: number } {
  const s = a.out;
  const sign = direction === 'below' ? -1 : 1;
  const events = a.stats.eventOffsets;
  const biased = events.filter((e) => sign * e.offset >= OFFSET_THRESHOLD).length;
  const periods: [number | null, string][] = [
    [s.morningOffset, 'during morning heat-ups'],
    [s.returnOffset, 'after returns from Away'],
    [s.averageOffset, 'across all heat-ups'],
  ];
  const match = periods.find(([offset]) => offset !== null && sign * offset >= OFFSET_THRESHOLD);
  const counted = `${s.name} read at least ${OFFSET_THRESHOLD.toFixed(1)} °C ${direction} the house average `
    + `in ${biased} of ${events.length} heat-ups`;
  if (!match) return { text: counted, magnitude: Math.abs(s.averageOffset ?? 0) };
  const offset = match[0]!;
  return { text: `${counted} (${fmt(offset)} °C ${direction} on average ${match[1]})`, magnitude: Math.abs(offset) };
}

// Recommendations are hypotheses: which sensors the thermostat's comfort
// setting uses, and what actually drives heating, aren't known here.
function recommend(analyzed: Analyzed[]): { rec: PlacementRecommendation; magnitude: number }[] {
  const recs: { rec: PlacementRecommendation; magnitude: number }[] = [];
  const overshooting = analyzed
    .filter((a) => a.out.classification !== 'insufficient'
      && a.out.overshoot !== null && a.out.overshoot >= OVERSHOOT_THRESHOLD)
    .sort((a, b) => b.out.overshoot! - a.out.overshoot!);

  analyzed.forEach((a) => {
    const s = a.out;
    if (s.classification === 'cold') {
      const { text, magnitude } = biasSummary(a, 'below');
      const warmer = overshooting.find((o) => o.out.id !== s.id && o.out.classification !== 'cold');
      const effect = warmer
        ? `while warmer rooms such as the ${warmer.out.name} rose ${fmt(warmer.out.overshoot!)} °C above the set point after heating stopped`
        : 'after other rooms are already warm';
      const severity: RecommendationSeverity = warmer && magnitude >= STRONG_OFFSET ? 'high' : 'medium';
      if (s.isThermostat) {
        recs.push({
          magnitude,
          rec: {
            id: `exclude-${slug(s.id)}`,
            severity,
            sensorId: s.id,
            action: 'exclude_from_comfort',
            title: `Review the ${s.name} thermostat sensor`,
            detail: `${text}. If the thermostat's own sensor is in the active comfort setting, it may be keeping the heat on ${effect}; `
              + 'check the comfort setting, and consider excluding it or looking for drafts near the thermostat.',
          },
        });
      } else {
        recs.push({
          magnitude,
          rec: {
            id: `move-${slug(s.id)}`,
            severity,
            sensorId: s.id,
            action: 'move',
            title: `Check the ${s.name} sensor placement`,
            detail: `${text}. If it is in the active comfort setting, it may be keeping the heat on ${effect}; `
              + 'check the comfort setting, and whether the sensor sits near an exterior wall, window, draft or cold floor.',
          },
        });
      }
    } else if ((s.classification === 'representative' || s.classification === 'warm')
      && s.overshoot !== null && s.overshoot >= OVERSHOOT_THRESHOLD) {
      const tracks = s.classification === 'representative'
        ? ` while tracking the house average within ${fmt(s.averageOffset ?? 0)} °C`
        : '';
      recs.push({
        magnitude: s.overshoot,
        rec: {
          id: `include-${slug(s.id)}`,
          severity: 'medium',
          sensorId: s.id,
          action: 'include_in_comfort',
          title: `Consider the ${s.name} sensor for comfort`,
          detail: `${s.name} rose ${fmt(s.overshoot)} °C above the set point on average after the thermostat stopped heating${tracks}. `
            + 'If it isn\'t already in the active comfort setting, adding it may help the thermostat stop heating sooner.',
        },
      });
    } else if (s.classification === 'warm') {
      const { text, magnitude } = biasSummary(a, 'above');
      recs.push({
        magnitude,
        rec: {
          id: `move-${slug(s.id)}`,
          severity: 'low',
          sensorId: s.id,
          action: 'move',
          title: `Check the ${s.name} sensor placement`,
          detail: `${text}. Check whether it sits in direct sun or near a vent, lamp or electronics.`,
        },
      });
    }
  });
  return recs;
}

// Summary when nothing was flagged; only claims what the data covered.
function noChanges(analyzed: Analyzed[]): PlacementRecommendation | null {
  const assessed = analyzed.filter((a) => a.out.classification !== 'insufficient');
  if (assessed.length < MIN_SENSORS_FOR_MEAN) return null;
  const missing = analyzed.filter((a) => a.out.classification === 'insufficient').map((a) => a.out.name);
  const overshootKnown = assessed.every((a) => a.out.overshoot !== null);
  const parts = ['No sensor with enough data read consistently above or below the house average during heat-ups.'];
  parts.push(overshootKnown
    ? `None of them rose ${OVERSHOOT_THRESHOLD.toFixed(1)} °C or more above the set point on average.`
    : 'Thermostat history didn\'t show when heating stopped, so overshoot wasn\'t checked for every room.');
  if (missing.length > 0) parts.push(`Not enough data for ${missing.join(', ')}.`);
  return {
    id: 'no-changes',
    severity: 'low',
    sensorId: null,
    action: 'none',
    title: overshootKnown && missing.length === 0
      ? 'No placement issues found'
      : 'No placement issues found in the available data',
    detail: parts.join(' '),
  };
}

export function analyzePlacement(input: PlacementInput): PlacementInsights {
  const sensors = input.sensors;
  const samples = [...(input.hvac ?? [])].sort((a, b) => a.t - b.t);
  const hvacAvailable = samples.length > 0;
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  // Recorder retention can be shorter than the window; infer mornings before it.
  const historyStart = hvacAvailable ? samples[0].t : null;
  const events = [
    ...(hvacAvailable ? detectHvacEvents(samples, input.timeZone) : []),
    ...inferMorningEvents(sensors, input.timeZone, historyStart ?? Number.POSITIVE_INFINITY),
  ].filter((e) => e.t >= startMs && e.t <= endMs).sort((a, b) => a.t - b.t);

  const grid = align(sensors);
  const contexts = eventContexts(grid, events, samples);
  const analyzed: Analyzed[] = sensors.map((sensor) => {
    const stats = measure(sensor, contexts, grid);
    const offsetsOf = (type?: PlacementEventType) => stats.eventOffsets
      .filter((e) => !type || e.type === type)
      .map((e) => e.offset);
    return {
      stats,
      out: {
        id: sensor.id,
        name: sensor.name,
        isThermostat: sensor.isThermostat,
        averageOffset: roundOrNull(mean(offsetsOf())),
        morningOffset: roundOrNull(mean(offsetsOf('morning'))),
        returnOffset: roundOrNull(mean(offsetsOf('return'))),
        overshoot: roundOrNull(mean(stats.overshoots)),
        sampleCount: stats.sampleCount,
        classification: classify(stats),
      },
    };
  });

  const ranked = recommend(analyzed).sort((a, b) => (
    SEVERITY_RANK[a.rec.severity] - SEVERITY_RANK[b.rec.severity] || b.magnitude - a.magnitude
  ));
  const recommendations = ranked.map((r) => r.rec);
  if (recommendations.length === 0) {
    const summary = noChanges(analyzed);
    if (summary) recommendations.push(summary);
  }

  const mornings = events.filter((e) => e.type === 'morning');
  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    windowDays: input.windowDays,
    unit: '°C',
    coverage: {
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      hvacHistoryAvailable: hvacAvailable,
      hvacHistoryStart: historyStart === null ? null : new Date(Math.max(historyStart, startMs)).toISOString(),
      returnHistoryAvailable: samples.some((sample) => sample.presetMode !== null),
      morningEvents: mornings.length,
      inferredMorningEvents: mornings.filter((e) => e.inferred).length,
      returnEvents: events.filter((e) => e.type === 'return').length,
    },
    sensors: analyzed.map((a) => a.out),
    recommendations,
  };
}
