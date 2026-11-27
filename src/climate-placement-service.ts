// Data fetching and caching for GET /climate/placement-insights. Reads room
// temperatures, thermostat history, the Ecobee comfort setting and room
// occupancy from the configured InfluxDB bucket that Home Assistant writes to
// (the recorder keeps only days of history), then hands them to the pure analysis in
// climate-placement.ts. Upstream failures degrade to an empty analysis rather
// than an error.
import type { InfluxDBClient } from './clients/influxdb';
import { fluxBucketLiteral } from './clients/safe-params';
import type { IndoorClimateStatus, PlacementDiscovery } from './indoor-climate';
import {
  analyzePlacement,
  BUCKET_MS,
  COMFORT_SETTINGS,
  compatibleHvacAction,
  reportedHasUsableHistory,
  type ComfortSample,
  type CoolingInput,
  type HvacSample,
  type OccupancySample,
  type ParticipationConfig,
  type PlacementInsights,
  type ReportedTemperatureInput,
  type SensorSeriesInput,
} from './climate-placement';
import logger from './logger';

const placementLogger = logger.child({ subsystem: 'climate-placement' });

export const DEFAULT_PLACEMENT_DAYS = 14;
export const MIN_PLACEMENT_DAYS = 3;
export const MAX_PLACEMENT_DAYS = 30;
export const PLACEMENT_CACHE_TTL_MS = 15 * 60 * 1000;
// Degraded results (an upstream failed) are retried sooner.
export const PLACEMENT_DEGRADED_TTL_MS = 60 * 1000;
// Results cached at once (windows × participation configurations); expired
// entries are evicted first, then the least recently used.
export const PLACEMENT_CACHE_MAX_ENTRIES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cooling tips use the most recent cooling within the past year.
export const COOLING_LOOKBACK_DAYS = 365;
const PRIOR_STATE_DAYS = 30;
const COOLING_TAIL_MS = 2 * 60 * 60 * 1000;
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

function inputError(message: string): Error {
  return namedError('PlacementInputError', message);
}

function parseIdList(value: unknown, name: string): string[] | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw inputError(`${name} must be a comma-separated list of sensor ids`);
  if (value === '') return [];
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !SAFE_OBJECT_ID.test(id))) {
    throw inputError(`${name} must be a comma-separated list of sensor ids`);
  }
  return [...new Set(ids)].sort();
}

function parseOptionalBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined) return null;
  if (value !== 'true' && value !== 'false') throw inputError(`${name} must be true or false`);
  return value === 'true';
}

// Optional comfort setting participation (`home`, `sleep`, `away`: sensor ids
// in that comfort setting, '' for none), thermostat sensor participation and
// `followMe` (true/false). Returns null when none is given. Ids are checked
// against the sensors later.
export function parsePlacementConfig(query: Record<string, unknown> = {}): ParticipationConfig | null {
  const home = parseIdList(query.home, 'home');
  const sleep = parseIdList(query.sleep, 'sleep');
  const away = parseIdList(query.away, 'away');
  const followMe = parseOptionalBoolean(query.followMe, 'followMe');
  const thermostat = {
    home: parseOptionalBoolean(query.thermostatHome, 'thermostatHome'),
    sleep: parseOptionalBoolean(query.thermostatSleep, 'thermostatSleep'),
    away: parseOptionalBoolean(query.thermostatAway, 'thermostatAway'),
  };
  const hasThermostat = COMFORT_SETTINGS.some((setting) => thermostat[setting] !== null);
  if (home === null && sleep === null && away === null && followMe === null && !hasThermostat) return null;
  return {
    home, sleep, away, followMe,
    ...(hasThermostat ? { thermostat } : {}),
  };
}

function configKey(days: number, config: ParticipationConfig | null): string {
  if (!config) return String(days);
  const list = (ids: string[] | null) => (ids === null ? '-' : ids.join(','));
  const thermostat = COMFORT_SETTINGS.map((setting) => String(config.thermostat?.[setting] ?? null)).join('|');
  return `${days}|${list(config.home)}|${list(config.sleep)}|${list(config.away)}|${String(config.followMe)}|${thermostat}`;
}

export interface PlacementIndoorClimate {
  cachedStatus: IndoorClimateStatus;
  refresh(): Promise<void>;
  placementDiscovery(): PlacementDiscovery;
}

export interface ClimatePlacementDeps {
  influxdb: InfluxDBClient;
  // The InfluxDB bucket Home Assistant writes its history to (INFLUXDB_BUCKET).
  bucket: string;
  indoorClimate: PlacementIndoorClimate;
  timeZone?: string;
  now?: () => Date;
}

export interface IndoorSensor {
  id: string;
  name: string;
  isThermostat: boolean;
  occupancyId?: string;
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

function knownUnit(unit: string | undefined): string | null {
  return unit === '°C' || unit === '°F' ? unit : null;
}

// Unit of an InfluxDB row: Home Assistant names measurements after the unit
// (`°C`/`°F`) unless overridden (e.g. `climate`); then only the unit recorded
// with the reading itself establishes it — the `unit_of_measurement` tag when
// it is configured as a tag (`tags_attributes`), else the
// `unit_of_measurement_str` field. The sensor's current unit says nothing
// about past readings.
export function rowUnit(row: Record<string, string>): string | null {
  /* eslint-disable-next-line no-underscore-dangle */
  const measurement = knownUnit(row._measurement);
  if (measurement) return measurement;
  if (row.unit_tag) return knownUnit(row.unit_tag);
  return knownUnit(row.unit_field);
}

// Unlike room sensors, an untagged climate attribute uses HA's last known
// climate unit as an explicitly qualified historical assumption. An explicit
// unknown/conflicting unit is never replaced with the assumption.
function reportedRowUnit(row: Record<string, string>): string | null | undefined {
  /* eslint-disable-next-line no-underscore-dangle */
  const measurement = row._measurement;
  const units = [
    measurement === '°C' || measurement === '°F' ? measurement : '',
    row.unit_tag ?? '',
    row.unit_field ?? '',
  ].filter(Boolean);
  if (units.length === 0) return undefined;
  if (units.some((unit) => knownUnit(unit) === null) || new Set(units).size !== 1) return null;
  return units[0];
}

function conflictsWithAssumption(recorded: string | null | undefined, assumed: string | null): boolean {
  return recorded === null || (recorded !== undefined && assumed !== null && recorded !== assumed);
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
// (the `unit_of_measurement` tag, or the `unit_of_measurement_str` field when
// the measurement is overridden; both kept as `unit_tag`/`unit_field` so the
// server decides), readings are averaged per series (so a unit change never
// mixes values) and
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
    unit_tag: if exists r.unit_of_measurement then r.unit_of_measurement else "",
    unit_field: if exists r.unit_of_measurement_str then r.unit_of_measurement_str else "",
  }))
  |> group(columns: ["domain", "entity_id", "_measurement", "unit_tag", "unit_field"])
  |> aggregateWindow(every: ${BUCKET_MS / 60_000}m, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_value", "_measurement", "unit_tag", "unit_field", "entity_id"])`;
}

// Query the selected climate attribute itself, not a sensor on its device.
// Restrict the range to complete, epoch-aligned source windows.
export function buildReportedTemperatureQuery(bucket: string, climate: string, start: Date, end: Date): string {
  if (!SAFE_OBJECT_ID.test(climate)) throw new Error('Unsafe entity id');
  const from = new Date(Math.ceil(start.getTime() / BUCKET_MS) * BUCKET_MS);
  const to = new Date(Math.floor(end.getTime() / BUCKET_MS) * BUCKET_MS);
  return `from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${from.toISOString()}"), stop: time(v: "${to.toISOString()}"))
  |> filter(fn: (r) => r._measurement == "climate" or r._measurement == "°C" or r._measurement == "°F")
  |> filter(fn: (r) => r.domain == "climate" and r.entity_id == "${climate}")
  |> filter(fn: (r) => r._field == "current_temperature" or r._field == "unit_of_measurement_str")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> filter(fn: (r) => exists r.current_temperature)
  |> map(fn: (r) => ({ r with
    _value: float(v: r.current_temperature),
    unit_tag: if exists r.unit_of_measurement then r.unit_of_measurement else "",
    unit_field: if exists r.unit_of_measurement_str then r.unit_of_measurement_str else "",
  }))
  |> group(columns: ["domain", "entity_id", "_measurement", "unit_tag", "unit_field"])
  |> aggregateWindow(every: ${BUCKET_MS / 60_000}m, fn: mean, createEmpty: false, timeSrc: "_start")
  |> keep(columns: ["_time", "_value", "_measurement", "unit_tag", "unit_field", "domain", "entity_id"])`;
}

function plausibleSetpoint(value: number | null): number | null {
  return value !== null && value >= MIN_PLAUSIBLE_SETPOINT_C && value <= MAX_PLAUSIBLE_SETPOINT_C ? value : null;
}

// Conventional Ecobee entity naming; not reliable evidence of a device match.
export function occupancyId(sensorId: string): string {
  return `${sensorId.replace(/(_current)?_temperature$/, '')}_occupancy`;
}

export interface StateEntities {
  // The climate entity's object id (`home`), its comfort setting select
  // (`home_current_mode`) and the occupancy binary sensors.
  climate: string;
  comfort: string;
  occupancy: string[];
}

const CLIMATE_FIELDS = [
  'state', 'hvac_action_str', 'preset_mode', 'preset_mode_str', 'temperature', 'temperature_str',
  'target_temp_low', 'target_temp_low_str', 'target_temp_high', 'target_temp_high_str', 'current_temperature_str',
  'unit_of_measurement_str',
];

function statePredicate(entities: StateEntities): string {
  // Static comparisons allow InfluxDB to push these filters into storage.
  const fields = CLIMATE_FIELDS.map((field) => `r._field == "${field}"`).join(' or ');
  const occupancy = entities.occupancy
    .filter((id) => SAFE_OBJECT_ID.test(id))
    .map((id) => `r.entity_id == "${id}"`)
    .join(' or ');
  const occupancyPredicate = occupancy
    ? `\n    or (r.domain == "binary_sensor" and (${occupancy})
      and (r._field == "value" or r._field == "state"))`
    : '';
  return `(r.domain == "climate" and r.entity_id == "${entities.climate}" and (${fields}))
    or (r.domain == "select" and r.entity_id == "${entities.comfort}" and r._field == "state")${occupancyPredicate}`;
}

// Thermostat, comfort setting and occupancy changes over [start, end), plus
// their last values before start. Prior climate mode history is included so
// outages can clear stale action, preset and set-point values.
export function buildStatesQuery(bucket: string, entities: StateEntities, start: Date, end: Date): string {
  if (!SAFE_OBJECT_ID.test(entities.climate) || !SAFE_OBJECT_ID.test(entities.comfort)) {
    throw new Error('Unsafe entity id');
  }
  const predicate = statePredicate(entities);
  const prior = new Date(start.getTime() - PRIOR_STATE_DAYS * DAY_MS);
  return `prior = from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${prior.toISOString()}"), stop: time(v: "${start.toISOString()}"))
  |> filter(fn: (r) => ${predicate})
  |> last()
priorStateHistory = from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${prior.toISOString()}"), stop: time(v: "${start.toISOString()}"))
  |> filter(fn: (r) => r.domain == "climate" and r.entity_id == "${entities.climate}" and r._field == "state")
changes = from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${start.toISOString()}"), stop: time(v: "${end.toISOString()}"))
  |> filter(fn: (r) => ${predicate})
union(tables: [prior, priorStateHistory, changes])
  |> keep(columns: ["_time", "_value", "_field", "domain", "entity_id", "_measurement", "unit_of_measurement"])`;
}

// Cooling actions and climate-mode changes in [start, end), plus recent
// prior mode changes to establish the mode at the lookback boundary.
export function buildLastCoolingQuery(bucket: string, climate: string, start: Date, end: Date): string {
  if (!SAFE_OBJECT_ID.test(climate)) throw new Error('Unsafe entity id');
  const prior = new Date(start.getTime() - PRIOR_STATE_DAYS * DAY_MS);
  return `prior = from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${prior.toISOString()}"), stop: time(v: "${start.toISOString()}"))
  |> filter(fn: (r) => r.domain == "climate" and r.entity_id == "${climate}" and r._field == "state")
changes = from(bucket: ${fluxBucketLiteral(bucket)})
  |> range(start: time(v: "${start.toISOString()}"), stop: time(v: "${end.toISOString()}"))
  |> filter(fn: (r) => r.domain == "climate" and r.entity_id == "${climate}"
    and (r._field == "state" or (r._field == "hvac_action_str" and r._value == "cooling")))
union(tables: [prior, changes])
  |> keep(columns: ["_time", "_field", "_value"])`;
}

// Most recent positively compatible cooling; undefined when a newer action's
// mode cannot be established, null when no possible cooling was reported.
function lastCompatibleCooling(rows: Record<string, string>[], start: number, end: number): number | null | undefined {
  const changes = new Map<number, { modes: Set<string>; cooling: boolean }>();
  const prior = start - PRIOR_STATE_DAYS * DAY_MS;
  let malformed = false;
  rows.forEach((row) => {
    const { _time: time, _field: field, _value: value } = row;
    const t = Date.parse(time);
    if (!Number.isFinite(t)) {
      malformed = true;
      return;
    }
    if (t < prior || t >= end) return;
    if (field !== 'state' && field !== 'hvac_action_str') {
      malformed = true;
      return;
    }
    if (field === 'hvac_action_str' && value !== 'cooling') {
      malformed = true;
      return;
    }
    if (!changes.has(t)) changes.set(t, { modes: new Set(), cooling: false });
    const change = changes.get(t)!;
    if (field === 'state') change.modes.add(typeof value === 'string' ? value.trim().toLowerCase() : '');
    else if (t >= start && value === 'cooling') change.cooling = true;
  });
  if (malformed) return undefined;
  let mode: string | null = null;
  let latest: number | null = null;
  let uncertain = false;
  [...changes.entries()].sort(([a], [b]) => a - b).forEach(([t, change]) => {
    if (change.modes.size > 0) mode = change.modes.size === 1 ? [...change.modes][0] : null;
    if (!change.cooling) return;
    if (/^(cool|heat_cool|auto)$/.test(mode ?? '')) {
      latest = t;
      uncertain = false;
    } else if (!/^(heat|off|dry|fan_only)$/.test(mode ?? '')) {
      uncertain = true;
    }
  });
  return uncertain ? undefined : latest;
}

const SETPOINT_FIELDS = ['temperature', 'target_temp_low', 'target_temp_high'];

function unknownState(value: string): boolean {
  return value === '' || value === 'unavailable' || value === 'unknown';
}

export interface ParsedStates {
  hvac: HvacSample[] | null;
  comfort: ComfortSample[] | null;
  // Occupancy per occupancy entity id.
  occupancy: Map<string, OccupancySample[]>;
  reportedInvalidations: number[];
  unitConflict: boolean;
  targetUnitAssumed: boolean;
}

// Rows from buildStatesQuery → thermostat samples (one per state change; mode,
// action and preset carry forward, set points are per change since Home
// Assistant omits empty attributes), comfort settings and occupancy.
// Unavailable or unknown thermostat states are gaps so no transition is read
// across them, and they clear the carried action, preset and set points; unavailable or unknown occupancy is kept as unknown (null) so
// the last value isn't carried across an outage.
export function parseStates(
  rows: Record<string, string>[],
  entities: StateEntities,
  unit: string | null | undefined,
): ParsedStates {
  const climate = new Map<number, Map<string, string>>();
  const comfort: ComfortSample[] = [];
  const occupancy = new Map<string, OccupancySample[]>();
  const reportedInvalidations: number[] = [];
  const assumedUnit = knownUnit(unit ?? undefined);
  let unitConflict = false;
  rows.forEach((row) => {
    /* eslint-disable no-underscore-dangle */
    const t = Date.parse(row._time);
    const field = row._field;
    const value = row._value === undefined || row._value === null ? '' : String(row._value);
    const measurement = row._measurement;
    /* eslint-enable no-underscore-dangle */
    if (!Number.isFinite(t)) return;
    if (row.domain === 'climate' && row.entity_id === entities.climate) {
      const recorded = reportedRowUnit({
        _measurement: measurement,
        unit_tag: row.unit_of_measurement ?? '',
        unit_field: field === 'unit_of_measurement_str' ? value : '',
      });
      unitConflict ||= conflictsWithAssumption(recorded, assumedUnit);
      if (field === 'unit_of_measurement_str') return;
      if (field === 'current_temperature_str') {
        reportedInvalidations.push(t);
        return;
      }
      if (!climate.has(t)) climate.set(t, new Map());
      climate.get(t)!.set(field.replace(/_str$/, ''), value);
    } else if (row.domain === 'select' && row.entity_id === entities.comfort) {
      comfort.push({ t, setting: value === 'unavailable' || value === 'unknown' || value === '' ? null : value });
    } else if (row.domain === 'binary_sensor' && entities.occupancy.includes(row.entity_id)) {
      // Home Assistant writes on/off as `value` 1/0 and anything else (e.g.
      // unavailable) as a `state` string.
      const n = Number.parseFloat(value);
      let occupied: boolean | null = null;
      if (Number.isFinite(n)) occupied = n >= 0.5;
      else if (value === 'on' || value === 'off') occupied = value === 'on';
      if (!occupancy.has(row.entity_id)) occupancy.set(row.entity_id, []);
      occupancy.get(row.entity_id)!.push({ t, occupied });
    }
  });
  let mode: string | null = null;
  let action: string | null = null;
  let preset: string | null = null;
  let setpoints = new Map<string, number | null>();
  let setpointObservedAt: number | null = null;
  const hvac = [...climate.keys()].sort((a, b) => a - b).map((t): HvacSample => {
    const fields = climate.get(t)!;
    if (fields.has('state')) {
      const nextMode = fields.get('state')!;
      // A single-temperature target observed in one mode is not evidence of
      // the target in another mode until that target is reported again.
      if (nextMode !== mode) {
        setpoints = new Map();
        setpointObservedAt = null;
      }
      mode = nextMode;
    }
    // An unknown/unavailable action isn't a reported action: no heating start
    // or satisfaction is read from (or into) it.
    if (fields.has('hvac_action')) action = unknownState(fields.get('hvac_action')!) ? null : fields.get('hvac_action')!;
    action = compatibleHvacAction(mode, action);
    if (fields.has('preset_mode')) {
      const value = fields.get('preset_mode')!;
      preset = value === 'none' || unknownState(value) ? null : value;
    }
    if (SETPOINT_FIELDS.some((f) => fields.has(f))) {
      setpoints = new Map(SETPOINT_FIELDS.map((f) => [
        f, plausibleSetpoint(toCelsius(toNumber(fields.get(f)), unitConflict ? null : unit)),
      ]));
      setpointObservedAt = t;
    }
    if (mode === null || mode === 'unavailable' || mode === 'unknown') {
      // An outage clears what was carried: after it, the action, preset and
      // set points are only what is reported again, never pre-outage values.
      action = null;
      preset = null;
      setpoints = new Map();
      setpointObservedAt = null;
      return {
        t, gap: true, hvacMode: null, hvacAction: null, presetMode: null, setpoint: null,
      };
    }
    const temperature = setpoints.get('temperature') ?? null;
    const setpoint = /^(heat_cool|auto)$/i.test(mode)
      ? setpoints.get('target_temp_low') ?? null
      : temperature ?? setpoints.get('target_temp_low') ?? null;
    return {
      t,
      gap: false,
      hvacMode: mode,
      hvacAction: action,
      presetMode: preset,
      setpoint,
      ...(setpoint !== null && setpointObservedAt !== null ? { setpointObservedAt } : {}),
      coolSetpoint: mode === 'cool' ? temperature : setpoints.get('target_temp_high') ?? null,
    };
  });
  const byTime = (a: { t: number }, b: { t: number }) => a.t - b.t;
  occupancy.forEach((samples) => samples.sort(byTime));
  return {
    hvac: hvac.length > 0 ? hvac : null,
    comfort: comfort.length > 0 ? comfort.sort(byTime) : null,
    occupancy,
    reportedInvalidations: reportedInvalidations.sort((a, b) => a - b),
    unitConflict,
    targetUnitAssumed: hvac.some((sample) => sample.setpoint !== null || (sample.coolSetpoint ?? null) !== null),
  };
}

// InfluxDB rows → per-sensor °C series, one point per 15-minute window. A
// window is kept only when it comes from a single series with a known unit.
// A window with an unknown unit, or split across series (different units, or
// measurements whose reading counts aren't known, so their means can't be
// weighted), is dropped and counted (in windows, not readings) rather than
// guessed, whatever order rows arrive in.
export function rowsToSeries(
  rows: Record<string, string>[],
  sensors: IndoorSensor[],
): { series: SensorSeriesInput[]; unknownUnitWindows: number } {
  const windows = new Map<string, Map<number, { unit: string | null; raw: number }[]>>();
  rows.forEach((row) => {
    /* eslint-disable no-underscore-dangle */
    const t = Date.parse(row._time);
    const raw = Number.parseFloat(row._value);
    /* eslint-enable no-underscore-dangle */
    if (!row.entity_id || !Number.isFinite(t) || !Number.isFinite(raw)) return;
    if (!windows.has(row.entity_id)) windows.set(row.entity_id, new Map());
    const byTime = windows.get(row.entity_id)!;
    if (!byTime.has(t)) byTime.set(t, []);
    byTime.get(t)!.push({ unit: rowUnit(row), raw });
  });
  let dropped = 0;
  const points = new Map<string, { t: number; v: number }[]>();
  windows.forEach((byTime, id) => {
    const kept: { t: number; v: number }[] = [];
    byTime.forEach((entries, t) => {
      const [{ unit, raw }] = entries;
      if (entries.length !== 1 || unit === null) {
        dropped += 1;
        return;
      }
      kept.push({ t, v: toCelsius(raw, unit)! });
    });
    points.set(id, kept.sort((a, b) => a.t - b.t));
  });
  if (dropped > 0) placementLogger.warn({ dropped }, 'Dropped temperature windows with an unknown unit or split across series');
  return {
    series: sensors.map((s) => ({
      id: s.id, name: s.name, isThermostat: s.isThermostat, points: points.get(s.id) ?? [],
    })),
    unknownUnitWindows: dropped,
  };
}

export function rowsToReportedTemperature(
  rows: Record<string, string>[], climate: string, unit: string | null | undefined, start: Date, end: Date,
): ReportedTemperatureInput {
  const entries = rows.filter((row) => row.domain === 'climate' && row.entity_id === climate);
  const assumedUnit = knownUnit(unit ?? undefined);
  // Evidence of a historical unit change makes the unit of untagged rows
  // ambiguous; do not extend today's unit over those rows.
  const conflictingHistory = entries.some((row) => conflictsWithAssumption(reportedRowUnit(row), assumedUnit));
  const windows = new Map<number, { value: number; unit: string | null; assumed: boolean }[]>();
  entries.forEach((row) => {
    /* eslint-disable no-underscore-dangle */
    const t = Date.parse(row._time);
    const value = row._value?.trim() ? Number(row._value) : NaN;
    /* eslint-enable no-underscore-dangle */
    if (!Number.isFinite(t) || t % BUCKET_MS !== 0 || t < start.getTime() || t + BUCKET_MS > end.getTime()) return;
    const recorded = reportedRowUnit(row);
    const assumed = recorded === undefined && !conflictingHistory && assumedUnit !== null;
    const actual = recorded === undefined ? (assumed ? assumedUnit : null) : recorded;
    if (!windows.has(t)) windows.set(t, []);
    windows.get(t)!.push({ value, unit: actual, assumed });
  });
  const points: SensorSeriesInput['points'] = [];
  const invalidWindows: number[] = [];
  const assumedWindows: number[] = [];
  let usedAssumption = false;
  windows.forEach((values, t) => {
    const [entry] = values;
    if (values.length !== 1 || entry.unit === null || !Number.isFinite(entry.value)) {
      invalidWindows.push(t);
      return;
    }
    points.push({ t, v: toCelsius(entry.value, entry.unit)! });
    usedAssumption ||= entry.assumed;
    if (entry.assumed) assumedWindows.push(t);
  });
  return {
    points: points.sort((a, b) => a.t - b.t),
    invalidWindows: invalidWindows.sort((a, b) => a - b),
    assumedUnit: usedAssumption,
    assumedWindows: assumedWindows.sort((a, b) => a - b),
    unitConflict: conflictingHistory,
  };
}

interface WindowData {
  series: SensorSeriesInput[];
  unknownUnitWindows: number;
  states: ParsedStates | null;
  reported: ReportedTemperatureInput | null;
  degraded: boolean;
}

export class ClimatePlacementService {
  private deps: ClimatePlacementDeps;

  private cache = new Map<string, { expires: number; result: Promise<PlacementInsights> }>();

  constructor(deps: ClimatePlacementDeps) {
    this.deps = deps;
  }

  get configured(): boolean {
    return this.deps.influxdb?.configured === true;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  public async getInsights(daysInput: unknown, query: Record<string, unknown> = {}): Promise<PlacementInsights> {
    const days = parsePlacementDays(daysInput);
    const config = parsePlacementConfig(query);
    if (!this.configured) throw namedError('PlacementUnavailableError', 'InfluxDB is not configured');
    const key = configKey(days, config);
    const now = this.now().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }
    this.cache.delete(key);
    this.cache.forEach((e, k) => {
      if (e.expires <= now) this.cache.delete(k);
    });
    while (this.cache.size >= PLACEMENT_CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    const entry = { expires: now + PLACEMENT_CACHE_TTL_MS, result: null as Promise<PlacementInsights> | null };
    const result = this.compute(days, config).then(({ insights, degraded }) => {
      if (degraded) entry.expires = Math.min(entry.expires, this.now().getTime() + PLACEMENT_DEGRADED_TTL_MS);
      return insights;
    }).catch((err) => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw err;
    });
    entry.result = result;
    this.cache.set(key, entry as { expires: number; result: Promise<PlacementInsights> });
    return result;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async compute(
    days: number,
    config: ParticipationConfig | null,
  ): Promise<{ insights: PlacementInsights; degraded: boolean }> {
    const end = this.now();
    const start = new Date(end.getTime() - days * DAY_MS);
    const { indoorClimate } = this.deps;
    // Discovery may not have run (or may have failed) yet; try once more.
    if (!indoorClimate.cachedStatus.thermostat || indoorClimate.cachedStatus.sensors.length === 0) {
      await indoorClimate.refresh().catch(() => {});
    }
    const status = indoorClimate.cachedStatus;
    const discovery = indoorClimate.placementDiscovery();
    const matchingClimate = !!status.thermostat && discovery.climateEntityId === status.thermostat.entityId;
    const incompleteSensorInventory = [...discovery.unclassifiedTemperatureIds].some((entityId) => {
      const sensor = status.sensors.find((s) => s.entityId === entityId);
      return SAFE_OBJECT_ID.test(objectId(entityId)) && !OUTDOOR_PATTERN.test(entityId)
        && (!sensor || !OUTDOOR_PATTERN.test(sensor.name));
    });
    const sensors: IndoorSensor[] = status.sensors
      .filter((s) => !discovery.unclassifiedTemperatureIds.has(s.entityId))
      .map((s) => {
        const occupancy = matchingClimate ? discovery.occupancyByTemperature.get(s.entityId) : undefined;
        const id = occupancy?.startsWith('binary_sensor.') ? objectId(occupancy) : undefined;
        return {
          id: objectId(s.entityId), name: s.name, isThermostat: s.isThermostat,
          occupancyId: id && SAFE_OBJECT_ID.test(id) ? id : undefined,
        };
      })
      .filter((s) => SAFE_OBJECT_ID.test(s.id) && !OUTDOOR_PATTERN.test(s.id) && !OUTDOOR_PATTERN.test(s.name));
    const primaryId = matchingClimate && discovery.thermostatTemperatureEntityId
      ? objectId(discovery.thermostatTemperatureEntityId) : null;
    const primaryThermostatId = sensors.some((s) => s.isThermostat && s.id === primaryId) ? primaryId : null;
    const thermostatOccupancyEntity = matchingClimate
      ? discovery.thermostatOccupancyEntityId === undefined && primaryThermostatId && discovery.thermostatTemperatureEntityId
        ? discovery.occupancyByTemperature.get(discovery.thermostatTemperatureEntityId)
        : discovery.thermostatOccupancyEntityId
      : null;
    const thermostatOccupancyId = thermostatOccupancyEntity?.startsWith('binary_sensor.')
      ? objectId(thermostatOccupancyEntity) : null;
    const physicalOccupancy = thermostatOccupancyId && SAFE_OBJECT_ID.test(thermostatOccupancyId)
      ? thermostatOccupancyId : null;
    if (config) {
      const selected = [config.home, config.sleep, config.away].flatMap((ids) => ids ?? []);
      const thermostatIds = new Set(sensors.filter((s) => s.isThermostat).map((s) => s.id));
      const thermostatMembers = selected.filter((id) => thermostatIds.has(id));
      if (thermostatMembers.length > 0) {
        throw inputError(`Thermostat-associated sensors cannot be listed as rooms: ${[...new Set(thermostatMembers)].join(', ')}. `
          + 'Use thermostatHome, thermostatSleep or thermostatAway to configure the built-in sensor.');
      }
      const rooms = sensors.filter((s) => !s.isThermostat);
      if (rooms.length > 0) {
        const known = new Set(rooms.map((s) => s.id));
        const unknown = selected.filter((id) => !known.has(id));
        if (unknown.length > 0) throw inputError(`Unknown sensor ids: ${[...new Set(unknown)].join(', ')}`);
      }
    }

    const climateId = status.thermostat ? objectId(status.thermostat.entityId) : null;
    const entities: StateEntities | null = climateId && SAFE_OBJECT_ID.test(climateId)
      ? {
        climate: climateId,
        comfort: `${climateId}_current_mode`,
        occupancy: [...new Set([...sensors.map((s) => s.occupancyId), physicalOccupancy].filter((id): id is string => !!id))],
      }
      : null;
    const unit = status.thermostat?.temperatureUnit;

    // Missing or unclassifiable discovery is retried soon.
    let degraded = sensors.every((s) => s.isThermostat) || !status.thermostat || incompleteSensorInventory;
    const reportedClimate = matchingClimate ? entities?.climate ?? null : null;
    const [heat, lastCooling] = await Promise.all([
      this.fetchWindow(sensors, entities, reportedClimate, unit, start, end),
      entities ? this.fetchLastCooling(entities.climate, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to look up the last cooling for placement insights');
        degraded = true;
        return undefined;
      }) : Promise.resolve(undefined),
    ]);
    if (heat.degraded) degraded = true;
    if (entities && lastCooling === undefined) degraded = true;

    let cooling: CoolingInput | null | undefined;
    if (lastCooling === null) cooling = null;
    else if (lastCooling !== undefined && entities) {
      if (lastCooling >= start.getTime()) {
        cooling = { start, end };
      } else {
        const coolEnd = new Date(Math.min(lastCooling + COOLING_TAIL_MS, end.getTime()));
        const coolStart = new Date(Math.max(
          coolEnd.getTime() - days * DAY_MS,
          end.getTime() - COOLING_LOOKBACK_DAYS * DAY_MS,
        ));
        const data = await this.fetchWindow(sensors, entities, reportedClimate, unit, coolStart, coolEnd);
        if (data.degraded) degraded = true;
        cooling = {
          start: coolStart, end: coolEnd, sensors: data.series, hvac: data.states?.hvac ?? null, comfort: data.states?.comfort ?? null,
          targetUnitAssumed: data.states?.targetUnitAssumed ?? false,
          thermostatOccupancy: physicalOccupancy ? data.states?.occupancy.get(physicalOccupancy) ?? null : null,
          reportedTemperature: data.reported && reportedHasUsableHistory(data.reported, data.states?.hvac ?? [])
            ? data.reported : null,
        };
      }
    }

    const { series, states } = heat;
    const hvac = states?.hvac ?? null;
    if (series.every((sensor) => sensor.points.length === 0)) degraded = true;
    const reported = heat.reported && reportedHasUsableHistory(heat.reported, hvac ?? []) ? heat.reported : null;
    const legacy = primaryThermostatId && series.some((sensor) => sensor.id === primaryThermostatId && sensor.points.length > 0);
    if (!reported && !legacy) degraded = true;

    const insights = analyzePlacement({
      start,
      end,
      windowDays: days,
      timeZone: resolveTimeZone(this.deps.timeZone),
      sensors: series,
      primaryThermostatId,
      reportedTemperature: reported,
      thermostatOccupancy: physicalOccupancy ? states?.occupancy.get(physicalOccupancy) ?? null : null,
      incompleteSensorInventory,
      hvac,
      targetUnitAssumed: states?.targetUnitAssumed ?? false,
      comfort: states?.comfort ?? null,
      participation: config,
      cooling,
      unknownUnitWindows: heat.unknownUnitWindows,
      generatedAt: end,
    });
    if (!insights.coverage.hvacHistoryAvailable) degraded = true;
    return { insights, degraded };
  }

  // Temperatures and thermostat / comfort / occupancy history over a window;
  // each source degrades independently.
  private async fetchWindow(
    sensors: IndoorSensor[],
    entities: StateEntities | null,
    reportedClimate: string | null,
    unit: string | null | undefined,
    start: Date,
    end: Date,
  ): Promise<WindowData> {
    let degraded = false;
    const [{ series, unknownUnitWindows }, states, reference] = await Promise.all([
      this.fetchSeries(sensors, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read room temperatures for placement insights');
        degraded = true;
        return {
          series: sensors.map((s) => ({
            id: s.id, name: s.name, isThermostat: s.isThermostat, points: [],
          })),
          unknownUnitWindows: 0,
        };
      }),
      entities ? this.fetchStates(entities, unit, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read thermostat history for placement insights');
        degraded = true;
        return null;
      }) : Promise.resolve(null),
      reportedClimate ? this.fetchReported(reportedClimate, unit, start, end).catch((err) => {
        placementLogger.warn({ err }, 'Failed to read the climate-reported temperature for placement insights');
        degraded = true;
        return null;
      }) : Promise.resolve(null),
    ]);
    // Either source can contradict HA's current unit. Reject assumed targets
    // and untagged references, but keep explicitly unit-tagged reference rows.
    const stateHistory = states && reference?.unitConflict ? {
      ...states,
      hvac: states.hvac?.map((sample) => ({ ...sample, setpoint: null, coolSetpoint: null })) ?? null,
      unitConflict: true,
      targetUnitAssumed: false,
    } : states;
    let reported = reference;
    if (reported?.assumedUnit && states?.unitConflict) {
      const assumed = new Set(reported.assumedWindows ?? reported.points.map((point) => point.t));
      reported = {
        ...reported,
        points: reported.points.filter((point) => !assumed.has(point.t)),
        invalidWindows: [...new Set([...(reported.invalidWindows ?? []), ...assumed])].sort((a, b) => a - b),
        assumedUnit: false,
        assumedWindows: [],
        unitConflict: true,
      };
    }
    const withOccupancy = series.map((s) => {
      const id = sensors.find((sensor) => sensor.id === s.id)?.occupancyId;
      const occupancy = id ? stateHistory?.occupancy.get(id) : undefined;
      return occupancy ? { ...s, occupancy } : s;
    });
    if (unknownUnitWindows > 0 || series.some((s) => !s.isThermostat && s.points.length === 0)) degraded = true;
    return {
      series: withOccupancy,
      unknownUnitWindows,
      states: stateHistory,
      reported: reported ? { ...reported, invalidations: stateHistory?.reportedInvalidations ?? [] } : null,
      degraded,
    };
  }

  private async fetchReported(
    climate: string, unit: string | null | undefined, start: Date, end: Date,
  ): Promise<ReportedTemperatureInput> {
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildReportedTemperatureQuery(this.deps.bucket, climate, start, end),
    );
    return rowsToReportedTemperature(rows, climate, unit, start, end);
  }

  private async fetchSeries(
    sensors: IndoorSensor[],
    start: Date,
    end: Date,
  ): Promise<{ series: SensorSeriesInput[]; unknownUnitWindows: number }> {
    if (sensors.length === 0) return { series: [], unknownUnitWindows: 0 };
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildPlacementQuery(this.deps.bucket, sensors.map((s) => s.id), start, end),
    );
    return rowsToSeries(rows, sensors);
  }

  private async fetchStates(
    entities: StateEntities,
    unit: string | null | undefined,
    start: Date,
    end: Date,
  ): Promise<ParsedStates> {
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildStatesQuery(this.deps.bucket, entities, start, end),
    );
    return parseStates(rows, entities, unit);
  }

  // Epoch ms of the last compatible cooling, null if absent, undefined if
  // the most recent candidate's mode cannot be established.
  private async fetchLastCooling(climate: string, end: Date): Promise<number | null | undefined> {
    const start = new Date(end.getTime() - COOLING_LOOKBACK_DAYS * DAY_MS);
    const rows: Record<string, string>[] = await this.deps.influxdb.query(
      buildLastCoolingQuery(this.deps.bucket, climate, start, end),
    );
    return lastCompatibleCooling(rows, start.getTime(), end.getTime());
  }
}
