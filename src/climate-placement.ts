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
// Sensor points are averages over BUCKET_MS windows stamped with the window
// start, so a point's readings may be anywhere in [t, t + BUCKET_MS). Readings
// are compared on a grid with the same spacing.
export const BUCKET_MS = 15 * 60 * 1000;
// A point is carried forward onto the grid only once its whole window has
// passed, and for at most this long after the window's start (its earliest
// possible reading); older points are stale and never compared.
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
// A room peaking this far above the set point counts as overshooting.
export const OVERSHOOT_THRESHOLD = 1.0;
// Overshoot is measured after the thermostat stops heating (reported
// hvac_action), for up to this long, ending early when heating restarts, at
// the next set point, preset or mode change, at a gap in thermostat history or
// at the next event. Heat-ups that don't stop within the limit aren't measured.
export const OVERSHOOT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SATISFACTION_LIMIT_MS = 4 * 60 * 60 * 1000;
// An overshoot window needs at least this many whole sensor windows, and a
// sensor needs points in this share of them, for it to count.
export const MIN_OVERSHOOT_BUCKETS = 2;
export const OVERSHOOT_COVERAGE = 0.75;
// A return from Away is only a heat-up if heating is reported this soon.
export const RETURN_HEAT_LIMIT_MS = 30 * 60 * 1000;
// Rise of the house mean within an hour that marks an inferred morning warm-up
// on days without one observed in thermostat history.
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
  // °C averages over [t, t + BUCKET_MS), t in epoch milliseconds.
  points: { t: number; v: number }[];
}

export interface HvacSample {
  t: number;
  // Home Assistant was unavailable/unknown: a discontinuity in history, not a state.
  gap: boolean;
  // The entity state (heat, cool, heat_cool, auto, off, …).
  hvacMode: string | null;
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
  // 15-minute sensor windows whose readings were dropped because their unit
  // was unknown or conflicting.
  unknownUnitWindows?: number;
  generatedAt?: Date;
}

export interface PlacementEvent {
  type: PlacementEventType;
  t: number;
  // True for morning warm-ups inferred from room temperatures rather than
  // observed in thermostat history.
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
    // Timestamp of the earliest recorded (not unavailable/unknown) thermostat
    // state Home Assistant returned, as returned (null without any). It may be
    // a snapshot of the state in force at the start of the window, so it
    // doesn't prove the recorder kept history continuously from then.
    hvacEarliestStateAt: string | null;
    // Whether the history reports presets; returns from Away need them.
    returnHistoryAvailable: boolean;
    morningEvents: number;
    // How many of morningEvents were inferred from room temperatures.
    inferredMorningEvents: number;
    returnEvents: number;
    // 15-minute sensor windows whose readings were dropped because their unit
    // was unknown or conflicting (windows, not individual readings).
    unknownUnitWindows: number;
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

// Modes in which the thermostat can heat; an unknown mode isn't ruled out.
function canHeat(sample: HvacSample): boolean {
  return !sample.hvacMode || /^(heat|heat_cool|auto)$/i.test(sample.hvacMode);
}

// Whether heating is reported between samples[index] and `limit` ms later,
// without a gap in history, or the preset leaving home/comfort, first.
function heatingReportedWithin(samples: HvacSample[], index: number, limit: number): boolean {
  const from = samples[index].t;
  for (let j = index; j < samples.length && samples[j].t <= from + limit; j += 1) {
    if (samples[j].gap || !isHomePreset(samples[j].presetMode)) return false;
    if (isHeating(samples[j].hvacAction)) return true;
  }
  return false;
}

// Morning warm-ups and returns from Away observed in thermostat history.
// Transitions are only read between consecutive recorded states, never across
// a gap. A morning warm-up is a reported heating start (from a reported
// non-heating action) in the morning window, once per local day. A return is
// an explicit preset change from Away to home/comfort, in a mode that can heat,
// with heating reported within RETURN_HEAT_LIMIT_MS while the preset stays
// home/comfort.
export function detectHvacEvents(samples: HvacSample[], timeZone: string): PlacementEvent[] {
  const clock = localClock(timeZone);
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const returns: PlacementEvent[] = [];
  const mornings = new Map<string, PlacementEvent>();

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.gap || cur.gap) continue;
    const { day, hour } = clock(cur.t);
    const inMorning = hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;

    if (isAway(prev.presetMode) && isHomePreset(cur.presetMode)) {
      const last = returns[returns.length - 1];
      if (canHeat(cur) && heatingReportedWithin(sorted, i, RETURN_HEAT_LIMIT_MS)
        && (!last || cur.t - last.t >= EVENT_WINDOW_MS)) {
        returns.push({ type: 'return', t: cur.t, inferred: false });
      }
    } else if (inMorning && !mornings.has(day) && !isAway(cur.presetMode) && canHeat(cur)
      && isHeating(cur.hvacAction) && prev.hvacAction !== null && !isHeating(prev.hvacAction)) {
      mornings.set(day, { type: 'morning', t: cur.t, inferred: false });
    }
  }

  const morningEvents = [...mornings.values()].filter(
    (m) => !returns.some((r) => Math.abs(r.t - m.t) < EVENT_WINDOW_MS),
  );
  return [...morningEvents, ...returns].sort((a, b) => a.t - b.t);
}

// Sensor points carried forward onto a shared grid, so staggered sensors are
// compared at the same instants. A point is used at grid time g only once its
// window has ended (t + BUCKET_MS <= g) and while g - t <= MAX_READING_AGE_MS,
// so every value used at g was read in [g - MAX_READING_AGE_MS, g].
export interface Grid {
  times: number[];
  values: Map<string, Map<number, number>>;
  // Start of the window of the point each value came from (its earliest
  // possible reading time).
  sources: Map<string, Map<number, number>>;
}

function cleanPoints(points: SensorSeriesInput['points']): SensorSeriesInput['points'] {
  return points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}

export function alignSensors(sensors: SensorSeriesInput[]): Grid {
  const cleaned = sensors.map((sensor) => ({ id: sensor.id, points: cleanPoints(sensor.points) }));
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  cleaned.forEach(({ points }) => {
    if (points.length === 0) return;
    first = Math.min(first, points[0].t);
    last = Math.max(last, points[points.length - 1].t);
  });
  const times: number[] = [];
  if (Number.isFinite(first)) {
    for (let t = Math.ceil((first + BUCKET_MS) / BUCKET_MS) * BUCKET_MS; t <= last + MAX_READING_AGE_MS; t += BUCKET_MS) {
      times.push(t);
    }
  }
  const values = new Map<string, Map<number, number>>();
  const sources = new Map<string, Map<number, number>>();
  cleaned.forEach(({ id, points }) => {
    const filled = new Map<number, number>();
    const from = new Map<number, number>();
    let index = -1;
    times.forEach((t) => {
      while (index + 1 < points.length && points[index + 1].t + BUCKET_MS <= t) index += 1;
      if (index >= 0 && t - points[index].t <= MAX_READING_AGE_MS) {
        filled.set(t, points[index].v);
        from.set(t, points[index].t);
      }
    });
    values.set(id, filled);
    sources.set(id, from);
  });
  return { times, values, sources };
}

// The grid restricted to readings taken within [from, to): a value is kept
// only when its whole window lies inside, so readings from before the start
// (e.g. while the thermostat was off) or after the end never count.
function windowGrid(grid: Grid, from: number, to: number): Grid {
  const values = new Map<string, Map<number, number>>();
  const sources = new Map<string, Map<number, number>>();
  grid.values.forEach((filled, id) => {
    const origin = grid.sources.get(id)!;
    const keptValues = new Map<number, number>();
    const keptSources = new Map<number, number>();
    filled.forEach((v, t) => {
      const source = origin.get(t)!;
      if (source >= from && source + BUCKET_MS <= to) {
        keptValues.set(t, v);
        keptSources.set(t, source);
      }
    });
    values.set(id, keptValues);
    sources.set(id, keptSources);
  });
  return { times: grid.times.filter((t) => t > from && t <= to), values, sources };
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

function stateIndexAt(samples: HvacSample[], t: number): number {
  let found = -1;
  for (let i = 0; i < samples.length && samples[i].t <= t; i += 1) found = i;
  return found;
}

// Only a recorded mode that can't heat (off, cool, …) rules heating out. A
// reported idle action doesn't: some integrations (e.g. an ecobee through
// homekit_controller) report idle for hours after a set point increase.
function rulesOutHeating(sample: HvacSample): boolean {
  return !sample.gap && !!sample.hvacMode && !canHeat(sample);
}

// First recorded state after `t` in which heating is impossible (off/cool) or
// unknown (a gap), if any.
function nextNoHeat(samples: HvacSample[], t: number): number | undefined {
  return samples.find((s) => s.t > t && (s.gap || rulesOutHeating(s)))?.t;
}

// Whether recorded thermostat modes show it couldn't heat throughout
// [from, to]. The earliest returned state may be a snapshot from before the
// recorder's retention, so it is never evidence on its own.
function heatingRuledOut(samples: HvacSample[], from: number, to: number): boolean {
  const index = stateIndexAt(samples, from);
  if (index <= 0 || !rulesOutHeating(samples[index])) return false;
  return samples.every((s) => s.t <= from || s.t > to || rulesOutHeating(s));
}

// Whether the recorded state in force at `t` (the last at or before it) is a
// gap or a mode that can't heat, so an inferred warm-up can't start there; a
// later grid time, once a heat-capable state is in force, still can. As in
// heatingRuledOut, the earliest returned state is a possible snapshot from
// before the recorder's retention, so it is never evidence on its own.
function cannotStartAt(samples: HvacSample[], t: number): boolean {
  const index = stateIndexAt(samples, t);
  return index > 0 && (samples[index].gap || rulesOutHeating(samples[index]));
}

// Morning warm-ups inferred from the house mean rising in the morning window,
// one per local day, on days without an observed morning warm-up and not near
// another observed event, unless a recorded mode that can't heat rules it out.
export function inferMorningEvents(
  sensors: SensorSeriesInput[],
  timeZone: string,
  samples: HvacSample[] = [],
  observed: PlacementEvent[] = [],
): PlacementEvent[] {
  const clock = localClock(timeZone);
  const grid = alignSensors(sensors);
  const events: PlacementEvent[] = [];
  const seenDays = new Set(observed.filter((e) => e.type === 'morning').map((e) => clock(e.t).day));
  grid.times.forEach((t) => {
    const { day, hour } = clock(t);
    if (seenDays.has(day) || hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return;
    if (observed.some((e) => Math.abs(e.t - t) < EVENT_WINDOW_MS)) return;
    if (cannotStartAt(samples, t)) return;
    // The rise must happen while heating is possible: only readings taken
    // from t until the first off/cool state or gap (at most an hour) count.
    const riseEnd = Math.min(t + INFERRED_RISE_WINDOW_MS, nextNoHeat(samples, t) ?? Number.POSITIVE_INFINITY);
    const window = windowGrid(grid, t, riseEnd);
    if (window.times.length < 2) return;
    const first = window.times[0];
    const last = window.times[window.times.length - 1];
    // Same sensors at both instants, so membership can't fake a rise.
    const cohort = [...window.values.entries()]
      .filter(([, filled]) => filled.has(first) && filled.has(last))
      .map(([id]) => id);
    if (cohort.length < MIN_SENSORS_FOR_MEAN) return;
    if (cohortMean(window, cohort, last) - cohortMean(window, cohort, first) < INFERRED_RISE) return;
    if (heatingRuledOut(samples, t, riseEnd)) return;
    seenDays.add(day);
    events.push({ type: 'morning', t, inferred: true });
  });
  return events;
}

interface OvershootWindow {
  from: number;
  to: number;
  setpoint: number;
}

interface EventContext {
  event: PlacementEvent;
  cohort: Set<string>;
  times: number[];
  // The grid restricted to readings taken within the event window.
  grid: Grid;
  // Post-satisfaction window and the set point in force; null when the
  // thermostat history can't establish it.
  overshoot: OvershootWindow | null;
}

interface HeatUpEnd {
  // When heating ended (satisfied or interrupted), or a gap; null if unknown.
  at: number | null;
  // True only when the thermostat was satisfied: it went from heating to a
  // reported non-heating action in a mode that can heat, with the mode, set
  // point and preset unchanged since the event. Anything else (off/cool, any
  // set point, preset or mode change during the heat-up, a gap) is an
  // interruption.
  satisfied: boolean;
}

// How the heat-up after an observed event ended, within SATISFACTION_LIMIT_MS.
function heatUpEnd(samples: HvacSample[], event: PlacementEvent): HeatUpEnd {
  const unknown = { at: null, satisfied: false };
  const index = stateIndexAt(samples, event.t);
  if (index < 0 || samples[index].gap) return unknown;
  let heating = isHeating(samples[index].hvacAction);
  for (let i = index + 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const sample = samples[i];
    if (sample.t > event.t + SATISFACTION_LIMIT_MS) return unknown;
    if (sample.gap) return { at: sample.t, satisfied: false };
    if (sample.hvacMode !== prev.hvacMode || sample.setpoint !== prev.setpoint
      || sample.presetMode !== prev.presetMode) {
      return { at: sample.t, satisfied: false };
    }
    if (isHeating(sample.hvacAction)) {
      heating = true;
    } else if (heating && (sample.hvacAction !== null || !canHeat(sample))) {
      return { at: sample.t, satisfied: canHeat(sample) && sample.hvacAction !== null };
    }
  }
  return unknown;
}

function overshootWindow(
  samples: HvacSample[],
  event: PlacementEvent,
  nextEvent: number,
): OvershootWindow | null {
  if (event.inferred) return null;
  const end = heatUpEnd(samples, event);
  if (!end.satisfied || end.at === null) return null;
  const from = end.at;
  const state = samples[stateIndexAt(samples, from)];
  if (state.setpoint === null) return null;
  const change = samples.find((s) => s.t > from && (s.gap || isHeating(s.hvacAction)
    || s.setpoint !== state.setpoint || s.presetMode !== state.presetMode || s.hvacMode !== state.hvacMode));
  const to = Math.min(from + OVERSHOOT_WINDOW_MS, nextEvent, change?.t ?? Number.POSITIVE_INFINITY);
  return { from, to, setpoint: state.setpoint };
}

function eventContexts(grid: Grid, events: PlacementEvent[], samples: HvacSample[]): EventContext[] {
  return events.map((event, index) => {
    // An inferred window also ends at the first recorded state in which the
    // thermostat couldn't heat (off/cool), so later readings never count.
    const stopped = event.inferred
      ? samples.find((s) => s.t > event.t && rulesOutHeating(s))?.t ?? null
      : heatUpEnd(samples, event).at;
    const gap = samples.find((s) => s.t > event.t && s.gap)?.t;
    const end = Math.min(event.t + EVENT_WINDOW_MS, stopped ?? Number.POSITIVE_INFINITY, gap ?? Number.POSITIVE_INFINITY);
    // Only readings taken within [event, end) count.
    const window = windowGrid(grid, event.t, end);
    const { cohort, times } = cohortAt(window, window.times);
    const nextEvent = events[index + 1]?.t ?? Number.POSITIVE_INFINITY;
    return {
      event, cohort: new Set(cohort), times, grid: window, overshoot: overshootWindow(samples, event, nextEvent),
    };
  });
}

// Peak above the set point from the sensor's own points that lie wholly inside
// the window; null unless they cover enough of it.
function overshootIn(points: SensorSeriesInput['points'], window: OvershootWindow): number | null {
  const firstSlot = Math.ceil(window.from / BUCKET_MS);
  const slots = Math.floor(window.to / BUCKET_MS) - firstSlot;
  if (slots < MIN_OVERSHOOT_BUCKETS) return null;
  const inside = points.filter((p) => p.t >= window.from && p.t + BUCKET_MS <= window.to);
  const covered = new Set(inside.map((p) => Math.floor(p.t / BUCKET_MS))).size;
  if (covered < OVERSHOOT_COVERAGE * slots) return null;
  return Math.max(0, Math.max(...inside.map((p) => p.v)) - window.setpoint);
}

interface SensorStats {
  sensor: SensorSeriesInput;
  eventOffsets: { type: PlacementEventType; offset: number; inferred: boolean }[];
  overshoots: number[];
  sampleCount: number;
  // Sum of |offset| over all samples, for the mean absolute difference.
  absoluteOffsetSum: number;
}

function measure(sensor: SensorSeriesInput, contexts: EventContext[]): SensorStats {
  const stats: SensorStats = {
    sensor, eventOffsets: [], overshoots: [], sampleCount: 0, absoluteOffsetSum: 0,
  };
  const points = cleanPoints(sensor.points);
  contexts.forEach((ctx) => {
    if (ctx.cohort.has(sensor.id) && ctx.times.length >= MIN_EVENT_SAMPLES) {
      const members = [...ctx.cohort];
      const filled = ctx.grid.values.get(sensor.id)!;
      const offsets = ctx.times.map((t) => filled.get(t)! - cohortMean(ctx.grid, members, t));
      stats.sampleCount += offsets.length;
      stats.absoluteOffsetSum += offsets.reduce((sum, o) => sum + Math.abs(o), 0);
      stats.eventOffsets.push({ type: ctx.event.type, offset: mean(offsets)!, inferred: ctx.event.inferred });
    }
    const overshoot = ctx.overshoot ? overshootIn(points, ctx.overshoot) : null;
    if (overshoot !== null) stats.overshoots.push(overshoot);
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

// ". N of these M heat-ups were inferred …" when any of a sensor's heat-ups
// were inferred from room temperatures; '' otherwise.
function inferredDisclosure(a: Analyzed): string {
  const events = a.stats.eventOffsets;
  const inferred = events.filter((e) => e.inferred).length;
  return inferred > 0
    ? `. ${inferred} of these ${events.length} heat-ups were inferred from room temperatures, not thermostat history`
    : '';
}

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
  const provenance = inferredDisclosure(a);
  if (!match) return { text: `${counted}${provenance}`, magnitude: Math.abs(s.averageOffset ?? 0) };
  const offset = match[0]!;
  return {
    text: `${counted} (${fmt(offset)} °C ${direction} on average ${match[1]})${provenance}`,
    magnitude: Math.abs(offset),
  };
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
      // Other rooms are only described as warm when overshoot was measured;
      // otherwise the hypothesis rests on the relative offset alone.
      const effect = warmer
        ? `it may be keeping the heat on while warmer rooms such as the ${warmer.out.name} peaked ${fmt(warmer.out.overshoot!)} °C above the set point on average after heating stopped`
        : 'the thermostat may keep heating to satisfy it';
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
            detail: `${text}. If the thermostat's own sensor is in the active comfort setting, ${effect}; `
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
            detail: `${text}. If it is in the active comfort setting, ${effect}; `
              + 'check the comfort setting, and whether the sensor sits near an exterior wall, window, draft or cold floor.',
          },
        });
      }
    } else if ((s.classification === 'representative' || s.classification === 'warm')
      && s.overshoot !== null && s.overshoot >= OVERSHOOT_THRESHOLD) {
      // Mean absolute difference, so opposite offsets don't cancel out.
      const tracks = s.classification === 'representative' && a.stats.sampleCount > 0
        ? `, while reading ${fmt(a.stats.absoluteOffsetSum / a.stats.sampleCount)} °C from the house average on average during heat-ups`
        : '';
      recs.push({
        magnitude: s.overshoot,
        rec: {
          id: `include-${slug(s.id)}`,
          severity: 'medium',
          sensorId: s.id,
          action: 'include_in_comfort',
          title: `Consider the ${s.name} sensor for comfort`,
          detail: `${s.name} peaked ${fmt(s.overshoot)} °C above the set point on average after the thermostat stopped heating${tracks}${inferredDisclosure(a)}. `
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
function noChanges(analyzed: Analyzed[], events: PlacementEvent[]): PlacementRecommendation | null {
  const assessed = analyzed.filter((a) => a.out.classification !== 'insufficient');
  if (assessed.length < MIN_SENSORS_FOR_MEAN) return null;
  const missing = analyzed.filter((a) => a.out.classification === 'insufficient').map((a) => a.out.name);
  const overshootKnown = assessed.every((a) => a.out.overshoot !== null);
  const parts = ['No sensor with enough data read consistently above or below the house average during heat-ups.'];
  parts.push(overshootKnown
    ? `None of them peaked ${OVERSHOOT_THRESHOLD.toFixed(1)} °C or more above the set point on average after heating stopped.`
    : 'Thermostat history didn\'t show when heating stopped, so overshoot wasn\'t checked for every room.');
  if (missing.length > 0) parts.push(`Not enough data for ${missing.join(', ')}.`);
  const inferred = events.filter((e) => e.inferred).length;
  if (inferred > 0) {
    parts.push(`${inferred} of the ${events.length} heat-ups were inferred from room temperatures, not thermostat history.`);
  }
  return {
    id: 'no-changes',
    severity: 'low',
    sensorId: null,
    action: 'none',
    title: overshootKnown && missing.length === 0 && inferred === 0
      ? 'No placement issues found'
      : 'No placement issues found in the available data',
    detail: parts.join(' '),
  };
}

export function analyzePlacement(input: PlacementInput): PlacementInsights {
  const sensors = input.sensors;
  const samples = [...(input.hvac ?? [])].sort((a, b) => a.t - b.t);
  // History with only unavailable/unknown rows says nothing about the thermostat.
  const recorded = samples.filter((s) => !s.gap);
  const hvacAvailable = recorded.length > 0;
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  const earliestState = hvacAvailable ? recorded[0].t : null;
  // Recorder retention can be shorter than the window and the earliest state
  // may be a snapshot, so mornings are inferred for any day without an
  // observed one rather than only before the earliest state.
  const inWindow = (e: PlacementEvent) => e.t >= startMs && e.t <= endMs;
  const observed = detectHvacEvents(samples, input.timeZone).filter(inWindow);
  const events = [
    ...observed,
    ...inferMorningEvents(sensors, input.timeZone, samples, observed).filter(inWindow),
  ].sort((a, b) => a.t - b.t);

  const grid = alignSensors(sensors);
  const contexts = eventContexts(grid, events, samples);
  const analyzed: Analyzed[] = sensors.map((sensor) => {
    const stats = measure(sensor, contexts);
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
    const summary = noChanges(analyzed, events);
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
      hvacEarliestStateAt: earliestState === null ? null : new Date(earliestState).toISOString(),
      returnHistoryAvailable: recorded.some((sample) => sample.presetMode !== null),
      morningEvents: mornings.length,
      inferredMorningEvents: mornings.filter((e) => e.inferred).length,
      returnEvents: events.filter((e) => e.type === 'return').length,
      unknownUnitWindows: input.unknownUnitWindows ?? 0,
    },
    sensors: analyzed.map((a) => a.out),
    recommendations,
  };
}
