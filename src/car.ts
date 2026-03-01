import fs from 'fs';
import { HomeAssistantClient } from './homeassistant-client';

export interface Doors {
  frontRight: number;
  frontLeft: number;
  backRight: number;
  backLeft: number;
}

export interface Atc {
  value: number;
  unit: number;
}

export interface RangeByFuel {
  gasModeRange: Atc;
  evModeRange: Atc;
  totalAvailableRange: Atc;
}

export interface DriveDistance {
  rangeByFuel: RangeByFuel;
  type: number;
}

export interface EVStatus {
  timestamp: string;
  batteryCharge: boolean;
  batteryStatus: number;
  batteryPlugin: number;
  drvDistance: DriveDistance[];
}

export interface CarStatus {
  timestamp: Date;
  lastStatusDate: string;
  airCtrlOn: boolean;
  doorLock: boolean;
  doorOpen: Doors;
  trunkOpen: boolean;
  defrost: boolean;
  hoodOpen: boolean;
  engine: boolean;
  evStatus: EVStatus;
}

export interface CarStartOptions {
  temperature?: number;
  heatedFeatures?: boolean;
  defrost?: boolean;
  seatClimateSettings?: {
    driverSeat?: number;
    passengerSeat?: number;
    rearLeftSeat?: number;
    rearRightSeat?: number;
  };
}

export interface CarConfig {
  client: HomeAssistantClient;
  entityPrefix: string;
  pollInterval?: number;
}

function dateToCompactString(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export default class Car {
  status?: CarStatus;

  odometer: number;

  private client: HomeAssistantClient;

  private entityPrefix: string;

  constructor(carConfig: CarConfig) {
    this.client = carConfig.client;
    this.entityPrefix = carConfig.entityPrefix;
    this.odometer = 0;

    this.loadCachedStatus();
    setInterval(() => {
      this.setStatus();
    }, carConfig.pollInterval ?? 1000 * 60 * 5);
  }

  private loadCachedStatus() {
    try {
      if (fs.existsSync('cache/carStatus.json')) {
        const cached = JSON.parse(fs.readFileSync('cache/carStatus.json', 'utf8'));
        cached.timestamp = new Date(cached.timestamp);
        this.status = cached;
        this.odometer = cached.odometer ?? this.odometer;
      }
    } catch {
      // Ignore corrupt cache
    }
  }

  private saveStatusToCache() {
    try {
      fs.writeFileSync(
        'cache/carStatus.json',
        JSON.stringify({ ...this.status, odometer: this.odometer }, null, 2),
      );
    } catch {
      // Ignore write errors
    }
  }

  private async getEntityState(entityId: string): Promise<string> {
    const state = await this.client.getState(entityId);
    return state.state;
  }

  // eslint-disable-next-line class-methods-use-this
  private isStatusValid(
    batteryLevel: string,
    evRange: string,
    totalRange: string,
    lastUpdated: string,
  ): boolean {
    const battery = parseInt(batteryLevel, 10);
    const ev = parseInt(evRange, 10);
    const total = parseInt(totalRange, 10);
    if (Number.isNaN(battery) && Number.isNaN(ev) && Number.isNaN(total)) return false;
    if (battery === 0 && ev === 0 && total === 0) return false;
    const allUnavailable = [batteryLevel, evRange, totalRange, lastUpdated]
      .every((v) => v === 'unavailable' || v === 'unknown');
    return !allUnavailable;
  }

  setStatus = async () => {
    try {
      const prefix = this.entityPrefix;

      const [
        batteryLevel,
        charging,
        pluggedIn,
        evRange,
        totalRange,
        airConditioner,
        doorLock,
        doorFrontLeft,
        doorFrontRight,
        doorRearLeft,
        doorRearRight,
        trunk,
        hood,
        defrost,
        engine,
        odometerState,
        lastUpdatedEntity,
      ] = await Promise.all([
        this.getEntityState(`sensor.${prefix}_ev_battery_level`),
        this.getEntityState(`binary_sensor.${prefix}_ev_battery_charge`),
        this.getEntityState(`binary_sensor.${prefix}_ev_battery_plug`),
        this.getEntityState(`sensor.${prefix}_ev_range`),
        this.getEntityState(`sensor.${prefix}_total_driving_range`),
        this.getEntityState(`binary_sensor.${prefix}_air_conditioner`),
        this.getEntityState(`lock.${prefix}_door_lock`),
        this.getEntityState(`binary_sensor.${prefix}_front_left_door`),
        this.getEntityState(`binary_sensor.${prefix}_front_right_door`),
        this.getEntityState(`binary_sensor.${prefix}_back_left_door`),
        this.getEntityState(`binary_sensor.${prefix}_back_right_door`),
        this.getEntityState(`binary_sensor.${prefix}_trunk`),
        this.getEntityState(`binary_sensor.${prefix}_hood`),
        this.getEntityState(`binary_sensor.${prefix}_defrost`),
        this.getEntityState(`binary_sensor.${prefix}_engine`),
        this.getEntityState(`sensor.${prefix}_odometer`),
        this.client.getState(`sensor.${prefix}_last_updated_at`),
      ]);

      const lastUpdated = lastUpdatedEntity.last_changed || lastUpdatedEntity.state;

      if (!this.isStatusValid(batteryLevel, evRange, totalRange, lastUpdated)) {
        // eslint-disable-next-line no-console
        console.log('Car status returned all zeros/unavailable, keeping last good status');
        return;
      }

      const timestamp = lastUpdated !== 'unavailable' ? new Date(lastUpdated) : new Date();
      const evModeRange = parseInt(evRange, 10) || 0;
      const totalAvailableRange = parseInt(totalRange, 10) || 0;

      const evStatus: EVStatus = {
        timestamp: timestamp.toISOString(),
        batteryCharge: charging === 'on',
        batteryStatus: parseInt(batteryLevel, 10) || 0,
        batteryPlugin: pluggedIn === 'on' ? 1 : 0,
        drvDistance: [{
          rangeByFuel: {
            gasModeRange: { value: 0, unit: 1 },
            evModeRange: { value: evModeRange, unit: evModeRange > 0 ? 1 : 0 },
            totalAvailableRange: { value: totalAvailableRange, unit: 1 },
          },
          type: 2,
        }],
      };

      // Preserve cached range data when HA returns zero
      if (evModeRange === 0 && this.status?.evStatus) {
        evStatus.drvDistance = this.status.evStatus.drvDistance;
      }

      this.status = {
        timestamp,
        lastStatusDate: dateToCompactString(timestamp),
        airCtrlOn: airConditioner === 'on',
        doorLock: doorLock === 'locked',
        doorOpen: {
          frontLeft: doorFrontLeft === 'on' ? 1 : 0,
          frontRight: doorFrontRight === 'on' ? 1 : 0,
          backLeft: doorRearLeft === 'on' ? 1 : 0,
          backRight: doorRearRight === 'on' ? 1 : 0,
        },
        trunkOpen: trunk === 'on',
        defrost: defrost === 'on',
        hoodOpen: hood === 'on',
        engine: engine === 'on',
        evStatus,
      };

      const odo = parseFloat(odometerState);
      if (!Number.isNaN(odo)) {
        this.odometer = odo;
      }

      this.saveStatusToCache();
    } catch (error) {
      console.error('Failed to fetch car status from Home Assistant:', error);
    }
  };

  lock = async (): Promise<string> => {
    await this.client.callService('lock', 'lock', {
      entity_id: `lock.${this.entityPrefix}_door_lock`,
    });
    return 'Locked';
  };

  unlock = async (): Promise<string> => {
    await this.client.callService('lock', 'unlock', {
      entity_id: `lock.${this.entityPrefix}_door_lock`,
    });
    return 'Unlocked';
  };

  start = async (config?: Partial<CarStartOptions>): Promise<string> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceData: any = {
      entity_id: `lock.${this.entityPrefix}_door_lock`,
      climate: true,
      temperature: config?.temperature ?? 21,
      defrost: config?.defrost ?? false,
      heating: config?.heatedFeatures ?? false,
    };
    await this.client.callService('kia_uvo', 'start_climate', serviceData);
    return 'Started';
  };

  stop = async (): Promise<string> => {
    await this.client.callService('kia_uvo', 'stop_climate', {
      entity_id: `lock.${this.entityPrefix}_door_lock`,
    });
    return 'Stopped';
  };

  resync = async () => {
    try {
      await this.client.callService('kia_uvo', 'force_update', {
        entity_id: `lock.${this.entityPrefix}_door_lock`,
      });
      // Re-fetch status after force update
      setTimeout(() => this.setStatus(), 10000);
    } catch (error) {
      console.error('Failed to resync car:', error);
    }
  };
}

