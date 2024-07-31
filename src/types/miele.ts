export interface MieleRoot {
  miele: Miele
}

export interface Miele {
  [device: string]: Device
}

export interface Device {
  ident: Ident
  state: State
}

export interface Ident {
  type: Type
  deviceName: string
  protocolVersion: number
  deviceIdentLabel: DeviceIdentLabel
  xkmIdentLabel: XkmIdentLabel
}

export interface Type {
  key_localized: string
  value_raw: number
  value_localized: string
}

export interface DeviceIdentLabel {
  fabNumber: string
  fabIndex: string
  techType: string
  matNumber: string
  swids: string[]
}

export interface XkmIdentLabel {
  techType: string
  releaseVersion: string
}

export interface State {
  ProgramID: ProgramId
  status: Status
  programType: ProgramType
  programPhase: ProgramPhase
  remainingTime: number[]
  startTime: number[]
  targetTemperature: TargetTemperature[]
  coreTargetTemperature: CoreTargetTemperature[]
  temperature: Temperature[]
  coreTemperature: CoreTemperature[]
  signalInfo: boolean
  signalFailure: boolean
  signalDoor: boolean
  remoteEnable: RemoteEnable
  ambientLight?: number
  light?: number
  elapsedTime: number[]
  spinningSpeed: SpinningSpeed
  dryingStep: DryingStep
  ventilationStep: VentilationStep
  plateStep?: string[]
  ecoFeedback?: number
  batteryLevel?: number
}

export interface ProgramId {
  value_raw: number
  value_localized: string
  key_localized: string
}

export interface Status {
  value_raw: number
  value_localized: string
  key_localized: string
}

export interface ProgramType {
  value_raw: number
  value_localized: string
  key_localized: string
}

export interface ProgramPhase {
  value_raw: number
  value_localized: string
  key_localized: string
}

export interface TargetTemperature {
  value_raw: number
  value_localized?: string
  unit: string
}

export interface CoreTargetTemperature {
  value_raw: number
  value_localized?: string
  unit: string
}

export interface Temperature {
  value_raw: number
  value_localized?: string
  unit: string
}

export interface CoreTemperature {
  value_raw: number
  value_localized?: string
  unit: string
}

export interface RemoteEnable {
  fullRemoteControl: boolean
  smartGrid: boolean
  mobileStart: boolean
}

export interface SpinningSpeed {
  unit: string
  value_raw?: number
  value_localized?: number
  key_localized: string
}

export interface DryingStep {
  value_raw?: string
  value_localized: string
  key_localized: string
}

export interface VentilationStep {
  value_raw?: string
  value_localized: string
  key_localized: string
}

