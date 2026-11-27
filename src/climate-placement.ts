// Pure analysis behind GET /climate/placement-insights. The thermostat-reported
// comfort reading is preferred; a simple mean of participating sensors is an
// approximation, not a proven description of HomeKit's reading. The analysis
// looks for room sensors that may skew it during warm-ups and cooling, and for
// warmth or coolness without the system running. No I/O here — see
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
// occupiedShare needs occupancy known for this share of the time.
export const OCCUPANCY_COVERAGE = 0.75;
// A Sleep setback or Smart Recovery warm-up at least this large is mentioned.
export const SETBACK_NOTE = 2.0;
export const LONG_RAMP_MS = 60 * 60 * 1000;
// A day's mean offset at least this far from the house counts as a cold/warm day.
export const DAILY_THRESHOLD = 0.5;
// Passive warmth (coolness): the reported or approximated comfort reading this
// far over the heating set point (under the cooling set point) while idle, for
// at least PASSIVE_SHARE of at least PASSIVE_MIN_SAMPLES idle 15-minute points.
export const PASSIVE_THRESHOLD = 1.0;
export const PASSIVE_SHARE = 0.5;
export const PASSIVE_MIN_SAMPLES = 96;
// Heating running for less than this share of the window counts as rare.
export const RARE_RUNTIME_SHARE = 0.1;
// Possible room participation is estimated using a simple mean approximation:
// subsets within FIT_MARGIN of the best fit, itself within FIT_TOLERANCE over
// at least FIT_MIN_SAMPLES comparable points.
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
  // A thermostat-associated sensor, not a room. It is the reported comfort
  // reading only if positively identified by primaryThermostatId.
  isThermostat: boolean;
  // °C averages over [t, t + BUCKET_MS), t in epoch milliseconds.
  points: { t: number; v: number }[];
  // Change-driven occupancy (each value holds until the next); null or absent
  // when the sensor has no occupancy history.
  occupancy?: OccupancySample[] | null;
}

// Which room sensor ids each comfort setting uses (null = unknown), Follow Me,
// and the separate physical thermostat sensor's participation when known.
export interface ParticipationConfig {
  home: string[] | null;
  sleep: string[] | null;
  away: string[] | null;
  followMe: boolean | null;
  thermostat?: Partial<Record<ComfortSetting, boolean | null>>;
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

// The most recent cooling found in available history within the past year.
// Data fields default to the heating data (when one range covers both).
export interface CoolingInput {
  start: Date;
  end: Date;
  sensors?: SensorSeriesInput[];
  hvac?: HvacSample[] | null;
  comfort?: ComfortSample[] | null;
  thermostatOccupancy?: OccupancySample[] | null;
}

export interface PlacementInput {
  start: Date;
  end: Date;
  windowDays: number;
  timeZone: string;
  sensors: SensorSeriesInput[];
  // A positively identified reported-temperature series for the selected
  // climate device; null or omitted when its meaning isn't established.
  primaryThermostatId?: string | null;
  // Physical built-in sensor occupancy, independent of the reported reading.
  // If omitted, an identified thermostat series may supply it for callers
  // that already associate occupancy with that series.
  thermostatOccupancy?: OccupancySample[] | null;
  // Discovery found temperature entities it could not classify as rooms or
  // thermostats, so unmodeled room subsets may still be plausible.
  incompleteSensorInventory?: boolean;
  // null when thermostat history could not be read.
  hvac: HvacSample[] | null;
  // Comfort setting history; where known it takes precedence over the samples' presetMode.
  comfort?: ComfortSample[] | null;
  participation?: ParticipationConfig | null;
  // null when none was found in the available history; absent when not checked.
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
  // Offsets from the average of the room sensors (thermostat-associated
  // sensors excluded) during heat-ups.
  averageOffset: number | null;
  morningOffset: number | null;
  returnOffset: number | null;
  overshoot: number | null;
  sampleCount: number;
  classification: SensorClassification;
  // Offsets from the thermostat's reported comfort reading, or an approximate
  // mean of participating / occupied sensors when that reading is unavailable.
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
    thermostatParticipationSupported: true;
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

// Do not apply a later grid-time mode to a source bucket. A known off/cool
// state at any point in the bucket makes it unsuitable for heating offsets.
function heatingPossibleDuring(samples: HvacSample[], window: Run): boolean {
  const index = stateIndexAt(samples, window.from);
  if (index >= 0 && rulesOutHeating(samples[index])) return false;
  for (let i = index + 1; i < samples.length && samples[i].t < window.to; i += 1) {
    if (rulesOutHeating(samples[i])) return false;
  }
  return true;
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
  const series = sensors.filter((sensor) => !sensor.isThermostat)
    .map((sensor) => cleanPoints(sensor.points)).filter((points) => points.length >= 2);
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

function settingDuring(timeline: SettingChange[], window: Run): ComfortSetting | null {
  const setting = settingAt(timeline, window.from);
  const next = firstIndexAfter(timeline, window.from, timeOf, true);
  return setting !== null && (timeline[next]?.t ?? Number.POSITIVE_INFINITY) >= window.to ? setting : null;
}

function homeOvershootWindow(timeline: SettingChange[], window: OvershootWindow): OvershootWindow | null {
  if (timeline.length === 0) return window;
  if (settingAt(timeline, window.from) !== 'home') return null;
  const nextChange = timeline.find((change) => change.t > window.from);
  const to = Math.min(window.to, nextChange?.t ?? window.to);
  return to > window.from ? { ...window, to } : null;
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
// shorter reported-idle spells than `merge` (never across a gap, an unknown
// action or any other action). Only the states in force then are visited.
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
    } else if (sample.gap || !/^idle$/i.test(sample.hvacAction ?? '')) {
      // Only a reported idle is bridged: not a gap, an unknown action, or any
      // other action (e.g. cooling between heating runs, or off).
      bridgeable = false;
    }
  }
  return runs;
}

const heatingNow = (sample: HvacSample) => isHeating(sample.hvacAction);
const coolingNow = (sample: HvacSample) => isCooling(sample.hvacAction);

// Change-driven action history covers an interval only if a known action was
// already in force at its start and no gap or unknown action interrupts it.
function actionsKnownThroughout(samples: HvacSample[], from: number, to: number): boolean {
  const index = stateIndexAt(samples, from);
  if (index < 0 || to <= from) return false;
  for (let i = index; i < samples.length && samples[i].t < to; i += 1) {
    const action = samples[i].hvacAction;
    if (samples[i].gap || !action || /^(unknown|unavailable)$/i.test(action)) return false;
  }
  return true;
}

interface SettingRun extends Run {
  setting: ComfortSetting | null;
}

// Runs split wherever the comfort setting changes, each with the setting in
// force (null: unknown).
function splitBySetting(timeline: SettingChange[], runs: Run[]): SettingRun[] {
  const parts: SettingRun[] = [];
  runs.forEach((run) => {
    let t = run.from;
    let index = firstIndexAfter(timeline, t, timeOf, true) - 1;
    while (t < run.to) {
      const end = Math.min(run.to, timeline[index + 1]?.t ?? run.to);
      if (end > t) parts.push({ from: t, to: end, setting: index >= 0 ? timeline[index].setting : null });
      t = end;
      index += 1;
    }
  });
  return parts;
}

interface Wake {
  // When Home started after Sleep, and when the next setting started.
  h: number;
  next: number;
  // The warm-up's heating: from the first run in the WAKE_LEAD_MS before Home
  // (Smart Recovery preheats, possibly finishing before Home) to the end of
  // the last one starting before Home; else the first run after Home.
  run: Run | null;
  // Active heating intervals split where the comfort setting changes.
  parts: SettingRun[];
  // Home set point minus the set point before the warm-up.
  setback: number | null;
  // Active heating time in the selected warm-up, null when the search period
  // or its run boundaries aren't fully observed.
  heatingMs: number | null;
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
      const searchFrom = h - WAKE_LEAD_MS;
      const searchTo = Math.min(h + WAKE_TAIL_MS, next);
      const runs = runsWithin(samples, searchFrom, searchTo, heatingNow, HEAT_RUN_MERGE_MS);
      const activeRuns = runsWithin(samples, searchFrom, searchTo, heatingNow, 0);
      const before = runs.filter((r) => r.from < h);
      const after = runs.find((r) => r.from >= h);
      let selected: Run[] = [];
      if (before.length > 0) selected = before;
      else if (after) selected = [after];
      const run = selected.length > 0 ? { from: selected[0].from, to: selected[selected.length - 1].to } : null;
      let setback: number | null = null;
      if (run) {
        const before = samples[stateIndexAt(samples, Math.min(run.from, h) - 1)];
        const home = samples[stateIndexAt(samples, h + BUCKET_MS)];
        if (before && home && before.setpoint !== null && home.setpoint !== null) {
          setback = home.setpoint - before.setpoint;
        }
      }
      const selectedActiveRuns = run
        ? activeRuns.filter((r) => r.from < run.to && r.to > run.from)
        : [];
      const startIndex = run ? stateIndexAt(samples, run.from) : -1;
      const endIndex = run ? stateIndexAt(samples, run.to) : -1;
      const startObserved = !run || run.from > searchFrom || (startIndex > 0 && samples[startIndex].t === run.from
        && !samples[startIndex - 1].gap && samples[startIndex - 1].hvacAction !== null
        && !heatingNow(samples[startIndex - 1]));
      const endObserved = !run || run.to < searchTo || (endIndex >= 0 && samples[endIndex].t === run.to
        && !samples[endIndex].gap && samples[endIndex].hvacAction !== null && !heatingNow(samples[endIndex]));
      const complete = searchFrom >= from && searchTo <= to && startObserved && endObserved
        && actionsKnownThroughout(samples, searchFrom, searchTo);
      wakes.push({
        h,
        next,
        run,
        parts: splitBySetting(timeline, selectedActiveRuns),
        setback,
        heatingMs: complete ? selectedActiveRuns.reduce((sum, r) => sum + r.to - r.from, 0) : null,
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

function inActiveRuns(runs: Run[], source: number | undefined): boolean {
  return source !== undefined && runs.some((run) => source >= run.from && source + BUCKET_MS <= run.to);
}

function occupiedAt(occupancy: OccupancySample[] | undefined, t: number): boolean | null {
  if (!occupancy || occupancy.length === 0) return null;
  const index = firstIndexAfter(occupancy, t, timeOf, true) - 1;
  return index >= 0 ? occupancy[index].occupied : null;
}

// Occupancy must be known and unchanged throughout the source interval, not
// merely at the later grid time. A change exactly at the end is not inside it.
function occupiedDuring(occupancy: OccupancySample[] | undefined, window: Run): boolean | null {
  const initial = occupiedAt(occupancy, window.from);
  if (initial === null || !occupancy) return null;
  for (let i = firstIndexAfter(occupancy, window.from, timeOf, true);
    i < occupancy.length && occupancy[i].t < window.to; i += 1) {
    if (occupancy[i].occupied !== initial) return null;
  }
  return initial;
}

// The combined extent of the actual 15-minute source buckets, including any
// gap between carried-forward and newer readings.
function sourceWindow(grid: Grid, t: number, ids: string[]): Run | null {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const source = grid.sources.get(id)?.get(t);
    if (source === undefined) return null;
    from = Math.min(from, source);
    to = Math.max(to, source + BUCKET_MS);
  }
  return from < to ? { from, to } : null;
}

function containsWindow(outer: Run, inner: Run): boolean {
  return inner.from >= outer.from && inner.to <= outer.to;
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
// The reported or approximated comfort reading.

interface Model {
  rooms: string[];
  roomSet: Set<string>;
  thermostatId: string | null;
  thermostatOccupancy: OccupancySample[] | null;
  incompleteSensorInventory: boolean;
  config: ParticipationConfig | null;
  occupancy: Map<string, OccupancySample[]>;
  timeline: SettingChange[];
  // Participation estimated from this dataset's thermostat reading.
  estimated: Map<string, Participation> | null;
}

// An empty room list and an excluded thermostat cannot describe a sensor-free
// Ecobee setting: its thermostat sensor is used when the last sensor is removed.
function contradictorySetting(config: ParticipationConfig | null, setting: ComfortSetting): boolean {
  return config?.[setting]?.length === 0 && config.thermostat?.[setting] === false;
}

function thermostatMemberIn(model: Model, setting: ComfortSetting): boolean | null {
  const member = model.config?.thermostat?.[setting] ?? null;
  return contradictorySetting(model.config, setting) ? null : member;
}

// Prefer a positively identified fresh thermostat-reported reading; otherwise
// approximate it with complete room readings only when the built-in sensor is
// excluded in the assumed Follow Me model. Occupancy must be stable across
// all source buckets used; actual HomeKit timing and weighting are unverified.
function effectiveAt(
  model: Model,
  grid: Grid,
  t: number,
  setting: ComfortSetting | null,
  referenceId?: string,
  bounds?: Run,
): number | null {
  const own = model.thermostatId === null ? undefined : grid.values.get(model.thermostatId)?.get(t);
  if (own !== undefined) {
    const window = sourceWindow(grid, t, [model.thermostatId!, ...(referenceId ? [referenceId] : [])]);
    if (!window || (bounds && !containsWindow(bounds, window))) return null;
    if (setting && settingDuring(model.timeline, window) !== setting) return null;
    return own;
  }
  const configured = setting ? model.config?.[setting] : null;
  if (!setting || !configured?.length || configured.some((id) => !model.roomSet.has(id))) return null;
  const fresh = (id: string) => grid.values.get(id)?.has(t) === true;
  const window = sourceWindow(grid, t, [...(referenceId ? [referenceId] : []), ...configured.filter(fresh)]);
  if (!window || (bounds && !containsWindow(bounds, window)) || settingDuring(model.timeline, window) !== setting) return null;
  const occupied = (id: string) => occupiedDuring(model.occupancy.get(id), window);
  let members = configured;
  const followMe = model.config?.followMe ?? null;
  const thermostat = thermostatMemberIn(model, setting);
  if (thermostat !== false && (followMe !== true || occupiedDuring(model.thermostatOccupancy ?? undefined, window) !== false)) return null;
  // The only participant counts regardless of occupancy or Follow Me.
  if (followMe !== false && !(thermostat === false && members.length === 1)) {
    if (members.some((id) => occupied(id) === null)) return null;
    const occupiedRooms = members.filter((id) => occupied(id) === true);
    // With no occupied room, Follow Me also averages the thermostat if it participates.
    if (thermostat !== false && occupiedRooms.length === 0) return null;
    if (occupiedRooms.length > 0 && occupiedRooms.length < members.length) {
      if (followMe === null) return null;
      members = occupiedRooms;
    }
  }
  if (!members.every(fresh)) return null;
  return mean(members.map((id) => grid.values.get(id)!.get(t)!));
}

// Source extent for the effective reading, conservatively including all fresh
// configured rooms used when the reported reference isn't available.
function effectiveSource(model: Model, grid: Grid, t: number, setting: ComfortSetting | null): Run | null {
  const primary = model.thermostatId;
  if (primary && grid.values.get(primary)?.has(t)) return sourceWindow(grid, t, [primary]);
  const configured = setting ? model.config?.[setting] ?? [] : [];
  return sourceWindow(grid, t, configured.filter((id) => grid.values.get(id)?.has(t)));
}

// A passive sample needs a reported idle action, a suitable mode and the same
// set point throughout its temperature source interval.
function passiveSetpoint(samples: HvacSample[], window: Run, mode: PlacementMode): number | null {
  const index = stateIndexAt(samples, window.from);
  if (index < 0) return null;
  const point = mode === 'heating' ? samples[index].setpoint : coolPointOf(samples[index]);
  if (point === null) return null;
  for (let i = index; i < samples.length && samples[i].t < window.to; i += 1) {
    const sample = samples[i];
    if (sample.gap || !/^idle$/i.test(sample.hvacAction ?? '')) return null;
    if (mode === 'heating') {
      if (!/^(heat|heat_cool|auto)$/i.test(sample.hvacMode ?? '') || sample.setpoint !== point) return null;
    } else if (!/^cool$/i.test(sample.hvacMode ?? '') || coolPointOf(sample) !== point) return null;
  }
  return point;
}

// Whether a room is in a setting: configured, else estimated (null: unknown).
function memberIn(model: Model, id: string, setting: ComfortSetting): boolean | null {
  if (contradictorySetting(model.config, setting)) return null;
  const configured = model.config?.[setting];
  if (configured !== null && configured !== undefined) return configured.includes(id);
  return model.estimated?.get(id)?.[setting] ?? null;
}

// With Follow Me on, whether a room (taken as in the setting) would count
// during the source interval under the assumed occupancy model.
function followMeCounts(model: Model, id: string, window: Run, setting: ComfortSetting): boolean | null {
  const configured = model.config?.[setting];
  if (thermostatMemberIn(model, setting) === false && configured?.length === 1 && configured[0] === id) return true;
  const occupied = (sensorId: string) => occupiedDuring(model.occupancy.get(sensorId), window);
  const roomOccupied = occupied(id);
  if (roomOccupied === null) return null;
  if (roomOccupied) return true;
  // Without a room list, discovery may not include every participant.
  let unknown = configured === null || configured === undefined || contradictorySetting(model.config, setting);
  const others = new Set([...model.rooms, ...(configured ?? [])]);
  for (const other of others) {
    if (other === id) continue;
    const otherMember = memberIn(model, other, setting);
    const otherOccupied = occupied(other);
    if (otherMember !== false && otherOccupied !== false) {
      if (otherMember === true && otherOccupied === true) return false;
      unknown = true;
    }
  }
  const thermostat = thermostatMemberIn(model, setting);
  const thermostatOccupied = occupiedDuring(model.thermostatOccupancy ?? undefined, window);
  if (thermostat !== false && thermostatOccupied !== false) {
    if (thermostat === true && thermostatOccupied === true) return false;
    unknown = true;
  }
  return unknown ? null : true;
}

// Whether a room would count in the approximation during the source interval,
// if it's in the setting in force: always without Follow Me; with it, while
// occupied or while no member was. When Follow Me isn't given, only where it
// would count either way. Null when the model cannot determine this.
function contributesAt(model: Model, id: string, window: Run, setting: ComfortSetting | null): boolean | null {
  if (setting === null) return null;
  if (memberIn(model, id, setting) === false) return false;
  const followMe = model.config?.followMe ?? null;
  if (followMe === false) return true;
  const counts = followMeCounts(model, id, window, setting);
  return followMe === true || counts === true ? counts : null;
}

// Modeled share of comparable grid samples in `windows`; not a measured
// participation time or weighting. Null below OCCUPANCY_COVERAGE, and when
// the model gives zero for known samples but some are unknown.
interface Contribution {
  share: number;
  coverage: number;
}

function contributionShare(model: Model, grid: Grid, windows: Run[], id: string, activeRuns?: Run[]): Contribution | null {
  let total = 0;
  let known = 0;
  let counted = 0;
  windows.forEach((w) => {
    for (let i = firstIndexAfter(grid.times, w.from, itself, true); i < grid.times.length && grid.times[i] <= w.to; i += 1) {
      const t = grid.times[i];
      const roomWindow = sourceWindow(grid, t, [id]);
      const setting = roomWindow ? settingDuring(model.timeline, roomWindow) : null;
      const candidates = [
        id, ...(model.thermostatId ? [model.thermostatId] : []), ...(setting ? model.config?.[setting] ?? [] : []),
      ].filter((sensorId) => grid.sources.get(sensorId)?.has(t));
      const window = roomWindow ? sourceWindow(grid, t, candidates) : null;
      const comparable = window && containsWindow(w, window)
        && (!activeRuns || activeRuns.some((run) => containsWindow(run, window)))
        && setting !== null && settingDuring(model.timeline, window) === setting;
      const c = comparable ? contributesAt(model, id, window, setting) : null;
      total += 1;
      if (c !== null) known += 1;
      if (c === true) counted += 1;
    }
  });
  if (known === 0 || known < OCCUPANCY_COVERAGE * total || (counted === 0 && known < total)) return null;
  return { share: counted / known, coverage: known / total };
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
  // Offsets from the reported or approximated comfort reading.
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
  // Heating (cooling) runs: idle time within OVERSHOOT_WINDOW_MS after one
  // still holds its heat (coolness), so it isn't passive warmth (coolness).
  runs: Run[];
  // Actual active intervals, without merging intervening idle time.
  activeRuns: Run[];
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
  const recent: Run[] = [];
  spec.runs.forEach((r) => {
    const last = recent[recent.length - 1];
    const to = r.to + OVERSHOOT_WINDOW_MS;
    if (last && r.from <= last.to) last.to = Math.max(last.to, to);
    else recent.push({ from: r.from, to });
  });
  const times = grid.times.slice(
    firstIndexAfter(grid.times, spec.from, itself, true),
    firstIndexAfter(grid.times, spec.to, itself, true),
  );
  times.forEach((t) => {
    const setting = settingAt(model.timeline, t);
    const effective = effectiveAt(model, grid, t, setting, undefined, { from: spec.from, to: spec.to });
    // Heating offsets use the state during each source bucket, not the later
    // grid time; without thermostat history all times still count.
    const counts = mode === 'heating' || inRuns(spec.windows, t);
    if (counts) {
      const fresh = model.rooms.filter((id) => {
        if (!grid.values.get(id)!.has(t)) return false;
        const source = sourceWindow(grid, t, [id]);
        if (mode === 'heating') return !!source && heatingPossibleDuring(samples, source);
        return !!source && spec.windows.some((window) => containsWindow(window, source))
          && spec.activeRuns.some((run) => containsWindow(run, source));
      });
      // Home evidence must use Home source windows for every room in the
      // reference, not a later grid-time setting or a carried Sleep value.
      const referenceRooms = fresh.filter((id) => {
        const source = sourceWindow(grid, t, [id]);
        return !!source && containsWindow({ from: spec.from, to: spec.to }, source)
          && (mode === 'cooling' || model.timeline.length === 0 || settingDuring(model.timeline, source) === 'home');
      });
      const reference = sourceWindow(grid, t, referenceRooms);
      const evidence = mode === 'cooling' || model.timeline.length === 0
        || (!!reference && settingDuring(model.timeline, reference) === 'home');
      const house = evidence && referenceRooms.length >= MIN_SENSORS_FOR_MEAN ? cohortMean(grid, referenceRooms, t) : null;
      const day = house === null ? '' : spec.clock(reference!.to - 1).day;
      fresh.forEach((id) => {
        const room = rooms.get(id)!;
        const value = grid.values.get(id)!.get(t)!;
        if (house !== null && referenceRooms.includes(id)) {
          addTo(room.bias, value - house);
          addTo(room.absBias, Math.abs(value - house));
          const daily = room.daily.get(day) ?? accum();
          addTo(daily, value - house);
          room.daily.set(day, daily);
        }
        const source = sourceWindow(grid, t, [id])!;
        const sourceSetting = settingDuring(model.timeline, source);
        const ownEffective = effectiveAt(model, grid, t, sourceSetting, id, { from: spec.from, to: spec.to });
        if (ownEffective === null) return;
        const offset = value - ownEffective;
        const active = spec.activeRuns.find((run) => containsWindow(run, source));
        if (mode === 'cooling') {
          const window = spec.windows.find((w) => containsWindow(w, source));
          if (window && active) {
            const bounds = { from: Math.max(window.from, active.from), to: Math.min(window.to, active.to) };
            const average = effectiveAt(model, grid, t, sourceSetting, id, bounds);
            if (average !== null) addTo(room.periods.cooling, value - average);
          }
          return;
        }
        if (sourceSetting === 'sleep' || sourceSetting === 'home') addTo(room.periods[sourceSetting], offset);
        const waking = spec.windows.find((window) => containsWindow(window, source));
        if (waking) {
          const average = effectiveAt(model, grid, t, sourceSetting, id, waking);
          if (average !== null) addTo(room.periods.wake, value - average);
        }
        if (active) {
          const average = effectiveAt(model, grid, t, sourceSetting, id, active);
          if (average !== null) addTo(room.periods.heatingRuns, value - average);
        }
      });
    }
    if (effective === null) return;
    const source = effectiveSource(model, grid, t, setting);
    if (!source) return;
    const nextRecent = recent[firstIndexAfter(recent, source.from, (run) => run.to, true)];
    if (nextRecent && nextRecent.from < source.to) return;
    const point = passiveSetpoint(samples, source, mode);
    if (point === null) return;
    const past = mode === 'heating' ? effective - point : point - effective;
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

// Fit every plausible room subset over the same complete, comparable samples,
// only when the physical thermostat sensor is explicitly excluded. Otherwise
// an unscored subset containing a missing room could hide an equally good fit.
function estimateParticipation(grid: Grid, model: Model, from: number, to: number): Map<string, Participation> {
  const result = new Map(model.rooms.map((id) => [id, unknownParticipation()]));
  const n = model.rooms.length;
  if (model.incompleteSensorInventory || model.thermostatId === null || n === 0 || n > MAX_FIT_ROOMS) return result;
  // Follow Me on or not given, with no occupancy history: any subset could
  // have been averaged at any time, and different subsets can share a mean
  // (18/20/22 averages 20 like the 20 room alone), so membership is unknown.
  const followMe = model.config?.followMe ?? null;
  if (followMe !== false && model.occupancy.size === 0) return result;
  const own = grid.values.get(model.thermostatId);
  if (!own) return result;
  const size = 1 << n;
  const sizes = new Uint8Array(size);
  for (let mask = 1; mask < size; mask += 1) sizes[mask] = sizes[mask & (mask - 1)] + 1;
  const fits = Object.fromEntries(COMFORT_SETTINGS.map((s) => [s, {
    errors: new Float64Array(size), counts: new Uint32Array(size),
  }]));
  const sums = new Float64Array(size);
  const tracked = followMe !== false;
  const times = grid.times.slice(
    firstIndexAfter(grid.times, from, itself, true),
    firstIndexAfter(grid.times, to, itself, true),
  );
  times.forEach((t) => {
    const target = own.get(t);
    const window = sourceWindow(grid, t, [model.thermostatId!, ...model.rooms]);
    if (target === undefined || !window || window.from < from || window.to > to) return;
    const setting = settingDuring(model.timeline, window);
    if (setting === null) return;
    if (thermostatMemberIn(model, setting) !== false) return;
    const configured = model.config?.[setting];
    if (configured?.some((id) => !model.roomSet.has(id))) return;
    let occupiedMask = 0;
    const values = model.rooms.map((id, i) => {
      const value = grid.values.get(id)!.get(t);
      if (tracked) {
        const occupied = occupiedDuring(model.occupancy.get(id), window);
        if (occupied === true) occupiedMask |= 1 << i;
        if (occupied === null) return null;
      }
      return value ?? null;
    });
    if (values.some((value) => value === null)) return;
    // When Follow Me is unknown, all subsets must have the same average
    // whether it is on or off, so mixed occupancy isn't comparable.
    if (followMe === null && occupiedMask !== 0 && occupiedMask !== size - 1) return;
    for (let mask = 1; mask < size; mask += 1) {
      const low = mask & -mask;
      sums[mask] = sums[mask ^ low] + values[31 - Math.clz32(low)]!;
    }
    const fit = fits[setting];
    for (let mask = 1; mask < size; mask += 1) {
      const used = followMe === true ? (mask & occupiedMask) || mask : mask;
      fit.errors[mask] += Math.abs(sums[used] / sizes[used] - target);
      fit.counts[mask] += 1;
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
  // A wake-up's heating runs, per comfort setting (else null).
  heatParts: SettingRun[] | null;
}

function eventContext(
  grid: Grid,
  model: Model,
  event: PlacementEvent,
  mode: PlacementMode,
  setting: ComfortSetting | null,
  window: Run,
  overshoot: OvershootWindow | null,
  heatParts: SettingRun[] | null = null,
): EventContext {
  // Only readings taken within the window count.
  const restricted = windowGrid(grid, window.from, window.to);
  const { cohort, times } = cohortAt(restricted, restricted.times, model.roomSet);
  return {
    event, mode, setting, model, cohort: new Set(cohort), times, grid: restricted, overshoot, heatParts,
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
      return eventContext(grid, model, event, 'heating', null, wakeMeasureWindow(wake), overshoot, wake.parts);
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
  // Mean offset from the house (room) average.
  offset: number;
  // Wake-ups: mean offset from the reported or approximated reading while heating
  // ran, per comfort setting in force then (when established at
  // MIN_EVENT_SAMPLES grid times).
  bySetting: Partial<Record<ComfortSetting, number>>;
  inferred: boolean;
}

interface Measured {
  heat: EventStat[];
  cool: EventStat[];
  overshoots: number[];
  homeOvershoots: number[];
  heatSamples: number;
  coolSamples: number;
  // Sum of |offset| over heat-up samples, for the mean absolute difference.
  absoluteOffsetSum: number;
}

// Whether every room used in this reference has a source interval in `only`
// (always, when no comfort setting is known at all).
function inSetting(ctx: EventContext, t: number, only: ComfortSetting): boolean {
  if (ctx.model.timeline.length === 0) return true;
  const source = sourceWindow(ctx.grid, t, [...ctx.cohort]);
  return source !== null && settingDuring(ctx.model.timeline, source) === only;
}

// Offsets per event; with `only`, from just the grid times in that comfort
// setting (heating evidence for one setting).
function measure(
  id: string,
  points: SensorSeriesInput['points'],
  contexts: EventContext[],
  only: ComfortSetting | null = null,
): Measured {
  const measured: Measured = {
    heat: [], cool: [], overshoots: [], homeOvershoots: [], heatSamples: 0, coolSamples: 0, absoluteOffsetSum: 0,
  };
  contexts.forEach((ctx) => {
    const times = only ? ctx.times.filter((t) => inSetting(ctx, t, only)) : ctx.times;
    if (ctx.cohort.has(id) && times.length >= MIN_EVENT_SAMPLES) {
      const members = [...ctx.cohort];
      const filled = ctx.grid.values.get(id)!;
      const sources = ctx.grid.sources.get(id)!;
      const offsets = times.map((t) => filled.get(t)! - cohortMean(ctx.grid, members, t));
      const bySetting: Partial<Record<ComfortSetting, number>> = {};
      const parts = ctx.heatParts ?? [];
      COMFORT_SETTINGS.forEach((setting) => {
        const runs = parts.filter((p) => p.setting === setting);
        const effective = times
          .filter((t) => inActiveRuns(runs, sources.get(t)))
          .map((t) => {
            const run = runs.find((part) => inActiveRuns([part], sources.get(t)))!;
            const average = effectiveAt(ctx.model, ctx.grid, t, setting, id, run);
            return average === null ? null : filled.get(t)! - average;
          })
          .filter((o): o is number => o !== null);
        if (effective.length >= MIN_EVENT_SAMPLES) bySetting[setting] = mean(effective)!;
      });
      const stat: EventStat = {
        type: ctx.event.type, offset: mean(offsets)!, bySetting, inferred: ctx.event.inferred,
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
    const window = ctx.overshoot && !only ? ctx.overshoot : null;
    if (window) {
      const overshoot = overshootIn(points, window);
      if (overshoot !== null) measured.overshoots.push(overshoot);
      const homeWindow = homeOvershootWindow(ctx.model.timeline, window);
      const homeOvershoot = homeWindow ? overshootIn(points, homeWindow) : null;
      if (homeOvershoot !== null) measured.homeOvershoots.push(homeOvershoot);
    }
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
// Sleep → Home change (whether or not heating ran). The set point is the one
// in force as Home starts (its first BUCKET_MS, so a target arriving with it
// counts); the window ends at the next set point, mode or comfort-setting
// change or history gap, so a later intentional change isn't overshoot.
function wakeOvershootOf(points: SensorSeriesInput['points'], wakes: Wake[], samples: HvacSample[]): number | null {
  const peaks = wakes.map((wake) => {
    const start = wake.h + BUCKET_MS;
    const state = samples[stateIndexAt(samples, start)];
    if (!state || state.gap || state.setpoint === null) return null;
    const window = wakeWindow(wake);
    const change = findAfter(samples, start, window.to, (x) => x.gap || x.setpoint !== state.setpoint
      || x.hvacMode !== state.hvacMode || x.presetMode !== state.presetMode);
    return overshootIn(points, {
      from: window.from, to: Math.min(window.to, change?.t ?? window.to), setpoint: state.setpoint,
    });
  }).filter((p): p is number => p !== null);
  return mean(peaks);
}

// Mean of each cooling run's greatest dip below the cool set point in force at
// that reading.
function coolingUndershootOf(points: SensorSeriesInput['points'], runs: Run[], samples: HvacSample[]): number | null {
  const dips = runs.map((run) => {
    const inside = points.slice(
      firstIndexAfter(points, run.from, timeOf, false),
      firstIndexAfter(points, run.to - BUCKET_MS, timeOf, true),
    );
    if (inside.length === 0) return null;
    const undershoots = inside.map((reading) => {
      const state = samples[stateIndexAt(samples, reading.t)];
      const point = state && !state.gap ? coolPointOf(state) : null;
      return point === null ? null : point - reading.v;
    }).filter((undershoot): undershoot is number => undershoot !== null);
    return undershoots.length > 0 ? Math.max(0, ...undershoots) : null;
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
  // Participation estimated from the thermostat's reading (null: can't tell),
  // in the window and in the cooling data.
  estimated: Participation;
  estimatedCool: Participation;
  // Approximate modeled contribution share (null: insufficient evidence).
  // wake: per comfort setting, over the wake-ups' heating runs in it.
  contribution: {
    wake: Partial<Record<ComfortSetting, Contribution | null>>; home: Contribution | null; cooling: Contribution | null;
  };
}

// Cooling run parts grouped by comfort setting, most cooling time first. Parts
// with an unknown setting are left out unless no setting is known at all, when
// they're treated as Home.
function coolingGroups(parts: SettingRun[]): { setting: ComfortSetting; runs: SettingRun[] }[] {
  const known = parts.some((p) => p.setting !== null);
  const groups = COMFORT_SETTINGS.map((setting) => ({
    setting,
    runs: parts.filter((p) => (known ? p.setting === setting : setting === 'home')),
  })).filter((g) => g.runs.length > 0);
  const time = (runs: SettingRun[]) => runs.reduce((sum, r) => sum + r.to - r.from, 0);
  return groups.sort((x, y) => time(y.runs) - time(x.runs));
}

interface Env {
  followMe: boolean | null;
  // Whether any sensor has occupancy history.
  occupancy: boolean;
  // Whether a primary thermostat temperature entity was identified.
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
  // The comfort setting the evidence is from: Home for heating, the setting
  // the cooling ran in for cooling.
  setting: ComfortSetting;
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

function minutes(ms: number): string {
  const amount = Math.round(ms / 60000);
  return `${amount} ${amount === 1 ? 'minute' : 'minutes'}`;
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
// look skewed the opposite way. Cooling is judged per comfort setting; `scope`
// (" in Sleep") names it when cooling ran in more than one.
function skewOf(
  a: Analyzed,
  mode: PlacementMode,
  typical: number | null,
  setting: ComfortSetting = 'home',
  scope = '',
): Skew | null {
  const { name } = a.out;
  const scanned = mode === 'heating' ? a.heatScan : a.coolScan;
  const bias = meanOf(scanned?.bias);
  const standsOut = (sign: number) => bias === null || typical === null || sign * (bias - typical) >= DAILY_THRESHOLD;
  const events = mode === 'heating' ? a.measured.heat : a.measured.cool;
  const cls = mode === 'heating' ? a.heatClass : a.coolClass;
  const noun = mode === 'heating' ? 'heat-ups' : `cooling runs${scope}`;
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
      : [[all, `while cooling ran${scope}`]];
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
      setting,
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
  const daysScope = mode === 'heating' ? 'days' : `days of cooling${scope}`;
  return {
    mode,
    setting,
    direction,
    magnitude: Math.abs(bias),
    evidence: `${name} read ${fmt(bias)} °C ${direction} the house average${mode === 'cooling' ? ` while cooling ran${scope}` : ''}, `
      + `and at least ${DAILY_THRESHOLD.toFixed(1)} °C ${direction} it on ${k} of ${days} ${daysScope}`,
    brief: `${name} reads ${fmt(bias)} °C ${direction} the house average on ${k} of ${days} ${daysScope}`,
  };
}

interface Known {
  value: boolean | null;
  source: 'configured' | 'estimated' | null;
}

function knownIn(a: Analyzed, setting: ComfortSetting, mode: PlacementMode = 'heating'): Known {
  const configured = a.out.participation[setting];
  if (configured !== null) return { value: configured, source: 'configured' };
  const estimated = (mode === 'heating' ? a.estimated : a.estimatedCool)[setting];
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
    below: 'a lower reading could contribute to longer heating and warmer rooms.',
    above: 'a higher reading could contribute to heating stopping sooner, leaving other rooms cooler.',
  },
  cooling: {
    above: 'a higher reading could contribute to longer cooling and colder rooms.',
    below: 'a lower reading could contribute to cooling stopping sooner, leaving other rooms warmer.',
  },
};

const PULL: Record<PlacementMode, Record<BiasDirection, string>> = {
  heating: {
    below: 'pulling the comfort reading down and contributing to warmer rooms',
    above: 'pushing the comfort reading up and contributing to cooler rooms',
  },
  cooling: {
    above: 'pushing the comfort reading up and contributing to colder rooms',
    below: 'pulling the comfort reading down and contributing to warmer rooms',
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
    return `Cooking and appliances could warm a nearby sensor; consider moving it away from the stove and appliances${
      removable ? `, or remove it from ${label}` : ''}.`;
  }
  if (direction === 'above' && isKitchen(a)) {
    return 'Cooking and appliances could warm a nearby sensor; consider moving it away from the stove and appliances '
      + 'or removing it from the comfort settings it may skew.';
  }
  const move = direction === 'below'
    ? 'Move it to an interior wall at about chest height, away from windows, doors and vents'
    : 'Move it out of direct sun and away from vents, lamps and electronics';
  return removable ? `${move}, or remove it from ${label}.` : `${move}.`;
}

function comfortReading(env: Env): string {
  return env.hasAverage ? 'the reported or approximated comfort reading' : 'the approximated comfort reading';
}

function quietNote(env: Env): string {
  if (env.heatingRuntimeMs !== null && env.heatingRare) {
    return ` Heating was reported running ${hours(env.heatingRuntimeMs)} h over ${env.windowDays} days, so this may matter more on colder days.`;
  }
  if (!env.passiveHeat) return '';
  const reference = comfortReading(env);
  return ` ${reference[0].toUpperCase()}${reference.slice(1)} was often above the set point in observed idle samples; `
    + 'this may matter more on colder days.';
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

// Modeled contribution over the skew's evidence (Home for heating; the
// cooling runs in the skew's setting for cooling), or null when unknown.
function shareOf(a: Analyzed, mode: PlacementMode): Contribution | null {
  return mode === 'heating' ? a.contribution.home : a.contribution.cooling;
}

// A zero modeled share isn't proof of exclusion: the HomeKit occupancy stream
// and the thermostat's timing/weighting are not verified.
function countUnknown(env: Env, c: Contribution | null): boolean {
  return env.followMe !== false && (c === null || c.share === 0);
}

const COUNT_UNKNOWN = 'the occupancy and comfort-setting history couldn\'t show whether it counted toward the '
  + 'average for enough of the time';

// Why whether it counted is unknown, as a clause after "but".
function countCaveat(env: Env, c: Contribution | null): string {
  if (env.followMe === true && c?.share === 0) {
    return 'with Follow Me on, the occupancy-based model suggests it may have been left out; actual Follow Me timing '
      + 'and weighting may differ';
  }
  return env.followMe === true
    ? `with Follow Me on, ${COUNT_UNKNOWN}`
    : 'Follow Me wasn\'t specified; if it\'s on it may have left it out of the average while unoccupied, and '
      + 'whether it counted isn\'t known';
}

// participationLead, qualified when whether it counted is unknown.
function countingLead(known: Known, setting: ComfortSetting, unknown: boolean, env: Env, c: Contribution | null): string {
  if (!unknown) return participationLead(known, setting);
  const label = SETTING_LABEL[setting];
  const caveat = `but ${countCaveat(env, c)}. If it counted, `;
  if (known.source === 'configured') return `It's in your ${label} comfort setting, ${caveat}`;
  if (known.source === 'estimated') return `The thermostat's readings suggest it's in your ${label} comfort setting, ${caveat}`;
  return `If it's in your ${label} comfort setting and counted toward the average (${countCaveat(env, c)}), `;
}

function shareText(share: number): string {
  const p = Math.round(share * 100);
  if (share === 0) return '0%';
  if (p === 0) return 'under 1%';
  return p === 100 && share < 1 ? 'over 99%' : `${p}%`;
}

// Follow Me timing and weighting are unverified: report modeled comparable
// samples as an approximation, including the fraction with sufficient data.
function countedNote(env: Env, c: Contribution | null, when: string, known: Known): string {
  if (env.followMe !== true || c === null) return '';
  const part = c.coverage < 1
    ? ` About ${shareText(c.coverage)} of samples had enough data for this estimate; the rest are unknown.`
    : '';
  const verb = known.source === 'configured' ? 'it would have counted' : 'it would have counted if it is in the setting';
  return ` With Follow Me on, the occupancy-based model estimates ${verb} in approximately ${shareText(c.share)} `
    + `of comparable samples ${when} (occupied participants, or all if none are occupied). Actual Follow Me timing `
    + `and weighting may differ from the model.${part}`;
}

function countedWhen(skew: Skew): string {
  return skew.mode === 'heating' ? 'in Home' : `while the AC ran in ${SETTING_LABEL[skew.setting]}`;
}

// Generic outlier tip for a participating (or possibly participating) room.
// For cooling, `undershoot` is each room's dip below the cool set point in the
// skew's own cooling runs (the setting it ran in).
function skewRec(
  a: Analyzed,
  skew: Skew,
  env: Env,
  rooms: Analyzed[],
  undershoot: Map<string, number | null> | null = null,
): Ranked | null {
  const { setting } = skew;
  const known = knownIn(a, setting, skew.mode);
  if (known.value === false) return null;
  const share = shareOf(a, skew.mode);
  const unknown = countUnknown(env, share);
  const heating = skew.mode === 'heating';
  // Cooling tips always recommend moving the sensor.
  const remove = heating && skew.direction === 'above' && isKitchen(a) && known.value === true;
  let prefix = 'move';
  if (!heating) prefix = 'cooling';
  else if (remove) prefix = 'remove';
  const quiet = heating ? quietNote(env) : '';
  let severity: RecommendationSeverity = 'medium';
  const others = rooms.filter((o) => o.out !== a.out && o.out.verdict !== null && o.out.verdict !== 'insufficient');
  const overshooting = others.filter((o) => (o.out.overshoot ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => y.out.overshoot! - x.out.overshoot!);
  const dipOf = (o: Analyzed) => (undershoot ? undershoot.get(o.out.id) ?? null : o.out.coolingUndershoot);
  const overcooled = others.filter((o) => (dipOf(o) ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => dipOf(y)! - dipOf(x)!);
  if (quiet || unknown || (heating && skew.direction === 'above' && known.value === null)) severity = 'low';
  else if (heating && skew.direction === 'below' && skew.magnitude >= STRONG_OFFSET
    && overshooting.some((o) => o.out.overshoot! >= OVERSHOOT_THRESHOLD)) severity = 'high';
  let effect = '';
  if (heating && skew.direction === 'below' && overshooting.length > 0) {
    effect = ` ${listOf(overshooting.map((o) => o.out.name))} peaked `
      + `${listOf(overshooting.map((o) => fmt(o.out.overshoot!)))} °C above the set point on average after heating stopped.`;
  } else if (!heating && skew.direction === 'above' && overcooled.length > 0) {
    effect = ` ${listOf(overcooled.map((o) => o.out.name))} dipped `
      + `${listOf(overcooled.map((o) => fmt(dipOf(o)!)))} °C below the cool set point on average while it ran.`;
  }
  const titles: Record<PlacementMode, Record<BiasDirection, string>> = {
    heating: { below: 'may be keeping the heat on', above: 'may be stopping the heat early' },
    cooling: { above: 'may be keeping the AC on', below: 'may be stopping the AC early' },
  };
  return {
    magnitude: skew.magnitude,
    rank: heating ? 1 : 2,
    rec: recBase(a, {
      id: `${prefix}-${slug(a.out.id)}`,
      severity,
      action: remove ? 'exclude_from_comfort' : 'move',
      title: `${a.out.name} ${titles[skew.mode][skew.direction]}`,
      detail: `${skew.evidence}. ${withLead(countingLead(known, setting, unknown, env, share), CONSEQUENCE[skew.mode][skew.direction])}`
        + `${effect} ${adviceFor(a, skew.direction, setting, true, !heating)}${countedNote(env, share, countedWhen(skew), known)}`
        + `${quiet}${heating ? '' : coolingNote(env)}`,
      mode: skew.mode,
      period: null,
      comfortSetting: setting,
      affectedSensorIds: others.map((o) => o.out.id),
      likelyCauses: causesFor(a, skew.direction, skew.mode),
    }),
  };
}

// Settings the warm-ups heated in where the room read consistently below the
// comfort reference and isn't known to be out. Home comes first.
function wakeSetting(a: Analyzed): {
  setting: ComfortSetting; offsets: number[]; cold: number; offset: number; known: Known; share: Contribution | null;
} | null {
  const candidates = COMFORT_SETTINGS.map((setting) => {
    const offsets = a.measured.heat.filter((e) => e.type === 'wake' && e.bySetting[setting] !== undefined)
      .map((e) => e.bySetting[setting]!);
    if (offsets.length < 2) return null;
    const cold = offsets.filter((o) => o <= -AFFECTED_THRESHOLD).length;
    const offset = mean(offsets)!;
    if (cold / offsets.length < CONSISTENCY_SHARE || offset > -AFFECTED_THRESHOLD) return null;
    const known = knownIn(a, setting);
    const share = a.contribution.wake[setting] ?? null;
    if (known.value === false) return null;
    return {
      setting, offsets, cold, offset, known, share,
    };
  }).filter((c): c is NonNullable<typeof c> => c !== null);
  return candidates.find((c) => c.setting === 'home')
    ?? candidates.sort((x, y) => x.offset - y.offset)[0] ?? null;
}

// A (possibly) participating room reading below the comfort average while
// wake-up warm-ups heated, while other rooms end up over the Home set point.
function wakeRec(a: Analyzed, env: Env, rooms: Analyzed[]): Ranked | null {
  // It must also stand out from the typical room, so one warm room inflating
  // the average doesn't make every other room look like the culprit.
  const wakeOffset = (o: Analyzed) => mean(o.measured.heat.filter((e) => e.type === 'wake').map((e) => e.offset));
  const typical = median(rooms.map(wakeOffset).filter((o): o is number => o !== null));
  const own = wakeOffset(a);
  if (typical === null || own === null || own - typical > -AFFECTED_THRESHOLD) return null;
  const found = wakeSetting(a);
  if (!found) return null;
  const {
    setting, offsets, cold, offset, known, share,
  } = found;
  const label = SETTING_LABEL[setting];
  const unknown = countUnknown(env, share);
  const affected = rooms.filter((o) => o !== a && (o.out.wakeOvershoot ?? 0) >= AFFECTED_THRESHOLD)
    .sort((x, y) => y.out.wakeOvershoot! - x.out.wakeOvershoot!);
  if (affected.length === 0) return null;
  const heated = env.wakes.filter((w) => w.run !== null);
  const setback = mean(heated.map((w) => w.setback).filter((s): s is number => s !== null));
  // Heating time, not the span: other time between runs isn't warm-up.
  const ramp = heated.length > 0 && heated.every((w) => w.heatingMs !== null)
    ? mean(heated.map((w) => w.heatingMs!)) : null;
  let recovery = '';
  if ((setback !== null && setback >= SETBACK_NOTE) || (ramp !== null && ramp >= LONG_RAMP_MS)) {
    const gap = setback !== null && setback > 0 ? ` The Sleep set point averaged ${fmt(setback)} °C below Home.` : '';
    const duration = ramp === null ? '' : ` The warm-up ran ${minutes(ramp)} on average.`;
    recovery = `${gap}${duration} Smart Recovery can start heating before Home; consider a smaller Sleep setback `
      + 'or reviewing Smart Recovery timing.';
  }
  const followMe = countedNote(env, share, `while the warm-ups heated in ${label}`, known);
  const quiet = quietNote(env);
  let severity: RecommendationSeverity = affected[0].out.wakeOvershoot! >= OVERSHOOT_THRESHOLD ? 'high' : 'medium';
  if (quiet || unknown) severity = 'low';
  return {
    magnitude: Math.abs(offset),
    rank: 0,
    rec: recBase(a, {
      id: `wake-${slug(a.out.id)}`,
      severity,
      action: 'move',
      title: `${a.out.name} may be holding the morning warm-up on`,
      detail: `In ${cold} of ${offsets.length} wake-ups (Sleep → Home), ${a.out.name} read ${fmt(offset)} °C below `
        + `the reported or approximated comfort reading${setting === 'home' ? '' : ` while heating in ${label} before Home`}. `
        + `${withLead(countingLead(known, setting, unknown, env, share), 'a low reading could contribute to a longer warm-up.')} `
        + `${listOf(affected.map((o) => o.out.name))} peaked `
        + `${listOf(affected.map((o) => fmt(o.out.wakeOvershoot!)))} °C over the Home set point on average in the 2 hours after waking. `
        + `${adviceFor(a, 'below', setting, true)}${recovery}${followMe}${quiet}`,
      mode: 'heating',
      period: 'wake',
      comfortSetting: setting,
      affectedSensorIds: affected.map((o) => o.out.id),
      likelyCauses: causesFor(a, 'below', 'heating'),
    }),
  };
}

// A room known not to be in Home that is consistently off: adding it lets the
// thermostat account for it.
function addRec(a: Analyzed, skew: Skew, env: Env): Ranked | null {
  const { setting } = skew;
  const label = SETTING_LABEL[setting];
  const known = knownIn(a, setting, skew.mode);
  if (known.value !== false) return null;
  const heating = skew.mode === 'heating';
  if (heating && env.heatingRare) return null;
  const which = known.source === 'configured'
    ? `It isn't in your ${label} comfort setting`
    : `The thermostat's readings suggest it isn't in your ${label} comfort setting`;
  // Over-conditioned (warm while heating, cool while cooling) or under-conditioned.
  const over = (skew.direction === 'above') === heating;
  const effect = over
    ? `Adding it to ${label} may help the thermostat stop ${heating ? 'heating' : 'cooling'} sooner, though the other rooms `
      + `could end up a little ${heating ? 'cooler' : 'warmer'}.`
    : `If the room feels too ${heating ? 'cool' : 'warm'}, adding it to ${label} may help account for it, though `
      + `the other rooms could end up ${heating ? 'warmer' : 'cooler'}.`;
  return {
    magnitude: skew.magnitude,
    rank: heating ? 1 : 2,
    rec: recBase(a, {
      id: `add-${heating ? '' : 'cooling-'}${slug(a.out.id)}`,
      severity: 'medium',
      action: 'include_in_comfort',
      title: `Consider adding ${a.out.name} to your ${label} comfort setting`,
      detail: `${skew.evidence}. ${which}, so its temperature ${known.source === 'configured' ? 'is not listed' : 'may not be included'}. `
        + `${effect}${heating ? '' : coolingNote(env)}`,
      mode: skew.mode,
      period: null,
      comfortSetting: setting,
      affectedSensorIds: [],
      likelyCauses: causesFor(a, skew.direction, skew.mode),
    }),
  };
}

// A room that overshoots after heating stops while it may not be in Home.
function overshootAddRec(a: Analyzed, env: Env): Ranked | null {
  const s = a.out;
  const homeOvershoot = mean(a.measured.homeOvershoots);
  if (homeOvershoot === null || homeOvershoot < OVERSHOOT_THRESHOLD || env.heatingRare) return null;
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
  const lead = known.value !== false ? 'If it isn\'t in your Home comfort setting, adding it'
    : known.source === 'configured' ? 'It isn\'t in your Home comfort setting; adding it'
      : 'The thermostat\'s readings suggest it isn\'t in your Home comfort setting; adding it';
  return {
    magnitude: homeOvershoot,
    rank: 1,
    rec: recBase(a, {
      id: `add-${slug(s.id)}`,
      severity: 'medium',
      action: 'include_in_comfort',
      title: `Consider adding ${s.name} to your Home comfort setting`,
      detail: `${s.name} peaked ${fmt(homeOvershoot)} °C above the set point on average after the thermostat stopped heating`
        + `${tracks}${provenance}. ${lead} may help Ecobee stop heating sooner.`,
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
  const average = comfortReading(env);
  const warmth = env.passiveWarmth;
  if (warmth && env.passiveHeat) {
    const runtime = env.heatingRuntimeMs === null
      ? ''
      : `; heating was reported running ${hours(env.heatingRuntimeMs)} h over ${env.windowDays} days`;
    const waking = rooms.filter((a) => (a.out.wakeOvershoot ?? 0) >= PASSIVE_THRESHOLD);
    const peak = mean(rooms.map((a) => a.out.wakeOvershoot).filter((o): o is number => o !== null));
    const heatingTime = env.wakes.length > 0 && env.wakes.every((w) => w.heatingMs !== null)
      ? mean(env.wakes.map((w) => w.heatingMs!)) : null;
    const wake = peak !== null && peak >= PASSIVE_THRESHOLD
      ? ` That includes waking up: in the 2 hours after Sleep ended, rooms peaked ${fmt(peak)} °C over the Home set point `
        + `on average${heatingTime === null ? '.' : `, with heating running ${minutes(heatingTime)} on average around the change.`}`
      : '';
    recs.push({
      magnitude: warmth.offset,
      rank: 0,
      rec: recBase(null, {
        id: 'passive-warmth-heating',
        severity: 'medium',
        action: 'none',
        title: 'The comfort reading stays warm while heating is idle',
        detail: `With heating idle, ${average} sat ${fmt(warmth.offset)} °C above the set point on average, and at least `
          + `${PASSIVE_THRESHOLD.toFixed(1)} °C above it ${percent(warmth.share)}% of the observed idle samples${runtime}. `
          + 'This does not establish the cause; sensor placement may still affect the comfort reading.'
          + `${wake} The set point, sun, cooking or appliances could also play a part. If rooms feel too warm, `
          + 'consider checking sensor placement, shading, ventilation or cooling on warm days.',
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
        title: 'The comfort reading stays cool while cooling is idle',
        detail: `With cooling idle, ${average} sat ${fmt(coolness.offset)} °C below the cool set point on average, and at least `
          + `${PASSIVE_THRESHOLD.toFixed(1)} °C below it ${percent(coolness.share)}% of the observed idle samples. `
          + 'This does not establish the cause; sensor placement may still affect the comfort reading. The set point, shade '
          + `or cool nights could also play a part; check sensor placement if rooms feel too cool.${coolingNote(env)}`,
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
// suggests under the simple averaging approximation.
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
        detail: `During ${label}, the thermostat's reading may not match the listed sensors under a simple averaging `
          + `approximation: ${parts.join('; ')}. `
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

// Ecobee falls back to its thermostat sensor when the last sensor is removed,
// so this pair of choices doesn't establish what the setting actually uses.
function emptySettingRecs(config: ParticipationConfig | null): Ranked[] {
  if (!config) return [];
  return COMFORT_SETTINGS.flatMap((setting) => {
    if (config[setting]?.length !== 0 || config.thermostat?.[setting] !== false) return [];
    const label = SETTING_LABEL[setting];
    return [{
      magnitude: 1,
      rank: 3,
      rec: recBase(null, {
        id: `participation-empty-${setting}`,
        severity: 'medium' as RecommendationSeverity,
        action: 'none' as RecommendationAction,
        title: `Check which sensors your ${label} setting uses`,
        detail: `No room sensors are listed for ${label}, but the thermostat's built-in sensor is also marked excluded. `
          + `Ecobee uses its thermostat sensor if the last sensor is removed. Check ${label} in the Ecobee app; `
          + 'actual participation is unknown.',
        mode: null,
        period: null,
        comfortSetting: setting,
        affectedSensorIds: [],
        likelyCauses: [],
      }),
    }];
  });
}

// Summary when nothing was flagged; only claims what the data covered, and
// never that there was no bias or overshoot when one was measured but no tip
// applied (e.g. the room isn't in, or didn't count toward, the setting).
function noChanges(
  rooms: Analyzed[],
  events: PlacementEvent[],
  cooling: { checked: boolean; found: boolean; events: number },
): PlacementRecommendation | null {
  const assessed = rooms.filter((a) => a.out.verdict !== 'insufficient');
  if (assessed.length < MIN_SENSORS_FOR_MEAN) return null;
  const missing = rooms.filter((a) => a.out.verdict === 'insufficient').map((a) => a.out.name);
  const overshootKnown = assessed.every((a) => a.out.overshoot !== null);
  const outliers = assessed.filter((a) => a.out.verdict === 'cold_outlier' || a.out.verdict === 'warm_outlier');
  const overshooting = assessed.filter((a) => (a.out.overshoot ?? 0) >= OVERSHOOT_THRESHOLD);
  const unacted = ', but no change is suggested from the comfort-setting, Follow Me and heating information available '
    + '(see each sensor\'s summary).';
  const parts = outliers.length > 0
    ? [`${listOf(outliers.map((a) => `${a.out.name} (${a.out.verdict === 'cold_outlier' ? 'below' : 'above'})`))} `
      + `read consistently off the house average${unacted}`]
    : ['No room sensor read consistently above or below the house average.'];
  // Coverage-neutral when overshoot is unknown: no claim about why.
  const unmeasured = assessed.filter((a) => a.out.overshoot === null).map((a) => a.out.name);
  if (overshooting.length > 0) {
    parts.push(`${listOf(overshooting.map((a) => a.out.name))} peaked ${OVERSHOOT_THRESHOLD.toFixed(1)} °C or more above the `
      + `set point on average after heating stopped${unacted}`);
  } else if (overshootKnown && events.length > 0) {
    parts.push(`None of them peaked ${OVERSHOOT_THRESHOLD.toFixed(1)} °C or more above the set point on average after heating stopped.`);
  } else if (unmeasured.length > 0) {
    parts.push(`Overshoot after heating stopped couldn't be measured for ${unmeasured.join(', ')}.`);
  } else {
    parts.push('Overshoot after heating stopped couldn\'t be measured.');
  }
  if (cooling.checked && !cooling.found) parts.push('No cooling was found in the available history for the past year.');
  else if (cooling.found && cooling.events === 0) parts.push('No cooling runs were found to compare.');
  if (missing.length > 0) parts.push(`Not enough data for ${missing.join(', ')}.`);
  const inferred = events.filter((e) => e.inferred).length;
  const noIssues = overshootKnown && missing.length === 0 && inferred === 0
    ? 'No placement issues found'
    : 'No placement issues found in the available data';
  if (inferred > 0) {
    parts.push(`${inferred} of the ${events.length} heat-ups were inferred from room temperatures, not thermostat history.`);
  }
  return {
    id: 'no-changes',
    severity: 'low',
    sensorId: null,
    action: 'none',
    title: outliers.length + overshooting.length > 0 ? 'No changes suggested' : noIssues,
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
    if (bias === null || Math.abs(bias) < 0.05) return `${name} tracks the house average in the available data.`;
    return `${name} stays close to the house average (${fmt(bias)} °C ${bias < 0 ? 'below' : 'above'} on average), `
      + 'so it does not stand out from the other rooms in the available data.';
  }
  const { setting } = skew;
  const known = knownIn(a, setting, skew.mode);
  const share = shareOf(a, skew.mode);
  const pull = PULL[skew.mode][skew.direction];
  let consequence = known.source === 'configured'
    ? `, but it isn't configured in the ${SETTING_LABEL[setting]} comfort setting`
    : `, but the thermostat's readings suggest it may not be in the ${SETTING_LABEL[setting]} comfort setting`;
  if (known.value !== false && countUnknown(env, share)) {
    consequence = ` — ${countCaveat(env, share)}, so it may or may not be ${pull}`;
  } else if (known.value === true) consequence = ` — it may be ${pull}`;
  else if (known.value === null) consequence = ` — if it's in the comfort setting, it may be ${pull}`;
  if (env.followMe === true && share !== null && known.value !== false) {
    const part = share.coverage < 1 ? `; about ${shareText(share.coverage)} of samples had enough data` : '';
    const verb = known.source === 'configured' ? 'it would have counted' : 'it would have counted if it is in the setting';
    consequence += ` (the Follow Me occupancy-based model estimates ${verb} in approximately ${shareText(share.share)} of comparable `
      + `samples ${countedWhen(skew)}${part}; actual timing and weighting may differ)`;
  }
  let note = '';
  if (skew.mode === 'heating' && env.heatingRare) note = '; heating was reported rarely running, so this may matter more on colder days';
  else if (skew.mode === 'heating' && env.passiveHeat) {
    note = `; ${comfortReading(env)} was often above the set point in observed idle samples`;
  }
  if (skew.mode === 'cooling' && env.coolingRange) note = ` (${env.coolingRange})`;
  return `${skew.brief}${consequence}${note}.`;
}

const COMFORT_AVERAGE_SUMMARY = 'This is the thermostat-reported comfort reading, not a room, so it isn\'t judged as an '
  + 'outlier. Sensor averaging is an approximation; the HomeKit reading\'s exact semantics are unverified.';
const UNSELECTED_THERMOSTAT_SUMMARY = 'This thermostat-associated temperature sensor is not known to be the selected '
  + 'thermostat\'s comfort reading, so it isn\'t judged as a room.';

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
  primaryThermostatId: string | null,
  incompleteSensorInventory: boolean,
  thermostatOccupancy: OccupancySample[] | null | undefined,
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
  const primary = sensors.filter((s) => s.isThermostat && s.id === primaryThermostatId);
  const physicalOccupancy = thermostatOccupancy === undefined && primary.length === 1 ? primary[0].occupancy : thermostatOccupancy;
  return {
    raw,
    samples: mergeComfort(raw, timeline, known),
    timeline,
    model: {
      rooms,
      roomSet: new Set(rooms),
      thermostatId: primary.length === 1 ? primary[0].id : null,
      thermostatOccupancy: physicalOccupancy ? [...physicalOccupancy].sort((a, b) => a.t - b.t) : null,
      incompleteSensorInventory,
      config,
      occupancy,
      timeline,
      estimated: null,
    },
    grid: alignSensors(sensors),
    points: new Map(sensors.map((s) => [s.id, cleanPoints(s.points)])),
  };
}

function participationOf(id: string, config: ParticipationConfig | null): Participation {
  const of = (setting: ComfortSetting) => {
    if (!config || contradictorySetting(config, setting)) return null;
    const ids = config[setting];
    return ids === null ? null : ids.includes(id);
  };
  return config
    ? { home: of('home'), sleep: of('sleep'), away: of('away') }
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
  const heat = dataset(
    input.sensors, input.hvac, input.comfort, config, input.primaryThermostatId ?? null, input.incompleteSensorInventory ?? false,
    input.thermostatOccupancy,
  );
  const { samples, model } = heat;
  const recorded = heat.raw.filter((s) => !s.gap);
  const latestBeforeWindow = [...heat.raw].reverse().find((s) => s.t < startMs);
  const hvacAvailable = recorded.some((s) => s.t >= startMs && s.t <= endMs)
    || (!!latestBeforeWindow && !latestBeforeWindow.gap);
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
  const wakeParts = wakes.flatMap((w) => w.parts);
  const heatRuns = runsWithin(samples, startMs - OVERSHOOT_WINDOW_MS, endMs, heatingNow, 0);
  const heatScan = scan({
    grid: heat.grid, from: startMs, to: endMs, model, samples, clock, mode: 'heating', windows: wakeWindows, runs: heatRuns,
    activeRuns: heatRuns,
  });
  const estimates = estimateParticipation(heat.grid, model, startMs, endMs);
  model.estimated = estimates;

  // Cooling: the most recent cooling within the past year (the same data when
  // the service fetched one range covering both).
  const cooling = input.cooling ?? null;
  let cool: Dataset | null = null;
  let coolRuns: Run[] = [];
  let activeCoolRuns: Run[] = [];
  let coolGroups: { setting: ComfortSetting; runs: SettingRun[]; contexts: EventContext[] }[] = [];
  let coolContexts: EventContext[] = [];
  let coolScan: ReturnType<typeof scan> | null = null;
  if (cooling) {
    const shared = cooling.sensors === undefined && cooling.hvac === undefined && cooling.comfort === undefined
      && cooling.thermostatOccupancy === undefined;
    // Its own model: membership is estimated from the cooling data.
    const data = shared ? { ...heat, model: { ...heat.model } } : dataset(
      cooling.sensors ?? input.sensors,
      cooling.hvac === undefined ? input.hvac : cooling.hvac,
      cooling.comfort === undefined ? input.comfort : cooling.comfort,
      config,
      input.primaryThermostatId ?? null,
      input.incompleteSensorInventory ?? false,
      cooling.thermostatOccupancy === undefined ? input.thermostatOccupancy : cooling.thermostatOccupancy,
    );
    const from = cooling.start.getTime();
    const to = cooling.end.getTime();
    data.model.estimated = estimateParticipation(data.grid, data.model, from, to);
    coolRuns = runsWithin(data.samples, from, to, coolingNow, COOL_RUN_MERGE_MS);
    activeCoolRuns = runsWithin(data.samples, from, to, coolingNow, 0);
    // Each run is split where the comfort setting changes: membership (and so
    // the advice) is per setting.
    const parts = splitBySetting(data.timeline, coolRuns);
    const contextOf = (part: SettingRun) => eventContext(
      data.grid,
      data.model,
      { type: 'cooling', t: part.from, inferred: false },
      'cooling',
      part.setting,
      part,
      null,
    );
    const byPart = new Map(parts.map((part) => [part, contextOf(part)]));
    coolContexts = [...byPart.values()];
    coolGroups = coolingGroups(parts).map((g) => ({ ...g, contexts: g.runs.map((run) => byPart.get(run)!) }));
    coolScan = scan({
      grid: data.grid, from, to, model: data.model, samples: data.samples, clock, mode: 'cooling', windows: coolRuns, runs: coolRuns,
      activeRuns: activeCoolRuns,
    });
    cool = data;
  }

  const runtime = actionsKnownThroughout(samples, startMs, endMs)
    ? heatRuns.reduce((sum, r) => sum + Math.max(0, r.to - Math.max(r.from, startMs)), 0)
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
    occupancy: model.occupancy.size > 0 || !!model.thermostatOccupancy?.length,
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
      estimatedCool: cool?.model.estimated?.get(sensor.id) ?? unknownParticipation(),
      contribution: room
        ? {
          wake: Object.fromEntries(COMFORT_SETTINGS.map((s) => {
            const runs = wakeParts.filter((p) => p.setting === s);
            return [s, runs.length > 0 ? contributionShare(model, heat.grid, runs, sensor.id) : null];
          })),
          home: contributionShare(model, heat.grid, homeWindows, sensor.id),
          // Per comfort setting, below.
          cooling: null,
        }
        : { wake: {}, home: null, cooling: null },
      out: {
        id: sensor.id,
        name: !room && sensor.id === model.thermostatId ? COMFORT_AVERAGE_NAME : sensor.name,
        isThermostat: sensor.isThermostat,
        averageOffset: offsetOf(),
        morningOffset: offsetOf(['wake', 'morning']),
        returnOffset: offsetOf(['return']),
        overshoot: roundOrNull(mean(measured.overshoots)),
        sampleCount: room ? measured.heatSamples : inWindowPoints,
        classification,
        wakeOffset: periodOffsets.wake,
        coolingOffset: periodOffsets.cooling,
        participation: room ? participationOf(sensor.id, config) : unknownParticipation(),
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
  const typicalOf = (list: Analyzed[], scanOf: (a: Analyzed) => RoomScan | undefined) => median(list
    .map((a) => meanOf(scanOf(a)?.bias)).filter((b): b is number => b !== null));
  const typicalHeat = typicalOf(rooms, (a) => a.heatScan);
  // Cooling is judged separately in each comfort setting it ran in, from that
  // setting's run parts only: a view of each room with its cooling evidence,
  // contribution and skew there.
  const coolViews = new Map<Analyzed, { view: Analyzed; skew: Skew; undershoot: Map<string, number | null> }[]>(
    rooms.map((a) => [a, []]),
  );
  coolGroups.forEach((group) => {
    const groupScan = scan({
      grid: cool!.grid,
      from: cooling!.start.getTime(),
      to: cooling!.end.getTime(),
      model: cool!.model,
      samples: cool!.samples,
      clock,
      mode: 'cooling',
      windows: group.runs,
      runs: coolRuns,
      activeRuns: activeCoolRuns,
    });
    const views = rooms.map((a) => {
      const m = measure(a.out.id, heat.points.get(a.out.id)!, group.contexts);
      return {
        ...a,
        measured: { ...a.measured, cool: m.cool, coolSamples: m.coolSamples },
        coolClass: classify(m.cool, m.coolSamples),
        coolScan: groupScan.rooms.get(a.out.id),
        contribution: {
          ...a.contribution, cooling: contributionShare(cool!.model, cool!.grid, group.runs, a.out.id, activeCoolRuns),
        },
      };
    });
    const typical = typicalOf(views, (v) => v.coolScan);
    // Dips below the cool set point in this setting's runs, for its advice.
    const undershoot = new Map(rooms.map((a) => {
      const points = cool!.points.get(a.out.id);
      return [a.out.id, points ? roundOrNull(coolingUndershootOf(points, group.runs, cool!.samples)) : null];
    }));
    const scope = coolGroups.length > 1 ? ` in ${SETTING_LABEL[group.setting]}` : '';
    views.forEach((view, i) => {
      const skew = skewOf(view, 'cooling', typical, group.setting, scope);
      if (skew) coolViews.get(rooms[i])!.push({ view, skew, undershoot });
    });
  });
  analyzed.forEach((a) => {
    if (!a.room) {
      a.out.verdictSummary = a.out.id === model.thermostatId ? COMFORT_AVERAGE_SUMMARY : UNSELECTED_THERMOSTAT_SUMMARY;
      return;
    }
    // Home's heating evidence only: heat-ups (and wake-ups) during Home.
    const home = measure(a.out.id, heat.points.get(a.out.id)!, contexts, 'home');
    heatSkews.set(a, skewOf({
      ...a, measured: { ...a.measured, heat: home.heat, heatSamples: home.heatSamples }, heatClass: classify(home.heat, home.heatSamples),
    }, 'heating', typicalHeat));
    const heatSkew = heatSkews.get(a) ?? null;
    const [firstCool] = coolViews.get(a)!;
    const skew = heatSkew ?? firstCool?.skew ?? null;
    if (skew) a.out.verdict = skew.direction === 'below' ? 'cold_outlier' : 'warm_outlier';
    else if (a.out.verdict === null) a.out.verdict = 'representative';
    a.out.verdictSummary = verdictSummaryOf(heatSkew || !firstCool ? a : firstCool.view, skew, env);
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
    const coolRecs = coolViews.get(a)!
      .map(({ view, skew, undershoot }) => skewRec(view, skew, env, rooms, undershoot) ?? addRec(view, skew, env))
      .filter((r): r is Ranked => r !== null);
    // Tips of the same kind in more than one setting are told apart by it.
    const duplicated = coolRecs.filter((r) => coolRecs.some((o) => o !== r && o.rec.id === r.rec.id));
    duplicated.forEach((r) => { r.rec.id = `${r.rec.id}-${r.rec.comfortSetting}`; });
    ranked.push(...coolRecs);
  });
  // Without a heating outlier, a room overshooting after heating stops may
  // not be in Home.
  if (!ranked.some((r) => r.rec.mode === 'heating')) {
    rooms.forEach((a) => {
      const rec = overshootAddRec(a, env);
      if (rec) ranked.push(rec);
    });
  }
  ranked.push(...passiveRecs(env, rooms), ...mismatchRecs(rooms, config), ...emptySettingRecs(config));
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
      thermostatParticipationSupported: true,
      followMe: config?.followMe ?? null,
      occupancyAvailable: model.occupancy.size > 0 || !!model.thermostatOccupancy?.length,
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
