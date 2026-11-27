// Pure analysis behind GET /climate/placement-insights. An Ecobee heats and
// cools to the average of the sensors in the active comfort setting (with
// Follow Me, only the occupied ones), which the thermostat reports as its
// current temperature. This finds the room sensors that skew that average —
// above all during the Sleep → Home warm-up (Smart Recovery), but also while
// cooling and during other heat-ups — says when rooms are warm (or cool)
// without the system running, and suggests what to change. No I/O here — see
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
// Smart Recovery can start heating this long before Home starts; a wake-up's
// warm-up is the heating run around the Sleep → Home change within
// [start - WAKE_LEAD_MS, start + WAKE_TAIL_MS].
export const WAKE_LEAD_MS = 3 * 60 * 60 * 1000;
export const WAKE_TAIL_MS = 2 * 60 * 60 * 1000;
// Rooms are checked against the Home set point this long after Home starts.
export const WAKE_OVERSHOOT_MS = 2 * 60 * 60 * 1000;
// Heating / cooling runs separated by shorter idle spells are one run.
export const HEAT_RUN_MERGE_MS = 20 * 60 * 1000;
export const COOL_RUN_MERGE_MS = 30 * 60 * 1000;
// Other rooms this far over (or under) count as affected by a skewed sensor.
export const AFFECTED_THRESHOLD = 0.5;
// With Follow Me, a sensor occupied less than this share (after waking, or
// while Home) barely counted toward the average, so it isn't blamed.
export const FOLLOW_ME_MIN_SHARE = 0.2;
// occupiedShare needs occupancy known for this share of the time.
export const OCCUPANCY_COVERAGE = 0.75;
// A Sleep setback or Smart Recovery warm-up at least this large is mentioned.
export const SETBACK_NOTE = 2.0;
export const LONG_RAMP_MS = 60 * 60 * 1000;
// A day's mean offset at least this far from the house counts as a cold/warm day.
export const DAILY_THRESHOLD = 0.5;
// Passive warmth (coolness): the comfort average this far over the heating set
// point (under the cooling set point) while the system is idle, for at least
// PASSIVE_SHARE of at least PASSIVE_MIN_SAMPLES idle 15-minute points.
export const PASSIVE_THRESHOLD = 1.0;
export const PASSIVE_SHARE = 0.5;
export const PASSIVE_MIN_SAMPLES = 96;
// Heating running for less than this share of the window counts as rare.
export const RARE_RUNTIME_SHARE = 0.1;
// Which room sensors Ecobee averages is estimated from the thermostat's
// reading: subsets of rooms within FIT_MARGIN of the best fit, which must be
// within FIT_TOLERANCE on average over at least FIT_MIN_SAMPLES points.
export const FIT_TOLERANCE = 0.2;
export const FIT_MARGIN = 0.1;
export const FIT_MIN_SAMPLES = 24;
const MAX_FIT_ROOMS = 8;

export const COMFORT_AVERAGE_NAME = 'Thermostat (Ecobee average)';

export type SensorClassification = 'cold' | 'warm' | 'representative' | 'insufficient';
export type SensorVerdict = 'cold_outlier' | 'warm_outlier' | 'representative' | 'insufficient';
export type RecommendationSeverity = 'high' | 'medium' | 'low';
export type RecommendationAction = 'move' | 'exclude_from_comfort' | 'include_in_comfort' | 'none';
export type PlacementEventType = 'wake' | 'morning' | 'return' | 'cooling';
export type ComfortSetting = 'home' | 'sleep' | 'away';
export const COMFORT_SETTINGS: readonly ComfortSetting[] = ['home', 'sleep', 'away'];
export type PlacementMode = 'heating' | 'cooling';
export type PlacementPeriod = 'wake' | 'sleep' | 'home' | 'return';

export interface OccupancySample {
  t: number;
  // null: unavailable/unknown, so occupancy isn't known until the next value.
  occupied: boolean | null;
}

// The thermostat's comfort setting (`select.<thermostat>_current_mode`).
export interface ComfortSample {
  t: number;
  setting: string | null;
}

export interface SensorSeriesInput {
  id: string;
  name: string;
  // The thermostat's current temperature: Ecobee's average of the sensors in
  // the comfort setting, not a room of its own.
  isThermostat: boolean;
  // °C averages over [t, t + BUCKET_MS), t in epoch milliseconds.
  points: { t: number; v: number }[];
  // Change-driven occupancy (each value holds until the next); null or absent
  // when the sensor has no occupancy history.
  occupancy?: OccupancySample[] | null;
}

// Which sensor ids each comfort setting uses (null = unknown), and Follow Me.
export interface ParticipationConfig {
  home: string[] | null;
  sleep: string[] | null;
  away: string[] | null;
  followMe: boolean | null;
}

export type Participation = Record<ComfortSetting, boolean | null>;

export interface HvacSample {
  t: number;
  // History was unavailable/unknown: a discontinuity, not a state.
  gap: boolean;
  // The entity state (heat, cool, heat_cool, auto, off, …).
  hvacMode: string | null;
  hvacAction: string | null;
  // The comfort setting (or Home Assistant preset) in force.
  presetMode: string | null;
  // Heating set point in °C (`temperature`, else `target_temp_low`).
  setpoint: number | null;
  // Cooling set point in °C (`temperature` in cool mode, else
  // `target_temp_high`); absent/null when unknown.
  coolSetpoint?: number | null;
}

// The most recent cooling within the past year. Data fields default to the
// heating data (when the service fetched one range covering both).
export interface CoolingInput {
  start: Date;
  end: Date;
  sensors?: SensorSeriesInput[];
  hvac?: HvacSample[] | null;
  comfort?: ComfortSample[] | null;
}

export interface PlacementInput {
  start: Date;
  end: Date;
  windowDays: number;
  timeZone: string;
  sensors: SensorSeriesInput[];
  // null when thermostat history could not be read.
  hvac: HvacSample[] | null;
  // Comfort setting history; where known it takes precedence over the samples' presetMode.
  comfort?: ComfortSample[] | null;
  participation?: ParticipationConfig | null;
  // null when no cooling was recorded in the past year; absent when not checked.
  cooling?: CoolingInput | null;
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

export interface PeriodOffsets {
  sleep: number | null;
  wake: number | null;
  home: number | null;
  heatingRuns: number | null;
  cooling: number | null;
}

export interface SensorConsistency {
  days: number;
  coldDays: number;
  warmDays: number;
  coolingDays: number;
  coolingColdDays: number;
  coolingWarmDays: number;
}

export interface PlacementSensor {
  id: string;
  name: string;
  isThermostat: boolean;
  // Offsets from the average of the room sensors (the thermostat's averaged
  // reading excluded) during heat-ups.
  averageOffset: number | null;
  morningOffset: number | null;
  returnOffset: number | null;
  overshoot: number | null;
  sampleCount: number;
  classification: SensorClassification;
  // Offsets from the effective comfort average (the thermostat's reading,
  // else the participating / occupied sensors' mean).
  wakeOffset: number | null;
  coolingOffset: number | null;
  participation: Participation;
  occupiedShare: { wake: number | null; home: number | null };
  verdict: SensorVerdict | null;
  verdictSummary: string | null;
  periodOffsets: PeriodOffsets;
  wakeOvershoot: number | null;
  coolingUndershoot: number | null;
  consistency: SensorConsistency | null;
  recommendationIds: string[];
}

export interface PlacementRecommendation {
  id: string;
  severity: RecommendationSeverity;
  sensorId: string | null;
  action: RecommendationAction;
  title: string;
  detail: string;
  mode: PlacementMode | null;
  period: PlacementPeriod | null;
  comfortSetting: ComfortSetting | null;
  affectedSensorIds: string[];
  likelyCauses: string[];
}

export interface PassiveSummary {
  // Share of idle points with the comfort average past the set point by
  // PASSIVE_THRESHOLD, and its mean distance past the set point (°C).
  share: number;
  offset: number;
}

export interface PlacementInsights {
  generatedAt: string;
  windowDays: number;
  unit: '°C';
  coverage: {
    start: string;
    end: string;
    hvacHistoryAvailable: boolean;
    // Timestamp of the earliest recorded thermostat state returned, as
    // returned (null without any). It may be a snapshot of the state in force
    // before the window, so it doesn't prove continuous history from then.
    hvacEarliestStateAt: string | null;
    // Whether the history reports comfort settings; returns from Away need them.
    returnHistoryAvailable: boolean;
    // Morning warm-ups, including wake-ups with heating.
    morningEvents: number;
    // How many of morningEvents were inferred from room temperatures.
    inferredMorningEvents: number;
    returnEvents: number;
    // 15-minute sensor windows whose readings were dropped because their unit
    // was unknown or conflicting (windows, not individual readings).
    unknownUnitWindows: number;
    participationConfigured: boolean;
    followMe: boolean | null;
    occupancyAvailable: boolean;
    comfortScheduleAvailable: boolean;
    // Sleep → Home changes in the window (with or without heating).
    wakeEvents: number;
    coolingFrom: string | null;
    coolingTo: string | null;
    coolingEvents: number;
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

// Index of the first element of the ascending `sorted` whose key is > t
// (`strict`) or >= t; sorted.length if none.
function firstIndexAfter<T>(sorted: T[], t: number, key: (item: T) => number, strict: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const k = key(sorted[mid]);
    if (strict ? k <= t : k < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const timeOf = (item: { t: number }) => item.t;
const itself = (n: number) => n;

// First of the time-sorted items with from < t <= limit matching `match`.
function findAfter<T extends { t: number }>(
  sorted: T[],
  from: number,
  limit: number,
  match: (item: T) => boolean,
): T | undefined {
  for (let i = firstIndexAfter(sorted, from, timeOf, true); i < sorted.length && sorted[i].t <= limit; i += 1) {
    if (match(sorted[i])) return sorted[i];
  }
  return undefined;
}

// Whether any of the time-sorted events lies within EVENT_WINDOW_MS of t.
function nearEvent(sorted: PlacementEvent[], t: number): boolean {
  const next = sorted[firstIndexAfter(sorted, t - EVENT_WINDOW_MS, timeOf, true)];
  return next !== undefined && next.t < t + EVENT_WINDOW_MS;
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
    (m) => !nearEvent(returns, m.t),
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
// (e.g. while the thermostat was off) or after the end never count. Only the
// grid times in (from, to] are visited.
function windowGrid(grid: Grid, from: number, to: number): Grid {
  const times = grid.times.slice(
    firstIndexAfter(grid.times, from, itself, true),
    firstIndexAfter(grid.times, to, itself, true),
  );
  const values = new Map<string, Map<number, number>>();
  const sources = new Map<string, Map<number, number>>();
  grid.values.forEach((filled, id) => {
    const origin = grid.sources.get(id)!;
    const keptValues = new Map<number, number>();
    const keptSources = new Map<number, number>();
    times.forEach((t) => {
      const source = origin.get(t);
      if (source !== undefined && source >= from && source + BUCKET_MS <= to) {
        keptValues.set(t, filled.get(t)!);
        keptSources.set(t, source);
      }
    });
    values.set(id, keptValues);
    sources.set(id, keptSources);
  });
  return { times, values, sources };
}


// Sensors fresh at enough of `times`, and the times at which all of them are fresh.
// Only the sensors in `ids` (the rooms) are considered.
function cohortAt(grid: Grid, times: number[], ids: Set<string>): { cohort: string[]; times: number[] } {
  if (times.length === 0) return { cohort: [], times: [] };
  const cohort = [...grid.values.entries()]
    .filter(([id, filled]) => ids.has(id)
      && times.filter((t) => filled.has(t)).length >= COHORT_COVERAGE * times.length)
    .map(([id]) => id);
  if (cohort.length < MIN_SENSORS_FOR_MEAN) return { cohort: [], times: [] };
  return { cohort, times: times.filter((t) => cohort.every((id) => grid.values.get(id)!.has(t))) };
}

function cohortMean(grid: Grid, cohort: string[], t: number): number {
  return mean(cohort.map((id) => grid.values.get(id)!.get(t)!))!;
}

// Index of the last state at or before t in the time-sorted samples; -1 if none.
function stateIndexAt(samples: HvacSample[], t: number): number {
  return firstIndexAfter(samples, t, timeOf, true) - 1;
}

// A recorded mode that can't heat (off, cool, …), or a reported cooling action
// (e.g. in heat_cool/auto), rules heating out. A reported idle action doesn't:
// some integrations (e.g. an ecobee through homekit_controller) report idle for
// hours after a set point increase.
function rulesOutHeating(sample: HvacSample): boolean {
  return !sample.gap && ((!!sample.hvacMode && !canHeat(sample)) || /cool/i.test(sample.hvacAction ?? ''));
}

// For each index i of the time-sorted samples, the time of the first state at
// or after i in which heating is impossible (off/cool) or unknown (a gap).
function noHeatFrom(samples: HvacSample[]): number[] {
  const next = new Array<number>(samples.length + 1).fill(Number.POSITIVE_INFINITY);
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    next[i] = samples[i].gap || rulesOutHeating(samples[i]) ? samples[i].t : next[i + 1];
  }
  return next;
}

// Whether recorded thermostat modes show it couldn't heat throughout
// [from, to]. The earliest returned state may be a snapshot from before the
// recorder's retention, so it is never evidence on its own. Only the states
// in force during [from, to] are visited.
function heatingRuledOut(samples: HvacSample[], from: number, to: number): boolean {
  const index = stateIndexAt(samples, from);
  if (index <= 0 || !rulesOutHeating(samples[index])) return false;
  for (let i = index + 1; i < samples.length && samples[i].t <= to; i += 1) {
    if (!rulesOutHeating(samples[i])) return false;
  }
  return true;
}

// Whether the recorded state in force at `t` (the last at or before it) is a
// gap, a mode that can't heat or a cooling action, so an inferred warm-up
// can't start there; a later grid time, once a heat-capable state is in force,
// still can. A gap blocks at any index, including the first row. As in
// heatingRuledOut, an earliest returned state that isn't a gap is a possible
// snapshot from before the recorder's retention, so its mode is never
// evidence on its own.
function cannotStartAt(samples: HvacSample[], t: number): boolean {
  const index = stateIndexAt(samples, t);
  if (index < 0) return false;
  return samples[index].gap || (index > 0 && rulesOutHeating(samples[index]));
}

// Rise of one sensor from its first to its last reading taken within
// [from, to) (whole 15-minute windows inside), or null with fewer than two.
function riseWithin(points: SensorSeriesInput['points'], from: number, to: number): number | null {
  const first = firstIndexAfter(points, from, timeOf, false);
  const last = firstIndexAfter(points, to - BUCKET_MS, timeOf, true) - 1;
  return last > first ? points[last].v - points[first].v : null;
}

// Morning warm-ups inferred from the house warming in the morning window, one
// per local day, on days without an observed morning warm-up and not near
// another observed event, unless a recorded mode that can't heat rules it out.
// Each sensor's rise is taken from its own first and last readings in the
// window, so sparse or staggered sensors still count, and the house rise is
// their mean (sensors without two readings are left out, so membership can't
// fake a rise). Per-sensor arrays and thermostat states are searched by
// binary search, so each candidate only touches its own window.
export function inferMorningEvents(
  sensors: SensorSeriesInput[],
  timeZone: string,
  hvac: HvacSample[] = [],
  observed: PlacementEvent[] = [],
): PlacementEvent[] {
  const clock = localClock(timeZone);
  const samples = [...hvac].sort((a, b) => a.t - b.t);
  const noHeat = noHeatFrom(samples);
  const series = sensors.map((sensor) => cleanPoints(sensor.points)).filter((points) => points.length >= 2);
  const events: PlacementEvent[] = [];
  if (series.length < MIN_SENSORS_FOR_MEAN) return events;
  const first = Math.min(...series.map((points) => points[0].t));
  const last = Math.max(...series.map((points) => points[points.length - 1].t));
  const seenDays = new Set(observed.filter((e) => e.type === 'morning' || e.type === 'wake').map((e) => clock(e.t).day));
  const nearby = [...observed].sort((a, b) => a.t - b.t);
  for (let t = Math.ceil(first / BUCKET_MS) * BUCKET_MS; t <= last; t += BUCKET_MS) {
    const { day, hour } = clock(t);
    if (seenDays.has(day) || hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) continue;
    if (nearEvent(nearby, t)) continue;
    if (cannotStartAt(samples, t)) continue;
    // The rise must happen while heating is possible: only readings taken
    // from t until the first off/cool state or gap (at most an hour) count.
    const riseEnd = Math.min(t + INFERRED_RISE_WINDOW_MS, noHeat[firstIndexAfter(samples, t, timeOf, true)]);
    const rises = series.map((points) => riseWithin(points, t, riseEnd)).filter((r): r is number => r !== null);
    if (rises.length < MIN_SENSORS_FOR_MEAN || mean(rises)! < INFERRED_RISE) continue;
    if (heatingRuledOut(samples, t, riseEnd)) continue;
    seenDays.add(day);
    events.push({ type: 'morning', t, inferred: true });
  }
  return events;
}

interface OvershootWindow {
  from: number;
  to: number;
  setpoint: number;
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
    } else if (heating) {
      // An unknown action after heating ends the heat-up unsatisfied: a later
      // idle can't be told apart from the end of heating.
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
  const change = findAfter(samples, from, from + OVERSHOOT_WINDOW_MS, (s) => s.gap || isHeating(s.hvacAction)
    || s.setpoint !== state.setpoint || s.presetMode !== state.presetMode || s.hvacMode !== state.hvacMode);
  const to = Math.min(from + OVERSHOOT_WINDOW_MS, nextEvent, change?.t ?? Number.POSITIVE_INFINITY);
  return { from, to, setpoint: state.setpoint };
}

// Peak above the set point from the sensor's own (time-sorted) points that
// lie wholly inside the window; null unless they cover enough of it. Only the
// window's points are visited.
function overshootIn(points: SensorSeriesInput['points'], window: OvershootWindow): number | null {
  const firstSlot = Math.ceil(window.from / BUCKET_MS);
  const slots = Math.floor(window.to / BUCKET_MS) - firstSlot;
  if (slots < MIN_OVERSHOOT_BUCKETS) return null;
  const inside = points.slice(
    firstIndexAfter(points, window.from, timeOf, false),
    firstIndexAfter(points, window.to - BUCKET_MS, timeOf, true),
  );
  const covered = new Set(inside.map((p) => Math.floor(p.t / BUCKET_MS))).size;
  if (covered < OVERSHOOT_COVERAGE * slots) return null;
  return Math.max(0, Math.max(...inside.map((p) => p.v)) - window.setpoint);
}

// ---------------------------------------------------------------------------
// Comfort settings, occupancy and heating / cooling runs.

interface SettingChange {
  t: number;
  setting: ComfortSetting | null;
}

interface Run {
  from: number;
  to: number;
}

const SETTING_LABEL: Record<ComfortSetting, string> = { home: 'Home', sleep: 'Sleep', away: 'Away' };

function normalizeSetting(raw: string | null): ComfortSetting | null {
  if (!raw) return null;
  if (/sleep/i.test(raw)) return 'sleep';
  if (/away|vacation/i.test(raw)) return 'away';
  if (/home|comfort/i.test(raw)) return 'home';
  return null;
}

function isCooling(action: string | null): boolean {
  return !!action && /cool/i.test(action);
}

function coolPointOf(sample: HvacSample): number | null {
  if (sample.coolSetpoint !== undefined && sample.coolSetpoint !== null) return sample.coolSetpoint;
  return /^cool$/i.test(sample.hvacMode ?? '') ? sample.setpoint : null;
}

// Comfort setting changes, time-sorted. A known comfort setting (the Ecobee
// select) takes precedence; while it is unknown (before its first value, or
// unavailable) the thermostat's preset is used. Without any known comfort
// setting the timeline is the preset history. An unknown preset (or a gap) is
// kept as unknown, so an earlier preset isn't carried past it.
function settingTimeline(comfort: ComfortSample[] | null | undefined, samples: HvacSample[]): SettingChange[] {
  const presets = samples
    .map((s) => ({ t: s.t, comfort: false, setting: s.gap ? null : normalizeSetting(s.presetMode) }));
  const known = !!comfort && comfort.some((c) => normalizeSetting(c.setting) !== null);
  const events = known
    ? [...comfort!.map((c) => ({ t: c.t, comfort: true, setting: normalizeSetting(c.setting) })), ...presets]
      .sort((a, b) => a.t - b.t)
    : presets;
  let select: ComfortSetting | null = null;
  let preset: ComfortSetting | null = null;
  const changes: SettingChange[] = [];
  events.forEach((e, i) => {
    if (e.comfort) select = e.setting;
    else preset = e.setting;
    // Settle all events at one time before recording the setting in force.
    if (events[i + 1]?.t === e.t) return;
    const setting = select ?? preset;
    if (changes.length === 0 || changes[changes.length - 1].setting !== setting) changes.push({ t: e.t, setting });
  });
  return changes.some((c) => c.setting !== null) ? changes : [];
}

function settingAt(timeline: SettingChange[], t: number): ComfortSetting | null {
  const index = firstIndexAfter(timeline, t, timeOf, true) - 1;
  return index >= 0 ? timeline[index].setting : null;
}

// Thermostat states with presetMode set to the comfort setting in force, plus a
// copy of the state in force at each setting change, so heat-up and return
// detection see setting changes. Without comfort history the samples are kept.
function mergeComfort(samples: HvacSample[], timeline: SettingChange[], comfort: boolean): HvacSample[] {
  if (!comfort || samples.length === 0) return samples;
  const merged: HvacSample[] = [];
  let preset: string | null = null;
  let si = 0;
  let ci = 0;
  while (si < samples.length || ci < timeline.length) {
    if (ci < timeline.length && (si >= samples.length || timeline[ci].t <= samples[si].t)) {
      const { t } = timeline[ci];
      preset = timeline[ci].setting;
      ci += 1;
      const prev = merged[merged.length - 1];
      if (prev && !(si < samples.length && samples[si].t === t)) {
        merged.push({ ...prev, t, presetMode: prev.gap ? null : preset });
      }
    } else {
      merged.push({ ...samples[si], presetMode: samples[si].gap ? null : preset });
      si += 1;
    }
  }
  return merged;
}

// Intervals within [from, to] whose state in force is `active`, merged across
// shorter known-idle spells than `merge` (never across a gap or an unknown
// action). Only the states in force then are visited.
function runsWithin(
  samples: HvacSample[],
  from: number,
  to: number,
  active: (sample: HvacSample) => boolean,
  merge: number,
): Run[] {
  const runs: Run[] = [];
  let bridgeable = false;
  for (let i = Math.max(0, stateIndexAt(samples, from)); i < samples.length && samples[i].t < to; i += 1) {
    const sample = samples[i];
    if (!sample.gap && active(sample)) {
      const a = Math.max(from, sample.t);
      const b = Math.min(to, samples[i + 1]?.t ?? to);
      const prev = runs[runs.length - 1];
      if (b > a && prev && bridgeable && a - prev.to <= merge) prev.to = Math.max(prev.to, b);
      else if (b > a) runs.push({ from: a, to: b });
      if (b > a) bridgeable = true;
    } else if (sample.gap || sample.hvacAction === null) {
      bridgeable = false;
    }
  }
  return runs;
}

const heatingNow = (sample: HvacSample) => isHeating(sample.hvacAction);
const coolingNow = (sample: HvacSample) => isCooling(sample.hvacAction);

interface Wake {
  // When Home started after Sleep, and when the next setting started.
  h: number;
  next: number;
  // The warm-up's heating: from the first run in the WAKE_LEAD_MS before Home
  // (Smart Recovery preheats, possibly finishing before Home) to the end of
  // the last one starting before Home; else the first run after Home.
  run: Run | null;
  // Home set point minus the set point before the warm-up.
  setback: number | null;
  // Heating time within [h - WAKE_LEAD_MS, h + WAKE_TAIL_MS].
  heatingMs: number;
}

// Sleep → Home changes in [from, to], each with its warm-up: the heating runs
// in the lead window before the change (ending before it or crossing it),
// else the first run after it.
function detectWakes(samples: HvacSample[], timeline: SettingChange[], from: number, to: number): Wake[] {
  const wakes: Wake[] = [];
  for (let i = 1; i < timeline.length; i += 1) {
    const h = timeline[i].t;
    if (timeline[i - 1].setting === 'sleep' && timeline[i].setting === 'home' && h >= from && h <= to) {
      const next = timeline[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      const runs = runsWithin(samples, h - WAKE_LEAD_MS, Math.min(h + WAKE_TAIL_MS, next), heatingNow, HEAT_RUN_MERGE_MS);
      const before = runs.filter((r) => r.from < h);
      const run = before.length > 0
        ? { from: before[0].from, to: before[before.length - 1].to }
        : runs.find((r) => r.from >= h) ?? null;
      let setback: number | null = null;
      if (run) {
        const before = samples[stateIndexAt(samples, Math.min(run.from, h) - 1)];
        const home = samples[stateIndexAt(samples, h + BUCKET_MS)];
        if (before && home && before.setpoint !== null && home.setpoint !== null) {
          setback = home.setpoint - before.setpoint;
        }
      }
      wakes.push({
        h, next, run, setback, heatingMs: runs.reduce((sum, r) => sum + r.to - r.from, 0),
      });
    }
  }
  return wakes;
}

function wakeWindow(wake: Wake): Run {
  return { from: wake.h, to: Math.min(wake.h + WAKE_OVERSHOOT_MS, wake.next) };
}

// Where a wake-up's room offsets are measured: from the start of its warm-up
// (a pre-Home preheat included) through the first WAKE_TAIL_MS of Home.
function wakeMeasureWindow(wake: Wake): Run {
  const from = Math.min(wake.run?.from ?? wake.h, wake.h);
  return { from, to: Math.max(from, Math.min(wake.h + WAKE_TAIL_MS, wake.next)) };
}

// Whether a grid time (readings in the half hour up to it) falls in one of the
// time-sorted, non-overlapping runs.
function inRuns(runs: Run[], t: number): boolean {
  const index = firstIndexAfter(runs, t, (r) => r.from, false) - 1;
  return index >= 0 && t <= runs[index].to;
}

function occupiedAt(occupancy: OccupancySample[] | undefined, t: number): boolean | null {
  if (!occupancy || occupancy.length === 0) return null;
  const index = firstIndexAfter(occupancy, t, timeOf, true) - 1;
  return index >= 0 ? occupancy[index].occupied : null;
}

// Occupied and known milliseconds in [from, to), holding each value until the
// next; unknown spells (and time before the first value) aren't known.
function occupiedTime(occupancy: OccupancySample[], from: number, to: number): { occupied: number; known: number } {
  let occupied = 0;
  let known = 0;
  for (let i = Math.max(0, firstIndexAfter(occupancy, from, timeOf, true) - 1);
    i < occupancy.length && occupancy[i].t < to; i += 1) {
    const a = Math.max(from, occupancy[i].t);
    const b = Math.min(to, occupancy[i + 1]?.t ?? to);
    if (b > a && occupancy[i].occupied !== null) {
      known += b - a;
      if (occupancy[i].occupied) occupied += b - a;
    }
  }
  return { occupied, known };
}

// Occupied share of the windows; null unless occupancy was known for at
// least OCCUPANCY_COVERAGE of their time, so an outage isn't read as a share.
function occupiedShare(occupancy: OccupancySample[] | undefined, windows: Run[]): number | null {
  if (!occupancy || occupancy.length === 0) return null;
  let occupied = 0;
  let known = 0;
  let total = 0;
  windows.forEach((w) => {
    const time = occupiedTime(occupancy, w.from, w.to);
    occupied += time.occupied;
    known += time.known;
    total += Math.max(0, w.to - w.from);
  });
  return known > 0 && known >= OCCUPANCY_COVERAGE * total ? Math.round((occupied / known) * 100) / 100 : null;
}

// ---------------------------------------------------------------------------
// The effective comfort average Ecobee heats or cools to.

interface Model {
  rooms: string[];
  roomSet: Set<string>;
  thermostatId: string | null;
  config: ParticipationConfig | null;
  occupancy: Map<string, OccupancySample[]>;
  timeline: SettingChange[];
}

// The thermostat's reading when fresh (it is Ecobee's average); otherwise the
// mean of the participating rooms (all rooms when unknown) — with Follow Me,
// only the occupied ones, falling back to all participating when none are.
// With Follow Me, a member whose occupancy history has a gap then leaves it
// unknown rather than assuming its last value.
function effectiveAt(model: Model, grid: Grid, t: number, setting: ComfortSetting | null): number | null {
  const own = model.thermostatId === null ? undefined : grid.values.get(model.thermostatId)?.get(t);
  if (own !== undefined) return own;
  const configured = setting && model.config ? model.config[setting] : null;
  let members = (configured ?? model.rooms)
    .filter((id) => model.roomSet.has(id) && grid.values.get(id)?.has(t) === true);
  if (model.config?.followMe === true) {
    if (members.some((id) => model.occupancy.has(id) && occupiedAt(model.occupancy.get(id), t) === null)) return null;
    const occupied = members.filter((id) => occupiedAt(model.occupancy.get(id), t) === true);
    if (occupied.length > 0) members = occupied;
  }
  if (members.length < (configured ? 1 : MIN_SENSORS_FOR_MEAN)) return null;
  return mean(members.map((id) => grid.values.get(id)!.get(t)!));
}

interface Accum {
  sum: number;
  n: number;
}

function accum(): Accum {
  return { sum: 0, n: 0 };
}

function addTo(acc: Accum, value: number): void {
  acc.sum += value;
  acc.n += 1;
}

function meanOf(acc: Accum | undefined): number | null {
  return acc && acc.n > 0 ? acc.sum / acc.n : null;
}

interface RoomScan {
  // Offsets from the mean of the fresh rooms, overall and per local day.
  bias: Accum;
  absBias: Accum;
  daily: Map<string, Accum>;
  // Offsets from the effective comfort average.
  periods: Record<keyof PeriodOffsets, Accum>;
}

interface PassiveAccum {
  n: number;
  over: number;
  sum: number;
}

interface ScanSpec {
  grid: Grid;
  from: number;
  to: number;
  model: Model;
  samples: HvacSample[];
  clock: (t: number) => { day: string };
  mode: PlacementMode;
  // Heating: wake-up windows. Cooling: only grid times in these runs count.
  windows: Run[];
}

// One pass over the grid times in (from, to]: room offsets (overall, daily
// and by period) and passive warmth (heating idle) or coolness (cooling idle).
function scan(spec: ScanSpec): { rooms: Map<string, RoomScan>; passive: PassiveAccum } {
  const { grid, model, samples, mode } = spec;
  const rooms = new Map<string, RoomScan>(model.rooms.map((id) => [id, {
    bias: accum(),
    absBias: accum(),
    daily: new Map<string, Accum>(),
    periods: {
      sleep: accum(), wake: accum(), home: accum(), heatingRuns: accum(), cooling: accum(),
    },
  }]));
  const passive: PassiveAccum = { n: 0, over: 0, sum: 0 };
  const times = grid.times.slice(
    firstIndexAfter(grid.times, spec.from, itself, true),
    firstIndexAfter(grid.times, spec.to, itself, true),
  );
  times.forEach((t) => {
    const state: HvacSample | undefined = samples[stateIndexAt(samples, t)];
    const known = state !== undefined && !state.gap;
    const running = known && (mode === 'heating' ? isHeating(state.hvacAction) : isCooling(state.hvacAction));
    const setting = settingAt(model.timeline, t);
    const effective = effectiveAt(model, grid, t, setting);
    if (mode === 'heating' || inRuns(spec.windows, t)) {
      const fresh = model.rooms.filter((id) => grid.values.get(id)!.has(t));
      const house = fresh.length >= MIN_SENSORS_FOR_MEAN ? cohortMean(grid, fresh, t) : null;
      const waking = mode === 'heating' && inRuns(spec.windows, t);
      const day = house === null ? '' : spec.clock(t).day;
      fresh.forEach((id) => {
        const room = rooms.get(id)!;
        const value = grid.values.get(id)!.get(t)!;
        if (house !== null) {
          addTo(room.bias, value - house);
          addTo(room.absBias, Math.abs(value - house));
          const daily = room.daily.get(day) ?? accum();
          addTo(daily, value - house);
          room.daily.set(day, daily);
        }
        if (effective === null) return;
        const offset = value - effective;
        if (mode === 'cooling') {
          addTo(room.periods.cooling, offset);
          return;
        }
        if (setting === 'sleep' || setting === 'home') addTo(room.periods[setting], offset);
        if (waking) addTo(room.periods.wake, offset);
        if (running) addTo(room.periods.heatingRuns, offset);
      });
    }
    if (!known || running || effective === null || state.hvacAction === null) return;
    let past: number | null = null;
    if (mode === 'heating' && /^(heat|heat_cool|auto)$/i.test(state.hvacMode ?? '')
      && !isCooling(state.hvacAction) && state.setpoint !== null) {
      past = effective - state.setpoint;
    } else if (mode === 'cooling' && /^cool$/i.test(state.hvacMode ?? '') && !isHeating(state.hvacAction)) {
      const point = coolPointOf(state);
      if (point !== null) past = point - effective;
    }
    if (past === null) return;
    passive.n += 1;
    passive.sum += past;
    if (past >= PASSIVE_THRESHOLD) passive.over += 1;
  });
  return { rooms, passive };
}

function passiveSummary(passive: PassiveAccum): PassiveSummary | null {
  if (passive.n < PASSIVE_MIN_SAMPLES) return null;
  return { share: Math.round((passive.over / passive.n) * 100) / 100, offset: round1(passive.sum / passive.n) };
}

function unknownParticipation(): Participation {
  return { home: null, sleep: null, away: null };
}

// Which rooms Ecobee averages in each setting, estimated from the thermostat's
// reading: every subset of rooms is scored by its mean absolute error against
// it over the times all its members have readings (with Follow Me, only a
// subset's occupied rooms count when any are; times a member's occupancy is
// unknown are skipped), so a sparse room only limits the subsets containing
// it. A room in every near-best subset is in; one in none (when subsets with
// it could be scored) is out; otherwise unknown.
function estimateParticipation(grid: Grid, model: Model, from: number, to: number): Map<string, Participation> {
  const result = new Map(model.rooms.map((id) => [id, unknownParticipation()]));
  const n = model.rooms.length;
  if (model.thermostatId === null || n === 0 || n > MAX_FIT_ROOMS) return result;
  const own = grid.values.get(model.thermostatId);
  if (!own) return result;
  const size = 1 << n;
  const sizes = new Uint8Array(size);
  for (let mask = 1; mask < size; mask += 1) sizes[mask] = sizes[mask & (mask - 1)] + 1;
  const fits = Object.fromEntries(COMFORT_SETTINGS.map((s) => [s, {
    errors: new Float64Array(size), counts: new Uint32Array(size),
  }]));
  const sums = new Float64Array(size);
  const followMe = model.config?.followMe === true;
  const times = grid.times.slice(
    firstIndexAfter(grid.times, from, itself, true),
    firstIndexAfter(grid.times, to, itself, true),
  );
  times.forEach((t) => {
    const target = own.get(t);
    const setting = settingAt(model.timeline, t);
    if (target === undefined || setting === null) return;
    let available = 0;
    let occupiedMask = 0;
    let unknownMask = 0;
    const values = model.rooms.map((id, i) => {
      const value = grid.values.get(id)!.get(t);
      if (value !== undefined) available |= 1 << i;
      if (followMe) {
        const occupied = occupiedAt(model.occupancy.get(id), t);
        if (occupied === true) occupiedMask |= 1 << i;
        else if (occupied === null && model.occupancy.has(id)) unknownMask |= 1 << i;
      }
      return value ?? 0;
    });
    if (available === 0) return;
    for (let mask = 1; mask < size; mask += 1) {
      const low = mask & -mask;
      sums[mask] = sums[mask ^ low] + values[31 - Math.clz32(low)];
    }
    const fit = fits[setting];
    for (let mask = 1; mask < size; mask += 1) {
      if ((mask & ~available) === 0 && (mask & unknownMask) === 0) {
        const used = (mask & occupiedMask) || mask;
        fit.errors[mask] += Math.abs(sums[used] / sizes[used] - target);
        fit.counts[mask] += 1;
      }
    }
  });
  COMFORT_SETTINGS.forEach((setting) => {
    const { errors, counts } = fits[setting];
    const scored: number[] = [];
    let best = Number.POSITIVE_INFINITY;
    for (let mask = 1; mask < size; mask += 1) {
      if (counts[mask] >= FIT_MIN_SAMPLES) {
        scored.push(mask);
        best = Math.min(best, errors[mask] / counts[mask]);
      }
    }
    if (best > FIT_TOLERANCE) return;
    const near = scored.filter((mask) => errors[mask] / counts[mask] <= best + FIT_MARGIN);
    model.rooms.forEach((id, i) => {
      const bit = 1 << i;
      if (near.every((mask) => (mask & bit) !== 0)) result.get(id)![setting] = true;
      else if (near.every((mask) => (mask & bit) === 0) && scored.some((mask) => (mask & bit) !== 0)) {
        result.get(id)![setting] = false;
      }
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Per-event offsets.

interface EventContext {
  event: PlacementEvent;
  mode: PlacementMode;
  setting: ComfortSetting | null;
  model: Model;
  cohort: Set<string>;
  times: number[];
  // The grid restricted to readings taken within the event window.
  grid: Grid;
  // Post-satisfaction window and the set point in force; null when the
  // thermostat history can't establish it.
  overshoot: OvershootWindow | null;
}

function eventContext(
  grid: Grid,
  model: Model,
  event: PlacementEvent,
  mode: PlacementMode,
  setting: ComfortSetting | null,
  window: Run,
  overshoot: OvershootWindow | null,
): EventContext {
  // Only readings taken within the window count.
  const restricted = windowGrid(grid, window.from, window.to);
  const { cohort, times } = cohortAt(restricted, restricted.times, model.roomSet);
  return {
    event, mode, setting, model, cohort: new Set(cohort), times, grid: restricted, overshoot,
  };
}

function heatingContexts(
  grid: Grid,
  model: Model,
  samples: HvacSample[],
  events: PlacementEvent[],
  wakes: Map<PlacementEvent, Wake>,
): EventContext[] {
  return events.map((event, index) => {
    const nextEvent = events[index + 1]?.t ?? Number.POSITIVE_INFINITY;
    const wake = wakes.get(event);
    if (wake && wake.run) {
      // Measured from the preheat through the first hours of Home, each
      // reading against the comfort setting in force then; overshoot is
      // measured once heating after the change to Home is satisfied.
      const from = Math.max(wake.run.from, wake.h);
      const overshoot = wake.run.to > wake.h ? overshootWindow(samples, { ...event, t: from }, nextEvent) : null;
      return eventContext(grid, model, event, 'heating', null, wakeMeasureWindow(wake), overshoot);
    }
    // An inferred window also ends at the first recorded state in which the
    // thermostat couldn't heat (off/cool), so later readings never count.
    const stopped = event.inferred
      ? findAfter(samples, event.t, event.t + EVENT_WINDOW_MS, rulesOutHeating)?.t ?? null
      : heatUpEnd(samples, event).at;
    const gap = findAfter(samples, event.t, event.t + EVENT_WINDOW_MS, (s) => s.gap)?.t;
    const end = Math.min(event.t + EVENT_WINDOW_MS, stopped ?? Number.POSITIVE_INFINITY, gap ?? Number.POSITIVE_INFINITY);
    return eventContext(
      grid,
      model,
      event,
      'heating',
      settingAt(model.timeline, event.t),
      { from: event.t, to: end },
      overshootWindow(samples, event, nextEvent),
    );
  });
}

interface EventStat {
  type: PlacementEventType;
  // Mean offset from the house (room) average, and from the effective
  // comfort average (null when it couldn't be established).
  offset: number;
  effective: number | null;
  inferred: boolean;
}

interface Measured {
  heat: EventStat[];
  cool: EventStat[];
  overshoots: number[];
  heatSamples: number;
  coolSamples: number;
  // Sum of |offset| over heat-up samples, for the mean absolute difference.
  absoluteOffsetSum: number;
}

function measure(id: string, points: SensorSeriesInput['points'], contexts: EventContext[]): Measured {
  const measured: Measured = {
    heat: [], cool: [], overshoots: [], heatSamples: 0, coolSamples: 0, absoluteOffsetSum: 0,
  };
  contexts.forEach((ctx) => {
    if (ctx.cohort.has(id) && ctx.times.length >= MIN_EVENT_SAMPLES) {
      const members = [...ctx.cohort];
      const filled = ctx.grid.values.get(id)!;
      const offsets = ctx.times.map((t) => filled.get(t)! - cohortMean(ctx.grid, members, t));
      const effective = ctx.times
        .map((t) => {
          const average = effectiveAt(ctx.model, ctx.grid, t, ctx.setting ?? settingAt(ctx.model.timeline, t));
          return average === null ? null : filled.get(t)! - average;
        })
        .filter((o): o is number => o !== null);
      const stat: EventStat = {
        type: ctx.event.type, offset: mean(offsets)!, effective: mean(effective), inferred: ctx.event.inferred,
      };
      if (ctx.mode === 'heating') {
        measured.heat.push(stat);
        measured.heatSamples += offsets.length;
        measured.absoluteOffsetSum += offsets.reduce((sum, o) => sum + Math.abs(o), 0);
      } else {
        measured.cool.push(stat);
        measured.coolSamples += offsets.length;
      }
    }
    const overshoot = ctx.overshoot ? overshootIn(points, ctx.overshoot) : null;
    if (overshoot !== null) measured.overshoots.push(overshoot);
  });
  return measured;
}

function classify(events: EventStat[], samples: number): SensorClassification {
  const n = events.length;
  if (n < MIN_EVENTS || samples < MIN_SAMPLES) return 'insufficient';
  const cold = events.filter((e) => e.offset <= -OFFSET_THRESHOLD).length / n;
  const warm = events.filter((e) => e.offset >= OFFSET_THRESHOLD).length / n;
  if (cold >= CONSISTENCY_SHARE) return 'cold';
  if (warm >= CONSISTENCY_SHARE) return 'warm';
  return 'representative';
}

// Mean peak above the Home set point in the WAKE_OVERSHOOT_MS after each
// Sleep → Home change (whether or not heating ran).
function wakeOvershootOf(points: SensorSeriesInput['points'], wakes: Wake[], samples: HvacSample[]): number | null {
  const peaks = wakes.map((wake) => {
    const state = samples[stateIndexAt(samples, wake.h + BUCKET_MS)];
    if (!state || state.gap || state.setpoint === null) return null;
    return overshootIn(points, { ...wakeWindow(wake), setpoint: state.setpoint });
  }).filter((p): p is number => p !== null);
  return mean(peaks);
}

// Mean of how far the lowest reading in each cooling run fell below the cool set point.
function coolingUndershootOf(points: SensorSeriesInput['points'], runs: Run[], samples: HvacSample[]): number | null {
  const dips = runs.map((run) => {
    const state = samples[stateIndexAt(samples, run.from)];
    const point = state && !state.gap ? coolPointOf(state) : null;
    const inside = points.slice(
      firstIndexAfter(points, run.from, timeOf, false),
      firstIndexAfter(points, run.to - BUCKET_MS, timeOf, true),
    );
    if (point === null || inside.length === 0) return null;
    return Math.max(0, point - Math.min(...inside.map((p) => p.v)));
  }).filter((d): d is number => d !== null);
  return mean(dips);
}


// ---------------------------------------------------------------------------
// Verdicts and recommendations. Recommendations are hypotheses: which sensors
// a comfort setting uses is only known when configured (or estimated from the
// thermostat's reading), and the wording says so.

type BiasDirection = 'below' | 'above';

const SEVERITY_RANK: Record<RecommendationSeverity, number> = { high: 0, medium: 1, low: 2 };
// Days need this many grid points (heating: two hours) to count for consistency.
const MIN_DAY_POINTS: Record<PlacementMode, number> = { heating: 8, cooling: 2 };

interface Analyzed {
  out: PlacementSensor;
  room: boolean;
  measured: Measured;
  heatClass: SensorClassification;
  coolClass: SensorClassification;
  heatScan: RoomScan | undefined;
  coolScan: RoomScan | undefined;
  // Participation estimated from the thermostat's reading (null: can't tell).
  estimated: Participation;
}

interface Env {
  followMe: boolean | null;
  // Whether the thermostat's averaged reading is available.
  hasAverage: boolean;
  heatingRuntimeMs: number | null;
  windowDays: number;
  heatingRare: boolean;
  passiveHeat: boolean;
  passiveWarmth: PassiveSummary | null;
  passiveCooling: PassiveSummary | null;
  wakes: Wake[];
  // "cooling from … to …, last cooling season" (or without the season), or ''.
  coolingRange: string;
}

interface Skew {
  mode: PlacementMode;
  direction: BiasDirection;
  magnitude: number;
  // Full evidence for a recommendation, and a short clause for the verdict.
  evidence: string;
  brief: string;
}

interface Ranked {
  rec: PlacementRecommendation;
  magnitude: number;
  // Wake-ups first, then other heating, then cooling, then settings checks.
  rank: number;
}

function slug(id: string): string {
  return id.replace(/_temperature$/, '').replace(/_/g, '-');
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function hours(ms: number): string {
  return (ms / (60 * 60 * 1000)).toFixed(1);
}

function percent(share: number): number {
  return Math.round(share * 100);
}

function isKitchen(a: Analyzed): boolean {
  return /kitchen/i.test(`${a.out.id} ${a.out.name}`);
}

function dailyCounts(scanned: RoomScan | undefined, mode: PlacementMode): { days: number; cold: number; warm: number } {
  const counts = { days: 0, cold: 0, warm: 0 };
  scanned?.daily.forEach((day) => {
    if (day.n < MIN_DAY_POINTS[mode]) return;
    counts.days += 1;
    const offset = day.sum / day.n;
    if (offset <= -DAILY_THRESHOLD) counts.cold += 1;
    else if (offset >= DAILY_THRESHOLD) counts.warm += 1;
  });
  return counts;
}

// How a room skews the average in one mode: from its heat-ups (or cooling
// runs) when they classify it, else from how many days it sat on one side of
// the house average.
// `typical` is the median room's mean offset: a sensor must stand out from it
// too, so one outlier pulling the house average doesn't make every other room
// look skewed the opposite way.
function skewOf(a: Analyzed, mode: PlacementMode, typical: number | null): Skew | null {
  const { name } = a.out;
  const scanned = mode === 'heating' ? a.heatScan : a.coolScan;
  const bias = meanOf(scanned?.bias);
  const standsOut = (sign: number) => bias === null || typical === null || sign * (bias - typical) >= DAILY_THRESHOLD;
  const events = mode === 'heating' ? a.measured.heat : a.measured.cool;
  const cls = mode === 'heating' ? a.heatClass : a.coolClass;
  const noun = mode === 'heating' ? 'heat-ups' : 'cooling runs';
  if ((cls === 'cold' && standsOut(-1)) || (cls === 'warm' && standsOut(1))) {
    const direction: BiasDirection = cls === 'cold' ? 'below' : 'above';
    const sign = cls === 'cold' ? -1 : 1;
    const biased = events.filter((e) => sign * e.offset >= OFFSET_THRESHOLD).length;
    const offsetOf = (types: PlacementEventType[]) => mean(events
      .filter((e) => types.includes(e.type)).map((e) => e.offset));
    const all = mean(events.map((e) => e.offset));
    // Quote the first period whose mean is on the classified side, so a
    // mixed-sign period is never quoted against it.
    const periods: [number | null, string][] = mode === 'heating'
      ? [[offsetOf(['wake', 'morning']), 'during morning warm-ups'], [offsetOf(['return']), 'after returns from Away'],
        [all, 'across all heat-ups']]
      : [[all, 'while cooling ran']];
    const match = periods.find(([offset]) => offset !== null && sign * offset >= OFFSET_THRESHOLD);
    const counted = `${name} read at least ${OFFSET_THRESHOLD.toFixed(1)} °C ${direction} the house average `
      + `in ${biased} of ${events.length} ${noun}`;
    const inferred = events.filter((e) => e.inferred).length;
    const provenance = inferred > 0
      ? `. ${inferred} of these ${events.length} ${noun} were inferred from room temperatures, not thermostat history`
      : '';
    const magnitude = Math.abs(match ? match[0]! : all ?? 0);
    return {
      mode,
      direction,
      magnitude,
      evidence: match
        ? `${counted} (${fmt(match[0]!)} °C ${direction} on average ${match[1]})${provenance}`
        : `${counted}${provenance}`,
      brief: `${name} reads ${fmt(magnitude)} °C ${direction} the house average${match ? ` ${match[1]}` : ''}, `
        + `and at least ${OFFSET_THRESHOLD.toFixed(1)} °C ${direction} it in ${biased} of ${events.length} ${noun}`,
    };
  }
  const { days, cold, warm } = dailyCounts(scanned, mode);
  if (days < MIN_EVENTS || bias === null) return null;
  let direction: BiasDirection | null = null;
  if (cold / days >= CONSISTENCY_SHARE && bias < 0 && standsOut(-1)) direction = 'below';
  else if (warm / days >= CONSISTENCY_SHARE && bias > 0 && standsOut(1)) direction = 'above';
  if (direction === null) return null;
  const k = direction === 'below' ? cold : warm;
  const scope = mode === 'heating' ? 'days' : 'days of cooling';
  return {
    mode,
    direction,
    magnitude: Math.abs(bias),
    evidence: `${name} read ${fmt(bias)} °C ${direction} the house average${mode === 'cooling' ? ' while cooling ran' : ''}, `
      + `and at least ${DAILY_THRESHOLD.toFixed(1)} °C ${direction} it on ${k} of ${days} ${scope}`,
    brief: `${name} reads ${fmt(bias)} °C ${direction} the house average on ${k} of ${days} ${scope}`,
  };
}

interface Known {
  value: boolean | null;
  source: 'configured' | 'estimated' | null;
}

function knownIn(a: Analyzed, setting: ComfortSetting): Known {
  const configured = a.out.participation[setting];
  if (configured !== null) return { value: configured, source: 'configured' };
  const estimated = a.estimated[setting];
  return estimated === null ? { value: null, source: null } : { value: estimated, source: 'estimated' };
}

function participationLead(known: Known, setting: ComfortSetting): string {
  const label = SETTING_LABEL[setting];
  if (known.source === 'configured') return `Because it's in your ${label} comfort setting, `;
  if (known.source === 'estimated') return `The thermostat's readings suggest it's in your ${label} comfort setting. `;
  return `If it's in your ${label} comfort setting, `;
}

// The lead followed by a consequence, capitalized after a full stop.
function withLead(lead: string, consequence: string): string {
  return lead.endsWith('. ') ? `${lead}${consequence[0].toUpperCase()}${consequence.slice(1)}` : `${lead}${consequence}`;
}

const CONSEQUENCE: Record<PlacementMode, Record<BiasDirection, string>> = {
  heating: {
    below: 'Ecobee keeps heating to warm it, so the other rooms end up warmer than the set point.',
    above: 'Ecobee stops heating before the other rooms reach the set point, leaving them cooler.',
  },
  cooling: {
    above: 'the AC keeps running to cool it, so the other rooms end up colder than the set point.',
    below: 'the AC stops before the other rooms cool down, leaving them warmer.',
  },
};

const PULL: Record<PlacementMode, Record<BiasDirection, string>> = {
  heating: {
    below: 'pulling the average down so other rooms overheat',
    above: 'pushing the average up so other rooms are under-heated',
  },
  cooling: {
    above: 'pushing the average up so the AC overcools other rooms',
    below: 'pulling the average down so the AC under-cools other rooms',
  },
};

function causesFor(a: Analyzed, direction: BiasDirection, mode: PlacementMode): string[] {
  if (direction === 'below') {
    return mode === 'heating'
      ? ['near a window or exterior wall', 'in a draft or near an outside door', 'low on a wall or over a cold floor']
      : ['in the airflow of an AC vent', 'near a window or exterior wall', 'in a draft'];
  }
  const warm = ['direct sun', 'near a vent, lamp or electronics'];
  return isKitchen(a) ? ['cooking and kitchen appliances', ...warm] : [...warm, 'near appliances'];
}

function adviceFor(a: Analyzed, direction: BiasDirection, setting: ComfortSetting, removable: boolean, moveOnly = false): string {
  const label = SETTING_LABEL[setting];
  if (direction === 'above' && isKitchen(a) && moveOnly) {
    return `Cooking and appliances will keep warming it, so move it away from the stove and appliances${
      removable ? `, or remove it from ${label}` : ''}.`;
  }
  if (direction === 'above' && isKitchen(a)) {
    return 'Cooking and appliances will keep warming it, so consider removing it from the comfort settings it skews, '
      + 'or move it away from the stove and appliances.';
  }
  const move = direction === 'below'
    ? 'Move it to an interior wall at about chest height, away from windows, doors and vents'
    : 'Move it out of direct sun and away from vents, lamps and electronics';
  return removable ? `${move}, or remove it from ${label}.` : `${move}.`;
}

function quietNote(env: Env): string {
  if (env.heatingRuntimeMs !== null && env.heatingRare) {
    return ` Heating ran only ${hours(env.heatingRuntimeMs)} h over ${env.windowDays} days, so this matters mainly on colder days.`;
  }
  return env.passiveHeat ? ' The house mostly stayed warm without heating, so this matters mainly on colder days.' : '';
}

function coolingNote(env: Env): string {
  return env.coolingRange ? ` Based on ${env.coolingRange}.` : '';
}

function recBase(
  a: Analyzed | null,
  fields: Pick<PlacementRecommendation, 'id' | 'severity' | 'action' | 'title' | 'detail' | 'mode' | 'period'
  | 'comfortSetting' | 'affectedSensorIds' | 'likelyCauses'>,
): PlacementRecommendation {
  return { sensorId: a ? a.out.id : null, ...fields };
}

// Generic outlier tip for a participating (or possibly participating) room.
function skewRec(a: Analyzed, skew: Skew, env: Env, rooms: Analyzed[]): Ranked | null {
  const setting: ComfortSetting = 'home';
  const known = knownIn(a, setting);
  if (known.value === false) return null;
  // With Follow Me, a sensor rarely occupied while Home barely counted.
  const share = a.out.occupiedShare.home;
  if (env.followMe === true && share !== null && share < FOLLOW_ME_MIN_SHARE) return null;
  const heating = skew.mode === 'heating';
  // Cooling tips always recommend moving the sensor.
  const remove = heating && skew.direction === 'above' && isKitchen(a) && known.value === true;
  let prefix = 'move';
  if (!heating) prefix = 'cooling';
  else if (remove) prefix = 'remove';
  const quiet = heating ? quietNote(env) : '';
  let severity: RecommendationSeverity = 'medium';
  const others = rooms.filter((o) => o !== a && o.out.verdict !== null && o.out.verdict !== 'insufficient');
  const overshooting = others.filter((o) => (o.out.overshoot ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => y.out.overshoot! - x.out.overshoot!);
  const overcooled = others.filter((o) => (o.out.coolingUndershoot ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => y.out.coolingUndershoot! - x.out.coolingUndershoot!);
  if (quiet || (heating && skew.direction === 'above' && known.value === null)) severity = 'low';
  else if (heating && skew.direction === 'below' && skew.magnitude >= STRONG_OFFSET
    && overshooting.some((o) => o.out.overshoot! >= OVERSHOOT_THRESHOLD)) severity = 'high';
  let effect = '';
  if (heating && skew.direction === 'below' && overshooting.length > 0) {
    effect = ` ${listOf(overshooting.map((o) => o.out.name))} peaked `
      + `${listOf(overshooting.map((o) => fmt(o.out.overshoot!)))} °C above the set point on average after heating stopped.`;
  } else if (!heating && skew.direction === 'above' && overcooled.length > 0) {
    effect = ` ${listOf(overcooled.map((o) => o.out.name))} dipped `
      + `${listOf(overcooled.map((o) => fmt(o.out.coolingUndershoot!)))} °C below the cool set point on average while it ran.`;
  }
  const sure = known.value === true ? 'is' : 'may be';
  const titles: Record<PlacementMode, Record<BiasDirection, string>> = {
    heating: { below: `${sure} keeping the heat on`, above: `${sure} stopping the heat early` },
    cooling: { above: `${sure} keeping the AC on`, below: `${sure} stopping the AC early` },
  };
  return {
    magnitude: skew.magnitude,
    rank: heating ? 1 : 2,
    rec: recBase(a, {
      id: `${prefix}-${slug(a.out.id)}`,
      severity,
      action: remove ? 'exclude_from_comfort' : 'move',
      title: `${a.out.name} ${titles[skew.mode][skew.direction]}`,
      detail: `${skew.evidence}. ${withLead(participationLead(known, setting), CONSEQUENCE[skew.mode][skew.direction])}${effect} `
        + `${adviceFor(a, skew.direction, setting, true, !heating)}${quiet}${heating ? '' : coolingNote(env)}`,
      mode: skew.mode,
      period: null,
      comfortSetting: setting,
      affectedSensorIds: others.map((o) => o.out.id),
      likelyCauses: causesFor(a, skew.direction, skew.mode),
    }),
  };
}

// A (possibly) participating room reading below the comfort average during
// wake-up warm-ups while other rooms end up over the Home set point.
function wakeRec(a: Analyzed, env: Env, rooms: Analyzed[]): Ranked | null {
  const offsets = a.measured.heat.filter((e) => e.type === 'wake' && e.effective !== null).map((e) => e.effective!);
  if (offsets.length < 2) return null;
  const cold = offsets.filter((o) => o <= -AFFECTED_THRESHOLD).length;
  const offset = mean(offsets)!;
  if (cold / offsets.length < CONSISTENCY_SHARE || offset > -AFFECTED_THRESHOLD) return null;
  // It must also stand out from the typical room, so one warm room inflating
  // the average doesn't make every other room look like the culprit.
  const wakeOffset = (o: Analyzed) => mean(o.measured.heat.filter((e) => e.type === 'wake').map((e) => e.offset));
  const typical = median(rooms.map(wakeOffset).filter((o): o is number => o !== null));
  const own = wakeOffset(a);
  if (typical === null || own === null || own - typical > -AFFECTED_THRESHOLD) return null;
  const known = knownIn(a, 'home');
  if (known.value === false) return null;
  // With Follow Me, a sensor that was rarely occupied after waking barely counted.
  const share = a.out.occupiedShare.wake;
  if (env.followMe === true && share !== null && share < FOLLOW_ME_MIN_SHARE) return null;
  const affected = rooms.filter((o) => o !== a && (o.out.wakeOvershoot ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => y.out.wakeOvershoot! - x.out.wakeOvershoot!);
  if (affected.length === 0) return null;
  const heated = env.wakes.filter((w) => w.run !== null);
  const setback = mean(heated.map((w) => w.setback).filter((s): s is number => s !== null));
  const ramp = mean(heated.map((w) => w.run!.to - w.run!.from));
  let recovery = '';
  if ((setback !== null && setback >= SETBACK_NOTE) || (ramp !== null && ramp >= LONG_RAMP_MS)) {
    const gap = setback !== null && setback > 0 ? `The Sleep set point averaged ${fmt(setback)} °C below Home, and the ` : 'The ';
    recovery = ` ${gap}warm-up ran ${Math.round((ramp ?? 0) / 60000)} minutes on average (Smart Recovery can start it before Home); `
      + 'a smaller Sleep setback or turning Smart Recovery off would shorten it.';
  }
  let followMe = '';
  if (env.followMe === true) {
    followMe = share === null
      ? ' Follow Me is on, but its occupancy wasn\'t known for enough of the time, so it was assumed to count.'
      : ` With Follow Me on, it only counted while occupied (${percent(share)}% of the time after waking).`;
  }
  const quiet = quietNote(env);
  let severity: RecommendationSeverity = affected[0].out.wakeOvershoot! >= OVERSHOOT_THRESHOLD ? 'high' : 'medium';
  if (quiet) severity = 'low';
  return {
    magnitude: Math.abs(offset),
    rank: 0,
    rec: recBase(a, {
      id: `wake-${slug(a.out.id)}`,
      severity,
      action: 'move',
      title: `${a.out.name} ${known.value === true ? 'is' : 'may be'} holding the morning warm-up on`,
      detail: `In ${cold} of ${offsets.length} wake-ups (Sleep → Home), ${a.out.name} read ${fmt(offset)} °C below `
        + `the comfort average Ecobee heats to. ${withLead(participationLead(known, 'home'), 'Ecobee keeps heating until it warms up, ')}`
        + `so ${listOf(affected.map((o) => o.out.name))} ended up `
        + `${listOf(affected.map((o) => fmt(o.out.wakeOvershoot!)))} °C over the Home set point on average in the 2 hours after waking. `
        + `${adviceFor(a, 'below', 'home', true)}${recovery}${followMe}${quiet}`,
      mode: 'heating',
      period: 'wake',
      comfortSetting: 'home',
      affectedSensorIds: affected.map((o) => o.out.id),
      likelyCauses: causesFor(a, 'below', 'heating'),
    }),
  };
}

// A room known not to be in Home that is consistently off: adding it lets the
// thermostat account for it.
function addRec(a: Analyzed, skew: Skew, env: Env): Ranked | null {
  const known = knownIn(a, 'home');
  if (known.value !== false) return null;
  const heating = skew.mode === 'heating';
  if (heating && (env.passiveHeat || env.heatingRare)) return null;
  const which = known.source === 'configured'
    ? 'It isn\'t in your Home comfort setting'
    : 'The thermostat\'s readings suggest it isn\'t in your Home comfort setting';
  const verb = heating ? 'heat' : 'cool';
  // Over-conditioned (warm while heating, cool while cooling) or under-conditioned.
  const over = (skew.direction === 'above') === heating;
  const effect = over
    ? `Adding it to Home would help the thermostat stop ${heating ? 'heating' : 'cooling'} sooner, though the other rooms `
      + `would end up a little ${heating ? 'cooler' : 'warmer'}.`
    : `If the room feels too ${heating ? 'cool' : 'warm'}, adding it to Home would make Ecobee ${verb} for it too, though `
      + `the other rooms would end up ${heating ? 'warmer' : 'cooler'}.`;
  return {
    magnitude: skew.magnitude,
    rank: heating ? 1 : 2,
    rec: recBase(a, {
      id: `add-${heating ? '' : 'cooling-'}${slug(a.out.id)}`,
      severity: 'medium',
      action: 'include_in_comfort',
      title: `Consider adding ${a.out.name} to your Home comfort setting`,
      detail: `${skew.evidence}. ${which}, so Ecobee doesn't ${verb} for it. ${effect}${heating ? '' : coolingNote(env)}`,
      mode: skew.mode,
      period: null,
      comfortSetting: 'home',
      affectedSensorIds: [],
      likelyCauses: causesFor(a, skew.direction, skew.mode),
    }),
  };
}

// A room that overshoots after heating stops while it may not be in Home.
function overshootAddRec(a: Analyzed, env: Env): Ranked | null {
  const s = a.out;
  if (s.overshoot === null || s.overshoot < OVERSHOOT_THRESHOLD || env.passiveHeat || env.heatingRare) return null;
  if (s.verdict !== 'representative' && s.verdict !== 'warm_outlier') return null;
  const known = knownIn(a, 'home');
  if (known.value === true) return null;
  // Mean absolute difference, so opposite offsets don't cancel out.
  const spread = s.verdict === 'representative' && a.measured.heatSamples > 0
    ? a.measured.absoluteOffsetSum / a.measured.heatSamples
    : null;
  let tracks = '';
  if (spread !== null) {
    tracks = round1(spread) === 0
      ? ', while closely tracking the house average during heat-ups'
      : `, while reading ${fmt(spread)} °C from the house average on average during heat-ups`;
  }
  const inferred = a.measured.heat.filter((e) => e.inferred).length;
  const provenance = inferred > 0
    ? `. ${inferred} of these ${a.measured.heat.length} heat-ups were inferred from room temperatures, not thermostat history`
    : '';
  const lead = known.value === false ? 'It isn\'t in your Home comfort setting; adding it' : 'If it isn\'t in your Home comfort setting, adding it';
  return {
    magnitude: s.overshoot,
    rank: 1,
    rec: recBase(a, {
      id: `add-${slug(s.id)}`,
      severity: 'medium',
      action: 'include_in_comfort',
      title: `Consider adding ${s.name} to your Home comfort setting`,
      detail: `${s.name} peaked ${fmt(s.overshoot)} °C above the set point on average after the thermostat stopped heating`
        + `${tracks}${provenance}. ${lead} would help Ecobee stop heating sooner.`,
      mode: 'heating',
      period: null,
      comfortSetting: 'home',
      affectedSensorIds: [],
      likelyCauses: [],
    }),
  };
}

const PASSIVE_WARM_CAUSES = [
  'set point lower than the house naturally holds',
  'sun through windows',
  'cooking and appliance heat',
];

function passiveRecs(env: Env, rooms: Analyzed[]): Ranked[] {
  const recs: Ranked[] = [];
  const average = env.hasAverage ? 'the Ecobee average' : 'the rooms';
  const warmth = env.passiveWarmth;
  if (warmth && env.passiveHeat) {
    const runtime = env.heatingRuntimeMs === null
      ? ''
      : `; heating ran only ${hours(env.heatingRuntimeMs)} h over ${env.windowDays} days`;
    const waking = rooms.filter((a) => (a.out.wakeOvershoot ?? 0) >= PASSIVE_THRESHOLD);
    const peak = mean(rooms.map((a) => a.out.wakeOvershoot).filter((o): o is number => o !== null));
    const heatingMinutes = mean(env.wakes.map((w) => w.heatingMs / 60000));
    const wake = peak !== null && peak >= PASSIVE_THRESHOLD && heatingMinutes !== null
      ? ` That includes waking up: in the 2 hours after Sleep ended, rooms peaked ${fmt(peak)} °C over the Home set point `
        + `on average, with heating running ${Math.round(heatingMinutes)} minutes on average around the change.`
      : '';
    recs.push({
      magnitude: warmth.offset,
      rank: 0,
      rec: recBase(null, {
        id: 'passive-warmth-heating',
        severity: 'medium',
        action: 'none',
        title: 'Rooms stay warm without the heat running',
        detail: `With heating idle, ${average} sat ${fmt(warmth.offset)} °C above the set point on average, and at least `
          + `${PASSIVE_THRESHOLD.toFixed(1)} °C above it ${percent(warmth.share)}% of the time${runtime}. Sensor placement isn't `
          + 'causing this: the house holds this warmth on its own, so moving sensors or lowering the set point won\'t cool it.'
          + `${wake} Likely the set point is lower than the house naturally sits, or sun or cooking and appliances are adding `
          + 'heat; shading, ventilating or cooling on warm days would help more.',
        mode: 'heating',
        period: wake ? 'wake' : null,
        comfortSetting: null,
        affectedSensorIds: wake ? waking.map((a) => a.out.id) : [],
        likelyCauses: PASSIVE_WARM_CAUSES,
      }),
    });
  }
  const coolness = env.passiveCooling;
  if (coolness && coolness.share >= PASSIVE_SHARE) {
    recs.push({
      magnitude: coolness.offset,
      rank: 2,
      rec: recBase(null, {
        id: 'passive-cooling',
        severity: 'low',
        action: 'none',
        title: 'Rooms stay cool without the AC running',
        detail: `With cooling idle, ${average} sat ${fmt(coolness.offset)} °C below the cool set point on average, and at least `
          + `${PASSIVE_THRESHOLD.toFixed(1)} °C below it ${percent(coolness.share)}% of the time. Sensor placement isn't causing `
          + 'this: the house stays cool on its own. Likely the cool set point is higher than the house naturally sits, or shade '
          + `and cool nights keep it cool; nothing needs to change unless it feels too cool.${coolingNote(env)}`,
        mode: 'cooling',
        period: null,
        comfortSetting: null,
        affectedSensorIds: [],
        likelyCauses: ['cool set point higher than the house naturally holds', 'shade', 'cool nights'],
      }),
    });
  }
  return recs;
}

// Configured participation that disagrees with what the thermostat's reading
// suggests Ecobee actually averages.
function mismatchRecs(rooms: Analyzed[], config: ParticipationConfig | null): Ranked[] {
  if (!config) return [];
  return COMFORT_SETTINGS.flatMap((setting) => {
    if (config[setting] === null) return [];
    const extra = rooms.filter((a) => a.estimated[setting] === true && a.out.participation[setting] === false);
    const missing = rooms.filter((a) => a.estimated[setting] === false && a.out.participation[setting] === true);
    if (extra.length + missing.length === 0) return [];
    const label = SETTING_LABEL[setting];
    const parts: string[] = [];
    if (extra.length > 0) {
      parts.push(`${listOf(extra.map((a) => a.out.name))} ${extra.length === 1 ? 'seems' : 'seem'} to be averaged but `
        + `${extra.length === 1 ? 'isn\'t' : 'aren\'t'} listed`);
    }
    if (missing.length > 0) {
      parts.push(`${listOf(missing.map((a) => a.out.name))} ${missing.length === 1 ? 'is' : 'are'} listed but `
        + `${missing.length === 1 ? 'doesn\'t' : 'don\'t'} seem to be averaged`);
    }
    return [{
      magnitude: extra.length + missing.length,
      rank: 3,
      rec: recBase(null, {
        id: `participation-mismatch-${setting}`,
        severity: 'medium' as RecommendationSeverity,
        action: 'none' as RecommendationAction,
        title: `Check which sensors your ${label} setting uses`,
        detail: `During ${label}, the thermostat's reading doesn't match the sensors you listed: ${parts.join('; ')}. `
          + `Check the ${label} comfort setting (and Follow Me) in the Ecobee app; these tips assume your list.`,
        mode: null,
        period: null,
        comfortSetting: setting,
        affectedSensorIds: [...extra, ...missing].map((a) => a.out.id),
        likelyCauses: [],
      }),
    }];
  });
}

// Summary when nothing was flagged; only claims what the data covered.
function noChanges(
  rooms: Analyzed[],
  events: PlacementEvent[],
  cooling: { checked: boolean; found: boolean; events: number },
): PlacementRecommendation | null {
  const assessed = rooms.filter((a) => a.out.verdict !== 'insufficient');
  if (assessed.length < MIN_SENSORS_FOR_MEAN) return null;
  const missing = rooms.filter((a) => a.out.verdict === 'insufficient').map((a) => a.out.name);
  const overshootKnown = assessed.every((a) => a.out.overshoot !== null);
  const parts = ['No room sensor read consistently above or below the house average.'];
  // Coverage-neutral when overshoot is unknown: no claim about why.
  const unmeasured = assessed.filter((a) => a.out.overshoot === null).map((a) => a.out.name);
  if (overshootKnown && events.length > 0) {
    parts.push(`None of them peaked ${OVERSHOOT_THRESHOLD.toFixed(1)} °C or more above the set point on average after heating stopped.`);
  } else if (unmeasured.length > 0) {
    parts.push(`Overshoot after heating stopped couldn't be measured for ${unmeasured.join(', ')}.`);
  } else {
    parts.push('Overshoot after heating stopped couldn\'t be measured.');
  }
  if (cooling.checked && !cooling.found) parts.push('No cooling was recorded in the past year.');
  else if (cooling.found && cooling.events === 0) parts.push('No cooling runs were found to compare.');
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
    mode: null,
    period: null,
    comfortSetting: null,
    affectedSensorIds: [],
    likelyCauses: [],
  };
}

function verdictSummaryOf(a: Analyzed, skew: Skew | null, env: Env): string {
  const { name } = a.out;
  if (!skew) {
    if (a.out.verdict === 'insufficient') return `There isn't enough data yet to judge ${name}.`;
    const bias = meanOf(a.heatScan?.bias) ?? meanOf(a.coolScan?.bias);
    if (bias === null || Math.abs(bias) < 0.05) return `${name} tracks the house average, so it isn't skewing the thermostat.`;
    return `${name} stays close to the house average (${fmt(bias)} °C ${bias < 0 ? 'below' : 'above'} on average), `
      + 'so it isn\'t skewing the thermostat.';
  }
  const setting: ComfortSetting = 'home';
  const known = knownIn(a, setting);
  let consequence = known.source === 'configured'
    ? `, but it isn't in the ${SETTING_LABEL[setting]} comfort setting, so it doesn't steer the thermostat`
    : `, but the thermostat's readings suggest it isn't in the ${SETTING_LABEL[setting]} comfort setting, so it likely doesn't steer it`;
  if (known.value === true) consequence = ` — likely ${PULL[skew.mode][skew.direction]}`;
  else if (known.value === null) consequence = ` — if it's in the comfort setting, it may be ${PULL[skew.mode][skew.direction]}`;
  let note = '';
  if (skew.mode === 'heating' && (env.heatingRare || env.passiveHeat)) note = '; heating rarely ran, so this matters mainly on colder days';
  if (skew.mode === 'cooling' && env.coolingRange) note = ` (${env.coolingRange})`;
  return `${skew.brief}${consequence}${note}.`;
}

const COMFORT_AVERAGE_SUMMARY = 'This is Ecobee\'s average of the sensors in the active comfort setting (what it heats '
  + 'and cools to), not a room, so it isn\'t judged as an outlier.';

// ---------------------------------------------------------------------------
// Assembly.

interface Dataset {
  raw: HvacSample[];
  samples: HvacSample[];
  timeline: SettingChange[];
  model: Model;
  grid: Grid;
  points: Map<string, SensorSeriesInput['points']>;
}

function dataset(
  sensors: SensorSeriesInput[],
  hvac: HvacSample[] | null | undefined,
  comfort: ComfortSample[] | null | undefined,
  config: ParticipationConfig | null,
): Dataset {
  const raw = [...(hvac ?? [])].sort((a, b) => a.t - b.t);
  // The Ecobee comfort setting takes precedence over the thermostat's preset,
  // which fills in wherever the comfort setting is unknown.
  const known = !!comfort && comfort.some((c) => normalizeSetting(c.setting) !== null);
  const timeline = settingTimeline(comfort, raw);
  const rooms = sensors.filter((s) => !s.isThermostat).map((s) => s.id);
  const occupancy = new Map(sensors
    .filter((s) => s.occupancy && s.occupancy.length > 0)
    .map((s) => [s.id, [...s.occupancy!].sort((a, b) => a.t - b.t)]));
  return {
    raw,
    samples: mergeComfort(raw, timeline, known),
    timeline,
    model: {
      rooms,
      roomSet: new Set(rooms),
      thermostatId: sensors.find((s) => s.isThermostat)?.id ?? null,
      config,
      occupancy,
      timeline,
    },
    grid: alignSensors(sensors),
    points: new Map(sensors.map((s) => [s.id, cleanPoints(s.points)])),
  };
}

function participationOf(id: string, config: ParticipationConfig | null): Participation {
  const of = (ids: string[] | null | undefined) => (ids === null || ids === undefined ? null : ids.includes(id));
  return config
    ? { home: of(config.home), sleep: of(config.sleep), away: of(config.away) }
    : unknownParticipation();
}

function day(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function analyzePlacement(input: PlacementInput): PlacementInsights {
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  const config = input.participation ?? null;
  const clock = localClock(input.timeZone);
  const heat = dataset(input.sensors, input.hvac, input.comfort, config);
  const { samples, model } = heat;
  // History with only unavailable/unknown rows says nothing about the thermostat.
  const recorded = heat.raw.filter((s) => !s.gap);
  const hvacAvailable = recorded.length > 0;
  const inWindow = (e: PlacementEvent) => e.t >= startMs && e.t <= endMs;

  // Every Sleep → Home change is a wake-up; those with a heating run are
  // heat-ups that replace the observed morning warm-up around them.
  const wakes = detectWakes(samples, heat.timeline, startMs, endMs);
  const wakeEvents = new Map<PlacementEvent, Wake>();
  wakes.forEach((wake) => {
    if (wake.run) wakeEvents.set({ type: 'wake', t: wake.run.from, inferred: false }, wake);
  });
  const heated = wakes.filter((w) => w.run !== null);
  const nearWake = (t: number) => {
    const index = firstIndexAfter(heated, t - WAKE_TAIL_MS, (w) => w.h, false);
    return index < heated.length && heated[index].h <= t + WAKE_LEAD_MS;
  };
  // Recorder retention can be shorter than the window and the earliest state
  // may be a snapshot, so mornings are inferred for any day without an
  // observed one rather than only before the earliest state.
  const observed = [
    ...detectHvacEvents(samples, input.timeZone)
      .filter((e) => inWindow(e) && !(e.type === 'morning' && nearWake(e.t))),
    ...wakeEvents.keys(),
  ].sort((a, b) => a.t - b.t);
  const events = [
    ...observed,
    ...inferMorningEvents(input.sensors, input.timeZone, samples, observed).filter(inWindow),
  ].sort((a, b) => a.t - b.t);
  const contexts = heatingContexts(heat.grid, model, samples, events, wakeEvents);
  const wakeWindows = wakes.map(wakeWindow);
  const heatScan = scan({
    grid: heat.grid, from: startMs, to: endMs, model, samples, clock, mode: 'heating', windows: wakeWindows,
  });
  const estimates = estimateParticipation(heat.grid, model, startMs, endMs);

  // Cooling: the most recent cooling within the past year (the same data when
  // the service fetched one range covering both).
  const cooling = input.cooling ?? null;
  let cool: Dataset | null = null;
  let coolRuns: Run[] = [];
  let coolContexts: EventContext[] = [];
  let coolScan: ReturnType<typeof scan> | null = null;
  if (cooling) {
    const shared = cooling.sensors === undefined && cooling.hvac === undefined && cooling.comfort === undefined;
    const data = shared ? heat : dataset(
      cooling.sensors ?? input.sensors,
      cooling.hvac === undefined ? input.hvac : cooling.hvac,
      cooling.comfort === undefined ? input.comfort : cooling.comfort,
      config,
    );
    const from = cooling.start.getTime();
    const to = cooling.end.getTime();
    coolRuns = runsWithin(data.samples, from, to, coolingNow, COOL_RUN_MERGE_MS);
    coolContexts = coolRuns.map((run) => eventContext(
      data.grid,
      data.model,
      { type: 'cooling', t: run.from, inferred: false },
      'cooling',
      settingAt(data.timeline, run.from),
      run,
      null,
    ));
    coolScan = scan({
      grid: data.grid, from, to, model: data.model, samples: data.samples, clock, mode: 'cooling', windows: coolRuns,
    });
    cool = data;
  }

  const runtime = hvacAvailable
    ? runsWithin(samples, startMs, endMs, heatingNow, 0).reduce((sum, r) => sum + r.to - r.from, 0)
    : null;
  const passiveWarmth = passiveSummary(heatScan.passive);
  const passiveCooling = coolScan ? passiveSummary(coolScan.passive) : null;
  let coolingRange = '';
  if (cooling) {
    coolingRange = `cooling from ${day(cooling.start.getTime())} to ${day(cooling.end.getTime())}`
      + `${cooling.end.getTime() <= startMs ? ', last cooling season' : ''}`;
  }
  const env: Env = {
    followMe: config?.followMe ?? null,
    hasAverage: model.thermostatId !== null,
    heatingRuntimeMs: runtime,
    windowDays: input.windowDays,
    heatingRare: runtime !== null && runtime < RARE_RUNTIME_SHARE * (endMs - startMs),
    passiveHeat: passiveWarmth !== null && passiveWarmth.share >= PASSIVE_SHARE,
    passiveWarmth,
    passiveCooling,
    wakes,
    coolingRange,
  };

  const homeWindows: Run[] = [];
  heat.timeline.forEach((change, i) => {
    if (change.setting !== 'home') return;
    const from = Math.max(change.t, startMs);
    const to = Math.min(heat.timeline[i + 1]?.t ?? endMs, endMs);
    if (to > from) homeWindows.push({ from, to });
  });

  const allContexts = [...contexts, ...coolContexts];
  const analyzed: Analyzed[] = input.sensors.map((sensor) => {
    const room = !sensor.isThermostat;
    const points = heat.points.get(sensor.id)!;
    const measured = measure(sensor.id, points, allContexts);
    const heatClass = classify(measured.heat, measured.heatSamples);
    const coolClass = classify(measured.cool, measured.coolSamples);
    const heatRoom = room ? heatScan.rooms.get(sensor.id) : undefined;
    const coolRoom = room ? coolScan?.rooms.get(sensor.id) : undefined;
    const offsetOf = (types?: PlacementEventType[]) => roundOrNull(mean(measured.heat
      .filter((e) => !types || types.includes(e.type)).map((e) => e.offset)));
    const periodOffsets: PeriodOffsets = {
      sleep: roundOrNull(meanOf(heatRoom?.periods.sleep)),
      wake: roundOrNull(meanOf(heatRoom?.periods.wake)),
      home: roundOrNull(meanOf(heatRoom?.periods.home)),
      heatingRuns: roundOrNull(meanOf(heatRoom?.periods.heatingRuns)),
      cooling: roundOrNull(meanOf(coolRoom?.periods.cooling)),
    };
    const heatDays = dailyCounts(heatRoom, 'heating');
    const coolDays = dailyCounts(coolRoom, 'cooling');
    const occupancy = model.occupancy.get(sensor.id);
    const coolPoints = cool?.points.get(sensor.id);
    const inWindowPoints = points.filter((p) => p.t >= startMs && p.t < endMs).length;
    let classification = heatClass;
    if (!room) classification = inWindowPoints > 0 ? 'representative' : 'insufficient';
    const assessed = heatClass !== 'insufficient' || coolClass !== 'insufficient'
      || heatDays.days >= MIN_EVENTS || coolDays.days >= MIN_EVENTS;
    return {
      room,
      measured,
      heatClass,
      coolClass,
      heatScan: heatRoom,
      coolScan: coolRoom,
      estimated: estimates.get(sensor.id) ?? unknownParticipation(),
      out: {
        id: sensor.id,
        name: room ? sensor.name : COMFORT_AVERAGE_NAME,
        isThermostat: sensor.isThermostat,
        averageOffset: offsetOf(),
        morningOffset: offsetOf(['wake', 'morning']),
        returnOffset: offsetOf(['return']),
        overshoot: roundOrNull(mean(measured.overshoots)),
        sampleCount: room ? measured.heatSamples : inWindowPoints,
        classification,
        wakeOffset: periodOffsets.wake,
        coolingOffset: periodOffsets.cooling,
        participation: participationOf(sensor.id, config),
        occupiedShare: { wake: occupiedShare(occupancy, wakeWindows), home: occupiedShare(occupancy, homeWindows) },
        verdict: room && !assessed ? 'insufficient' : null,
        verdictSummary: null,
        periodOffsets,
        wakeOvershoot: roundOrNull(wakeOvershootOf(points, wakes, samples)),
        coolingUndershoot: cool && coolPoints ? roundOrNull(coolingUndershootOf(coolPoints, coolRuns, cool.samples)) : null,
        consistency: room
          ? {
            days: heatDays.days,
            coldDays: heatDays.cold,
            warmDays: heatDays.warm,
            coolingDays: coolDays.days,
            coolingColdDays: coolDays.cold,
            coolingWarmDays: coolDays.warm,
          }
          : null,
        recommendationIds: [],
      },
    };
  });

  // Verdicts are relative to the other rooms: heating first, else cooling.
  const rooms = analyzed.filter((a) => a.room);
  const heatSkews = new Map<Analyzed, Skew | null>();
  const coolSkews = new Map<Analyzed, Skew | null>();
  const typicalOf = (scan: (a: Analyzed) => RoomScan | undefined) => median(rooms
    .map((a) => meanOf(scan(a)?.bias)).filter((b): b is number => b !== null));
  const typicalHeat = typicalOf((a) => a.heatScan);
  const typicalCool = typicalOf((a) => a.coolScan);
  analyzed.forEach((a) => {
    if (!a.room) {
      a.out.verdictSummary = COMFORT_AVERAGE_SUMMARY;
      return;
    }
    heatSkews.set(a, skewOf(a, 'heating', typicalHeat));
    coolSkews.set(a, skewOf(a, 'cooling', typicalCool));
    const skew = heatSkews.get(a) ?? coolSkews.get(a) ?? null;
    if (skew) a.out.verdict = skew.direction === 'below' ? 'cold_outlier' : 'warm_outlier';
    else if (a.out.verdict === null) a.out.verdict = 'representative';
    a.out.verdictSummary = verdictSummaryOf(a, skew, env);
  });

  const ranked: Ranked[] = [];
  rooms.forEach((a) => {
    const wake = wakeRec(a, env, rooms);
    if (wake) ranked.push(wake);
    const heatSkew = heatSkews.get(a);
    if (heatSkew && !(wake && heatSkew.direction === 'below')) {
      const rec = skewRec(a, heatSkew, env, rooms) ?? addRec(a, heatSkew, env);
      if (rec) ranked.push(rec);
    }
    const coolSkew = coolSkews.get(a);
    if (coolSkew) {
      const rec = skewRec(a, coolSkew, env, rooms) ?? addRec(a, coolSkew, env);
      if (rec) ranked.push(rec);
    }
  });
  // Without a heating outlier, a room overshooting after heating stops may
  // not be in Home.
  if (!ranked.some((r) => r.rec.mode === 'heating')) {
    rooms.forEach((a) => {
      const rec = overshootAddRec(a, env);
      if (rec) ranked.push(rec);
    });
  }
  ranked.push(...passiveRecs(env, rooms), ...mismatchRecs(rooms, config));
  ranked.sort((a, b) => (
    SEVERITY_RANK[a.rec.severity] - SEVERITY_RANK[b.rec.severity] || a.rank - b.rank || b.magnitude - a.magnitude
  ));
  const recommendations = ranked.map((r) => r.rec);
  if (recommendations.length === 0) {
    const summary = noChanges(rooms, events, {
      checked: input.cooling !== undefined, found: cooling !== null, events: coolRuns.length,
    });
    if (summary) recommendations.push(summary);
  }
  analyzed.forEach((a) => {
    a.out.recommendationIds = recommendations
      .filter((r) => r.sensorId === a.out.id || r.affectedSensorIds.includes(a.out.id))
      .map((r) => r.id);
  });

  const mornings = events.filter((e) => e.type === 'morning' || e.type === 'wake');
  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    windowDays: input.windowDays,
    unit: '°C',
    coverage: {
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      hvacHistoryAvailable: hvacAvailable,
      hvacEarliestStateAt: hvacAvailable ? new Date(recorded[0].t).toISOString() : null,
      returnHistoryAvailable: heat.timeline.length > 0,
      morningEvents: mornings.length,
      inferredMorningEvents: mornings.filter((e) => e.inferred).length,
      returnEvents: events.filter((e) => e.type === 'return').length,
      unknownUnitWindows: input.unknownUnitWindows ?? 0,
      participationConfigured: !!config && COMFORT_SETTINGS.some((s) => config[s] !== null),
      followMe: config?.followMe ?? null,
      occupancyAvailable: model.occupancy.size > 0,
      comfortScheduleAvailable: heat.timeline.length > 0,
      wakeEvents: wakes.length,
      coolingFrom: cooling ? cooling.start.toISOString() : null,
      coolingTo: cooling ? cooling.end.toISOString() : null,
      coolingEvents: coolRuns.length,
    },
    sensors: analyzed.map((a) => a.out),
    recommendations,
  };
}
