import { HomeAssistantClient } from './homeassistant-client';

export interface HomeAssistantRobotConfig {
  name: string;
  entityId: string;
  client: HomeAssistantClient;
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

export default class HomeAssistantRobot {
  public cachedStatus: Status = EMPTY_STATUS;

  private config: HomeAssistantRobotConfig;

  private pollInterval: NodeJS.Timeout | null = null;

  constructor(config: HomeAssistantRobotConfig) {
    this.config = config;
    this.startPolling();
  }

  // eslint-disable-next-line class-methods-use-this
  public identify() {
    // Not implemented for Home Assistant
    console.warn('Identify not implemented for Home Assistant robot');
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
      this.updateStatus(state);
    } catch (error) {
      console.error(`Failed to poll robot ${this.config.name}:`, error);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateStatus(state: any) {
    // Home Assistant Vacuum states: cleaning, docked, paused, idle, returning, error
    const status = state.state;
    const { attributes } = state;

    const running = status === 'cleaning';
    const docking = status === 'returning';
    const paused = status === 'paused';
    const charging = status === 'docked' && attributes.battery_level < 100; // Approximation
    const batteryLevel = attributes.battery_level;
    // Some vacuums expose bin_full attribute, others don't.
    // eslint-disable-next-line camelcase
    const binFull = attributes.bin_full || false;

    this.cachedStatus = {
      timestamp: new Date(),
      running,
      docking,
      paused,
      charging,
      batteryLevel,
      binFull,
    };
  }

  public async turnOn() {
    try {
      await this.config.client.callService('vacuum', 'start', {
        entity_id: this.config.entityId,
      });
      this.poll();
    } catch (error) {
      console.error(`Failed to turn on robot ${this.config.name}:`, error);
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
