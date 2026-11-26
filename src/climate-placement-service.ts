// Data fetching and caching for GET /climate/placement-insights. Reads room
// temperatures from InfluxDB and thermostat history from Home Assistant, then
// hands both to the pure analysis in climate-placement.ts. Upstream failures
// degrade to an empty analysis rather than an error.
import type { InfluxDBClient } from './clients/influxdb';
import { fluxBucketLiteral } from './clients/safe-params';
import type { HomeAssistantClient } from './homeassistant-client';
import type { IndoorClimateStatus } from './indoor-climate';
import {
  analyzePlacement, BUCKET_MS, type HvacSample, type PlacementInsights, type SensorSeriesInput,
} from './climate-placement';
import logger from './logger';

const placementLogger = logger.child({ subsystem: 'climate-placement' });

export const DEFAULT_PLACEMENT_DAYS = 14;
export const MIN_PLACEMENT_DAYS = 3;
export const MAX_PLACEMENT_DAYS = 30;
export const PLACEMENT_CACHE_TTL_MS = 15 * 60 * 1000;
// Degraded results (an upstream failed) are retried sooner.
export const PLACEMENT_DEGRADED_TTL_MS = 60 * 1000;
const HISTORY_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Temperature sensors that aren't indoor rooms.
const OUTDOOR_PATTERN = /outdoor|outside|patio|exterior|environment_canada/i;
const SAFE_OBJECT_ID = /^[a-z0-9_]+$/;
// Converted set points outside this °C range are treated as unknown (e.g.
// history recorded in a different unit than the thermostat reports now).
const MIN_PLAUSIBLE_SETPOINT_C = 5;
const MAX_PLAUSIBLE_SETPOINT_C = 35;

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function isPlacementInputError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PlacementInputError';
}

export function isPlacementUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === 'PlacementUnavailableError';
}

export function parsePlacementDays(value: unknown): number {
  if (value === undefined) return DEFAULT_PLACEMENT_DAYS;
  const days = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(days) || days < MIN_PLACEMENT_DAYS || days > MAX_PLACEMENT_DAYS) {
    throw namedError(
      'PlacementInputError',
      `days must be an integer from ${MIN_PLACEMENT_DAYS} to ${MAX_PLACEMENT_DAYS}`,
    );
  }
  return days;
}

export interface PlacementIndoorClimate {
  cachedStatus: IndoorClimateStatus;
  refresh(): Promise<void>;
}

export interface ClimatePlacementDeps {
  influxdb: InfluxDBClient;
  bucket: string;
  homeAssistant: HomeAssistantClient;
  indoorClimate: PlacementIndoorClimate;
  timeZone?: string;
  now?: () => Date;
}

export interface IndoorSensor {
  id: string;
  name: string;
  isThermostat: boolean;
}

function objectId(entityId: string): string {
  return entityId.slice(entityId.indexOf('.') + 1);
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

// Converts to °C; null when the unit is unknown, so nothing is compared or
// reported in a unit that can't be established.
export function toCelsius(value: number | null, unit: string | null | undefined): number | null {
  if (value === null) return null;
  if (unit === '°C') return value;
  if (unit === '°F') return (value - 32) * (5 / 9);
  return null;
}

// Unit of an InfluxDB row: Home Assistant names measurements after the unit
// (`°C`/`°F`) unless overridden (e.g. `climate`); then only the unit recorded
// with the reading itself (its `unit_of_measurement_str` field) establishes
// it. The sensor's current unit says nothing about past readings.
export function rowUnit(measurement: string | undefined, recordedUnit: string | undefined): string | null {
  if (measurement === '°C' || measurement === '°F') return measurement;
  return recordedUnit === '°C' || recordedUnit === '°F' ? recordedUnit : null;
}

// The server's time zone: TZ, else the system zone, else UTC.
export function resolveTimeZone(preferred?: string): string {
  const candidates = [preferred, process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  const valid = candidates.find((zone) => {
    if (!zone) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
      return true;
    } catch {
      return false;
    }
  });
  return valid ?? 'UTC';
}

// Each reading is paired with the unit Home Assistant recorded alongside it
// (written as `unit_of_measurement_str` when the measurement is overridden),
// readings are averaged per unit (so a unit change never mixes values) and
// stamped with the start of their window (`timeSrc: "_start"`), the earliest
// time any of them could have been read.
export function buildPlacementQuery(bucket: string, ids: string[], start: Date, end: Date): string {
  const set = ids.filter((id) => SAFE_OBJECT_ID.test(id)).map((id) => `"${id}"`).join(', ');
  return `from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${start.toISOString()}"), stop: time(v: "${end.toISOString()}"))
  |> filter(fn: (r) => r._measurement == "climate" or r._measurement == "°C" or r._measurement == "°F")
  |> filter(fn: (r) => r._field == "value" or r._field == "unit_of_measurement_str")
  |> filter(fn: (r) => r.domain == "sensor" and contains(value: r.entity_id, set: [${set}]))
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> filter(fn: (r) => exists r.value)
  |> map(fn: (r) => ({ r with
    _value: float(v: r.value),
    unit: if exists r.unit_of_measurement_str then r.unit_of_measurement_str else "",
  }))
  |> group(columns: ["domain", "entity_id", "_measurement", "unit"])
  |> aggregateWindow(every: ${BUCKET_MS / 60_000}m, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_value", "_measurement", "unit", "entity_id"])`;
}

function plausibleSetpoint(value: number | null): number | null {
  return value !== null && value >= MIN_PLAUSIBLE_SETPOINT_C && value <= MAX_PLAUSIBLE_SETPOINT_C ? value : null;
}

// Home Assistant history rows for a climate entity → mode / set point / action
// samples. Unavailable/unknown states are kept as gaps so no transition is
// read across them.
export function parseClimateHistory(history: unknown, unit: string | null | undefined): HvacSample[] {
  const rows = Array.isArray(history) && Array.isArray(history[0]) ? history[0] : [];
  return rows.flatMap((row: unknown): HvacSample[] => {
    if (!row || typeof row !== 'object') return [];
    const { state, attributes, last_updated: lastUpdated, last_changed: lastChanged } = row as Record<string, unknown>;
    const t = Date.parse(String(lastUpdated ?? lastChanged ?? ''));
    if (!Number.isFinite(t)) return [];
    if (typeof state !== 'string' || state === 'unavailable' || state === 'unknown') {
      return [{
        t, gap: true, hvacMode: null, hvacAction: null, presetMode: null, setpoint: null,
      }];
    }
    const attrs = (attributes && typeof attributes === 'object' ? attributes : {}) as Record<string, unknown>;
    const setpoint = toNumber(attrs.temperature) ?? toNumber(attrs.target_temp_low);
    return [{
      t,
      gap: false,
      hvacMode: state,
      hvacAction: typeof attrs.hvac_action === 'string' ? attrs.hvac_action : null,
      presetMode: typeof attrs.preset_mode === 'string' ? attrs.preset_mode : null,
      setpoint: plausibleSetpoint(toCelsius(setpoint, unit)),
    }];
  });
}

// InfluxDB rows → per-sensor °C series. Rows whose unit can't be established
// are dropped (counted and logged) rather than compared as °C.
export function rowsToSeries(
  rows: Record<string, string>[],
  sensors: IndoorSensor[],
): { series: SensorSeriesInput[]; unknownUnitReadings: number } {
  const points = new Map<string, { t: number; v: number }[]>();
  let skipped = 0;
  rows.forEach((row) => {
    /* eslint-disable no-underscore-dangle */
    const t = Date.parse(row._time);
    const raw = Number.parseFloat(row._value);
    const unit = rowUnit(row._measurement, row.unit);
    /* eslint-enable no-underscore-dangle */
    if (!row.entity_id || !Number.isFinite(t) || !Number.isFinite(raw)) return;
    const v = toCelsius(raw, unit);
    if (v === null) {
      skipped += 1;
      return;
    }
    if (!points.has(row.entity_id)) points.set(row.entity_id, []);
    points.get(row.entity_id)!.push({ t, v });
  });
  if (skipped > 0) placementLogger.warn({ skipped }, 'Skipped temperature readings with an unknown unit');
  return {
    series: sensors.map((s) => ({
      id: s.id, name: s.name, isThermostat: s.isThermostat, points: points.get(s.id) ?? [],
    })),
    unknownUnitReadings: skipped,
  };
}

export class ClimatePlacementService {
  private deps: ClimatePlacementDeps;

  private cache = new Map<number, { expires: number; result: Promise<PlacementInsights> }>();

  constructor(deps: ClimatePlacementDeps) {
    this.deps = deps;
  }

  get configured(): boolean {
    return this.deps.influxdb?.configured === true;
  }

  public async getInsights(daysInput: unknown): Promise<PlacementInsights> {
    const days = parsePlacementDays(daysInput);
    if (!this.configured) throw namedError('PlacementUnavailableError', 'InfluxDB is not configured');
    const now = this.now().getTime();
    const cached = this.cache.get(days);
    if (cached && cached.expires > now) return cached.result;
    const entry = { expires: now + PLACEMENT_CACHE_TTL_MS, result: null as Promise<PlacementInsights> | null };
    const result = this.compute(days).then(({ insights, degraded }) => {
      if (degraded) entry.expires = Math.min(entry.expires, this.now().getTime() + PLACEMENT_DEGRADED_TTL_MS);
      return insights;
    }).catch((err) => {
      if (this.cache.get(days) === entry) this.cache.delete(days);
      throw err;
    });
    entry.result = result;
    this.cache.set(days, entry as { expires: number; result: Promise<PlacementInsights> });
    return result;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async compute(days: number): Promise<{ insights: PlacementInsights; degraded: boolean }> {
    const end = this.now();
    const start = new Date(end.getTime() - days * DAY_MS);
    const { indoorClimate } = this.deps;
    // Discovery may not have run (or may have failed) yet; try once more.
    if (!indoorClimate.cachedStatus.thermostat || indoorClimate.cachedStatus.sensors.length === 0) {
      await indoorClimate.refresh().catch(() => {});
    }
    const status = indoorClimate.cachedStatus;
    const sensors: IndoorSensor[] = status.sensors
      .map((s) => ({ id: objectId(s.entityId), name: s.name, isThermostat: s.isThermostat }))
      .filter((s) => SAFE_OBJECT_ID.test(s.id) && !OUTDOOR_PATTERN.test(s.id) && !OUTDOOR_PATTERN.test(s.name));

    // Missing discovery or thermostat counts as degraded so it is retried soon.
    let degraded = sensors.length === 0 || !status.thermostat;
    const [{ series, unknownUnitReadings }, hvac] = await Promise.all([
      this.fetchSeries(sensors, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read room temperatures for placement insights');
        degraded = true;
        return {
          series: sensors.map((s) => ({
            id: s.id, name: s.name, isThermostat: s.isThermostat, points: [],
          })),
          unknownUnitReadings: 0,
        };
      }),
      this.fetchHvac(status, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read thermostat history for placement insights');
        degraded = true;
        return null;
      }),
    ]);

    if (series.every((sensor) => sensor.points.length === 0) || !hvac || hvac.length === 0) degraded = true;

    const insights = analyzePlacement({
      start,
      end,
      windowDays: days,
      timeZone: resolveTimeZone(this.deps.timeZone),
      sensors: series,
      hvac,
      unknownUnitReadings,
      generatedAt: end,
    });
    return { insights, degraded };
  }

  private async fetchSeries(
    sensors: IndoorSensor[],
    start: Date,
    end: Date,
  ): Promise<{ series: SensorSeriesInput[]; unknownUnitReadings: number }> {
    if (sensors.length === 0) return { series: [], unknownUnitReadings: 0 };
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildPlacementQuery(this.deps.bucket, sensors.map((s) => s.id), start, end),
    );
    return rowsToSeries(rows, sensors);
  }

  private async fetchHvac(status: IndoorClimateStatus, start: Date, end: Date): Promise<HvacSample[] | null> {
    const entityId = status.thermostat?.entityId;
    if (!entityId) return null;
    const history = await this.deps.homeAssistant.getHistory(
      entityId,
      start.toISOString(),
      end.toISOString(),
      { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) },
    );
    return parseClimateHistory(history, status.thermostat?.temperatureUnit);
  }
}
