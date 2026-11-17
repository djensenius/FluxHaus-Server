import { HomeAssistantClient } from './homeassistant-client';
import logger from './logger';

const indoorClimateLogger = logger.child({ subsystem: 'indoor-climate' });

const SAFE_NAME = /^[a-z0-9_]+$/;
const SUPPORTED_ENTITY = /^(sensor|binary_sensor|climate)\.[a-z0-9_]+$/;
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);
// Used to validate set_hvac_mode when the thermostat doesn't report hvac_modes.
const DEFAULT_HVAC_MODES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'];

// A control request the thermostat can't accept: 400 for invalid input, 409
// when there is no usable thermostat. Anything else thrown by a control method
// is a Home Assistant failure or timeout.
export class ThermostatControlError extends Error {
  public readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
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
}

export interface IndoorClimateStatus {
  timestamp: Date;
  thermostat: ThermostatStatus | null;
  sensors: IndoorTemperatureSensor[];
  unit: string | null;
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
}

interface DiscoveredEntity {
  entityId: string;
  deviceId: string | null;
  deviceName: string | null;
  area: string | null;
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

// Bounds a single Home Assistant request so one hung call cannot stall polling
// or a thermostat control request. Deliberately local to this module: other HA
// calls (e.g. car commands) can legitimately take much longer.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

function discoveryTemplate(integration: string): string {
  return `[{%- for entity_id in integration_entities('${integration}') -%}
{{ {'entity_id': entity_id, 'device_id': device_id(entity_id), 'device_name': device_attr(entity_id, 'name_by_user') or device_attr(entity_id, 'name'), 'area': area_name(entity_id)} | tojson }}{{ ',' if not loop.last else '' }}
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
    this.integrationValid = SAFE_NAME.test(this.integration);
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

  public async setTemperature(request: ThermostatTemperatureRequest): Promise<IndoorClimateStatus> {
    const thermostat = await this.controllableThermostat();
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
      return this.callControl('climate', 'set_temperature', { entity_id: thermostat.entityId, temperature });
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
    return this.callControl('climate', 'set_temperature', {
      entity_id: thermostat.entityId,
      target_temp_low: targetTempLow,
      target_temp_high: targetTempHigh,
    });
  }

  public async setHvacMode(mode: string): Promise<IndoorClimateStatus> {
    const thermostat = await this.controllableThermostat();
    requireSupported(
      mode,
      thermostat.hvacModes.length > 0 ? thermostat.hvacModes : DEFAULT_HVAC_MODES,
      'HVAC mode',
    );
    return this.callControl('climate', 'set_hvac_mode', { entity_id: thermostat.entityId, hvac_mode: mode });
  }

  public async setPresetMode(preset: string): Promise<IndoorClimateStatus> {
    const thermostat = await this.controllableThermostat();
    requireSupported(preset, thermostat.presetModes, 'preset mode');
    return this.callControl('climate', 'set_preset_mode', { entity_id: thermostat.entityId, preset_mode: preset });
  }

  public async setFanMode(mode: string): Promise<IndoorClimateStatus> {
    const thermostat = await this.controllableThermostat();
    requireSupported(mode, thermostat.fanModes, 'fan mode');
    return this.callControl('climate', 'set_fan_mode', { entity_id: thermostat.entityId, fan_mode: mode });
  }

  // Cancels the active hold (or every hold with resumeAll) so the Ecobee
  // schedule takes over again.
  public async resumeProgram(resumeAll = false): Promise<IndoorClimateStatus> {
    if (this.integration !== 'ecobee') {
      throw new ThermostatControlError(400, 'Resume program is not supported by this integration');
    }
    const thermostat = await this.controllableThermostat();
    return this.callControl('ecobee', 'resume_program', {
      entity_id: thermostat.entityId,
      resume_all: resumeAll,
    });
  }

  private async controllableThermostat(): Promise<ThermostatStatus> {
    // Before the first successful poll (e.g. right after startup) try once
    // rather than rejecting a thermostat we simply haven't seen yet.
    if (!this.cachedStatus.thermostat) await this.refresh();
    const { thermostat } = this.cachedStatus;
    if (!thermostat) throw new ThermostatControlError(409, 'No thermostat discovered');
    if (!thermostat.available) throw new ThermostatControlError(409, 'Thermostat unavailable');
    return thermostat;
  }

  private async callControl(
    domain: string,
    service: string,
    serviceData: Record<string, unknown>,
  ): Promise<IndoorClimateStatus> {
    await withTimeout(
      this.client.callService(domain, service, serviceData),
      this.controlTimeout,
      `${domain}.${service}`,
    );
    // A poll already in flight may have read the state before this change, so
    // let it finish and then poll again for the updated thermostat.
    if (this.inFlight) await this.inFlight;
    await this.refresh();
    return this.cachedStatus;
  }

  private async discover(): Promise<void> {
    const due = this.discovered.length === 0
      || Date.now() - this.lastDiscoveryAttempt >= this.discoveryInterval;
    if (!due) return;
    this.lastDiscoveryAttempt = Date.now();
    try {
      const raw = await withTimeout(
        this.client.renderTemplate(discoveryTemplate(this.integration)),
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
          this.client.getState(entity.entityId),
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
          })
          : null,
        sensors,
        unit: sensors.find((sensor) => sensor.unit !== null)?.unit ?? null,
      };
      this.onStatusChange?.(this.cachedStatus);
    } catch (err) {
      indoorClimateLogger.error({ err }, 'Failed to update indoor climate status');
    }
  }
}
