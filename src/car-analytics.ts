import type { InfluxDBClient } from './clients/influxdb';
import logger from './logger';

const analyticsLogger = logger.child({ subsystem: 'car-analytics' });

export type CarAnalyticsRange = '7d' | '30d' | '90d' | '1y' | 'all' | 'custom';
export type CarAnalyticsTopic = 'overview' | 'charging' | 'efficiency' | 'weather' | 'comparison';
export type EfficiencyMethod = 'measured_kwh' | 'battery_proxy' | 'unavailable';

export interface CarAnalyticsRequest {
  range?: unknown;
  start?: unknown;
  end?: unknown;
  timezone?: unknown;
  comparison?: unknown;
  topic?: unknown;
}

interface ResolvedRequest {
  range: CarAnalyticsRange;
  start: Date;
  end: Date;
  requestedStart: Date | null;
  timezone: string;
  includeComparison: boolean;
  topic: CarAnalyticsTopic;
}

export interface CarTelemetryPoint {
  time: Date;
  odometer?: number;
  batteryLevel?: number;
  batteryUsedPercent?: number;
  evRange?: number;
  energyTotalKWh?: number;
}

export interface ChargingPoint {
  time: Date;
  charging: boolean;
}

export interface WeatherPoint {
  time: Date;
  temperatureC: number;
}

export interface ChargingSession {
  start: string;
  end: string;
  durationHours: number;
  batteryAddedPercent: number | null;
}

export interface EfficiencyResult {
  method: EfficiencyMethod;
  value: number | null;
  unit: 'kWh/100 km' | '%/100 km' | null;
  label: string;
}

export interface TemperatureBandResult {
  id: 'cold' | 'mild' | 'warm';
  label: string;
  minimumC: number | null;
  maximumC: number | null;
  distanceKm: number;
  efficiency: EfficiencyResult;
}

export interface CarAnalyticsResponse {
  period: {
    range: CarAnalyticsRange;
    requestedStart: string | null;
    requestedEnd: string;
    effectiveStart: string | null;
    effectiveEnd: string | null;
    timezone: string;
    aggregationWindow: string;
  };
  summary: string;
  charging: {
    sessionCount: number;
    averageIntervalDays: number | null;
    averageSessionHours: number | null;
    averageChargeAddedPercent: number | null;
    sessions: ChargingSession[];
    sessionsTruncated: boolean;
  };
  usage: {
    distanceKm: number;
    energyKWh: number | null;
    measuredEnergyDistanceKm: number | null;
    batteryUsedPercent: number | null;
    efficiency: EfficiencyResult;
  };
  weather: {
    averageTemperatureC: number | null;
    bands: TemperatureBandResult[];
    estimatedImpactPercent: number | null;
    comparisonBands: ['cold', 'mild'] | null;
    efficiencyMethod: EfficiencyMethod;
  };
  comparison: {
    periodStart: string;
    periodEnd: string;
    distanceChangePercent: number | null;
    chargingFrequencyChangePercent: number | null;
    efficiencyChangePercent: number | null;
    previousCoveragePercent: number;
    previousEffectiveStart: string | null;
    previousEffectiveEnd: string | null;
  } | null;
  dataQuality: {
    coveragePercent: number;
    energyCoveragePercent: number;
    telemetrySamples: number;
    chargingSamples: number;
    weatherSamples: number;
    warnings: string[];
  };
}

interface PeriodData {
  telemetry: CarTelemetryPoint[];
  charging: ChargingPoint[];
  weather: WeatherPoint[];
}

interface PeriodAnalysis {
  effectiveStart: Date | null;
  effectiveEnd: Date | null;
  summary: string;
  charging: CarAnalyticsResponse['charging'];
  usage: CarAnalyticsResponse['usage'];
  weather: CarAnalyticsResponse['weather'];
  dataQuality: CarAnalyticsResponse['dataQuality'];
}

const RANGE_MILLISECONDS: Record<Exclude<CarAnalyticsRange, 'all' | 'custom'>, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
};

const RANGE_VALUES = new Set<CarAnalyticsRange>(['7d', '30d', '90d', '1y', 'all']);
const TOPIC_VALUES = new Set<CarAnalyticsTopic>([
  'overview',
  'charging',
  'efficiency',
  'weather',
  'comparison',
]);
const ALL_HISTORY_START = new Date('1970-01-01T00:00:00.000Z');
const MAX_SESSION_RESULTS = 100;
const SESSION_GAP_TOLERANCE_MS = 15 * 60 * 1000;
const MAX_BATTERY_LOOKUP_DISTANCE_MS = 6 * 60 * 60 * 1000;

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function isCarAnalyticsInputError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CarAnalyticsInputError';
}

export function isCarAnalyticsUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CarAnalyticsUnavailableError';
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseDate(value: unknown, name: string): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw namedError('CarAnalyticsInputError', `${name} must be an ISO-8601 date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw namedError('CarAnalyticsInputError', `${name} must be an ISO-8601 date`);
  }
  return date;
}

function validateTimezone(value: unknown): string {
  const timezone = typeof value === 'string' && value.trim()
    ? value.trim()
    : (process.env.TZ || 'UTC');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw namedError('CarAnalyticsInputError', `Unknown timezone: ${timezone}`);
  }
}

export function normalizeCarAnalyticsRequest(
  input: CarAnalyticsRequest,
  now = new Date(),
): ResolvedRequest {
  const hasCustomDates = input.start !== undefined || input.end !== undefined;
  let range: CarAnalyticsRange;
  let start: Date;
  let end: Date;
  let requestedStart: Date | null;

  if (hasCustomDates) {
    if (input.start === undefined || input.end === undefined) {
      throw namedError('CarAnalyticsInputError', 'Custom analytics require both start and end');
    }
    range = 'custom';
    start = parseDate(input.start, 'start');
    end = parseDate(input.end, 'end');
    requestedStart = start;
  } else {
    const requestedRange = typeof input.range === 'string' ? input.range : '30d';
    if (!RANGE_VALUES.has(requestedRange as CarAnalyticsRange)) {
      throw namedError('CarAnalyticsInputError', `Unsupported range: ${requestedRange}`);
    }
    range = requestedRange as CarAnalyticsRange;
    end = now;
    if (range === 'all') {
      start = ALL_HISTORY_START;
      requestedStart = null;
    } else {
      const presetRange = range as Exclude<CarAnalyticsRange, 'all' | 'custom'>;
      start = new Date(end.getTime() - RANGE_MILLISECONDS[presetRange]);
      requestedStart = start;
    }
  }

  if (start >= end) {
    throw namedError('CarAnalyticsInputError', 'start must be earlier than end');
  }
  if (end.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw namedError('CarAnalyticsInputError', 'end cannot be in the future');
  }

  const topicInput = typeof input.topic === 'string' ? input.topic : 'overview';
  if (!TOPIC_VALUES.has(topicInput as CarAnalyticsTopic)) {
    throw namedError('CarAnalyticsInputError', `Unsupported topic: ${topicInput}`);
  }

  const comparisonInput = input.comparison === undefined ? 'previous' : input.comparison;
  if (comparisonInput !== 'previous' && comparisonInput !== 'none') {
    throw namedError('CarAnalyticsInputError', 'comparison must be previous or none');
  }

  return {
    range,
    start,
    end,
    requestedStart,
    timezone: validateTimezone(input.timezone),
    includeComparison: comparisonInput === 'previous' && range !== 'all',
    topic: topicInput as CarAnalyticsTopic,
  };
}

export function aggregationWindow(start: Date, end: Date): string {
  const durationDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
  if (durationDays <= 30) return '5m';
  if (durationDays <= 90) return '15m';
  if (durationDays <= 365) return '1h';
  return '1d';
}

function escapeFlux(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function rangeClause(start: Date, end: Date): string {
  return `range(start: time(v: "${start.toISOString()}"), stop: time(v: "${end.toISOString()}"))`;
}

export function buildCarTelemetryQuery(
  bucket: string,
  vehicle: string,
  start: Date,
  end: Date,
  window: string,
): string {
  const vehicleFilter = vehicle
    ? `\n  |> filter(fn: (r) => r.vehicle == "${escapeFlux(vehicle)}")`
    : '';
  return `base = from(bucket: "${escapeFlux(bucket)}")
  |> ${rangeClause(start, end)}
  |> filter(fn: (r) => r._measurement == "car")${vehicleFilter}

numeric = base
  |> filter(fn: (r) => contains(
    value: r._field,
    set: ["odometer", "battery_level", "ev_range", "energy_total_kwh"],
  ))
  |> aggregateWindow(every: ${window}, fn: last, createEmpty: false)

batteryUse = base
  |> filter(fn: (r) => r._field == "battery_level")
  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)
  |> difference(nonNegative: false)
  |> map(fn: (r) => ({
    r with
    _field: "battery_used_percent",
    _value: if r._value < 0.0 then -r._value else 0.0,
  }))
  |> aggregateWindow(every: ${window}, fn: sum, createEmpty: false)

union(tables: [numeric, batteryUse])
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"])`;
}

export function buildEarliestCarQuery(
  bucket: string,
  vehicle: string,
  end: Date,
): string {
  const vehicleFilter = vehicle
    ? `\n  |> filter(fn: (r) => r.vehicle == "${escapeFlux(vehicle)}")`
    : '';
  return `from(bucket: "${escapeFlux(bucket)}")
  |> ${rangeClause(ALL_HISTORY_START, end)}
  |> filter(fn: (r) => r._measurement == "car" and r._field == "odometer")${vehicleFilter}
  |> first()
  |> keep(columns: ["_time"])`;
}

export function buildChargingQuery(
  bucket: string,
  vehicle: string,
  start: Date,
  end: Date,
): string {
  const vehicleFilter = vehicle
    ? `\n  |> filter(fn: (r) => r.vehicle == "${escapeFlux(vehicle)}")`
    : '';
  return `raw = from(bucket: "${escapeFlux(bucket)}")
  |> ${rangeClause(start, end)}
  |> filter(fn: (r) => r._measurement == "car" and r._field == "charging")${vehicleFilter}
  |> aggregateWindow(every: 5m, fn: last, createEmpty: false)
  |> map(fn: (r) => ({ r with _value: if r._value then 1 else 0 }))

initial = raw
  |> first()

changes = raw
  |> difference(nonNegative: false)
  |> filter(fn: (r) => r._value != 0)

latest = raw
  |> last()

union(tables: [initial, changes, latest])
  |> map(fn: (r) => ({ r with _value: r._value > 0 }))
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}

export function buildWeatherQuery(
  bucket: string,
  entityId: string,
  start: Date,
  end: Date,
  window: string,
): string {
  return `from(bucket: "${escapeFlux(bucket)}")
  |> ${rangeClause(start, end)}
  |> filter(fn: (r) => r._measurement == "climate" and r._field == "value")
  |> filter(fn: (r) => r.entity_id == "${escapeFlux(entityId)}")
  |> aggregateWindow(every: ${window}, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value"])
  |> sort(columns: ["_time"])`;
}

function parseTelemetryRows(rows: Record<string, unknown>[]): CarTelemetryPoint[] {
  return rows.flatMap((row) => {
    const time = new Date(String(Reflect.get(row, '_time') ?? ''));
    if (Number.isNaN(time.getTime())) return [];
    return [{
      time,
      odometer: finiteNumber(row.odometer),
      batteryLevel: finiteNumber(row.battery_level),
      batteryUsedPercent: finiteNumber(row.battery_used_percent),
      evRange: finiteNumber(row.ev_range),
      energyTotalKWh: finiteNumber(row.energy_total_kwh),
    }];
  });
}

function parseChargingRows(rows: Record<string, unknown>[]): ChargingPoint[] {
  return rows.flatMap((row) => {
    const time = new Date(String(Reflect.get(row, '_time') ?? ''));
    const value = String(Reflect.get(row, '_value') ?? '').toLowerCase();
    if (Number.isNaN(time.getTime()) || (value !== 'true' && value !== 'false')) return [];
    return [{ time, charging: value === 'true' }];
  });
}

function parseWeatherRows(rows: Record<string, unknown>[]): WeatherPoint[] {
  return rows.flatMap((row) => {
    const time = new Date(String(Reflect.get(row, '_time') ?? ''));
    const temperatureC = finiteNumber(Reflect.get(row, '_value'));
    if (Number.isNaN(time.getTime()) || temperatureC === undefined) return [];
    return [{ time, temperatureC }];
  });
}

function nearestBattery(
  telemetry: CarTelemetryPoint[],
  time: Date,
): number | null {
  let nearest: CarTelemetryPoint | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  telemetry.forEach((point) => {
    if (point.batteryLevel === undefined) return;
    const distance = Math.abs(point.time.getTime() - time.getTime());
    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  });
  if (!nearest || nearestDistance > MAX_BATTERY_LOOKUP_DISTANCE_MS) return null;
  return nearest.batteryLevel ?? null;
}

export function detectChargingSessions(
  charging: ChargingPoint[],
  telemetry: CarTelemetryPoint[],
): ChargingSession[] {
  const points = [...charging].sort((left, right) => left.time.getTime() - right.time.getTime());
  const sessions: ChargingSession[] = [];
  let start: Date | null = null;
  let pendingEnd: Date | null = null;

  const finish = (end: Date) => {
    if (!start || end <= start) return;
    const startBattery = nearestBattery(telemetry, start);
    const endBattery = nearestBattery(telemetry, end);
    const batteryAdded = startBattery === null || endBattery === null
      ? null
      : Math.max(0, endBattery - startBattery);
    sessions.push({
      start: start.toISOString(),
      end: end.toISOString(),
      durationHours: round((end.getTime() - start.getTime()) / (60 * 60 * 1000), 2),
      batteryAddedPercent: batteryAdded === null ? null : round(batteryAdded),
    });
    start = null;
    pendingEnd = null;
  };

  points.forEach((point) => {
    if (point.charging) {
      if (!start) {
        start = point.time;
      } else if (
        pendingEnd
        && point.time.getTime() - pendingEnd.getTime() > SESSION_GAP_TOLERANCE_MS
      ) {
        finish(pendingEnd);
        start = point.time;
      }
      pendingEnd = null;
      return;
    }

    if (!start) return;
    if (!pendingEnd) {
      pendingEnd = point.time;
      return;
    }
    if (point.time.getTime() - pendingEnd.getTime() > SESSION_GAP_TOLERANCE_MS) {
      finish(pendingEnd);
    }
  });

  if (start) {
    finish(pendingEnd ?? points.at(-1)?.time ?? start);
  }
  return sessions;
}

function isChargingAt(time: Date, charging: ChargingPoint[]): boolean {
  let low = 0;
  let high = charging.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (charging[middle].time <= time) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match >= 0 ? charging[match].charging : false;
}

function nearestTemperature(
  time: Date,
  weather: WeatherPoint[],
  maximumDistanceMs: number,
): number | null {
  let low = 0;
  let high = weather.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (weather[middle].time < time) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const candidates = [weather[high], weather[low]].filter(
    (point): point is WeatherPoint => point !== undefined,
  );
  const nearest = candidates.reduce<WeatherPoint | null>((current, point) => {
    if (!current) return point;
    const currentDistance = Math.abs(current.time.getTime() - time.getTime());
    const pointDistance = Math.abs(point.time.getTime() - time.getTime());
    return pointDistance < currentDistance ? point : current;
  }, null);
  if (!nearest) return null;
  const distance = Math.abs(nearest.time.getTime() - time.getTime());
  return distance <= maximumDistanceMs ? nearest.temperatureC : null;
}

interface UsageAccumulator {
  distanceKm: number;
  energyKWh: number;
  measuredEnergyDistanceKm: number;
  batteryUsedPercent: number;
  invalidOdometerDeltas: number;
  bandValues: Record<'cold' | 'mild' | 'warm', {
    distanceKm: number;
    energyKWh: number;
    measuredEnergyDistanceKm: number;
    batteryUsedPercent: number;
  }>;
}

function temperatureBand(temperatureC: number): 'cold' | 'mild' | 'warm' {
  if (temperatureC < 0) return 'cold';
  if (temperatureC < 20) return 'mild';
  return 'warm';
}

function windowMilliseconds(window: string): number {
  const amount = Number.parseInt(window, 10);
  if (window.endsWith('d')) return amount * 24 * 60 * 60 * 1000;
  if (window.endsWith('h')) return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function calculateUsage(
  telemetry: CarTelemetryPoint[],
  charging: ChargingPoint[],
  weather: WeatherPoint[],
  window: string,
): UsageAccumulator {
  const sorted = [...telemetry].sort((left, right) => left.time.getTime() - right.time.getTime());
  const accumulator: UsageAccumulator = {
    distanceKm: 0,
    energyKWh: 0,
    measuredEnergyDistanceKm: 0,
    batteryUsedPercent: 0,
    invalidOdometerDeltas: 0,
    bandValues: {
      cold: {
        distanceKm: 0, energyKWh: 0, measuredEnergyDistanceKm: 0, batteryUsedPercent: 0,
      },
      mild: {
        distanceKm: 0, energyKWh: 0, measuredEnergyDistanceKm: 0, batteryUsedPercent: 0,
      },
      warm: {
        distanceKm: 0, energyKWh: 0, measuredEnergyDistanceKm: 0, batteryUsedPercent: 0,
      },
    },
  };
  const maximumWeatherDistanceMs = Math.max(6 * 60 * 60 * 1000, windowMilliseconds(window));

  sorted.slice(1).forEach((current, offset) => {
    const index = offset + 1;
    const previous = sorted[index - 1];
    const hours = (current.time.getTime() - previous.time.getTime()) / (60 * 60 * 1000);
    if (hours <= 0) return;
    const energyDelta = previous.energyTotalKWh !== undefined && current.energyTotalKWh !== undefined
      ? current.energyTotalKWh - previous.energyTotalKWh
      : 0;
    if (previous.odometer === undefined || current.odometer === undefined) return;
    const distance = current.odometer - previous.odometer;
    const maximumPlausibleDistance = Math.max(25, hours * 250 + 5);
    if (distance < 0 || distance > maximumPlausibleDistance) {
      accumulator.invalidOdometerDeltas += 1;
      return;
    }
    if (distance === 0) return;

    accumulator.distanceKm += distance;
    if (energyDelta > 0) accumulator.energyKWh += energyDelta;
    const midpoint = new Date((previous.time.getTime() + current.time.getTime()) / 2);
    const temperature = nearestTemperature(midpoint, weather, maximumWeatherDistanceMs);
    const band = temperature === null ? null : temperatureBand(temperature);
    if (band) accumulator.bandValues[band].distanceKm += distance;

    if (previous.energyTotalKWh !== undefined && current.energyTotalKWh !== undefined) {
      accumulator.measuredEnergyDistanceKm += distance;
      if (band) accumulator.bandValues[band].measuredEnergyDistanceKm += distance;
      if (energyDelta > 0 && band) accumulator.bandValues[band].energyKWh += energyDelta;
    }

    const batteryDelta = current.batteryUsedPercent ?? (
      previous.batteryLevel !== undefined && current.batteryLevel !== undefined
        ? previous.batteryLevel - current.batteryLevel
        : 0
    );
    const validBatteryUse = current.batteryUsedPercent !== undefined
      ? batteryDelta > 0
      : batteryDelta > 0 && !isChargingAt(midpoint, charging);
    if (validBatteryUse) {
      accumulator.batteryUsedPercent += batteryDelta;
      if (band) accumulator.bandValues[band].batteryUsedPercent += batteryDelta;
    }
  });
  return accumulator;
}

function efficiencyResult(
  distanceKm: number,
  energyKWh: number,
  measuredEnergyDistanceKm: number,
  batteryUsedPercent: number,
): EfficiencyResult {
  const energyCoverage = distanceKm > 0 ? measuredEnergyDistanceKm / distanceKm : 0;
  if (measuredEnergyDistanceKm >= 1 && energyKWh > 0 && energyCoverage >= 0.75) {
    return {
      method: 'measured_kwh',
      value: round((energyKWh / measuredEnergyDistanceKm) * 100),
      unit: 'kWh/100 km',
      label: 'Measured energy efficiency',
    };
  }
  if (distanceKm >= 1 && batteryUsedPercent > 0) {
    return {
      method: 'battery_proxy',
      value: round((batteryUsedPercent / distanceKm) * 100),
      unit: '%/100 km',
      label: 'Battery-use estimate',
    };
  }
  return {
    method: 'unavailable',
    value: null,
    unit: null,
    label: 'Efficiency unavailable',
  };
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current - previous) / previous) * 100);
}

function buildWeatherResult(
  accumulator: UsageAccumulator,
  weather: WeatherPoint[],
): CarAnalyticsResponse['weather'] {
  const definitions: Array<{
    id: 'cold' | 'mild' | 'warm';
    label: string;
    minimumC: number | null;
    maximumC: number | null;
  }> = [
    {
      id: 'cold', label: 'Below freezing', minimumC: null, maximumC: 0,
    },
    {
      id: 'mild', label: 'Mild', minimumC: 0, maximumC: 20,
    },
    {
      id: 'warm', label: 'Warm', minimumC: 20, maximumC: null,
    },
  ];
  const bands = definitions.map((definition) => {
    const values = accumulator.bandValues[definition.id];
    return {
      ...definition,
      distanceKm: round(values.distanceKm),
      efficiency: efficiencyResult(
        values.distanceKm,
        values.energyKWh,
        values.measuredEnergyDistanceKm,
        values.batteryUsedPercent,
      ),
    };
  });
  const cold = bands.find((band) => band.id === 'cold');
  const mild = bands.find((band) => band.id === 'mild');
  const comparable = cold?.distanceKm !== undefined
    && mild?.distanceKm !== undefined
    && cold.distanceKm >= 10
    && mild.distanceKm >= 10
    && cold.efficiency.method === mild.efficiency.method
    && cold.efficiency.method !== 'unavailable';
  const impact = comparable
    ? percentChange(cold?.efficiency.value ?? null, mild?.efficiency.value ?? null)
    : null;

  return {
    averageTemperatureC: weather.length > 0
      ? round(weather.reduce((sum, point) => sum + point.temperatureC, 0) / weather.length)
      : null,
    bands,
    estimatedImpactPercent: impact,
    comparisonBands: impact === null ? null : ['cold', 'mild'],
    efficiencyMethod: impact === null ? 'unavailable' : cold?.efficiency.method ?? 'unavailable',
  };
}

function buildSummary(
  range: CarAnalyticsRange,
  sessions: number,
  distanceKm: number,
  efficiency: EfficiencyResult,
): string {
  const period = range === 'all' ? 'across all retained history' : `during the selected ${range} period`;
  const parts = [
    `You charged ${sessions} ${sessions === 1 ? 'time' : 'times'} ${period}`,
    `and drove ${round(distanceKm)} km`,
  ];
  if (efficiency.value !== null && efficiency.unit) {
    const qualifier = efficiency.method === 'battery_proxy' ? 'estimated battery use' : 'measured efficiency';
    parts.push(`with ${qualifier} of ${efficiency.value} ${efficiency.unit}`);
  }
  return `${parts.join(', ')}.`;
}

export function calculateCarAnalytics(
  data: PeriodData,
  range: CarAnalyticsRange,
  periodStart: Date,
  periodEnd: Date,
  window: string,
): PeriodAnalysis {
  const telemetry = [...data.telemetry].sort((left, right) => left.time.getTime() - right.time.getTime());
  const charging = [...data.charging].sort((left, right) => left.time.getTime() - right.time.getTime());
  const weather = [...data.weather].sort((left, right) => left.time.getTime() - right.time.getTime());
  const allTimes = [
    ...telemetry.map((point) => point.time),
    ...charging.map((point) => point.time),
  ].sort((left, right) => left.getTime() - right.getTime());
  const effectiveStart = allTimes.at(0) ?? null;
  const effectiveEnd = allTimes.at(-1) ?? null;
  const sessions = detectChargingSessions(charging, telemetry);
  const usageValues = calculateUsage(telemetry, charging, weather, window);
  const efficiency = efficiencyResult(
    usageValues.distanceKm,
    usageValues.energyKWh,
    usageValues.measuredEnergyDistanceKm,
    usageValues.batteryUsedPercent,
  );
  const durations = sessions.map((session) => session.durationHours);
  const batteryAdditions = sessions.flatMap((session) => (
    session.batteryAddedPercent === null ? [] : [session.batteryAddedPercent]
  ));
  const intervals = sessions.slice(1).map((session, index) => (
    (new Date(session.start).getTime() - new Date(sessions[index].start).getTime())
      / (24 * 60 * 60 * 1000)
  ));
  const expectedWindowMs = windowMilliseconds(window);
  const effectiveDuration = range === 'all' && effectiveStart && effectiveEnd
    ? Math.max(expectedWindowMs, effectiveEnd.getTime() - effectiveStart.getTime())
    : periodEnd.getTime() - periodStart.getTime();
  const expectedSamples = Math.max(1, Math.floor(effectiveDuration / expectedWindowMs) + 1);
  const coveragePercent = Math.min(100, (telemetry.length / expectedSamples) * 100);
  const warnings: string[] = [];
  if (telemetry.length === 0) warnings.push('No car telemetry was retained for this period.');
  if (coveragePercent < 75) warnings.push('Car telemetry coverage is below 75 percent.');
  if (weather.length === 0) warnings.push('Outdoor temperature data is unavailable for this period.');
  if (usageValues.invalidOdometerDeltas > 0) {
    warnings.push(`${usageValues.invalidOdometerDeltas} invalid odometer deltas were ignored.`);
  }
  if (efficiency.method === 'battery_proxy') {
    warnings.push('Efficiency is a battery-use estimate because measured kWh telemetry is unavailable.');
  }
  const energyCoveragePercent = usageValues.distanceKm > 0
    ? Math.min(100, (usageValues.measuredEnergyDistanceKm / usageValues.distanceKm) * 100)
    : 0;
  if (usageValues.energyKWh > 0 && energyCoveragePercent < 75) {
    warnings.push('Measured energy coverage is below 75 percent; efficiency uses the battery estimate.');
  }
  if (efficiency.method === 'unavailable') {
    warnings.push('There is not enough distance and energy data to calculate efficiency.');
  }

  return {
    effectiveStart,
    effectiveEnd,
    summary: buildSummary(range, sessions.length, usageValues.distanceKm, efficiency),
    charging: {
      sessionCount: sessions.length,
      averageIntervalDays: intervals.length > 0 ? round(average(intervals) ?? 0) : null,
      averageSessionHours: durations.length > 0 ? round(average(durations) ?? 0, 2) : null,
      averageChargeAddedPercent: batteryAdditions.length > 0
        ? round(average(batteryAdditions) ?? 0)
        : null,
      sessions: sessions.slice(-MAX_SESSION_RESULTS),
      sessionsTruncated: sessions.length > MAX_SESSION_RESULTS,
    },
    usage: {
      distanceKm: round(usageValues.distanceKm),
      energyKWh: usageValues.energyKWh > 0 ? round(usageValues.energyKWh, 2) : null,
      measuredEnergyDistanceKm: usageValues.measuredEnergyDistanceKm > 0
        ? round(usageValues.measuredEnergyDistanceKm)
        : null,
      batteryUsedPercent: usageValues.batteryUsedPercent > 0
        ? round(usageValues.batteryUsedPercent)
        : null,
      efficiency,
    },
    weather: buildWeatherResult(usageValues, weather),
    dataQuality: {
      coveragePercent: round(coveragePercent),
      energyCoveragePercent: round(energyCoveragePercent),
      telemetrySamples: telemetry.length,
      chargingSamples: charging.length,
      weatherSamples: weather.length,
      warnings,
    },
  };
}

function comparisonResponse(
  current: PeriodAnalysis,
  previous: PeriodAnalysis,
  start: Date,
  end: Date,
): NonNullable<CarAnalyticsResponse['comparison']> {
  const currentEfficiency = current.usage.efficiency;
  const previousEfficiency = previous.usage.efficiency;
  const comparableEfficiency = currentEfficiency.method === previousEfficiency.method
    ? percentChange(currentEfficiency.value, previousEfficiency.value)
    : null;
  const sufficientCoverage = current.dataQuality.coveragePercent >= 75
    && previous.dataQuality.coveragePercent >= 75;
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    distanceChangePercent: sufficientCoverage
      ? percentChange(current.usage.distanceKm, previous.usage.distanceKm)
      : null,
    chargingFrequencyChangePercent: sufficientCoverage
      ? percentChange(current.charging.sessionCount, previous.charging.sessionCount)
      : null,
    efficiencyChangePercent: sufficientCoverage ? comparableEfficiency : null,
    previousCoveragePercent: previous.dataQuality.coveragePercent,
    previousEffectiveStart: previous.effectiveStart?.toISOString() ?? null,
    previousEffectiveEnd: previous.effectiveEnd?.toISOString() ?? null,
  };
}

export interface CarAnalyticsServiceConfig {
  influxdb?: InfluxDBClient;
  bucket: string;
  vehicle?: string;
  outdoorTemperatureEntityId?: string;
  now?: () => Date;
}

export class CarAnalyticsService {
  private influxdb?: InfluxDBClient;

  private bucket: string;

  private vehicle: string;

  private outdoorTemperatureEntityId: string;

  private now: () => Date;

  constructor(config: CarAnalyticsServiceConfig) {
    this.influxdb = config.influxdb;
    this.bucket = config.bucket;
    this.vehicle = config.vehicle ?? '';
    this.outdoorTemperatureEntityId = config.outdoorTemperatureEntityId
      ?? 'patio_environment_canada_temperature';
    this.now = config.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.influxdb?.configured === true;
  }

  private async fetchPeriod(start: Date, end: Date, window: string): Promise<PeriodData> {
    if (!this.influxdb?.configured) {
      throw namedError('CarAnalyticsUnavailableError', 'InfluxDB is not configured');
    }
    const [telemetryRows, chargingRows, weatherRows] = await Promise.all([
      this.influxdb.query(buildCarTelemetryQuery(
        this.bucket,
        this.vehicle,
        start,
        end,
        window,
      )),
      this.influxdb.query(buildChargingQuery(this.bucket, this.vehicle, start, end)),
      this.influxdb.query(buildWeatherQuery(
        this.bucket,
        this.outdoorTemperatureEntityId,
        start,
        end,
        window,
      )),
    ]);
    return {
      telemetry: parseTelemetryRows(telemetryRows as Record<string, unknown>[]),
      charging: parseChargingRows(chargingRows as Record<string, unknown>[]),
      weather: parseWeatherRows(weatherRows as Record<string, unknown>[]),
    };
  }

  private async fetchEarliestCarTime(end: Date): Promise<Date | null> {
    if (!this.influxdb?.configured) {
      throw namedError('CarAnalyticsUnavailableError', 'InfluxDB is not configured');
    }
    const rows = await this.influxdb.query(buildEarliestCarQuery(
      this.bucket,
      this.vehicle,
      end,
    )) as Record<string, unknown>[];
    const time = new Date(String(Reflect.get(rows[0] ?? {}, '_time') ?? ''));
    return Number.isNaN(time.getTime()) ? null : time;
  }

  async analyze(input: CarAnalyticsRequest = {}): Promise<CarAnalyticsResponse> {
    const request = normalizeCarAnalyticsRequest(input, this.now());
    const startedAt = performance.now();
    const earliestTime = request.range === 'all'
      ? await this.fetchEarliestCarTime(request.end)
      : null;
    const analysisStart = earliestTime ?? request.start;
    const window = aggregationWindow(analysisStart, request.end);
    const duration = request.end.getTime() - analysisStart.getTime();
    const previousEnd = analysisStart;
    const previousStart = new Date(previousEnd.getTime() - duration);
    const previousWindow = aggregationWindow(previousStart, previousEnd);
    const currentDataPromise = request.range === 'all' && !earliestTime
      ? Promise.resolve({ telemetry: [], charging: [], weather: [] })
      : this.fetchPeriod(analysisStart, request.end, window);
    const previousDataPromise = request.includeComparison
      ? this.fetchPeriod(previousStart, previousEnd, previousWindow)
      : Promise.resolve(null);
    const [currentData, previousData] = await Promise.all([
      currentDataPromise,
      previousDataPromise,
    ]);
    const current = calculateCarAnalytics(
      currentData,
      request.range,
      analysisStart,
      request.end,
      window,
    );

    let comparison: CarAnalyticsResponse['comparison'] = null;
    if (previousData) {
      const previous = calculateCarAnalytics(
        previousData,
        request.range,
        previousStart,
        previousEnd,
        previousWindow,
      );
      comparison = comparisonResponse(current, previous, previousStart, previousEnd);
    }

    analyticsLogger.info({
      range: request.range,
      topic: request.topic,
      durationMs: Math.round(performance.now() - startedAt),
      coveragePercent: current.dataQuality.coveragePercent,
    }, 'Calculated car analytics');

    return {
      period: {
        range: request.range,
        requestedStart: request.requestedStart?.toISOString() ?? null,
        requestedEnd: request.end.toISOString(),
        effectiveStart: current.effectiveStart?.toISOString() ?? null,
        effectiveEnd: current.effectiveEnd?.toISOString() ?? null,
        timezone: request.timezone,
        aggregationWindow: window,
      },
      summary: current.summary,
      charging: current.charging,
      usage: current.usage,
      weather: current.weather,
      comparison,
      dataQuality: current.dataQuality,
    };
  }
}
