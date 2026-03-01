import { HomeAssistantClient } from './homeassistant-client';
import logger from './logger';

export interface HomeAssistantRobotConfig {
  name: string;
  entityId: string;
  batteryEntityId?: string;
  client: HomeAssistantClient;
  pollInterval?: number;
}

interface Status {
  timestamp: Date;
  running?: boolean;
  docking?: boolean;
  docked?: boolean;
  charging?: boolean;
  paused?: boolean;
  batteryLevel?: number;
  binFull?: boolean;
  timeStarted?: Date;
}

const EMPTY_STATUS: Status = {
  timestamp: new Date(),
};

export default class HomeAssistantRobot {
  public cachedStatus: Status = EMPTY_STATUS;

  private config: HomeAssistantRobotConfig;

  private pollInterval: NodeJS.Timeout | null = null;

  private readonly log = logger.child({ subsystem: 'robot' });

  constructor(config: HomeAssistantRobotConfig) {
    this.config = config;
    this.startPolling();
  }

  // eslint-disable-next-line class-methods-use-this
  public identify() {
    // Not implemented for Home Assistant
    this.log.warn('Identify not implemented for Home Assistant robot');
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
      const state = await this.config.client.getState(this.config.entityId);
      let batteryState;
      if (this.config.batteryEntityId) {
        try {
          batteryState = await this.config.client.getState(this.config.batteryEntityId);
        } catch (error) {
          this.log.warn({ err: error }, `Failed to poll battery for ${this.config.name}:`);
        }
      }
      this.updateStatus(state, batteryState);
    } catch (error) {
      this.log.error({ err: error }, `Failed to poll robot ${this.config.name}:`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateStatus(state: any, batteryState?: any) {
    // Home Assistant Vacuum states: cleaning, docked, paused, idle, returning, error
    const status = state.state;
    const { attributes } = state;

    const running = status === 'cleaning';
    const docking = status === 'returning';
    const docked = status === 'docked';
    const paused = status === 'paused';

    let batteryLevel = attributes.battery_level;
    if (batteryLevel === undefined) {
      batteryLevel = attributes.battery;
    }
    if (batteryState && batteryState.state && !Number.isNaN(parseFloat(batteryState.state))) {
      batteryLevel = parseFloat(batteryState.state);
    }

    const charging = docked && batteryLevel < 100; // Approximation

    // Some vacuums expose bin_full attribute, others don't.
    // eslint-disable-next-line camelcase
    const binFull = attributes.bin_full;

    // Try to determine start time
    // eslint-disable-next-line camelcase
    const cleaningTime = attributes.cleaning_time; // seconds
    let { timeStarted } = this.cachedStatus;

    if (running) {
      if (cleaningTime !== undefined) {
        timeStarted = new Date(Date.now() - cleaningTime * 1000);
      } else if (!this.cachedStatus.running) {
        // Just started running and no cleaning_time available
        timeStarted = new Date();
      }
    }

    this.cachedStatus = {
      timestamp: new Date(),
      running,
      docking,
      docked,
      paused,
      charging,
      batteryLevel,
      binFull,
      timeStarted,
    };
  }

  public async turnOn() {
    try {
      await this.config.client.callService('vacuum', 'start', {
        entity_id: this.config.entityId,
      });
      this.poll();
    } catch (error) {
      this.log.error({ err: error }, `Failed to turn on robot ${this.config.name}:`);
    }
  }

  public async turnOff() {
    try {
      // 'return_to_base' is usually what we want for "off" in a vacuum context
      await this.config.client.callService('vacuum', 'return_to_base', {
        entity_id: this.config.entityId,
      });
      this.poll();
    } catch (error) {
      this.log.error({ err: error }, `Failed to turn off robot ${this.config.name}:`);
    }
  }

  public stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  static runningStatus = (status: Status) => (status.running === undefined
    ? undefined
    : status.running);

  static chargingStatus = (status: Status) => (status.charging === undefined
    ? undefined : status.charging);

  static dockingStatus = (status: Status) => {
    if (status.docking === undefined) {
      return undefined;
    }
    return status.docking;
  };

  static dockedStatus = (status: Status) => {
    if (status.docked === undefined) {
      return undefined;
    }
    return status.docked ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED';
  };

  static batteryLevelStatus = (status: Status) => (status.batteryLevel === undefined
    ? undefined
    : status.batteryLevel);

  static binStatus = (status: Status) => {
    if (status.binFull === undefined) {
      return undefined;
    }
    return status.binFull ? 'CHANGE_FILTER' : 'FILTER_OK';
  };

  static batteryStatus = (status: Status) => {
    if (status.batteryLevel === undefined) {
      return undefined;
    }
    return status.batteryLevel <= 20 ? 'Low' : 'Normal';
  };
}
