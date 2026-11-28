import {
  BUCKET_MS,
  type ComfortSample,
  type HvacSample,
  type OccupancySample,
  type ParticipationConfig,
  type ReportedTemperatureInput,
  type SensorSeriesInput,
} from './climate-placement';

const MIN_HEATING_SAMPLES = 8;
const MIN_COOLING_SAMPLES = 2;
const MIN_BASELINE_DAYS = 3;
const UNUSUAL_SHIFT_C = 0.5;
const LOCAL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export interface PlacementDayInput {
  date: string;
  timeZone: string;
  start: number;
  end: number;
  historyEnd?: number;
  now: number;
  sensors: SensorSeriesInput[];
  hvac: HvacSample[] | null;
  comfort: ComfortSample[] | null;
  reportedTemperature: ReportedTemperatureInput | null;
  participation: ParticipationConfig | null;
  unknownUnitWindows: number;
  unitAssumptions: { setpoints: boolean; reportedTemperature: boolean };
  incompleteSensorInventory: boolean;
}

export interface PlacementDayTimelinePoint {
  t: string;
  setpoint: number | null;
  hvacAction: string | null;
  hvacMode: string | null;
  comfortSetting: string | null;
  average: number | null;
  rooms: Record<string, number | null>;
  occupied: Record<string, boolean | null>;
}

interface DayBucket extends PlacementDayTimelinePoint {
  start: number;
  end: number;
  sourceComplete: boolean;
}

interface TemporalDateApi {
  PlainDate: {
    from(value: string): {
      toZonedDateTime(timeZone: string): { epochMilliseconds: number };
    };
  };
}

function localParts(timeZone: string, time: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let formatter = LOCAL_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    LOCAL_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour % 24, minute: values.minute, second: values.second,
  };
}

function dateString(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseDate(value: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function calendarDate(value: string, offset: number): string {
  const parsed = parseDate(value)!;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + offset));
  return dateString({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() });
}

// Temporal's start-of-day semantics handle skipped and repeated midnights and
// local-date rollbacks without assuming local dates are monotonic in UTC.
function localDayStart(date: string, timeZone: string): number {
  if (!parseDate(date)) throw new Error('Invalid local calendar date');
  const temporal = (globalThis as typeof globalThis & { Temporal?: TemporalDateApi }).Temporal;
  if (!temporal) throw new Error('Temporal is unavailable for house-local day boundaries');
  return temporal.PlainDate.from(date).toZonedDateTime(timeZone).epochMilliseconds;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function resolvePlacementDay(
  inputDate: unknown,
  timeZone: string,
  now: Date,
): { date: string; start: Date; end: Date; today: string } {
  if (!isValidTimeZone(timeZone)) throw new Error('Home Assistant house time zone is unavailable or invalid');
  const today = dateString(localParts(timeZone, now.getTime()));
  const requested = inputDate === undefined ? calendarDate(today, -1) : inputDate;
  if (typeof requested !== 'string' || !parseDate(requested)) {
    throw new Error('date must be a valid YYYY-MM-DD house-calendar date');
  }
  if (requested > today || requested < calendarDate(today, -364)) {
    throw new Error('date must be today or within the previous 364 house-calendar dates');
  }
  return {
    date: requested,
    start: new Date(localDayStart(requested, timeZone)),
    end: new Date(localDayStart(calendarDate(requested, 1), timeZone)),
    today,
  };
}

export function placementDateBounds(date: string, timeZone: string): { start: Date; end: Date } {
  if (!parseDate(date) || !isValidTimeZone(timeZone)) throw new Error('Invalid house date or time zone');
  return {
    start: new Date(localDayStart(date, timeZone)),
    end: new Date(localDayStart(calendarDate(date, 1), timeZone)),
  };
}

function lastAt<T extends { t: number }>(samples: T[] | null | undefined, time: number): T | null {
  if (!samples) return null;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (samples[mid].t <= time) low = mid + 1;
    else high = mid;
  }
  return low > 0 ? samples[low - 1] : null;
}

function inWindow<T extends { t: number }>(samples: T[] | null | undefined, start: number, end: number): T[] {
  return (samples ?? []).filter((sample) => sample.t >= start && sample.t < end);
}

function climateAt(samples: HvacSample[] | null, start: number, end: number): HvacSample | null {
  const state = lastAt(samples, start);
  if (!state || state.gap) return null;
  const changes = inWindow(samples, start, end);
  if (changes.some((change) => change.t === start && (
    (change.subMillisecondFields && Object.keys(change.subMillisecondFields).length > 0)
    || (change.orderedUpdates && change.orderedUpdates.some((update) => update.subMillisecond !== ''))
  ))) return null;
  if (changes.some((change) => change.t > start && (
    change.gap || change.hvacMode !== state.hvacMode || change.hvacAction !== state.hvacAction
      || change.setpoint !== state.setpoint || (change.coolSetpoint ?? null) !== (state.coolSetpoint ?? null)
      || change.presetMode !== state.presetMode
  ))) return null;
  return state;
}

function comfortAt(samples: ComfortSample[] | null, start: number, end: number): string | null {
  const state = lastAt(samples, start);
  if (!state || state.ambiguous || state.setting === null) return null;
  const changes = inWindow(samples, start, end);
  if (changes.some((change) => change.t > start && (change.ambiguous || change.setting !== state.setting))) return null;
  if (changes.some((change) => change.t === start && change.subMillisecond)) return null;
  const normalized = state.setting.toLowerCase();
  return ['home', 'sleep', 'away'].includes(normalized) ? normalized : null;
}

function occupancyAt(samples: OccupancySample[] | null | undefined, start: number, end: number): boolean | null {
  const state = lastAt(samples, start);
  if (!state || state.occupied === null || (state.t === start && state.afterMillisecond)) return null;
  const changes = inWindow(samples, start, end);
  if (changes.some((change) => change.t > start && change.occupied !== state.occupied)) return null;
  if (changes.some((change) => change.t === start && change.afterMillisecond)) return null;
  return state.occupied;
}

function pointAt(points: { t: number; v: number }[], time: number): number | null {
  const point = points.find((candidate) => candidate.t === time);
  return point?.v ?? null;
}

function reportedAt(input: ReportedTemperatureInput | null, time: number): number | null {
  if (!input || input.invalidWindows?.includes(time)
    || input.invalidations?.some((t) => t >= time && t < time + BUCKET_MS)) {
    return null;
  }
  return pointAt(input.points, time);
}

function availableAverage(
  rooms: Record<string, number | null>,
  occupied: Record<string, boolean | null>,
  setting: string | null,
  config: ParticipationConfig | null,
  thermostatValues: Record<string, number | null>,
): number | null {
  if (!setting || config?.followMe === null || config?.followMe === undefined) return null;
  const selected = config?.[setting as 'home' | 'sleep' | 'away'];
  if (selected === null || selected === undefined) return null;
  let ids = selected;
  const thermostatParticipation = config.thermostat?.[setting as 'home' | 'sleep' | 'away'];
  if (thermostatParticipation === null || thermostatParticipation === undefined) return null;
  if (thermostatParticipation) {
    const thermostatIds = Object.keys(thermostatValues);
    if (thermostatIds.length === 0) return null;
    ids = [...ids, ...thermostatIds];
  }
  if (config.followMe) {
    if (ids.some((id) => occupied[id] === null || occupied[id] === undefined)) return null;
    ids = ids.filter((id) => occupied[id] === true);
  }
  const values = ids.map((id) => (rooms[id] !== undefined ? rooms[id] : thermostatValues[id]))
    .filter((value): value is number => value !== null && value !== undefined);
  if (values.length !== ids.length || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function comfortSetting(
  comfort: ComfortSample[] | null,
  climate: HvacSample | null,
  start: number,
  end: number,
): string | null {
  const selected = comfortAt(comfort, start, end);
  if (selected !== null) return selected;
  // An explicit unknown/ambiguous select observation must not be replaced by
  // the climate preset. Preset fallback is only for missing select history.
  if (comfort && comfort.length > 0) return null;
  const preset = climate?.presetMode?.toLowerCase();
  return preset && ['home', 'sleep', 'away'].includes(preset) ? preset : null;
}

function makeBucket(input: PlacementDayInput, start: number): DayBucket {
  const end = start + BUCKET_MS;
  const roomSensors = input.sensors.filter((sensor) => !sensor.isThermostat);
  const sourceComplete = end <= (input.historyEnd ?? input.end) && end <= input.now;
  const sensorValues = Object.fromEntries(input.sensors.map((sensor) => [
    sensor.id,
    sourceComplete ? pointAt(sensor.points, start) : null,
  ]));
  const rooms = Object.fromEntries(roomSensors.map((sensor) => [sensor.id, sensorValues[sensor.id]]));
  const climate = sourceComplete ? climateAt(input.hvac, start, end) : null;
  const setting = sourceComplete ? comfortSetting(input.comfort, climate, start, end) : null;
  const reported = sourceComplete ? reportedAt(input.reportedTemperature, start) : null;
  const occupied = Object.fromEntries(input.sensors.map((sensor) => [
    sensor.id,
    sourceComplete ? occupancyAt(sensor.occupancy, start, end) : null,
  ]));
  const thermostatValues = Object.fromEntries(input.sensors.filter((sensor) => sensor.isThermostat)
    .map((sensor) => [sensor.id, sensorValues[sensor.id]]));
  const average = reported ?? availableAverage(
    rooms, occupied, setting, input.participation, thermostatValues,
  );
  return {
    t: new Date(start).toISOString(),
    start,
    end,
    sourceComplete,
    setpoint: climate?.hvacAction?.toLowerCase() === 'cooling' ? climate.coolSetpoint ?? null : climate?.setpoint ?? null,
    hvacAction: climate?.hvacAction ?? null,
    hvacMode: climate?.hvacMode ?? null,
    comfortSetting: setting,
    average,
    rooms,
    occupied,
  };
}

function makeBuckets(input: PlacementDayInput): DayBucket[] {
  const buckets: DayBucket[] = [];
  for (let start = input.start; start < input.end; start += BUCKET_MS) {
    buckets.push(makeBucket(input, start));
  }
  return buckets;
}

interface DayOffset {
  offset: number;
  count: number;
}

function cohortOffsets(
  sensors: SensorSeriesInput[],
  buckets: DayBucket[],
  mode: 'heating' | 'cooling',
): Map<string, DayOffset> {
  const rooms = sensors.filter((sensor) => !sensor.isThermostat);
  const sums = new Map(rooms.map((sensor) => [sensor.id, { sum: 0, count: 0 }]));
  buckets.forEach((bucket) => {
    if (!bucket.sourceComplete || !bucket.setpoint
      || bucket.hvacAction?.toLowerCase() !== mode) return;
    const values = rooms.map((sensor) => bucket.rooms[sensor.id]);
    // Keep a fixed room cohort for every compared source window; a missing room
    // is not silently removed from the contemporaneous reference average.
    if (values.length < 2 || values.some((value) => value === null)) return;
    const mean = values.reduce<number>((sum, value) => sum + value!, 0) / values.length;
    rooms.forEach((sensor) => {
      const state = sums.get(sensor.id)!;
      state.sum += bucket.rooms[sensor.id]! - mean;
      state.count += 1;
    });
  });
  return new Map([...sums].map(([id, value]) => [
    id,
    { offset: value.count ? value.sum / value.count : NaN, count: value.count },
  ]));
}

function makeWake(input: PlacementDayInput, buckets: DayBucket[]): Record<string, unknown> | null {
  const hasComfortSettingHistory = input.comfort?.some((sample) => (
    sample.setting !== null && !sample.ambiguous
  )) ?? false;
  const settingHistory: ComfortSample[] = hasComfortSettingHistory
    ? input.comfort ?? []
    : (input.hvac ?? []).map((sample) => ({
      t: sample.t,
      setting: sample.presetMode,
      ...(sample.subMillisecondFields?.preset_mode
        ? { subMillisecond: sample.subMillisecondFields.preset_mode } : {}),
    }));
  const transitions = settingHistory.filter((sample, index, history) => {
    if (sample.setting?.toLowerCase() !== 'home' || sample.ambiguous || sample.subMillisecond) return false;
    const before = history[index - 1];
    return !!before && !before.ambiguous && before.setting?.toLowerCase() === 'sleep';
  });
  const selected = transitions.find((sample) => sample.t >= input.start && sample.t < input.end);
  if (!selected) return null;
  const contextStart = selected.t - 2 * 60 * 60 * 1000;
  const contextEnd = selected.t + 2 * 60 * 60 * 1000;
  const before = lastAt(input.hvac, selected.t - 1);
  const after = lastAt(input.hvac, selected.t);
  const afterAmbiguous = after?.t === selected.t && (
    !!after.subMillisecondFields && Object.keys(after.subMillisecondFields).length > 0
    || !!after.orderedUpdates?.some((update) => update.subMillisecond !== '')
  );
  const context = buckets.filter((bucket) => bucket.start >= contextStart && bucket.end <= contextEnd);
  const knownStarts = new Set(context.map((bucket) => bucket.start));
  const firstContextBucket = Math.ceil(contextStart / BUCKET_MS) * BUCKET_MS;
  const lastContextBucket = Math.floor((contextEnd - BUCKET_MS) / BUCKET_MS) * BUCKET_MS;
  for (let start = firstContextBucket; start <= lastContextBucket; start += BUCKET_MS) {
    if (!knownStarts.has(start)) context.push(makeBucket(input, start));
  }
  context.sort((a, b) => a.start - b.start);
  const completeContext = context.length === 16
    && context.every((bucket) => bucket.sourceComplete && bucket.hvacMode !== null && bucket.hvacAction !== null);
  const rooms = input.sensors.filter((sensor) => !sensor.isThermostat).map((sensor) => {
    const switchBucket = buckets.find((bucket) => bucket.start <= selected.t && selected.t < bucket.end);
    const afterBuckets = context.filter((bucket) => bucket.start >= selected.t);
    const completeRoomContext = afterBuckets.length === 8 && afterBuckets.every((bucket) => (
      bucket.sourceComplete && bucket.rooms[sensor.id] !== null
    ));
    const readings = completeRoomContext
      ? afterBuckets.map((bucket) => ({ t: bucket.start, value: bucket.rooms[sensor.id] }))
        .filter((point): point is { t: number; value: number } => point.value !== null)
      : [];
    const peak = readings.length ? Math.max(...readings.map((point) => point.value)) : null;
    const peakAt = peak === null ? null : readings.find((point) => point.value === peak)?.t ?? null;
    const overSetpoint = peak === null ? null : (() => {
      const peakBucket = afterBuckets.find((bucket) => bucket.start === peakAt);
      return peakBucket?.setpoint === null || peakBucket?.setpoint === undefined ? null : peak - peakBucket.setpoint;
    })();
    return {
      sensorId: sensor.id,
      atSwitch: switchBucket?.sourceComplete && switchBucket.start === selected.t
        ? switchBucket.rooms[sensor.id] ?? null : null,
      peak,
      peakAt: peakAt === null ? null : new Date(peakAt).toISOString(),
      overSetpoint,
    };
  });
  const minutes = (action: string) => completeContext
    ? context.filter((bucket) => bucket.hvacAction?.toLowerCase() === action).length * 15 : null;
  return {
    at: new Date(selected.t).toISOString(),
    setpointBefore: before && !before.gap ? before.setpoint : null,
    setpointAfter: after && !after.gap && !afterAmbiguous ? after.setpoint : null,
    heatingMinutes: minutes('heating'),
    coolingMinutes: minutes('cooling'),
    rooms,
    context: { from: new Date(contextStart).toISOString(), to: new Date(contextEnd).toISOString() },
  };
}

export function analyzePlacementDay(input: PlacementDayInput) {
  const buckets = makeBuckets(input);
  const roomSensors = input.sensors.filter((sensor) => !sensor.isThermostat);
  const baselineByMode = new Map<string, Map<string, DayOffset[]>>();
  (['heating', 'cooling'] as const).forEach((mode) => {
    // Buckets include only the selected date. Baseline offsets are therefore
    // sampled directly from the raw sensor and HVAC series below.
    const daily = new Map<string, DayOffset[]>();
    for (let day = 0; day < 14; day += 1) {
      const date = calendarDate(input.date, day - 14);
      const from = localDayStart(date, input.timeZone);
      const to = localDayStart(calendarDate(date, 1), input.timeZone);
      const baselineBuckets: DayBucket[] = [];
      for (let start = from; start < to; start += BUCKET_MS) {
        if (start + BUCKET_MS > to) continue;
        const climate = climateAt(input.hvac, start, start + BUCKET_MS);
        const setting = comfortSetting(input.comfort, climate, start, start + BUCKET_MS);
        const rooms = Object.fromEntries(roomSensors.map((sensor) => [sensor.id, pointAt(sensor.points, start)]));
        baselineBuckets.push({
          t: new Date(start).toISOString(), start, end: start + BUCKET_MS, sourceComplete: true,
          setpoint: climate?.hvacAction?.toLowerCase() === 'cooling' ? climate.coolSetpoint ?? null : climate?.setpoint ?? null,
          hvacAction: climate?.hvacAction ?? null,
          hvacMode: climate?.hvacMode ?? null, comfortSetting: setting,
          average: null, rooms, occupied: {},
        });
      }
      const offsets = cohortOffsets(input.sensors, baselineBuckets, mode);
      offsets.forEach((value, id) => {
        if (!daily.has(id)) daily.set(id, []);
        if (value.count >= (mode === 'heating' ? MIN_HEATING_SAMPLES : MIN_COOLING_SAMPLES) && Number.isFinite(value.offset)) {
          daily.get(id)!.push(value);
        }
      });
    }
    baselineByMode.set(mode, daily);
  });

  const roomMetrics = roomSensors.map((sensor) => {
    const heatDay = cohortOffsets(input.sensors, buckets, 'heating').get(sensor.id)!;
    const coolDay = cohortOffsets(input.sensors, buckets, 'cooling').get(sensor.id)!;
    const options = [
      { mode: 'heating', day: heatDay, minimum: MIN_HEATING_SAMPLES },
      { mode: 'cooling', day: coolDay, minimum: MIN_COOLING_SAMPLES },
    ].map((option) => ({
      ...option,
      baseline: baselineByMode.get(option.mode)?.get(sensor.id) ?? [],
    }));
    const qualifyingDay = options.find((option) => option.day.count >= option.minimum);
    const assessed = options.find((option) => (
      option.day.count >= option.minimum && option.baseline.length >= MIN_BASELINE_DAYS
    ));
    const chosen = assessed ?? qualifyingDay;
    const baselineOffset = assessed
      ? assessed.baseline.reduce((sum, entry) => sum + entry.offset, 0) / assessed.baseline.length : null;
    const dayOffset = chosen ? chosen.day.offset : null;
    const deviation = dayOffset === null || baselineOffset === null ? null : dayOffset - baselineOffset;
    return {
      id: sensor.id,
      name: sensor.name,
      isThermostat: false,
      dayOffset: input.incompleteSensorInventory || dayOffset === null ? null : Math.round(dayOffset * 10) / 10,
      baselineOffset: input.incompleteSensorInventory || baselineOffset === null ? null : Math.round(baselineOffset * 10) / 10,
      deviation: input.incompleteSensorInventory || deviation === null ? null : Math.round(deviation * 10) / 10,
      unusual: input.incompleteSensorInventory || deviation === null ? null : Math.abs(deviation) >= UNUSUAL_SHIFT_C,
    };
  });
  const roomMetricsById = new Map(roomMetrics.map((sensor) => [sensor.id, sensor]));
  const sensors = input.sensors.map((sensor) => roomMetricsById.get(sensor.id) ?? ({
    id: sensor.id,
    name: sensor.name,
    isThermostat: true,
    dayOffset: null,
    baselineOffset: null,
    deviation: null,
    unusual: null,
  }));
  const findings = sensors.filter((sensor) => sensor.unusual === true).map((sensor) => ({
    id: `day-shift-${sensor.id}`,
    severity: 'medium',
    title: `${sensor.name} differed from its recent room-relative pattern`,
    detail: `${sensor.name} averaged ${Math.abs(sensor.deviation!).toFixed(1)} °C `
      + `${sensor.deviation! < 0 ? 'below' : 'above'} its prior-14-day room-cohort-relative offset `
      + 'during adequately sampled HVAC operation. This describes recorded sensor readings, not a cause or thermostat physical temperature.',
    sensorIds: [sensor.id],
  }));
  const expected = Math.floor((input.end - input.start) / BUCKET_MS);
  const completeBuckets = buckets.filter((bucket) => bucket.sourceComplete).length;
  const validRoomReadings = buckets.reduce((sum, bucket) => (
    sum + Object.values(bucket.rooms).filter((value) => value !== null).length
  ), 0);
  const occupancyKnown = buckets.reduce((sum, bucket) => (
    sum + Object.values(bucket.occupied).filter((value) => value !== null).length
  ), 0);
  return {
    date: input.date,
    timeZone: input.timeZone,
    unit: '°C' as const,
    timeline: buckets.map(({ start: _start, end: _end, sourceComplete: _complete, ...point }) => point),
    wake: makeWake(input, buckets),
    sensors,
    findings,
    coverage: {
      start: new Date(input.start).toISOString(),
      end: new Date(input.end).toISOString(),
      expectedBuckets: expected,
      completeBuckets,
      missingRoomReadings: Math.max(0, expected * roomSensors.length - validRoomReadings),
      unknownUnitWindows: input.unknownUnitWindows,
      missingHvacBuckets: buckets.filter((bucket) => (
        bucket.sourceComplete && (bucket.hvacMode === null || bucket.hvacAction === null)
      )).length,
      missingAverageBuckets: buckets.filter((bucket) => bucket.sourceComplete && bucket.average === null).length,
      reportedAverageBuckets: buckets.filter((bucket) => bucket.sourceComplete && bucket.average !== null
        && reportedAt(input.reportedTemperature, bucket.start) !== null).length,
      approximatedAverageBuckets: buckets.filter((bucket) => bucket.sourceComplete && bucket.average !== null
        && reportedAt(input.reportedTemperature, bucket.start) === null).length,
      unknownUnitWindowsScope: 'selected date, baseline and wake-context query',
      hvacHistoryAvailable: input.hvac !== null && input.hvac.length > 0,
      occupancyKnownReadings: occupancyKnown,
      occupancyExpectedReadings: expected * input.sensors.length,
      baselineDays: 14,
      incompleteSensorInventory: input.incompleteSensorInventory,
      unitAssumptions: input.unitAssumptions,
      averageIsApproximationWhenReportedUnavailable: true,
    },
  };
}

export type PlacementDayInsights = ReturnType<typeof analyzePlacementDay>;
