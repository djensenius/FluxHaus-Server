import { HomeAssistantClient, HomeAssistantRequestError } from './homeassistant-client';
import logger from './logger';

const indoorClimateLogger = logger.child({ subsystem: 'indoor-climate' });

const SAFE_NAME = /^[a-z0-9_]+$/;
// The integration setting may be a config-entry title (e.g. "Ecobee Upstairs"),
// so it is not limited to entity-id characters; discoveryTemplate() embeds it
// as an escaped string literal instead.
const MAX_INTEGRATION_LENGTH = 100;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SUPPORTED_ENTITY = /^(sensor|binary_sensor|climate)\.[a-z0-9_]+$/;
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);
// Used to validate set_hvac_mode when the thermostat doesn't report hvac_modes.
const DEFAULT_HVAC_MODES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

// Ecobee stores set points in tenths of a °F, so a °C set point can come back
// slightly off; anything closer than this counts as the requested value.
const SETPOINT_TOLERANCE = 0.25;
// The Ecobee preset reported while a temperature (not comfort setting) hold is active.
const TEMPERATURE_HOLD_PRESET = 'temp';

// A control request that failed in a known way, with the HTTP status and a
// plain-text reason: 400 for invalid input; 409 when there is no usable
// thermostat, or an earlier change that may still be on its way hasn't taken
// effect yet; 503 when its state couldn't be read so nothing was sent; 502 when
// a change was sent but its result couldn't be read, or the call failed in a
// way that may still have applied it; and 504 when the service call timed out
// and may still have been applied. Anything else thrown by a control method is
// Home Assistant refusing the service call, so nothing was changed.
export type ThermostatControlStatus = 400 | 409 | 502 | 503 | 504;

export class ThermostatControlError extends Error {
  public readonly status: ThermostatControlStatus;

  constructor(status: ThermostatControlStatus, message: string) {
    super(message);
    this.name = 'ThermostatControlError';
    this.status = status;
  }
}

export interface ThermostatTemperatureRequest {
  // Single set point (any mode except heat_cool).
  temperature?: number;
  // Heat/cool set points (heat_cool mode only); both are required together.
  targetTempLow?: number;
  targetTempHigh?: number;
}

export interface IndoorTemperatureSensor {
  entityId: string;
  name: string;
  area: string | null;
  temperature: number | null;
  unit: string | null;
  available: boolean;
  occupied: boolean | null;
  isThermostat: boolean;
  lastUpdated: string | null;
}

export interface ThermostatStatus {
  entityId: string;
  name: string;
  area: string | null;
  available: boolean;
  currentTemperature: number | null;
  currentHumidity: number | null;
  hvacMode: string | null;
  hvacAction: string | null;
  targetTemperature: number | null;
  targetTemperatureLow: number | null;
  targetTemperatureHigh: number | null;
  presetMode: string | null;
  hvacModes: string[];
  presetModes: string[];
  fanMode: string | null;
  fanModes: string[];
  minTemp: number | null;
  maxTemp: number | null;
  targetTempStep: number | null;
  // Home Assistant's temperature unit, used by every climate attribute and
  // service call (set points, limits, step); null until it has been read.
  temperatureUnit: string | null;
}

export interface IndoorClimateStatus {
  timestamp: Date;
  thermostat: ThermostatStatus | null;
  sensors: IndoorTemperatureSensor[];
  unit: string | null;
}

// Returned by thermostat controls. `confirmed` is false when Home Assistant
// accepted the change but the thermostat had not reported it by the last read,
// so the snapshot may still show the previous values.
export interface ThermostatControlResult extends IndoorClimateStatus {
  confirmed: boolean;
}

// The thermostat controls, as run by IndoorClimate.withControls().
export interface ThermostatControls {
  setTemperature(request: ThermostatTemperatureRequest): Promise<ThermostatControlResult>;
  setHvacMode(mode: string): Promise<ThermostatControlResult>;
  setPresetMode(preset: string): Promise<ThermostatControlResult>;
  setFanMode(mode: string): Promise<ThermostatControlResult>;
  resumeProgram(resumeAll?: boolean): Promise<ThermostatControlResult>;
  // Whether the thermostat has since reported a change that `result` returned
  // unconfirmed (e.g. seen while a later control waited for it).
  wasReported(result: ThermostatControlResult): boolean;
}

// Service domains that can change a thermostat; raw calls to them take their
// turn with the thermostat controls (see IndoorClimate.runServiceCall).
const THERMOSTAT_SERVICE_DOMAINS = new Set(['climate', 'ecobee']);

export interface IndoorClimateConfig {
  client: HomeAssistantClient;
  integration?: string;
  pollInterval?: number;
  discoveryInterval?: number;
  // Per-request timeout for Home Assistant calls made by this poller.
  requestTimeout?: number;
  // Timeout for thermostat control service calls (Ecobee cloud calls are slow).
  controlTimeout?: number;
  // Reads of the thermostat after a control, and the pause between them, while
  // waiting for it to report the change.
  confirmAttempts?: number;
  confirmDelay?: number;
  // How long a change whose outcome is uncertain holds back other kinds of
  // control while the thermostat hasn't reported it.
  settleTimeout?: number;
}

interface DiscoveredEntity {
  entityId: string;
  deviceId: string | null;
  deviceName: string | null;
  area: string | null;
  // Integration domain of the entity's config entry (e.g. "ecobee"); null when
  // Home Assistant can't say (no config entry, or HA older than 2024.7).
  platform: string | null;
}

// A control that may still take effect: it timed out, its outcome was lost, or
// the thermostat hadn't reported it by the last read.
interface UnsettledControl {
  entityId: string;
  service: string;
  applied: (thermostat: ThermostatStatus) => boolean;
  since: number;
}

// A thermostat read, numbered in the order reads were started so a newer poll
// result is never replaced by an older control read.
interface ThermostatRead {
  thermostat: ThermostatStatus;
  readSeq: number;
}

interface HaState {
  state?: unknown;
  attributes?: Record<string, unknown>;
  last_updated?: unknown;
  last_changed?: unknown;
}

function emptyStatus(): IndoorClimateStatus {
  return {
    timestamp: new Date(0), thermostat: null, sensors: [], unit: null,
  };
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Whether the thermostat reports the requested set point. The tolerance absorbs
// Ecobee's rounding, but shrinks for a small change so the previous value can
// never pass for the new one (e.g. 21.0 still reported after asking for 21.2).
function reports(actual: number | null, expected: number, previous: number | null): boolean {
  if (actual === null) return false;
  const tolerance = previous === null || previous === expected
    ? SETPOINT_TOLERANCE
    : Math.min(SETPOINT_TOLERANCE, Math.abs(expected - previous) / 2);
  return Math.abs(actual - expected) < tolerance;
}

// Converts between °C and °F (to 0.1°). Returns null when it can't be
// converted, including when either unit is unknown: a unitless reading could
// be on any scale.
function convertTemperature(value: number | null, from: string | null, to: string | null): number | null {
  if (value === null || !from || !to) return null;
  if (from === to) return value;
  if (from === '°F' && to === '°C') return Math.round(((value - 32) * 50) / 9) / 10;
  if (from === '°C' && to === '°F') return Math.round(((value * 9) / 5 + 32) * 10) / 10;
  return null;
}

// Bounds a single Home Assistant request so one hung call cannot stall polling
// or a thermostat control request. At the deadline the request is also aborted,
// so a stuck call does not keep a connection open. Deliberately local to this
// module: other HA calls (e.g. car commands) can legitimately take much longer.
function withTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(`${label} timed out after ${ms}ms`);
      // Reject first so the timeout error, not the abort, settles the race.
      reject(error);
      controller.abort(error);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([request(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isAvailable(state: HaState | null | undefined): state is HaState {
  return !!state && typeof state.state === 'string' && !UNAVAILABLE_STATES.has(state.state);
}

function numericState(state: HaState | null | undefined): number | null {
  return isAvailable(state) ? toNumber(state.state) : null;
}

function objectId(entityId: string): string {
  return entityId.slice(entityId.indexOf('.') + 1);
}

function titleCase(value: string): string {
  return value.split('_').filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function stripTemperatureSuffix(name: string): string {
  const stripped = name.replace(/\s+(current\s+)?temperature$/i, '').trim();
  return stripped || name;
}

function isValidIntegration(integration: string): boolean {
  return integration.trim() !== ''
    && integration.length <= MAX_INTEGRATION_LENGTH
    && !CONTROL_CHARACTER.test(integration);
}

// JSON.stringify yields a double-quoted literal with every `"` and `\` escaped,
// which Jinja reads as one string token, so Jinja delimiters in the value stay
// inert text. Control characters are rejected earlier by isValidIntegration().
// `platform` uses config_entry_id (HA 2022.11+) and config_entry_attr (HA
// 2024.7+); config_entry_attr raises for a missing entry id, hence the guards.
function discoveryTemplate(integration: string): string {
  return `[{%- for entity_id in integration_entities(${JSON.stringify(integration)}) -%}
{%- set entry_id = config_entry_id(entity_id) if config_entry_attr is defined else none -%}
{{ {'entity_id': entity_id, 'device_id': device_id(entity_id), 'device_name': device_attr(entity_id, 'name_by_user') or device_attr(entity_id, 'name'), 'area': area_name(entity_id), 'platform': config_entry_attr(entry_id, 'domain') if entry_id else none} | tojson }}{{ ',' if not loop.last else '' }}
{%- endfor -%}]`;
}

function parseDiscovery(raw: string): DiscoveredEntity[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Discovery template did not return an array');
  }
  const entities: DiscoveredEntity[] = [];
  parsed.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    if (typeof record.entity_id !== 'string' || !SUPPORTED_ENTITY.test(record.entity_id)) return;
    entities.push({
      entityId: record.entity_id,
      deviceId: toStringOrNull(record.device_id),
      deviceName: toStringOrNull(record.device_name)?.trim() ?? null,
      area: toStringOrNull(record.area)?.trim() ?? null,
      platform: toStringOrNull(record.platform),
    });
  });
  return entities;
}

function toSensor(
  entity: DiscoveredEntity,
  state: HaState | null,
  previous: IndoorTemperatureSensor | undefined,
  extra: { occupied: boolean | null; isThermostat: boolean },
): IndoorTemperatureSensor {
  const attributes = state?.attributes ?? {};
  const temperature = numericState(state);
  const friendlyName = toStringOrNull(attributes.friendly_name)?.trim();
  const name = entity.deviceName
    || (friendlyName ? stripTemperatureSuffix(friendlyName) : null)
    || previous?.name
    || stripTemperatureSuffix(titleCase(objectId(entity.entityId)));
  return {
    entityId: entity.entityId,
    name,
    area: entity.area,
    temperature,
    unit: toStringOrNull(attributes.unit_of_measurement) ?? previous?.unit ?? null,
    available: temperature !== null,
    occupied: extra.occupied,
    isThermostat: extra.isThermostat,
    lastUpdated: toStringOrNull(state?.last_updated) ?? toStringOrNull(state?.last_changed),
  };
}

function toThermostat(
  entity: DiscoveredEntity,
  state: HaState | null,
  fallback: { temperature: number | null; humidity: number | null },
  temperatureUnit: string | null,
): ThermostatStatus {
  const attributes = state?.attributes ?? {};
  const available = isAvailable(state);
  return {
    entityId: entity.entityId,
    name: toStringOrNull(attributes.friendly_name)?.trim() || titleCase(objectId(entity.entityId)),
    area: entity.area,
    available,
    currentTemperature: toNumber(attributes.current_temperature ?? fallback.temperature),
    currentHumidity: toNumber(attributes.current_humidity ?? fallback.humidity),
    hvacMode: available ? toStringOrNull(state.state) : null,
    hvacAction: toStringOrNull(attributes.hvac_action),
    targetTemperature: toNumber(attributes.temperature),
    targetTemperatureLow: toNumber(attributes.target_temp_low),
    targetTemperatureHigh: toNumber(attributes.target_temp_high),
    presetMode: toStringOrNull(attributes.preset_mode),
    hvacModes: toStringArray(attributes.hvac_modes),
    presetModes: toStringArray(attributes.preset_modes),
    fanMode: toStringOrNull(attributes.fan_mode),
    fanModes: toStringArray(attributes.fan_modes),
    minTemp: toNumber(attributes.min_temp),
    maxTemp: toNumber(attributes.max_temp),
    targetTempStep: toNumber(attributes.target_temp_step),
    temperatureUnit,
  };
}

// Error messages never echo the requested value: routes send them as text.
function requireSupported(value: string, supported: string[], label: string): void {
  if (supported.length === 0) {
    throw new ThermostatControlError(400, `Thermostat does not report any ${label}s`);
  }
  if (!supported.includes(value)) {
    throw new ThermostatControlError(400, `Unsupported ${label} (supported: ${supported.join(', ')})`);
  }
}

function checkRange(value: number, thermostat: ThermostatStatus, label: string): void {
  const { minTemp, maxTemp } = thermostat;
  if ((minTemp !== null && value < minTemp) || (maxTemp !== null && value > maxTemp)) {
    let range = `between ${minTemp} and ${maxTemp}`;
    if (maxTemp === null) range = `at least ${minTemp}`;
    else if (minTemp === null) range = `at most ${maxTemp}`;
    throw new ThermostatControlError(400, `${label} must be ${range}`);
  }
}

export default class IndoorClimate {
  public cachedStatus: IndoorClimateStatus = emptyStatus();

  public onStatusChange?: (status: IndoorClimateStatus) => void;

  private client: HomeAssistantClient;

  private integration: string;

  private integrationValid: boolean;

  private discoveryInterval: number;

  private requestTimeout: number;

  private controlTimeout: number;

  private confirmAttempts: number;

  private confirmDelay: number;

  private settleTimeout: number;

  private unsettled: UnsettledControl | null = null;

  // Unsettled changes the thermostat has since reported, and the change each
  // unconfirmed result left behind, so withControls can tell which steps landed.
  private reportedChanges = new WeakSet<UnsettledControl>();

  private resultChanges = new WeakMap<ThermostatControlResult, UnsettledControl>();

  // The thermostat a withControls operation acts on, pinned by its first control.
  private batch: { entityId: string | null } | null = null;

  private readSequence = 0;

  // readSeq of the read behind cachedStatus.thermostat.
  private thermostatReadSeq = 0;

  // From Home Assistant's config; refreshed with discovery.
  private temperatureUnit: string | null = null;

  // Controls run one at a time so one request's read, checks, change and
  // confirmation can't be invalidated by another (app or MCP) in between.
  private controlQueue: Promise<unknown> = Promise.resolve();

  private discovered: DiscoveredEntity[] = [];

  private lastDiscoveryAttempt = 0;

  private discoveryFailing = false;

  private knownTemperatureIds = new Set<string>();

  private inFlight: Promise<void> | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: IndoorClimateConfig) {
    this.client = config.client;
    this.integration = config.integration ?? 'ecobee';
    this.discoveryInterval = config.discoveryInterval ?? 10 * 60_000;
    this.requestTimeout = config.requestTimeout ?? 15_000;
    this.controlTimeout = config.controlTimeout ?? 30_000;
    this.confirmAttempts = Math.max(1, config.confirmAttempts ?? 4);
    this.confirmDelay = config.confirmDelay ?? 1_500;
    this.settleTimeout = config.settleTimeout ?? 60_000;
    this.integrationValid = isValidIntegration(this.integration);
    if (!this.integrationValid) {
      indoorClimateLogger.error(
        { integration: this.integration },
        'Invalid indoor climate integration name; indoor climate disabled',
      );
      return;
    }
    this.startPolling(config.pollInterval ?? 60_000);
  }

  private startPolling(interval: number) {
    this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, interval);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Runs one poll. Concurrent callers share the in-flight poll.
  public refresh(): Promise<void> {
    if (!this.integrationValid) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.updateStatus().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  // Object ids (without the `sensor.` prefix) of the current temperature
  // sensors, matching how Home Assistant's InfluxDB integration tags entity_id.
  public temperatureObjectIds(): string[] {
    return this.cachedStatus.sensors
      .map((sensor) => objectId(sensor.entityId))
      .filter((id) => SAFE_NAME.test(id));
  }

  public setTemperature(request: ThermostatTemperatureRequest): Promise<ThermostatControlResult> {
    return this.exclusive(() => this.applyTemperature(request));
  }

  public setHvacMode(mode: string): Promise<ThermostatControlResult> {
    return this.exclusive(() => this.applyHvacMode(mode));
  }

  public setPresetMode(preset: string): Promise<ThermostatControlResult> {
    return this.exclusive(() => this.applyPresetMode(preset));
  }

  public setFanMode(mode: string): Promise<ThermostatControlResult> {
    return this.exclusive(() => this.applyFanMode(mode));
  }

  // Cancels the active hold (or every hold with resumeAll) so the Ecobee
  // schedule takes over again.
  public resumeProgram(resumeAll = false): Promise<ThermostatControlResult> {
    return this.exclusive(() => this.applyResume(resumeAll));
  }

  // Runs several controls as one operation, so no other control (app or MCP)
  // can change the thermostat between them, and all of them act on the same
  // thermostat. Use only the `controls` passed in: this instance's own control
  // methods would wait for `run` to finish, and the passed controls stop
  // working once it has.
  public withControls<T>(run: (controls: ThermostatControls) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      let open = true;
      const batch: { entityId: string | null } = { entityId: null };
      this.batch = batch;
      const guarded = <A extends unknown[]>(
        control: (...args: A) => Promise<ThermostatControlResult>,
      ) => (...args: A): Promise<ThermostatControlResult> => (
        open ? control(...args) : Promise.reject(new Error('Thermostat controls used after withControls finished'))
      );
      try {
        return await run({
          setTemperature: guarded((request: ThermostatTemperatureRequest) => this.applyTemperature(request)),
          setHvacMode: guarded((mode: string) => this.applyHvacMode(mode)),
          setPresetMode: guarded((preset: string) => this.applyPresetMode(preset)),
          setFanMode: guarded((mode: string) => this.applyFanMode(mode)),
          resumeProgram: guarded((resumeAll?: boolean) => this.applyResume(resumeAll ?? false)),
          wasReported: (result: ThermostatControlResult) => {
            const change = this.resultChanges.get(result);
            return change !== undefined && this.reportedChanges.has(change);
          },
        });
      } finally {
        open = false;
        if (this.batch === batch) this.batch = null;
      }
    });
  }

  // Runs a raw Home Assistant service call (e.g. the call_ha_service tools).
  // One that can change a thermostat takes its turn with the thermostat
  // controls, so it can't land between the steps of a withControls operation.
  public runServiceCall<T>(domain: string, call: () => Promise<T>): Promise<T> {
    return THERMOSTAT_SERVICE_DOMAINS.has(domain) ? this.exclusive(call) : call();
  }

  // A fresh read of the thermostat for reporting, or null if it can't be read.
  public async currentThermostat(): Promise<ThermostatStatus | null> {
    const entityId = this.cachedStatus.thermostat?.entityId;
    const entity = this.discovered.find((candidate) => candidate.entityId === entityId);
    if (!entity) return null;
    const thermostat = await this.readThermostat(entity);
    return thermostat?.available ? thermostat : null;
  }

  private async applyTemperature(request: ThermostatTemperatureRequest): Promise<ThermostatControlResult> {
    const { entity, thermostat } = await this.controllable('set_temperature');
    const { temperature, targetTempLow, targetTempHigh } = request;
    if (temperature !== undefined) {
      if (targetTempLow !== undefined || targetTempHigh !== undefined) {
        throw new ThermostatControlError(400, 'Provide either temperature or targetTempLow and targetTempHigh');
      }
      if (!Number.isFinite(temperature)) {
        throw new ThermostatControlError(400, 'temperature must be a finite number');
      }
      if (thermostat.hvacMode === 'heat_cool') {
        throw new ThermostatControlError(
          400,
          'Thermostat is in heat_cool mode; set targetTempLow and targetTempHigh instead',
        );
      }
      checkRange(temperature, thermostat, 'temperature');
      return this.callControl(
        entity,
        ['climate', 'set_temperature', { entity_id: thermostat.entityId, temperature }],
        (updated) => reports(updated.targetTemperature, temperature, thermostat.targetTemperature),
      );
    }
    if (targetTempLow === undefined || targetTempHigh === undefined) {
      throw new ThermostatControlError(400, 'temperature, or targetTempLow and targetTempHigh, are required');
    }
    if (!Number.isFinite(targetTempLow) || !Number.isFinite(targetTempHigh)) {
      throw new ThermostatControlError(400, 'targetTempLow and targetTempHigh must be finite numbers');
    }
    if (thermostat.hvacMode !== 'heat_cool') {
      throw new ThermostatControlError(400, 'targetTempLow and targetTempHigh require heat_cool mode');
    }
    if (targetTempLow >= targetTempHigh) {
      throw new ThermostatControlError(400, 'targetTempLow must be lower than targetTempHigh');
    }
    checkRange(targetTempLow, thermostat, 'targetTempLow');
    checkRange(targetTempHigh, thermostat, 'targetTempHigh');
    return this.callControl(
      entity,
      ['climate', 'set_temperature', {
        entity_id: thermostat.entityId,
        target_temp_low: targetTempLow,
        target_temp_high: targetTempHigh,
      }],
      (updated) => reports(updated.targetTemperatureLow, targetTempLow, thermostat.targetTemperatureLow)
        && reports(updated.targetTemperatureHigh, targetTempHigh, thermostat.targetTemperatureHigh),
    );
  }

  private async applyHvacMode(mode: string): Promise<ThermostatControlResult> {
    const { entity, thermostat } = await this.controllable('set_hvac_mode');
    requireSupported(
      mode,
      thermostat.hvacModes.length > 0 ? thermostat.hvacModes : DEFAULT_HVAC_MODES,
      'HVAC mode',
    );
    return this.callControl(
      entity,
      ['climate', 'set_hvac_mode', { entity_id: thermostat.entityId, hvac_mode: mode }],
      (updated) => updated.hvacMode === mode,
    );
  }

  private async applyPresetMode(preset: string): Promise<ThermostatControlResult> {
    const { entity, thermostat } = await this.controllable('set_preset_mode');
    requireSupported(preset, thermostat.presetModes, 'preset mode');
    return this.callControl(
      entity,
      ['climate', 'set_preset_mode', { entity_id: thermostat.entityId, preset_mode: preset }],
      (updated) => updated.presetMode === preset,
    );
  }

  private async applyFanMode(mode: string): Promise<ThermostatControlResult> {
    const { entity, thermostat } = await this.controllable('set_fan_mode');
    requireSupported(mode, thermostat.fanModes, 'fan mode');
    return this.callControl(
      entity,
      ['climate', 'set_fan_mode', { entity_id: thermostat.entityId, fan_mode: mode }],
      (updated) => updated.fanMode === mode,
    );
  }

  private async applyResume(resumeAll: boolean): Promise<ThermostatControlResult> {
    const entity = await this.thermostatEntity();
    // The selector may be a config-entry title, so check the thermostat's own
    // integration. If HA didn't report it, the selector must be the domain.
    if ((entity.platform ?? this.integration) !== 'ecobee') {
      throw new ThermostatControlError(400, 'Resume program is not supported by this integration');
    }
    const thermostat = await this.settle(entity, 'resume_program', await this.freshThermostat(entity));
    // Ecobee reports "temp" during a temperature hold, the held comfort setting
    // during a comfort hold, and the scheduled one otherwise. Only a different,
    // non-hold preset proves a hold ended; resuming when the schedule matches
    // the hold (or there was none) changes nothing visible, so it is reported
    // unconfirmed but doesn't hold back later controls.
    return this.callControl(
      entity,
      ['ecobee', 'resume_program', { entity_id: thermostat.entityId, resume_all: resumeAll }],
      (updated) => updated.presetMode !== null
        && updated.presetMode !== TEMPERATURE_HOLD_PRESET
        && updated.presetMode !== thermostat.presetMode,
      { holdUnconfirmed: false },
    );
  }

  private exclusive<T>(control: () => Promise<T>): Promise<T> {
    const result = this.controlQueue.then(control);
    this.controlQueue = result.catch(() => {});
    return result;
  }

  private async controllable(service: string): Promise<{ entity: DiscoveredEntity; thermostat: ThermostatStatus }> {
    const entity = await this.thermostatEntity();
    return { entity, thermostat: await this.settle(entity, service, await this.freshThermostat(entity)) };
  }

  // A change that may still be on its way could land after the next control
  // and undo or invalidate it, e.g. a mode change arriving after a set point
  // chosen for the new mode. Until the thermostat reports it (or it expires),
  // only a control of the same kind may run; it replaces the pending change
  // only once Home Assistant accepts it (see callControl). Returns the latest
  // read of the thermostat to validate against.
  private async settle(
    entity: DiscoveredEntity,
    service: string,
    thermostat: ThermostatStatus,
  ): Promise<ThermostatStatus> {
    const pending = this.unsettled;
    if (!pending || pending.service === service) return thermostat;
    if (pending.entityId !== entity.entityId || Date.now() - pending.since >= this.settleTimeout) {
      this.unsettled = null;
      return thermostat;
    }
    if (pending.applied(thermostat)) {
      this.markReported(pending);
      return thermostat;
    }
    const read = await this.readUntil(entity, pending.applied, true);
    if (read && pending.applied(read.thermostat)) {
      this.markReported(pending);
      return read.thermostat;
    }
    throw new ThermostatControlError(409, 'The previous thermostat change has not taken effect yet; try again shortly');
  }

  private markReported(change: UnsettledControl) {
    this.reportedChanges.add(change);
    if (this.unsettled === change) this.unsettled = null;
  }

  // The discovered climate entity behind the reported thermostat.
  private async thermostatEntity(): Promise<DiscoveredEntity> {
    if (this.inFlight) await this.inFlight;
    // Before the first successful poll (e.g. right after startup) try once
    // rather than rejecting a thermostat we simply haven't seen yet.
    if (!this.cachedStatus.thermostat) await this.refresh();
    const entityId = this.cachedStatus.thermostat?.entityId;
    const entity = this.discovered.find((candidate) => candidate.entityId === entityId);
    if (!entity) throw new ThermostatControlError(409, 'No thermostat discovered');
    if (this.batch) {
      this.batch.entityId ??= entity.entityId;
      if (this.batch.entityId !== entity.entityId) {
        throw new ThermostatControlError(
          409,
          'A different thermostat was selected during this operation; this change was not sent',
        );
      }
    }
    return entity;
  }

  // Reads only the thermostat (no sensor poll), or null if the read fails.
  private async readThermostat(entity: DiscoveredEntity): Promise<ThermostatStatus | null> {
    let state: HaState | null;
    try {
      state = await withTimeout(
        (signal) => this.client.getState(entity.entityId, { signal }),
        this.requestTimeout,
        entity.entityId,
      );
    } catch (err) {
      indoorClimateLogger.warn({ err, entityId: entity.entityId }, 'Could not read the thermostat');
      return null;
    }
    const cached = this.cachedStatus.thermostat;
    return toThermostat(entity, state, {
      temperature: cached?.currentTemperature ?? null,
      humidity: cached?.currentHumidity ?? null,
    }, this.temperatureUnit);
  }

  // HA can acknowledge a service call before the thermostat reports the
  // change, so read it (only the thermostat) until it does or we give up.
  // Returns the last available read, or null if none succeeded.
  private async readUntil(
    entity: DiscoveredEntity,
    applied: (thermostat: ThermostatStatus) => boolean,
    delayFirst = false,
  ): Promise<ThermostatRead | null> {
    let latest: ThermostatRead | null = null;
    for (let attempt = 0; attempt < this.confirmAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (attempt > 0 || delayFirst) await sleep(this.confirmDelay);
      this.readSequence += 1;
      const readSeq = this.readSequence;
      // eslint-disable-next-line no-await-in-loop
      const thermostat = await this.readThermostat(entity);
      if (thermostat?.available) latest = { thermostat, readSeq };
      if (latest && applied(latest.thermostat)) break;
    }
    return latest;
  }

  // Reads the thermostat right before a control so validation uses its current
  // mode and limits, not a snapshot up to a poll interval old.
  private async freshThermostat(entity: DiscoveredEntity): Promise<ThermostatStatus> {
    const thermostat = await this.readThermostat(entity);
    if (!thermostat) {
      throw new ThermostatControlError(503, 'Could not read the thermostat state; no change was sent');
    }
    if (!thermostat.available) throw new ThermostatControlError(409, 'Thermostat unavailable');
    return thermostat;
  }

  private async callControl(
    entity: DiscoveredEntity,
    [domain, service, serviceData]: [string, string, Record<string, unknown>],
    applied: (thermostat: ThermostatStatus) => boolean,
    { holdUnconfirmed = true }: { holdUnconfirmed?: boolean } = {},
  ): Promise<ThermostatControlResult> {
    // Replaces any pending change of the same kind (see settle), but only once
    // Home Assistant may have accepted this one.
    const change: UnsettledControl = {
      entityId: entity.entityId, service, applied, since: Date.now(),
    };
    const hold = () => { this.unsettled = change; };
    try {
      await withTimeout(
        (signal) => this.client.callService(domain, service, serviceData, { signal }),
        this.controlTimeout,
        `${domain}.${service}`,
      );
    } catch (err) {
      // Home Assistant answered and refused the call, so nothing changed.
      if (err instanceof HomeAssistantRequestError && err.status < 500) throw err;
      // Otherwise (a timeout, a dropped connection, an unreadable response or a
      // gateway error) HA may already have accepted the change.
      hold();
      if (err instanceof TimeoutError) {
        // Aborting frees the connection, but HA may already have accepted the change.
        indoorClimateLogger.warn({ domain, service }, 'Thermostat control timed out');
        throw new ThermostatControlError(
          504,
          'Thermostat did not respond in time; the change may still be applied, so check its state before retrying',
        );
      }
      indoorClimateLogger.warn({ err, domain, service }, 'Thermostat control outcome unknown');
      throw new ThermostatControlError(
        502,
        'Could not tell whether the thermostat received the change; it may still be applied, '
        + 'so check its state before retrying',
      );
    }

    const read = await this.readUntil(entity, applied);
    if (!read) {
      hold();
      indoorClimateLogger.error({ domain, service }, 'Thermostat state could not be read after a control');
      throw new ThermostatControlError(502, 'Thermostat change was sent but its new state could not be read');
    }
    // A poll already in flight may have read the thermostat before this change;
    // let it finish, then keep whichever read is newer. A poll that picked a
    // different thermostat (or none) is kept too, so later controls follow it.
    if (this.inFlight) await this.inFlight;
    const latest = this.cachedStatus.thermostat;
    let reported: ThermostatStatus | null = read.thermostat;
    if (this.thermostatReadSeq > read.readSeq || (latest && latest.entityId !== entity.entityId)) {
      reported = latest?.entityId === entity.entityId ? latest : null;
    } else {
      this.thermostatReadSeq = read.readSeq;
      this.cachedStatus = { ...this.cachedStatus, timestamp: new Date(), thermostat: read.thermostat };
      this.onStatusChange?.(this.cachedStatus);
    }
    // Confirmed only by the snapshot returned, which must still be this thermostat.
    const confirmed = reported !== null && reported.available && applied(reported);
    this.unsettled = !confirmed && holdUnconfirmed ? change : null;
    const result = { ...this.cachedStatus, confirmed };
    if (!confirmed) {
      indoorClimateLogger.warn({ domain, service }, 'Thermostat has not reported a control yet');
      if (holdUnconfirmed) this.resultChanges.set(result, change);
    }
    return result;
  }

  private async discover(): Promise<void> {
    const due = this.discovered.length === 0
      || Date.now() - this.lastDiscoveryAttempt >= this.discoveryInterval;
    // Neither rejects; the unit is retried every poll until it has been read.
    await Promise.all([
      due ? this.discoverEntities() : Promise.resolve(),
      due || this.temperatureUnit === null ? this.loadTemperatureUnit() : Promise.resolve(),
    ]);
  }

  private async loadTemperatureUnit(): Promise<void> {
    try {
      const config = await withTimeout(
        (signal) => this.client.getConfig({ signal }),
        this.requestTimeout,
        'Home Assistant config',
      );
      this.temperatureUnit = toStringOrNull(config?.unit_system?.temperature) ?? this.temperatureUnit;
    } catch (err) {
      indoorClimateLogger.debug({ err }, 'Could not read the Home Assistant temperature unit');
    }
  }

  private async discoverEntities(): Promise<void> {
    this.lastDiscoveryAttempt = Date.now();
    try {
      const raw = await withTimeout(
        (signal) => this.client.renderTemplate(discoveryTemplate(this.integration), { signal }),
        this.requestTimeout,
        'Discovery template',
      );
      const entities = parseDiscovery(raw);
      // An empty result is usually transient (e.g. Home Assistant still
      // starting), so never let it wipe a working entity list.
      if (entities.length === 0) {
        throw new Error('Discovery returned no supported entities');
      }
      this.discovered = entities;
      if (this.discoveryFailing) {
        indoorClimateLogger.info({ count: entities.length }, 'Indoor climate discovery recovered');
      }
      this.discoveryFailing = false;
    } catch (err) {
      // Warn on the first failure only; repeats are logged at debug to avoid
      // flooding the log while Home Assistant is unreachable.
      const level = this.discoveryFailing ? 'debug' : 'warn';
      indoorClimateLogger[level](
        { err, integration: this.integration },
        'Indoor climate discovery failed; keeping previously discovered entities',
      );
      this.discoveryFailing = true;
    }
  }

  private async updateStatus(): Promise<void> {
    try {
      await this.discover();
      const entities = this.discovered;
      if (entities.length === 0) return;

      this.readSequence += 1;
      const readSeq = this.readSequence;
      const states: (HaState | null)[] = await Promise.all(
        entities.map((entity) => withTimeout(
          (signal) => this.client.getState(entity.entityId, { signal }),
          this.requestTimeout,
          entity.entityId,
        ).catch(() => null)),
      );
      const entries = entities.map((entity, index) => ({ entity, state: states[index] ?? null }));

      const occupancyByDevice = new Map<string, boolean | null>();
      entries.forEach(({ entity, state }) => {
        if (!entity.entityId.startsWith('binary_sensor.') || !entity.deviceId) return;
        if (state?.attributes?.device_class !== 'occupancy') return;
        if (occupancyByDevice.has(entity.deviceId)) return;
        let occupied: boolean | null = null;
        if (state.state === 'on') occupied = true;
        else if (state.state === 'off') occupied = false;
        occupancyByDevice.set(entity.deviceId, occupied);
      });

      const climates = entries
        .filter(({ entity }) => entity.entityId.startsWith('climate.'))
        .sort((a, b) => a.entity.entityId.localeCompare(b.entity.entityId));
      const climate = climates[0];
      const climateDeviceIds = new Set(climates
        .map(({ entity }) => entity.deviceId)
        .filter((id): id is string => !!id));

      const previous = new Map(this.cachedStatus.sensors.map((sensor) => [sensor.entityId, sensor]));
      const sensors: IndoorTemperatureSensor[] = [];
      entries.forEach(({ entity, state }) => {
        if (!entity.entityId.startsWith('sensor.')) return;
        const isTemperature = state?.attributes?.device_class === 'temperature';
        const knownUnavailable = !isAvailable(state) && this.knownTemperatureIds.has(entity.entityId);
        if (!isTemperature && !knownUnavailable) return;
        sensors.push(toSensor(entity, state, previous.get(entity.entityId), {
          occupied: entity.deviceId ? occupancyByDevice.get(entity.deviceId) ?? null : null,
          isThermostat: !!entity.deviceId && climateDeviceIds.has(entity.deviceId),
        }));
      });
      sensors.sort((a, b) => {
        if (a.isThermostat !== b.isThermostat) return a.isThermostat ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // Readings from sensors on the primary thermostat's own device, used when
      // the climate entity omits current_temperature / current_humidity.
      const primaryDeviceId = climate?.entity.deviceId ?? null;
      const primaryState = (deviceClass: string): HaState | null => {
        if (!primaryDeviceId) return null;
        const match = entries.find(({ entity, state }) => (
          entity.deviceId === primaryDeviceId
          && entity.entityId.startsWith('sensor.')
          && state?.attributes?.device_class === deviceClass
          && numericState(state) !== null
        ));
        return match?.state ?? null;
      };
      // The sensor's own unit can differ from the one HA uses for the climate
      // entity, so convert it (or drop it if it can't be converted).
      const temperatureState = primaryState('temperature');
      const fallbackTemperature = convertTemperature(
        numericState(temperatureState),
        toStringOrNull(temperatureState?.attributes?.unit_of_measurement),
        this.temperatureUnit,
      );

      const thermostat = climate
        ? toThermostat(climate.entity, climate.state, {
          temperature: fallbackTemperature,
          humidity: numericState(primaryState('humidity')),
        }, this.temperatureUnit)
        : null;
      if (thermostat?.available && this.unsettled?.entityId === thermostat.entityId
        && this.unsettled.applied(thermostat)) {
        this.markReported(this.unsettled);
      }

      this.knownTemperatureIds = new Set(sensors.map((sensor) => sensor.entityId));
      this.thermostatReadSeq = readSeq;
      this.cachedStatus = {
        timestamp: new Date(),
        thermostat,
        sensors,
        unit: sensors.find((sensor) => sensor.unit !== null)?.unit ?? this.temperatureUnit,
      };
      this.onStatusChange?.(this.cachedStatus);
    } catch (err) {
      indoorClimateLogger.error({ err }, 'Failed to update indoor climate status');
    }
  }
}
