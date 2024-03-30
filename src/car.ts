import { BlueLinky } from 'dfj-bluelinky';
// eslint-disable-next-line import/no-unresolved
import { Vehicle } from 'dfj-bluelinky/dist/vehicles/vehicle';
// eslint-disable-next-line import/no-unresolved
import { RawVehicleStatus } from 'dfj-bluelinky/dist/interfaces/common.interfaces';

export interface CarConfig {
  username: string;
  password: string;
  region: 'CA';
  brand: 'kia';
  pin: string;
  useInfo: boolean;
}

export default class Car {
  status?: RawVehicleStatus;

  vehicle?: Vehicle;

  private client: BlueLinky;

  constructor(carConfig: CarConfig) {
    this.client = new BlueLinky({
      username: carConfig.username,
      password: carConfig.password,
      region: carConfig.region,
      brand: carConfig.brand,
      pin: carConfig.pin,
    });
    this.client.on('ready', this.onReadyHandler);
  }

  onReadyHandler = <T extends Vehicle>(vehicles: T[]) => {
    [this.vehicle] = vehicles;
    this.setStatus();
    setInterval(() => {
      this.setStatus();
    }, 1000 * 60 * 15);
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
        this.status = status as RawVehicleStatus;
        if (this.status.evStatus === null) {
          this.setStatus(true);
        }
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
      await this.setStatus();
    }
  };
}
