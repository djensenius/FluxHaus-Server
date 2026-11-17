import { HomeAssistantClient } from './homeassistant-client';
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

// A control request that failed in a known way, with the HTTP status and a
// plain-text reason: 400 for invalid input, 409 when there is no usable
// thermostat, 503 when its state couldn't be read so nothing was sent, 502
// when a change was sent but its result couldn't be read, and 504 when the
// service call timed out and may still have been applied. Anything else thrown
// by a control method is a Home Assistant failure of the service call.
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

function near(actual: number | null, expected: number): boolean {
  return actual !== null && Math.abs(actual - expected) < SETPOINT_TOLERANCE;
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
    return this.exclusive(async () => {
      const { entity, thermostat } = await this.controllable();
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
          (updated) => near(updated.targetTemperature, temperature),
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
        (updated) => near(updated.targetTemperatureLow, targetTempLow)
          && near(updated.targetTemperatureHigh, targetTempHigh),
      );
    });
  }

  public setHvacMode(mode: string): Promise<ThermostatControlResult> {
    return this.exclusive(async () => {
      const { entity, thermostat } = await this.controllable();
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
    });
  }

  public setPresetMode(preset: string): Promise<ThermostatControlResult> {
    return this.exclusive(async () => {
      const { entity, thermostat } = await this.controllable();
      requireSupported(preset, thermostat.presetModes, 'preset mode');
      return this.callControl(
        entity,
        ['climate', 'set_preset_mode', { entity_id: thermostat.entityId, preset_mode: preset }],
        (updated) => updated.presetMode === preset,
      );
    });
  }

  public setFanMode(mode: string): Promise<ThermostatControlResult> {
    return this.exclusive(async () => {
      const { entity, thermostat } = await this.controllable();
      requireSupported(mode, thermostat.fanModes, 'fan mode');
      return this.callControl(
        entity,
        ['climate', 'set_fan_mode', { entity_id: thermostat.entityId, fan_mode: mode }],
        (updated) => updated.fanMode === mode,
      );
    });
  }

  // Cancels the active hold (or every hold with resumeAll) so the Ecobee
  // schedule takes over again. The resulting comfort setting depends on the
  // schedule, so any successful read afterwards counts as confirmed.
  public resumeProgram(resumeAll = false): Promise<ThermostatControlResult> {
    return this.exclusive(async () => {
      const entity = await this.thermostatEntity();
      // The selector may be a config-entry title, so check the thermostat's own
      // integration. If HA didn't report it, the selector must be the domain.
      if ((entity.platform ?? this.integration) !== 'ecobee') {
        throw new ThermostatControlError(400, 'Resume program is not supported by this integration');
      }
      const thermostat = await this.freshThermostat(entity);
      return this.callControl(
        entity,
        ['ecobee', 'resume_program', { entity_id: thermostat.entityId, resume_all: resumeAll }],
        () => true,
      );
    });
  }

  // A fresh read of the thermostat for reporting, or null if it can't be read.
  public async currentThermostat(): Promise<ThermostatStatus | null> {
    const entityId = this.cachedStatus.thermostat?.entityId;
    const entity = this.discovered.find((candidate) => candidate.entityId === entityId);
    if (!entity) return null;
    const thermostat = await this.readThermostat(entity);
    return thermostat?.available ? thermostat : null;
  }

  private exclusive<T>(control: () => Promise<T>): Promise<T> {
    const result = this.controlQueue.then(control);
    this.controlQueue = result.catch(() => {});
    return result;
  }

  private async controllable(): Promise<{ entity: DiscoveredEntity; thermostat: ThermostatStatus }> {
    const entity = await this.thermostatEntity();
    return { entity, thermostat: await this.freshThermostat(entity) };
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
  ): Promise<ThermostatControlResult> {
    try {
      await withTimeout(
        (signal) => this.client.callService(domain, service, serviceData, { signal }),
        this.controlTimeout,
        `${domain}.${service}`,
      );
    } catch (err) {
      if (!(err instanceof TimeoutError)) throw err;
      // Aborting frees the connection, but HA may already have accepted the change.
      indoorClimateLogger.warn({ domain, service }, 'Thermostat control timed out');
      throw new ThermostatControlError(
        504,
        'Thermostat did not respond in time; the change may still be applied, so check its state before retrying',
      );
    }

    // HA can acknowledge a service call before the thermostat reports the
    // change, so read it (only the thermostat) until it does or we give up.
    let thermostat: ThermostatStatus | null = null;
    for (let attempt = 0; attempt < this.confirmAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (attempt > 0) await sleep(this.confirmDelay);
      // eslint-disable-next-line no-await-in-loop
      const read = await this.readThermostat(entity);
      if (read?.available) thermostat = read;
      if (thermostat && applied(thermostat)) break;
    }
    if (!thermostat) {
      indoorClimateLogger.error({ domain, service }, 'Thermostat state could not be read after a control');
      throw new ThermostatControlError(502, 'Thermostat change was sent but its new state could not be read');
    }
    const confirmed = applied(thermostat);
    if (!confirmed) {
      indoorClimateLogger.warn({ domain, service }, 'Thermostat has not reported a control yet');
    }
    // A poll already in flight may have read the thermostat before this
    // change; let it finish so it can't overwrite the newer read below.
    if (this.inFlight) await this.inFlight;
    this.cachedStatus = { ...this.cachedStatus, timestamp: new Date(), thermostat };
    this.onStatusChange?.(this.cachedStatus);
    return { ...this.cachedStatus, confirmed };
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
      const primaryReading = (deviceClass: string): number | null => {
        if (!primaryDeviceId) return null;
        const match = entries.find(({ entity, state }) => (
          entity.deviceId === primaryDeviceId
          && entity.entityId.startsWith('sensor.')
          && state?.attributes?.device_class === deviceClass
          && numericState(state) !== null
        ));
        return numericState(match?.state);
      };

      this.knownTemperatureIds = new Set(sensors.map((sensor) => sensor.entityId));
      this.cachedStatus = {
        timestamp: new Date(),
        thermostat: climate
          ? toThermostat(climate.entity, climate.state, {
            temperature: primaryReading('temperature'),
            humidity: primaryReading('humidity'),
          }, this.temperatureUnit)
          : null,
        sensors,
        unit: sensors.find((sensor) => sensor.unit !== null)?.unit ?? this.temperatureUnit,
      };
      this.onStatusChange?.(this.cachedStatus);
    } catch (err) {
      indoorClimateLogger.error({ err }, 'Failed to update indoor climate status');
    }
  }
}
