// Pure analysis behind GET /climate/placement-insights: finds morning warm-ups
// and returns from Away in recent history, measures how each room sensor reads
// against the house average while the house heats up, and recommends sensor
// placement / comfort-setting changes. No I/O here — see
// climate-placement-service.ts for data fetching and caching.

// Local hours (server time zone) in which a heat-up counts as a morning warm-up.
export const MORNING_START_HOUR = 4;
export const MORNING_END_HOUR = 10;
// How long after an event offsets and overshoot are measured.
export const EVENT_WINDOW_MS = 2 * 60 * 60 * 1000;
// Readings are aligned to this bucket before comparing sensors.
export const BUCKET_MS = 15 * 60 * 1000;
// A sensor reading at least this far from the house mean counts as biased.
export const OFFSET_THRESHOLD = 1.0;
// A strongly biased sensor is always a high-severity finding.
export const STRONG_OFFSET = 2.0;
// Share of events in which a sensor must be biased to be classified cold/warm.
export const CONSISTENCY_SHARE = 0.6;
// Fewer events (or samples) than this → insufficient.
export const MIN_EVENTS = 3;
export const MIN_SAMPLES = 12;
// Samples needed in one event window for it to count for a sensor.
export const MIN_EVENT_SAMPLES = 2;
// Sensors that must report at a timestamp for a house mean.
export const MIN_SENSORS_FOR_MEAN = 2;
// A room rising this far above the set point counts as overshooting.
export const OVERSHOOT_THRESHOLD = 1.0;
// A set point increase of at least this much is a heat-up trigger.
export const SETPOINT_STEP = 0.5;
// A set point jump of at least this much after a setback held this long (outside
// the morning window) is treated as a return from Away.
export const RETURN_SETPOINT_JUMP = 1.5;
export const LONG_SETBACK_MS = 3 * 60 * 60 * 1000;
// Rise of the house mean within an hour that marks an inferred morning warm-up
// when thermostat history is unavailable.
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
  setpoint: number | null;
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
    morningEvents: number;
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

// Morning warm-ups and returns from Away found in thermostat history.
export function detectHvacEvents(samples: HvacSample[], timeZone: string): PlacementEvent[] {
  const clock = localClock(timeZone);
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const returns: PlacementEvent[] = [];
  // Per local day: earliest set point / preset trigger, else earliest heating start.
  const morningTriggers = new Map<string, PlacementEvent>();
  const morningHeating = new Map<string, PlacementEvent>();
  let setpointSince = sorted[0]?.t ?? 0;

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const { day, hour } = clock(cur.t);
    const inMorning = hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
    const setpointRise = prev.setpoint !== null && cur.setpoint !== null
      ? cur.setpoint - prev.setpoint : 0;
    const heldFor = cur.t - setpointSince;
    if (prev.setpoint !== cur.setpoint) setpointSince = cur.t;

    const lastReturn = returns[returns.length - 1];
    const recentReturn = !!lastReturn && cur.t - lastReturn.t < EVENT_WINDOW_MS;
    const event = { t: cur.t, setpoint: cur.setpoint ?? prev.setpoint };

    if (isAway(prev.presetMode) && cur.presetMode !== null && !isAway(cur.presetMode)) {
      if (!recentReturn) returns.push({ type: 'return', ...event });
    } else if (inMorning) {
      const presetToHome = isHomePreset(cur.presetMode) && !isHomePreset(prev.presetMode);
      if ((setpointRise >= SETPOINT_STEP || presetToHome) && !morningTriggers.has(day)) {
        morningTriggers.set(day, { type: 'morning', ...event });
      }
      if (cur.hvacAction === 'heating' && prev.hvacAction !== 'heating' && !morningHeating.has(day)) {
        morningHeating.set(day, { type: 'morning', ...event });
      }
    } else if (setpointRise >= RETURN_SETPOINT_JUMP && heldFor >= LONG_SETBACK_MS && !recentReturn) {
      returns.push({ type: 'return', ...event });
    }
  }

  const mornings = new Map(morningHeating);
  morningTriggers.forEach((event, day) => mornings.set(day, event));
  const returnTimes = returns.map((r) => r.t);
  const morningEvents = [...mornings.values()].filter(
    (m) => !returnTimes.some((t) => Math.abs(t - m.t) < EVENT_WINDOW_MS),
  );
  return [...morningEvents, ...returns].sort((a, b) => a.t - b.t);
}

function bucket(t: number): number {
  return Math.round(t / BUCKET_MS) * BUCKET_MS;
}

interface AlignedData {
  times: number[];
  values: Map<number, Map<string, number>>;
  houseMean: Map<number, number>;
}

function align(sensors: SensorSeriesInput[]): AlignedData {
  const values = new Map<number, Map<string, number>>();
  sensors.forEach((sensor) => {
    sensor.points.forEach(({ t, v }) => {
      if (!Number.isFinite(t) || !Number.isFinite(v)) return;
      const key = bucket(t);
      if (!values.has(key)) values.set(key, new Map());
      values.get(key)!.set(sensor.id, v);
    });
  });
  const houseMean = new Map<number, number>();
  values.forEach((readings, t) => {
    if (readings.size >= MIN_SENSORS_FOR_MEAN) houseMean.set(t, mean([...readings.values()])!);
  });
  const times = [...houseMean.keys()].sort((a, b) => a - b);
  return { times, values, houseMean };
}

// Morning warm-ups inferred from the house mean rising in the morning window,
// one per local day, for periods without thermostat history.
export function inferMorningEvents(
  sensors: SensorSeriesInput[],
  timeZone: string,
  before = Number.POSITIVE_INFINITY,
): PlacementEvent[] {
  const clock = localClock(timeZone);
  const { times, houseMean } = align(sensors);
  const events: PlacementEvent[] = [];
  const seenDays = new Set<string>();
  times.forEach((t) => {
    if (t >= before) return;
    const { day, hour } = clock(t);
    if (seenDays.has(day) || hour < MORNING_START_HOUR || hour >= MORNING_END_HOUR) return;
    const later = houseMean.get(t + INFERRED_RISE_WINDOW_MS);
    if (later === undefined) return;
    if (later - houseMean.get(t)! >= INFERRED_RISE) {
      seenDays.add(day);
      events.push({ type: 'morning', t, setpoint: null });
    }
  });
  return events;
}

interface SensorStats {
  sensor: SensorSeriesInput;
  eventOffsets: { type: PlacementEventType; offset: number }[];
  overshoots: number[];
  peaks: number[];
  sampleCount: number;
}

function measure(sensor: SensorSeriesInput, events: PlacementEvent[], data: AlignedData): SensorStats {
  const stats: SensorStats = {
    sensor, eventOffsets: [], overshoots: [], peaks: [], sampleCount: 0,
  };
  events.forEach((event) => {
    const offsets: number[] = [];
    let peak = Number.NEGATIVE_INFINITY;
    data.times.forEach((t) => {
      if (t < event.t || t > event.t + EVENT_WINDOW_MS) return;
      const value = data.values.get(t)?.get(sensor.id);
      if (value === undefined) return;
      offsets.push(value - data.houseMean.get(t)!);
      peak = Math.max(peak, value);
    });
    if (offsets.length < MIN_EVENT_SAMPLES) return;
    stats.sampleCount += offsets.length;
    stats.eventOffsets.push({ type: event.type, offset: mean(offsets)! });
    stats.peaks.push(peak);
    if (event.setpoint !== null) stats.overshoots.push(Math.max(0, peak - event.setpoint));
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
  meanPeak: number | null;
}

function offsetPhrase(sensor: PlacementSensor): { offset: number; when: string } {
  if (sensor.morningOffset !== null) return { offset: sensor.morningOffset, when: 'during morning heat-ups' };
  if (sensor.returnOffset !== null) return { offset: sensor.returnOffset, when: 'after returning from Away' };
  return { offset: sensor.averageOffset ?? 0, when: 'during heat-ups' };
}

function recommend(analyzed: Analyzed[]): { rec: PlacementRecommendation; magnitude: number }[] {
  const recs: { rec: PlacementRecommendation; magnitude: number }[] = [];
  const overshooting = analyzed
    .filter((a) => a.out.overshoot !== null && a.out.overshoot >= OVERSHOOT_THRESHOLD)
    .sort((a, b) => b.out.overshoot! - a.out.overshoot!);

  analyzed.forEach((a) => {
    const s = a.out;
    if (s.classification === 'cold') {
      const { offset, when } = offsetPhrase(s);
      const victim = overshooting.find((o) => o.out.id !== s.id && o.out.classification !== 'cold');
      const reads = `${s.name} reads ${fmt(offset)} °C below the house average ${when}`;
      const cause = victim && victim.meanPeak !== null
        ? `${reads}, so the thermostat keeps heating while the ${victim.out.name} climbs to ${round1(victim.meanPeak).toFixed(1)} °C.`
        : `${reads}, so the thermostat may keep heating after other rooms are warm.`;
      const severity: RecommendationSeverity = victim || offset <= -STRONG_OFFSET ? 'high' : 'medium';
      if (s.isThermostat) {
        recs.push({
          magnitude: Math.abs(offset),
          rec: {
            id: `exclude-${slug(s.id)}`,
            severity,
            sensorId: s.id,
            action: 'exclude_from_comfort',
            title: `Exclude the ${s.name} thermostat sensor`,
            detail: `${cause} Remove the thermostat's own sensor from the Home and Sleep comfort settings, or check it isn't on an exterior wall or near a draft.`,
          },
        });
      } else {
        recs.push({
          magnitude: Math.abs(offset),
          rec: {
            id: `move-${slug(s.id)}`,
            severity,
            sensorId: s.id,
            action: 'move',
            title: `Move the ${s.name} sensor`,
            detail: `${cause} Move it away from exterior walls, windows, drafts and cold floors, or exclude it from comfort settings until it is moved.`,
          },
        });
      }
    } else if ((s.classification === 'representative' || s.classification === 'warm')
      && s.overshoot !== null && s.overshoot >= OVERSHOOT_THRESHOLD) {
      const tracks = s.classification === 'representative'
        ? `${s.name} tracks the house average within ${fmt(s.averageOffset ?? 0)} °C but`
        : `${s.name}`;
      recs.push({
        magnitude: s.overshoot,
        rec: {
          id: `include-${slug(s.id)}`,
          severity: 'medium',
          sensorId: s.id,
          action: 'include_in_comfort',
          title: `Include the ${s.name} sensor`,
          detail: `${tracks} rises ${fmt(s.overshoot)} °C above the set point after heat-ups. Including it in the Home and Sleep comfort settings lets the thermostat stop heating sooner.`,
        },
      });
    } else if (s.classification === 'warm') {
      const { offset, when } = offsetPhrase(s);
      recs.push({
        magnitude: Math.abs(offset),
        rec: {
          id: `move-${slug(s.id)}`,
          severity: 'low',
          sensorId: s.id,
          action: 'move',
          title: `Check the ${s.name} sensor`,
          detail: `${s.name} reads ${fmt(offset)} °C above the house average ${when}. Make sure it isn't in direct sun or near a vent, lamp or electronics.`,
        },
      });
    }
  });
  return recs;
}

export function analyzePlacement(input: PlacementInput): PlacementInsights {
  const sensors = input.sensors;
  const hvacAvailable = input.hvac !== null && input.hvac.length > 0;
  let events: PlacementEvent[] = [];
  if (hvacAvailable) {
    events = detectHvacEvents(input.hvac!, input.timeZone);
    // Recorder retention can be shorter than the window; infer mornings before it.
    const historyStart = input.hvac!.reduce((min, s) => Math.min(min, s.t), Number.POSITIVE_INFINITY);
    events = [...inferMorningEvents(sensors, input.timeZone, historyStart), ...events];
  } else {
    events = inferMorningEvents(sensors, input.timeZone);
  }
  const startMs = input.start.getTime();
  const endMs = input.end.getTime();
  events = events.filter((e) => e.t >= startMs && e.t <= endMs).sort((a, b) => a.t - b.t);

  const data = align(sensors);
  const analyzed: Analyzed[] = sensors.map((sensor) => {
    const stats = measure(sensor, events, data);
    const offsetsOf = (type?: PlacementEventType) => stats.eventOffsets
      .filter((e) => !type || e.type === type)
      .map((e) => e.offset);
    return {
      stats,
      meanPeak: mean(stats.peaks),
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
  const assessed = analyzed.filter((a) => a.out.classification !== 'insufficient');
  if (recommendations.length === 0 && assessed.length >= MIN_SENSORS_FOR_MEAN) {
    recommendations.push({
      id: 'no-changes',
      severity: 'low',
      sensorId: null,
      action: 'none',
      title: 'Sensor placement looks good',
      detail: 'Every sensor with enough data reads close to the house average during heat-ups, and no room overshoots the set point.',
    });
  }

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    windowDays: input.windowDays,
    unit: '°C',
    coverage: {
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      hvacHistoryAvailable: hvacAvailable,
      morningEvents: events.filter((e) => e.type === 'morning').length,
      returnEvents: events.filter((e) => e.type === 'return').length,
    },
    sensors: analyzed.map((a) => a.out),
    recommendations,
  };
}
