import { HomeAssistantClient } from './homeassistant-client';
import { writePoint } from './influx';
import logger from './logger';

const environmentLogger = logger.child({ subsystem: 'environment' });

export interface EnvironmentSensor {
  entityId: string;
  room: string;
  metric: string;
}

export interface EnvironmentReading {
  room: string;
  metric: string;
  value: number;
  timestamp: string;
}

export interface EnvironmentConfig {
  client: HomeAssistantClient;
  sensors?: EnvironmentSensor[];
  pollInterval?: number;
}

const DEFAULT_SENSORS: EnvironmentSensor[] = [
  { entityId: 'sensor.bedroom_temperature', room: 'Bedroom', metric: 'temperature' },
  { entityId: 'sensor.living_room_temperature', room: 'Living Room', metric: 'temperature' },
  { entityId: 'sensor.kitchen_temperature', room: 'Kitchen', metric: 'temperature' },
  { entityId: 'sensor.home_current_temperature', room: 'Thermostat', metric: 'temperature' },
  { entityId: 'sensor.home_current_humidity', room: 'Thermostat', metric: 'humidity' },
];

function parseSensorsFromEnv(): EnvironmentSensor[] | null {
  const raw = process.env.ENVIRONMENT_SENSORS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => s.entityId && s.room && s.metric)) {
      return parsed as EnvironmentSensor[];
    }
    environmentLogger.warn('ENVIRONMENT_SENSORS is not a valid sensor array — using defaults');
  } catch (err) {
    environmentLogger.warn({ err }, 'Failed to parse ENVIRONMENT_SENSORS — using defaults');
  }
  return null;
}

export default class Environment {
  public readings: EnvironmentReading[] = [];

  private client: HomeAssistantClient;

  private sensors: EnvironmentSensor[];

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: EnvironmentConfig) {
    this.client = config.client;
    this.sensors = config.sensors ?? parseSensorsFromEnv() ?? DEFAULT_SENSORS;
    this.startPolling(config.pollInterval ?? 1000 * 60 * 5);
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

  private async collect() {
    const results = await Promise.all(
      this.sensors.map(async (sensor) => {
        try {
          const state = await this.client.getState(sensor.entityId);
          const value = parseFloat(state?.state);
          if (!Number.isFinite(value)) return null;
          writePoint('environment', { [sensor.metric]: value }, { room: sensor.room });
          return {
            room: sensor.room,
            metric: sensor.metric,
            value,
            timestamp: new Date().toISOString(),
          } as EnvironmentReading;
        } catch (err) {
          environmentLogger.debug({ err, entityId: sensor.entityId }, 'Sensor read failed');
          return null;
        }
      }),
    );

    this.readings = results.filter((r): r is EnvironmentReading => r !== null);
    environmentLogger.debug({ count: this.readings.length }, 'Collected environment readings');
  }
}
