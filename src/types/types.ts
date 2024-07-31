export interface MieleDevice {
  name: string;
  timeRunning?: number;
  timeRemaining?: number;
  step?: string;
  programName?: string;
  status?: string;
  inUse: boolean;
}

export type DishWasherProgram =
  'PreRinse' | 'Auto1' | 'Auto2' | 'Auto3' | 'Eco50' | 'Quick45' | 'Intensiv70' | 'Normal65' | 'Glas40' |
  'GlassCare' | 'NightWash' | 'Quick65' | 'Normal45' | 'Intensiv45' | 'AutoHalfLoad' | 'IntensivPower' |
  'MagicDaily' | 'Super60' | 'Kurz60' | 'ExpressSparkle65' | 'MachineCare' | 'SteamFresh' | 'MaximumCleaning' |
  'MixedLoad';

export type OperationState =
  'Inactive' | 'Ready' | 'DelayedStart' | 'Run' | 'Pause' | 'ActionRequired' | 'Finished' | 'Error' | 'Aborting';

export interface DishWasher {
  status?: 'Running' | 'Paused' | 'Finished' | 'Aborted';
  program?: string;
  remainingTime?: number;
  remainingTimeUnit?: 'seconds' | 'minutes' | 'hours';
  remainingTimeEstimate?: boolean;
  programProgress?: number;
  operationState: OperationState;
  doorState: 'Open' | 'Closed';
  selectedProgram?: string;
  activeProgram?: DishWasherProgram;
  startInRelative?: number;
  startInRelativeUnit?: 'seconds' | 'minutes' | 'hours';
}
