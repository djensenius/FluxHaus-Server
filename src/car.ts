import fs from 'fs';
import { BlueLinky } from 'bluelinky';
// eslint-disable-next-line import/no-unresolved
import { Vehicle } from 'bluelinky/dist/vehicles/vehicle';
// eslint-disable-next-line import/no-unresolved
import { RawVehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';

export interface CarStatus extends RawVehicleStatus {
  timestamp: Date;
}

export interface CarConfig {
  username: string;
  password: string;
  region: 'CA';
  brand: 'kia';
  pin: string;
  useInfo: boolean;
}

function strDateToDateTime(strDate: string): Date {
  const parsedDate = strDate.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/g, '$1-$2-$3T$4:$5:$6.000Z');
  const date = new Date(parsedDate);
  return date;
}

export default class Car {
  status?: CarStatus;

  vehicle?: Vehicle;

  odometer: number;

  count: number;

  private client: BlueLinky;

  constructor(carConfig: CarConfig) {
    this.client = new BlueLinky({
      username: carConfig.username,
      password: carConfig.password,
      region: carConfig.region,
      brand: carConfig.brand,
      pin: carConfig.pin,
    });
    this.count = 0;
    this.odometer = 0;
    this.client.on('ready', this.onReadyHandler);
  }

  onReadyHandler = <T extends Vehicle>(vehicles: T[]) => {
    [this.vehicle] = vehicles;
    this.setStatus();
    setInterval(() => {
      let refresh = false;
      if (this.count === 1) {
        refresh = true;
        this.count = 0;
      } else {
        this.count += 1;
      }
      this.setStatus(refresh);
    }, 1000 * 60 * 120);
  };

  setStatus = async (refresh = false) => {
    if (this.vehicle !== undefined) {
      const status = await this.vehicle.status({
        refresh,
        parsed: false,
        useInfo: true,
      });

      if (status !== null) {
        // Check if evStatus is null, and call again with refresh
        const timestamp = strDateToDateTime((status as RawVehicleStatus).lastStatusDate);
        this.status = { timestamp, ...status as RawVehicleStatus };
        if (this.status.evStatus) {
          const oldEvStatus = JSON.parse(fs.readFileSync('cache/evStatus.json', 'utf8'));
          const newEvStatus = this.status.evStatus;
          const combinedEvStatus = newEvStatus;
          if (newEvStatus.drvDistance[0].rangeByFuel.evModeRange.unit === 0) {
            combinedEvStatus.drvDistance = oldEvStatus.drvDistance;
          }

          fs.writeFileSync(
            'cache/evStatus.json',
            JSON.stringify({ timestamp, ...this.status.evStatus }, null, 2),
          );
        }
      }

      const odometer = await this.vehicle.odometer();
      if (odometer) {
        this.odometer = odometer.unit;
      }
    }
  };

  lock = async (): Promise<string> => {
    if (this.vehicle !== undefined) {
      const result = await this.vehicle.lock();
      return result;
    }
    return 'No vehicle found';
  };

  unlock = async (): Promise<string> => {
    if (this.vehicle !== undefined) {
      const result = await this.vehicle.unlock();
      return result;
    }
    return 'No vehicle found';
  };

  start = async (): Promise<string> => {
    if (this.vehicle !== undefined) {
      const result = await this.vehicle.start({
        hvac: true,
        temperature: 21,
        duration: 120,
        defrost: false,
        heatedFeatures: false,
        unit: 'C',
      });
      return result;
    }
    return 'No vehicle found';
  };

  stop = async (): Promise<string> => {
    if (this.vehicle !== undefined) {
      const result = await this.vehicle.stop();
      return result;
    }
    return 'No vehicle found';
  };

  resync = async () => {
    if (this.vehicle !== undefined) {
      await this.setStatus(true);
    }
  };
}

