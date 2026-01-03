import { HomebridgeClient } from './homebridge-client';

export interface HomebridgeRobotConfig {
  name: string;
  uniqueId: string;
  client: HomebridgeClient;
  pollInterval?: number;
}

interface Status {
  timestamp: Date;
  running?: boolean;
  docking?: boolean;
  charging?: boolean;
  paused?: boolean;
  batteryLevel?: number;
  binFull?: boolean;
  timeStarted?: Date;
}

const EMPTY_STATUS: Status = {
  timestamp: new Date(),
};

const UUIDS = {
  On: '00000025-0000-1000-8000-0026BB765291',
  BatteryLevel: '00000068-0000-1000-8000-0026BB765291',
  ChargingState: '0000008F-0000-1000-8000-0026BB765291',
  FilterChangeIndication: '000000AC-0000-1000-8000-0026BB765291',
};

export default class HomebridgeRobot {
  public cachedStatus: Status = EMPTY_STATUS;

  private config: HomebridgeRobotConfig;

  private pollInterval: NodeJS.Timeout | null = null;

  constructor(config: HomebridgeRobotConfig) {
    this.config = config;
    this.startPolling();
  }

  // eslint-disable-next-line class-methods-use-this
  public identify() {
    // Not implemented for Homebridge
    console.warn('Identify not implemented for Homebridge robot');
  }

  public isActive(): boolean {
    return this.cachedStatus.running || this.cachedStatus.docking || false;
  }

  private startPolling() {
    const interval = this.config.pollInterval || 10000;
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), interval);
  }

  private async poll() {
    try {
      const accessory = await this.config.client.getAccessory(this.config.uniqueId);
      this.updateStatus(accessory);
    } catch (error) {
      console.error(`Failed to poll robot ${this.config.name}:`, error);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateStatus(accessory: any) {
    const services = accessory.serviceCharacteristics || [];

    let running = false;
    let batteryLevel = 0;
    let charging = false;
    let binFull = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    services.forEach((service: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onChar = service.characteristics.find((c: any) => c.type === UUIDS.On);
      if (onChar) {
        running = onChar.value;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batteryChar = service.characteristics.find((c: any) => c.type === UUIDS.BatteryLevel);
      if (batteryChar) {
        batteryLevel = batteryChar.value;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chargingChar = service.characteristics.find((c: any) => c.type === UUIDS.ChargingState);
      if (chargingChar) {
        charging = chargingChar.value === 1;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filterChar = service.characteristics.find((c: any) => c.type === UUIDS.FilterChangeIndication);
      if (filterChar) {
        binFull = filterChar.value === 1;
      }
    });

    this.cachedStatus = {
      timestamp: new Date(),
      running,
      batteryLevel,
      charging,
      binFull,
      docking: false,
      paused: false,
    };
  }

  public async turnOn() {
    try {
      await this.config.client.setCharacteristic(this.config.uniqueId, UUIDS.On, true);
      this.poll();
    } catch (error) {
      console.error(`Failed to turn on robot ${this.config.name}:`, error);
    }
  }

  public async turnOff() {
    try {
      await this.config.client.setCharacteristic(this.config.uniqueId, UUIDS.On, false);
      this.poll();
    } catch (error) {
      console.error(`Failed to turn off robot ${this.config.name}:`, error);
    }
  }

  public stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
