import { HomeAssistantClient } from './homeassistant-client';
import { DishWasher, DishWasherProgram, OperationState } from './types/types';
import logger from './logger';

const dwLogger = logger.child({ subsystem: 'homeassistant-dishwasher' });

interface HomeAssistantDishwasherConfig {
  client: HomeAssistantClient;
  operationStateEntity?: string;
  programProgressEntity?: string;
  finishTimeEntity?: string;
  activeProgramEntity?: string;
  selectedProgramEntity?: string;
  doorEntity?: string;
  pollInterval?: number;
}

const PROGRAM_MAP: Record<string, DishWasherProgram> = {
  dishcare_dishwasher_program_pre_rinse: 'PreRinse',
  dishcare_dishwasher_program_auto_1: 'Auto1',
  dishcare_dishwasher_program_auto_2: 'Auto2',
  dishcare_dishwasher_program_auto_3: 'Auto3',
  dishcare_dishwasher_program_eco_50: 'Eco50',
  dishcare_dishwasher_program_quick_45: 'Quick45',
  dishcare_dishwasher_program_intensiv_70: 'Intensiv70',
  dishcare_dishwasher_program_normal_65: 'Normal65',
  dishcare_dishwasher_program_glas_40: 'Glas40',
  dishcare_dishwasher_program_glass_care: 'GlassCare',
  dishcare_dishwasher_program_night_wash: 'NightWash',
  dishcare_dishwasher_program_quick_65: 'Quick65',
  dishcare_dishwasher_program_normal_45: 'Normal45',
  dishcare_dishwasher_program_intensiv_45: 'Intensiv45',
  dishcare_dishwasher_program_auto_half_load: 'AutoHalfLoad',
  dishcare_dishwasher_program_intensiv_power: 'IntensivPower',
  dishcare_dishwasher_program_magic_daily: 'MagicDaily',
  dishcare_dishwasher_program_super_60: 'Super60',
  dishcare_dishwasher_program_kurz_60: 'Kurz60',
  dishcare_dishwasher_program_express_sparkle_65: 'ExpressSparkle65',
  dishcare_dishwasher_program_machine_care: 'MachineCare',
  dishcare_dishwasher_program_steam_fresh: 'SteamFresh',
  dishcare_dishwasher_program_maximum_cleaning: 'MaximumCleaning',
  dishcare_dishwasher_program_mixed_load: 'MixedLoad',
};

const OPERATION_STATE_MAP: Record<string, OperationState> = {
  inactive: 'Inactive',
  ready: 'Ready',
  delayedstart: 'DelayedStart',
  run: 'Run',
  pause: 'Pause',
  actionrequired: 'ActionRequired',
  finished: 'Finished',
  error: 'Error',
  aborting: 'Aborting',
};

export default class HomeAssistantDishwasher {
  public dishwasher: DishWasher;

  public onStatusChange?: (dishwasher: DishWasher) => void;

  private client: HomeAssistantClient;

  private entities: {
    operationState: string;
    programProgress: string;
    finishTime: string;
    activeProgram: string;
    selectedProgram: string;
    door: string;
  };

  private pollInterval: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HomeAssistantDishwasherConfig) {
    this.client = config.client;
    this.entities = {
      operationState: config.operationStateEntity || 'sensor.dishwasher_operation_state',
      programProgress: config.programProgressEntity || 'sensor.dishwasher_program_progress',
      finishTime: config.finishTimeEntity || 'sensor.dishwasher_program_finish_time',
      activeProgram: config.activeProgramEntity || 'select.dishwasher_active_program',
      selectedProgram: config.selectedProgramEntity || 'select.dishwasher_selected_program',
      door: config.doorEntity || 'sensor.dishwasher_door',
    };
    this.pollInterval = config.pollInterval || 10_000;
    this.dishwasher = {
      operationState: 'Inactive',
      doorState: 'Closed',
    };

    this.startPolling();
  }

  private startPolling(): void {
    this.poll().catch((err) => {
      dwLogger.error({ err }, 'Initial dishwasher poll failed');
    });

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        dwLogger.error({ err }, 'Dishwasher poll failed');
      });
    }, this.pollInterval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const results = await Promise.all([
        this.client.getState(this.entities.operationState),
        this.client.getState(this.entities.programProgress),
        this.client.getState(this.entities.finishTime),
        this.client.getState(this.entities.activeProgram),
        this.client.getState(this.entities.selectedProgram),
        this.client.getState(this.entities.door),
      ]);

      const [opState, progress, finishTime, activeProgram, selectedProgram, door] = results;
      const prev = { ...this.dishwasher };

      // Operation state
      const opStateValue = opState?.state?.toLowerCase() || 'inactive';
      this.dishwasher.operationState = OPERATION_STATE_MAP[opStateValue] || 'Inactive';

      // Door state
      this.dishwasher.doorState = door?.state === 'open' ? 'Open' : 'Closed';

      // Program progress
      const progressValue = parseFloat(progress?.state || '0');
      this.dishwasher.programProgress = Number.isNaN(progressValue) ? 0 : progressValue;

      // Active program
      const activeProgramKey = activeProgram?.state || '';
      this.dishwasher.activeProgram = PROGRAM_MAP[activeProgramKey] || undefined;

      // Selected program
      const selectedProgramKey = selectedProgram?.state || '';
      this.dishwasher.selectedProgram = PROGRAM_MAP[selectedProgramKey] || selectedProgramKey;

      // Remaining time (in seconds, matching old HomeConnect behavior)
      const ftState = finishTime?.state;
      if (ftState && ftState !== 'unknown' && ftState !== 'unavailable') {
        const finish = new Date(ftState);
        const remainingSeconds = Math.max(
          0,
          Math.floor((finish.getTime() - Date.now()) / 1000),
        );
        this.dishwasher.remainingTime = remainingSeconds;
        this.dishwasher.remainingTimeUnit = 'seconds';
        this.dishwasher.remainingTimeEstimate = true;
      } else {
        this.dishwasher.remainingTime = undefined;
        this.dishwasher.remainingTimeUnit = undefined;
        this.dishwasher.remainingTimeEstimate = undefined;
      }

      // Status mapping (matches old HomeConnect module)
      if (this.dishwasher.operationState === 'Run') {
        this.dishwasher.status = 'Running';
      } else if (this.dishwasher.operationState === 'Pause') {
        this.dishwasher.status = 'Paused';
      } else if (this.dishwasher.operationState === 'Finished') {
        this.dishwasher.status = 'Finished';
      } else if (this.dishwasher.operationState === 'Aborting') {
        this.dishwasher.status = 'Aborted';
      } else {
        this.dishwasher.status = undefined;
      }

      // Fire callback if state changed
      const changed = prev.operationState !== this.dishwasher.operationState
        || prev.programProgress !== this.dishwasher.programProgress
        || prev.doorState !== this.dishwasher.doorState
        || prev.remainingTime !== this.dishwasher.remainingTime
        || prev.activeProgram !== this.dishwasher.activeProgram;

      if (changed) {
        dwLogger.debug(
          {
            operationState: this.dishwasher.operationState,
            progress: this.dishwasher.programProgress,
            program: this.dishwasher.activeProgram,
            remaining: this.dishwasher.remainingTime,
          },
          'Dishwasher status updated',
        );
        this.onStatusChange?.(this.dishwasher);
      }
    } catch (err) {
      dwLogger.error({ err }, 'Failed to poll dishwasher status');
    }
  }
}
