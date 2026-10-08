import { HomeAssistantClient } from './homeassistant-client';

export interface HomeAssistantRobotConfig {
  name: string;
  entityId: string;
  batteryEntityId?: string;
  entityPrefix?: string;
  client: HomeAssistantClient;
  pollInterval?: number;
}

export interface RobotRoom {
  id: number;
  name: string;
  icon?: string;
}

export interface RobotMaintenance {
  mainBrushPercent?: number;
  sideBrushPercent?: number;
  filterPercent?: number;
  sensorPercent?: number;
  wheelPercent?: number;
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
  progressPercent?: number;
  elapsedMinutes?: number;
  estimatedRemainingMinutes?: number;
  cleanedArea?: number;
  cleaningMode?: string;
  suctionLevel?: string;
  currentRoom?: string;
  currentRoomId?: number;
  cleanWaterTankStatus?: string;
  dirtyWaterTankStatus?: string;
  dustBagStatus?: string;
  detergentStatus?: string;
  lowWaterWarning?: string;
  autoEmptyStatus?: string;
  drainageStatus?: string;
  selfWashBaseStatus?: string;
  maintenance?: RobotMaintenance;
  rooms?: RobotRoom[];
}

const EMPTY_STATUS: Status = {
  timestamp: new Date(),
};

export default class HomeAssistantRobot {
  public cachedStatus: Status = EMPTY_STATUS;

  public onStatusChange?: (name: string, status: Status) => void;

  private config: HomeAssistantRobotConfig;

  private pollInterval: NodeJS.Timeout | null = null;

  private entityPrefix: string;

  constructor(config: HomeAssistantRobotConfig) {
    this.config = config;
    this.entityPrefix = config.entityPrefix || config.entityId.split('.')[1] || 'v70_ultra_complete';
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
      const extras = await this.pollExtraStates();
      let batteryState;
      if (this.config.batteryEntityId) {
        try {
          batteryState = await this.config.client.getState(this.config.batteryEntityId);
        } catch (error) {
          console.warn(`Failed to poll battery for ${this.config.name}:`, error);
        }
      }
      this.updateStatus(state, batteryState, extras);
    } catch (error) {
      console.error(`Failed to poll robot ${this.config.name}:`, error);
    }
  }

  private static findState(states: unknown, entityId: string) {
    return Array.isArray(states)
      ? states.find((state) => state?.entity_id === entityId)
      : undefined;
  }

  private sensorId(suffix: string): string {
    return `sensor.${this.entityPrefix}_${suffix}`;
  }

  private cameraId(suffix = 'map'): string {
    return `camera.${this.entityPrefix}_${suffix}`;
  }

  private async pollExtraStates() {
    const ids = {
      progress: this.sensorId('cleaning_progress'),
      elapsed: this.sensorId('cleaning_time'),
      area: this.sensorId('cleaned_area'),
      room: this.sensorId('current_room'),
      cleanWater: this.sensorId('clean_water_tank_status'),
      dirtyWater: this.sensorId('dirty_water_tank_status'),
      dustBag: this.sensorId('dust_bag_status'),
      detergent: this.sensorId('detergent_status'),
      lowWater: this.sensorId('low_water_warning'),
      autoEmpty: this.sensorId('auto_empty_status'),
      drainage: this.sensorId('drainage_status'),
      selfWashBase: this.sensorId('self_wash_base_status'),
      mainBrush: this.sensorId('main_brush_left'),
      sideBrush: this.sensorId('side_brush_left'),
      filter: this.sensorId('filter_left'),
      sensor: this.sensorId('sensor_dirty_left'),
      wheel: this.sensorId('wheel_dirty_left'),
      map: this.cameraId('map'),
    };
    try {
      const states = await this.config.client.getState('');
      return Object.fromEntries(
        Object.entries(ids).map(([key, entityId]) => [key, HomeAssistantRobot.findState(states, entityId)]),
      );
    } catch (error) {
      console.warn(`Failed to poll extra robot states for ${this.config.name}:`, error);
      return {};
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, class-methods-use-this
  private numericState(entity: any): number | undefined {
    if (!entity || entity.state === 'unavailable' || entity.state === 'unknown') return undefined;
    const n = parseFloat(entity.state);
    return Number.isFinite(n) ? n : undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, class-methods-use-this
  private textState(entity: any): string | undefined {
    if (!entity || entity.state === 'unavailable' || entity.state === 'unknown') return undefined;
    return entity.state;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, class-methods-use-this
  private roomsFromMap(mapState: any): RobotRoom[] | undefined {
    const rooms = mapState?.attributes?.rooms;
    if (!rooms || typeof rooms !== 'object') return undefined;
    return Object.values(rooms).map((room) => {
      const roomData = room as { room_id?: number | string; name?: string; room_name?: string; icon?: string };
      return {
        id: Number(roomData.room_id),
        name: String(roomData.name || roomData.room_name || roomData.room_id),
        icon: roomData.icon,
      };
    }).filter((room) => Number.isFinite(room.id) && room.name);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updateStatus(state: any, batteryState?: any, extras: Record<string, any> = {}) {
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

    const progressPercent = this.numericState(extras.progress);
    const elapsedMinutes = this.numericState(extras.elapsed);

    // Try to determine start time.
    // Prefer the dedicated elapsed-minute sensor when present; Mova/Dreame attributes
    // expose cleaning_time in minutes on newer integrations, while older vacuums used seconds.
    const cleaningTime = elapsedMinutes ?? this.numericState({ state: attributes.cleaning_time });
    let { timeStarted } = this.cachedStatus;

    if (running) {
      if (cleaningTime !== undefined) {
        timeStarted = new Date(Date.now() - cleaningTime * 60 * 1000);
      } else if (state.last_changed) {
        // Reliable fallback: HA records exactly when state changed to 'cleaning'
        timeStarted = new Date(state.last_changed);
      } else if (!this.cachedStatus.running) {
        // Last resort: just started and no timing info available
        timeStarted = new Date(Date.now());
      }
    }
    const estimatedRemainingMinutes = running && progressPercent && progressPercent > 0 && progressPercent < 100
      && elapsedMinutes !== undefined
      ? Math.max(0, Math.round((elapsedMinutes / (progressPercent / 100)) - elapsedMinutes))
      : undefined;
    const currentRoomId = extras.room?.attributes?.room_id;

    this.cachedStatus = {
      timestamp: new Date(Date.now()),
      running,
      docking,
      docked,
      paused,
      charging,
      batteryLevel,
      binFull,
      timeStarted,
      progressPercent,
      elapsedMinutes,
      estimatedRemainingMinutes,
      cleanedArea: this.numericState(extras.area),
      cleaningMode: attributes.cleaning_mode,
      suctionLevel: attributes.suction_level || attributes.fan_speed,
      currentRoom: this.textState(extras.room),
      currentRoomId: Number.isFinite(currentRoomId) ? Number(currentRoomId) : undefined,
      cleanWaterTankStatus: this.textState(extras.cleanWater),
      dirtyWaterTankStatus: this.textState(extras.dirtyWater),
      dustBagStatus: this.textState(extras.dustBag),
      detergentStatus: this.textState(extras.detergent),
      lowWaterWarning: this.textState(extras.lowWater),
      autoEmptyStatus: this.textState(extras.autoEmpty),
      drainageStatus: this.textState(extras.drainage),
      selfWashBaseStatus: this.textState(extras.selfWashBase),
      maintenance: {
        mainBrushPercent: this.numericState(extras.mainBrush),
        sideBrushPercent: this.numericState(extras.sideBrush),
        filterPercent: this.numericState(extras.filter),
        sensorPercent: this.numericState(extras.sensor),
        wheelPercent: this.numericState(extras.wheel),
      },
      rooms: this.roomsFromMap(extras.map),
    };
    this.onStatusChange?.(this.config.name, this.cachedStatus);
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

  public async cleanRooms(roomIds: number[], repeats = 1) {
    try {
      await this.config.client.callService('dreame_vacuum', 'vacuum_clean_segment', {
        entity_id: this.config.entityId,
        segments: roomIds,
        repeats,
      });
      this.poll();
    } catch (error) {
      console.error(`Failed to clean rooms with robot ${this.config.name}:`, error);
      throw error;
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
