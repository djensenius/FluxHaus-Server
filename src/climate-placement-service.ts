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

interface IndoorSensor {
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

function toCelsius(value: number | null, unit: string | null | undefined): number | null {
  if (value === null) return null;
  return unit === '°F' ? (value - 32) * (5 / 9) : value;
}

export function buildPlacementQuery(bucket: string, ids: string[], start: Date, end: Date): string {
  const set = ids.filter((id) => SAFE_OBJECT_ID.test(id)).map((id) => `"${id}"`).join(', ');
  return `from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${start.toISOString()}"), stop: time(v: "${end.toISOString()}"))
  |> filter(fn: (r) => (r._measurement == "climate" or r._measurement == "°C") and r._field == "value")
  |> filter(fn: (r) => contains(value: r.entity_id, set: [${set}]))
  |> group(columns: ["entity_id"])
  |> aggregateWindow(every: ${BUCKET_MS / 60_000}m, fn: mean, createEmpty: false)
  |> keep(columns: ["_time", "_value", "entity_id"])`;
}

// Home Assistant history rows for a climate entity → set point / action samples.
export function parseClimateHistory(history: unknown, unit: string | null | undefined): HvacSample[] {
  const rows = Array.isArray(history) && Array.isArray(history[0]) ? history[0] : [];
  return rows.flatMap((row: unknown): HvacSample[] => {
    if (!row || typeof row !== 'object') return [];
    const { state, attributes, last_updated: lastUpdated, last_changed: lastChanged } = row as Record<string, unknown>;
    if (state === 'unavailable' || state === 'unknown') return [];
    const t = Date.parse(String(lastUpdated ?? lastChanged ?? ''));
    if (!Number.isFinite(t)) return [];
    const attrs = (attributes && typeof attributes === 'object' ? attributes : {}) as Record<string, unknown>;
    const setpoint = toNumber(attrs.temperature) ?? toNumber(attrs.target_temp_low);
    return [{
      t,
      hvacAction: typeof attrs.hvac_action === 'string' ? attrs.hvac_action : null,
      presetMode: typeof attrs.preset_mode === 'string' ? attrs.preset_mode : null,
      setpoint: toCelsius(setpoint, unit),
    }];
  });
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
    if (!indoorClimate.cachedStatus.thermostat && indoorClimate.cachedStatus.sensors.length === 0) {
      await indoorClimate.refresh().catch(() => {});
    }
    const status = indoorClimate.cachedStatus;
    const sensors: IndoorSensor[] = status.sensors
      .map((s) => ({ id: objectId(s.entityId), name: s.name, isThermostat: s.isThermostat }))
      .filter((s) => SAFE_OBJECT_ID.test(s.id) && !OUTDOOR_PATTERN.test(s.id) && !OUTDOOR_PATTERN.test(s.name));

    let degraded = false;
    const [series, hvac] = await Promise.all([
      this.fetchSeries(sensors, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read room temperatures for placement insights');
        degraded = true;
        return sensors.map((s) => ({ ...s, points: [] }));
      }),
      this.fetchHvac(status, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read thermostat history for placement insights');
        degraded = true;
        return null;
      }),
    ]);

    const insights = analyzePlacement({
      start,
      end,
      windowDays: days,
      timeZone: this.deps.timeZone || process.env.TZ || 'UTC',
      sensors: series,
      hvac,
      generatedAt: end,
    });
    return { insights, degraded };
  }

  private async fetchSeries(sensors: IndoorSensor[], start: Date, end: Date): Promise<SensorSeriesInput[]> {
    if (sensors.length === 0) return [];
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildPlacementQuery(this.deps.bucket, sensors.map((s) => s.id), start, end),
    );
    const points = new Map<string, { t: number; v: number }[]>();
    rows.forEach((row) => {
      /* eslint-disable no-underscore-dangle */
      const t = Date.parse(row._time);
      const v = Number.parseFloat(row._value);
      /* eslint-enable no-underscore-dangle */
      if (!row.entity_id || !Number.isFinite(t) || !Number.isFinite(v)) return;
      if (!points.has(row.entity_id)) points.set(row.entity_id, []);
      points.get(row.entity_id)!.push({ t, v });
    });
    return sensors.map((s) => ({ ...s, points: points.get(s.id) ?? [] }));
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
