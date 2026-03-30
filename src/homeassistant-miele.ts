import { HomeAssistantClient } from './homeassistant-client';
import { MieleDevice } from './types/types';
import logger from './logger';

const mieleLogger = logger.child({ subsystem: 'homeassistant-miele' });

interface MieleDeviceEntities {
  status: string;
  programName?: string;
  programPhase?: string;
  elapsedTime?: string;
  remainingTime?: string;
}

export interface HomeAssistantMieleConfig {
  client: HomeAssistantClient;
  washerEntities?: Partial<MieleDeviceEntities>;
  dryerEntities?: Partial<MieleDeviceEntities>;
  pollInterval?: number;
}

const STATUS_MAP: Record<string, string> = {
  off: 'Off',
  on: 'On',
  running: 'Running',
  not_connected: 'Not Connected',
  program_ended: 'End programmed',
  programmed: 'Programmed',
  waiting_to_start: 'Waiting to start',
  in_use: 'In use',
  pause: 'Pause',
  failure: 'Failure',
  program_interrupted: 'Program interrupted',
  idle: 'Idle',
  rinse_hold: 'Rinse hold',
  service: 'Service',
  superfreezing: 'Superfreezing',
  supercooling: 'Supercooling',
  superheating: 'Superheating',
};

const DEFAULT_WASHER_ENTITIES: MieleDeviceEntities = {
  status: 'sensor.washing_machine_status',
  programName: 'sensor.washing_machine_program_name',
  programPhase: 'sensor.washing_machine_program_phase',
  elapsedTime: 'sensor.washing_machine_elapsed_time',
  remainingTime: 'sensor.washing_machine_remaining_time',
};

const DEFAULT_DRYER_ENTITIES: MieleDeviceEntities = {
  status: 'sensor.tumble_dryer_status',
  programName: 'sensor.tumble_dryer_program_name',
  programPhase: 'sensor.tumble_dryer_program_phase',
  elapsedTime: 'sensor.tumble_dryer_elapsed_time',
  remainingTime: 'sensor.tumble_dryer_remaining_time',
};

export default class HomeAssistantMiele {
  public washer: MieleDevice;

  public dryer: MieleDevice;

  public onStatusChange?: (deviceType: 'washer' | 'dryer', device: MieleDevice) => void;

  private client: HomeAssistantClient;

  private washerEntities: MieleDeviceEntities;

  private dryerEntities: MieleDeviceEntities;

  private pollInterval: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HomeAssistantMieleConfig) {
    this.client = config.client;
    this.washerEntities = { ...DEFAULT_WASHER_ENTITIES, ...config.washerEntities };
    this.dryerEntities = { ...DEFAULT_DRYER_ENTITIES, ...config.dryerEntities };
    this.pollInterval = config.pollInterval || 10_000;
    this.washer = { name: 'Washer', inUse: false };
    this.dryer = { name: 'Dryer', inUse: false };

    this.startPolling();
  }

  private startPolling(): void {
    this.poll().catch((err) => {
      mieleLogger.error({ err }, 'Initial Miele poll failed');
    });

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        mieleLogger.error({ err }, 'Miele poll failed');
      });
    }, this.pollInterval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private parseTimeMinutes(state: string | undefined | null): number | undefined {
    if (!state || state === 'unknown' || state === 'unavailable') return undefined;
    // Try HH:MM format first (before parseFloat, which would partially parse it)
    const match = state.match(/^(\d+):(\d+)$/);
    if (match) {
      return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    }
    // Try plain numeric value (minutes)
    const num = Number(state);
    if (!Number.isNaN(num)) return num;
    return undefined;
  }

  private async pollDevice(
    entities: MieleDeviceEntities,
    displayName: string,
  ): Promise<MieleDevice> {
    const entityIds = [
      entities.status,
      entities.programName,
      entities.programPhase,
      entities.elapsedTime,
      entities.remainingTime,
    ].filter(Boolean) as string[];

    const results = await Promise.all(
      entityIds.map((id) => this.client.getState(id)),
    );

    let idx = 0;
    const statusResult = results[idx++];
    const programNameResult = entities.programName ? results[idx++] : null;
    const programPhaseResult = entities.programPhase ? results[idx++] : null;
    const elapsedTimeResult = entities.elapsedTime ? results[idx++] : null;
    const remainingTimeResult = entities.remainingTime ? results[idx++] : null;

    // Status
    const rawStatus = (statusResult?.state || 'off').toLowerCase().replace(/\s+/g, '_');
    const status = STATUS_MAP[rawStatus] || statusResult?.state || 'Off';
    const inUse = status !== 'Off' && status !== 'Not Connected';

    // Program name
    const pnState = programNameResult?.state;
    const programName = (pnState && pnState !== 'unknown' && pnState !== 'unavailable')
      ? pnState : undefined;

    // Program phase / step
    const ppState = programPhaseResult?.state;
    const step = (ppState && ppState !== 'unknown' && ppState !== 'unavailable')
      ? ppState : undefined;

    // Time values (in minutes)
    const timeRunning = this.parseTimeMinutes(elapsedTimeResult?.state);
    const timeRemaining = this.parseTimeMinutes(remainingTimeResult?.state);

    return {
      name: displayName,
      timeRunning,
      timeRemaining,
      step,
      programName,
      status,
      inUse,
    };
  }

  // eslint-disable-next-line class-methods-use-this
  private hasChanged(prev: MieleDevice, next: MieleDevice): boolean {
    return prev.status !== next.status
      || prev.timeRunning !== next.timeRunning
      || prev.timeRemaining !== next.timeRemaining
      || prev.step !== next.step
      || prev.programName !== next.programName
      || prev.inUse !== next.inUse;
  }

  private async poll(): Promise<void> {
    try {
      const [washerDevice, dryerDevice] = await Promise.all([
        this.pollDevice(this.washerEntities, 'Washing machine'),
        this.pollDevice(this.dryerEntities, 'Tumble dryer'),
      ]);

      // Check washer changes
      const washerChanged = this.hasChanged(this.washer, washerDevice);
      this.washer = washerDevice;
      if (washerChanged) {
        mieleLogger.debug({ deviceType: 'washer', ...washerDevice }, 'Washer status updated');
        this.onStatusChange?.('washer', washerDevice);
      }

      // Check dryer changes
      const dryerChanged = this.hasChanged(this.dryer, dryerDevice);
      this.dryer = dryerDevice;
      if (dryerChanged) {
        mieleLogger.debug({ deviceType: 'dryer', ...dryerDevice }, 'Dryer status updated');
        this.onStatusChange?.('dryer', dryerDevice);
      }
    } catch (err) {
      mieleLogger.error({ err }, 'Failed to poll Miele status');
    }
  }
}
