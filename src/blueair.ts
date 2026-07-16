import { HomeAssistantClient } from './homeassistant-client';
import logger from './logger';

const blueairLogger = logger.child({ subsystem: 'blueair' });

export interface BlueairStatus {
  timestamp: Date;
  online: boolean;
  fanOn: boolean;
  fanSpeed: number | null;
  presetMode: string | null;
  presetModes: string[];
  lightOn: boolean;
  brightness: number | null;
  pm25: number | null;
  filterLife: number | null;
}

export interface BlueairConfig {
  client: HomeAssistantClient;
  fanEntityId?: string;
  lightEntityId?: string;
  pm25EntityId?: string;
  filterEntityId?: string;
  onlineEntityId?: string;
  pollInterval?: number;
}

const EMPTY_STATUS: BlueairStatus = {
  timestamp: new Date(0),
  online: false,
  fanOn: false,
  fanSpeed: null,
  presetMode: null,
  presetModes: [],
  lightOn: false,
  brightness: null,
  pm25: null,
  filterLife: null,
};

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Home Assistant reports light brightness on a 0-255 scale; convert it to a
// 0-100 percentage so it matches the brightness_pct value the API accepts.
function brightnessToPercent(value: unknown): number | null {
  const raw = toNumber(value);
  if (raw === null) return null;
  return Math.round((Math.max(0, Math.min(255, raw)) / 255) * 100);
}

export default class Blueair {
  public cachedStatus: BlueairStatus = EMPTY_STATUS;

  public onStatusChange?: (status: BlueairStatus) => void;

  private client: HomeAssistantClient;

  private fanEntityId: string;

  private lightEntityId: string;

  private pm25EntityId: string;

  private filterEntityId: string;

  private onlineEntityId: string;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: BlueairConfig) {
    this.client = config.client;
    this.fanEntityId = config.fanEntityId || 'fan.blue_pure_fan';
    this.lightEntityId = config.lightEntityId || 'light.blue_pure_led_light';
    this.pm25EntityId = config.pm25EntityId || 'sensor.blue_pure_pm_2_5';
    this.filterEntityId = config.filterEntityId || 'sensor.blue_pure_filter_life';
    this.onlineEntityId = config.onlineEntityId || 'binary_sensor.blue_pure_online';
    this.startPolling(config.pollInterval ?? 1000 * 60);
  }

  private startPolling(interval: number) {
    this.updateStatus().catch(() => {});
    this.timer = setInterval(() => {
      this.updateStatus().catch(() => {});
    }, interval);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async updateStatus() {
    try {
      const [fan, light, pm25, filter, online] = await Promise.all([
        this.client.getState(this.fanEntityId).catch(() => null),
        this.client.getState(this.lightEntityId).catch(() => null),
        this.client.getState(this.pm25EntityId).catch(() => null),
        this.client.getState(this.filterEntityId).catch(() => null),
        this.client.getState(this.onlineEntityId).catch(() => null),
      ]);

      const pm25Value = pm25 ? toNumber(pm25.state) : null;
      const filterValue = filter ? toNumber(filter.state) : null;

      this.cachedStatus = {
        timestamp: new Date(),
        online: online ? online.state === 'on' : false,
        fanOn: fan ? fan.state === 'on' : false,
        fanSpeed: fan ? toNumber(fan.attributes?.percentage) : null,
        presetMode: toStringOrNull(fan?.attributes?.preset_mode),
        presetModes: toStringArray(fan?.attributes?.preset_modes),
        lightOn: light ? light.state === 'on' : false,
        brightness: light ? brightnessToPercent(light.attributes?.brightness) : null,
        pm25: pm25Value,
        filterLife: filterValue,
      };

      this.onStatusChange?.(this.cachedStatus);
    } catch (err) {
      blueairLogger.error({ err }, 'Failed to update Blueair status');
    }
  }

  public async setFan(on: boolean): Promise<string> {
    await this.client.callService('fan', on ? 'turn_on' : 'turn_off', {
      entity_id: this.fanEntityId,
    });
    await this.updateStatus();
    return on ? 'Fan on' : 'Fan off';
  }

  public async setSpeed(percentage: number): Promise<string> {
    const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
    await this.client.callService('fan', 'set_percentage', {
      entity_id: this.fanEntityId,
      percentage: clamped,
    });
    await this.updateStatus();
    return `Fan speed ${clamped}%`;
  }

  public async setPreset(mode: string): Promise<string> {
    const allowed = this.cachedStatus.presetModes.length > 0
      ? this.cachedStatus.presetModes
      : ['auto', 'night', 'manual'];
    if (!allowed.includes(mode)) {
      const error = new Error(`Invalid preset mode: ${mode}`);
      error.name = 'InvalidPresetError';
      throw error;
    }
    await this.client.callService('fan', 'set_preset_mode', {
      entity_id: this.fanEntityId,
      preset_mode: mode,
    });
    await this.updateStatus();
    return `Preset ${mode}`;
  }

  public async setLight(on: boolean): Promise<string> {
    await this.client.callService('light', on ? 'turn_on' : 'turn_off', {
      entity_id: this.lightEntityId,
    });
    await this.updateStatus();
    return on ? 'Light on' : 'Light off';
  }

  public async setBrightness(percentage: number): Promise<string> {
    const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
    await this.client.callService('light', 'turn_on', {
      entity_id: this.lightEntityId,
      brightness_pct: clamped,
    });
    await this.updateStatus();
    return `Brightness ${clamped}%`;
  }
}
