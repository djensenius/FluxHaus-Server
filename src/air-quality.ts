import { HomeAssistantClient } from './homeassistant-client';
import { writePoint } from './influx';
import logger from './logger';

const aqLogger = logger.child({ subsystem: 'air-quality' });

// InfluxDB entity ids / friendly names for the two AQHI series. Both are
// written under measurement "state" / field "value" so the existing
// `outdoor_air_quality` and `aqhi` metrics pick them up (see metrics.ts).
export const ECCC_INFLUX_ENTITY_ID = 'patio_environment_canada_aqhi';
export const ECCC_INFLUX_FRIENDLY_NAME = 'Environment Canada AQHI';
export const OPEN_METEO_INFLUX_ENTITY_ID = 'aqhi_open_meteo';
export const OPEN_METEO_INFLUX_FRIENDLY_NAME = 'Open-Meteo';

// Default Kitchener, ON coordinates (matches the app's fallback location and
// the AirVisual/Environment Canada sensors already configured in HA).
const DEFAULT_LATITUDE = 43.4468;
const DEFAULT_LONGITUDE = -80.4906;

const OPEN_METEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// Abort the Open-Meteo request if it hangs, so overlapping 10-minute collects
// can't accumulate in-flight fetches.
const OPEN_METEO_TIMEOUT_MS = 10_000;

// Molar-volume conversion (µg/m³ -> ppb) at 25 °C, 1013 hPa: ppb = µg/m³ × 24.45 / MW.
const MOLAR_VOLUME = 24.45;
const MW_O3 = 48.0;
const MW_NO2 = 46.01;

export function ozoneUgm3ToPpb(ugm3: number): number {
  return (ugm3 * MOLAR_VOLUME) / MW_O3;
}

export function no2Ugm3ToPpb(ugm3: number): number {
  return (ugm3 * MOLAR_VOLUME) / MW_NO2;
}

// Ensure the configured ECCC sensor id includes a Home Assistant domain;
// `/api/states/<id>` requires a `<domain>.<object_id>` entity id.
function normalizeEntityId(entityId?: string): string {
  const trimmed = entityId?.trim();
  if (!trimmed) return `sensor.${ECCC_INFLUX_ENTITY_ID}`;
  return trimmed.includes('.') ? trimmed : `sensor.${trimmed}`;
}

/**
 * Environment Canada's Air Quality Health Index formula. Ozone and NO₂ are the
 * 3-hour average concentrations in ppb; PM2.5 is the 3-hour average in µg/m³.
 * The result is rounded to the nearest integer with a floor of 1, matching how
 * Environment Canada publishes the index.
 */
export function computeAqhi(o3Ppb: number, no2Ppb: number, pm25Ugm3: number): number {
  const raw = (1000 / 10.4) * (
    (Math.exp(0.000537 * o3Ppb) - 1)
    + (Math.exp(0.000871 * no2Ppb) - 1)
    + (Math.exp(0.000487 * pm25Ugm3) - 1)
  );
  return Math.max(1, Math.round(raw));
}

interface OpenMeteoHourly {
  time: string[];
  pm2_5: (number | null)[];
  nitrogen_dioxide: (number | null)[];
  ozone: (number | null)[];
}

/**
 * Average up to the three most recent hourly samples (at or before "now") for a
 * pollutant, skipping gaps. Returns null when no usable sample exists.
 */
function trailingAverage(values: (number | null)[], endIndex: number): number | null {
  const samples: number[] = [];
  for (let i = endIndex; i >= 0 && samples.length < 3; i -= 1) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) samples.push(value);
  }
  if (samples.length === 0) return null;
  return samples.reduce((sum, v) => sum + v, 0) / samples.length;
}

export interface AirQualityConfig {
  client: HomeAssistantClient;
  latitude?: number;
  longitude?: number;
  ecccEntityId?: string;
  pollInterval?: number;
  fetchFn?: typeof fetch;
}

export default class AirQuality {
  private client: HomeAssistantClient;

  private latitude: number;

  private longitude: number;

  private ecccEntityId: string;

  private fetchFn: typeof fetch;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AirQualityConfig) {
    this.client = config.client;
    this.latitude = Number.isFinite(config.latitude) ? (config.latitude as number) : DEFAULT_LATITUDE;
    this.longitude = Number.isFinite(config.longitude) ? (config.longitude as number) : DEFAULT_LONGITUDE;
    this.ecccEntityId = normalizeEntityId(config.ecccEntityId);
    this.fetchFn = config.fetchFn ?? fetch;
    this.startPolling(config.pollInterval ?? 1000 * 60 * 10);
  }

  private startPolling(interval: number) {
    this.collect().catch(() => {});
    this.timer = setInterval(() => {
      this.collect().catch(() => {});
    }, interval);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Fetch, compute, and persist both AQHI series. Public for testing. */
  public async collect(): Promise<void> {
    await Promise.all([this.collectOpenMeteo(), this.collectEnvironmentCanada()]);
  }

  private async collectOpenMeteo(): Promise<void> {
    try {
      const aqhi = await this.fetchOpenMeteoAqhi();
      if (aqhi === null) return;
      writePoint(
        'state',
        { value: aqhi },
        { entity_id: OPEN_METEO_INFLUX_ENTITY_ID, friendly_name: OPEN_METEO_INFLUX_FRIENDLY_NAME },
      );
      aqLogger.debug({ aqhi }, 'Wrote Open-Meteo AQHI');
    } catch (err) {
      aqLogger.error({ err }, 'Failed to collect Open-Meteo AQHI');
    }
  }

  private async collectEnvironmentCanada(): Promise<void> {
    try {
      const state = await this.client.getState(this.ecccEntityId);
      const value = parseFloat(state?.state);
      if (!Number.isFinite(value)) return;
      writePoint(
        'state',
        { value },
        { entity_id: ECCC_INFLUX_ENTITY_ID, friendly_name: ECCC_INFLUX_FRIENDLY_NAME },
      );
      aqLogger.debug({ value }, 'Wrote Environment Canada AQHI');
    } catch (err) {
      aqLogger.error({ err }, 'Failed to collect Environment Canada AQHI');
    }
  }

  /** Compute AQHI from the latest Open-Meteo pollutant data. Public for testing. */
  public async fetchOpenMeteoAqhi(): Promise<number | null> {
    const params = new URLSearchParams({
      latitude: String(this.latitude),
      longitude: String(this.longitude),
      hourly: 'pm2_5,nitrogen_dioxide,ozone',
      past_days: '1',
      forecast_days: '1',
      timezone: 'GMT',
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPEN_METEO_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${OPEN_METEO_URL}?${params.toString()}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      aqLogger.warn({ status: response.status }, 'Open-Meteo air-quality request failed');
      return null;
    }
    const body = await response.json() as { hourly?: OpenMeteoHourly };
    const { hourly } = body;
    if (!hourly?.time?.length) return null;

    // Find the most recent hour at or before now. Open-Meteo returns forecast
    // hours too, so bail out rather than computing AQHI from future samples.
    const now = Date.now();
    let endIndex = -1;
    for (let i = 0; i < hourly.time.length; i += 1) {
      if (new Date(`${hourly.time[i]}Z`).getTime() <= now) endIndex = i;
      else break;
    }
    if (endIndex < 0) return null;

    const pm25 = trailingAverage(hourly.pm2_5, endIndex);
    const no2 = trailingAverage(hourly.nitrogen_dioxide, endIndex);
    const o3 = trailingAverage(hourly.ozone, endIndex);
    if (pm25 === null || no2 === null || o3 === null) return null;

    return computeAqhi(ozoneUgm3ToPpb(o3), no2Ugm3ToPpb(no2), pm25);
  }
}
