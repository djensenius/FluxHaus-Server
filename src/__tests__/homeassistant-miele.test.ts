import HomeAssistantMiele from '../homeassistant-miele';
import { HomeAssistantClient } from '../homeassistant-client';

// Mock HomeAssistantClient
jest.mock('../homeassistant-client');

// Mock logger
jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

describe('HomeAssistantMiele', () => {
  let mockClient: jest.Mocked<HomeAssistantClient>;
  let miele: HomeAssistantMiele;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = new HomeAssistantClient({ url: 'http://test', token: 'token' }) as jest.Mocked<HomeAssistantClient>;

    // Default: both devices off
    mockClient.getState = jest.fn().mockResolvedValue({
      state: 'off',
      attributes: {},
    });
  });

  afterEach(() => {
    if (miele) {
      miele.stop();
    }
    jest.useRealTimers();
  });

  it('should initialize with default washer and dryer', () => {
    miele = new HomeAssistantMiele({
      client: mockClient,
    });

    expect(miele.washer).toEqual({ name: 'Washer', inUse: false });
    expect(miele.dryer).toEqual({ name: 'Dryer', inUse: false });
  });

  it('should poll status on initialization', async () => {
    miele = new HomeAssistantMiele({
      client: mockClient,
    });

    // Wait for async poll
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // Should have polled all entities for both washer and dryer (5 each = 10 total)
    expect(mockClient.getState).toHaveBeenCalledTimes(10);
  });

  it('should update washer status from HA entities', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'sensor.washing_machine') {
        return Promise.resolve({ state: 'running' });
      }
      if (entityId === 'sensor.washing_machine_program') {
        return Promise.resolve({ state: 'Cottons' });
      }
      if (entityId === 'sensor.washing_machine_program_phase') {
        return Promise.resolve({ state: 'Wash' });
      }
      if (entityId === 'sensor.washing_machine_elapsed_time') {
        return Promise.resolve({ state: '90' });
      }
      if (entityId === 'sensor.washing_machine_remaining_time') {
        return Promise.resolve({ state: '45' });
      }
      // Dryer entities - off
      return Promise.resolve({ state: 'off' });
    });

    miele = new HomeAssistantMiele({
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(miele.washer).toEqual({
      name: 'Washing machine',
      timeRunning: 90,
      timeRemaining: 45,
      step: 'Wash',
      programName: 'Cottons',
      status: 'Running',
      inUse: true,
    });
  });

  it('should update dryer status from HA entities', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'sensor.tumble_dryer') {
        return Promise.resolve({ state: 'running' });
      }
      if (entityId === 'sensor.tumble_dryer_program') {
        return Promise.resolve({ state: 'Warm air' });
      }
      if (entityId === 'sensor.tumble_dryer_program_phase') {
        return Promise.resolve({ state: 'Drying' });
      }
      if (entityId === 'sensor.tumble_dryer_elapsed_time') {
        return Promise.resolve({ state: '30' });
      }
      if (entityId === 'sensor.tumble_dryer_remaining_time') {
        return Promise.resolve({ state: '60' });
      }
      // Washer entities - off
      return Promise.resolve({ state: 'off' });
    });

    miele = new HomeAssistantMiele({
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(miele.dryer).toEqual({
      name: 'Tumble dryer',
      timeRunning: 30,
      timeRemaining: 60,
      step: 'Drying',
      programName: 'Warm air',
      status: 'Running',
      inUse: true,
    });
  });

  it('should map status values correctly', async () => {
    const testCases: Array<{ haState: string; expectedStatus: string; expectedInUse: boolean }> = [
      { haState: 'off', expectedStatus: 'Off', expectedInUse: false },
      { haState: 'running', expectedStatus: 'Running', expectedInUse: true },
      { haState: 'not_connected', expectedStatus: 'Not Connected', expectedInUse: false },
      { haState: 'program_ended', expectedStatus: 'End programmed', expectedInUse: true },
      { haState: 'pause', expectedStatus: 'Pause', expectedInUse: true },
      { haState: 'in_use', expectedStatus: 'In use', expectedInUse: true },
      { haState: 'failure', expectedStatus: 'Failure', expectedInUse: true },
      { haState: 'idle', expectedStatus: 'Idle', expectedInUse: true },
    ];

    for (const { haState, expectedStatus, expectedInUse } of testCases) {
      jest.clearAllMocks();
      mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
        if (entityId === 'sensor.washing_machine') {
          return Promise.resolve({ state: haState });
        }
        return Promise.resolve({ state: 'off' });
      });

      miele = new HomeAssistantMiele({ client: mockClient });
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

      expect(miele.washer.status).toBe(expectedStatus);
      expect(miele.washer.inUse).toBe(expectedInUse);
      miele.stop();
    }
  });

  it('should handle unknown/unavailable entity states', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'sensor.washing_machine') {
        return Promise.resolve({ state: 'off' });
      }
      if (entityId === 'sensor.washing_machine_program') {
        return Promise.resolve({ state: 'unknown' });
      }
      if (entityId === 'sensor.washing_machine_program_phase') {
        return Promise.resolve({ state: 'unavailable' });
      }
      if (entityId === 'sensor.washing_machine_elapsed_time') {
        return Promise.resolve({ state: 'unknown' });
      }
      if (entityId === 'sensor.washing_machine_remaining_time') {
        return Promise.resolve({ state: 'unavailable' });
      }
      return Promise.resolve({ state: 'off' });
    });

    miele = new HomeAssistantMiele({ client: mockClient });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(miele.washer.programName).toBeUndefined();
    expect(miele.washer.step).toBeUndefined();
    expect(miele.washer.timeRunning).toBeUndefined();
    expect(miele.washer.timeRemaining).toBeUndefined();
  });

  it('should parse HH:MM time format', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'sensor.washing_machine') {
        return Promise.resolve({ state: 'running' });
      }
      if (entityId === 'sensor.washing_machine_elapsed_time') {
        return Promise.resolve({ state: '1:30' }); // 1 hour 30 minutes = 90 minutes
      }
      if (entityId === 'sensor.washing_machine_remaining_time') {
        return Promise.resolve({ state: '0:45' }); // 45 minutes
      }
      return Promise.resolve({ state: 'off' });
    });

    miele = new HomeAssistantMiele({ client: mockClient });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(miele.washer.timeRunning).toBe(90);
    expect(miele.washer.timeRemaining).toBe(45);
  });

  it('should fire onStatusChange callback when state changes', async () => {
    const statusChangeSpy = jest.fn();
    mockClient.getState = jest.fn().mockResolvedValue({ state: 'running' });

    miele = new HomeAssistantMiele({ client: mockClient });
    miele.onStatusChange = statusChangeSpy;

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // Initial poll triggers change from default 'Washer'/'Dryer' to polled state
    expect(statusChangeSpy).toHaveBeenCalledWith('washer', expect.objectContaining({
      name: 'Washing machine',
      status: 'Running',
      inUse: true,
    }));
    expect(statusChangeSpy).toHaveBeenCalledWith('dryer', expect.objectContaining({
      name: 'Tumble dryer',
      status: 'Running',
      inUse: true,
    }));
  });

  it('should not fire onStatusChange when state has not changed', async () => {
    const statusChangeSpy = jest.fn();
    mockClient.getState = jest.fn().mockResolvedValue({ state: 'off' });

    miele = new HomeAssistantMiele({ client: mockClient });
    miele.onStatusChange = statusChangeSpy;

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // First poll fires change (default name 'Washer' differs from polled 'Washing machine')
    statusChangeSpy.mockClear();

    // Trigger another poll manually
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (miele as any).poll();

    // State hasn't changed, so no callback should be fired
    expect(statusChangeSpy).not.toHaveBeenCalled();
  });

  it('should use custom entity IDs when provided', async () => {
    miele = new HomeAssistantMiele({
      client: mockClient,
      washerEntities: {
        status: 'sensor.my_washer_status',
        programName: 'sensor.my_washer_program',
      },
      dryerEntities: {
        status: 'sensor.my_dryer_status',
      },
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(mockClient.getState).toHaveBeenCalledWith('sensor.my_washer_status');
    expect(mockClient.getState).toHaveBeenCalledWith('sensor.my_washer_program');
    expect(mockClient.getState).toHaveBeenCalledWith('sensor.my_dryer_status');
  });

  it('should stop polling when requested', () => {
    jest.useFakeTimers();
    miele = new HomeAssistantMiele({
      client: mockClient,
      pollInterval: 1000,
    });

    const initialCalls = (mockClient.getState as jest.Mock).mock.calls.length;

    jest.advanceTimersByTime(1000);
    const afterOneTick = (mockClient.getState as jest.Mock).mock.calls.length;
    expect(afterOneTick).toBeGreaterThan(initialCalls);

    miele.stop();

    const afterStop = (mockClient.getState as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(1000);
    expect((mockClient.getState as jest.Mock).mock.calls.length).toBe(afterStop);
  });

  it('should handle poll errors gracefully', async () => {
    mockClient.getState = jest.fn().mockRejectedValue(new Error('Network error'));

    miele = new HomeAssistantMiele({ client: mockClient });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // Should not throw and default state should be preserved
    expect(miele.washer).toEqual({ name: 'Washer', inUse: false });
    expect(miele.dryer).toEqual({ name: 'Dryer', inUse: false });
  });

  it('should fall back to raw state for unmapped status values', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'sensor.washing_machine') {
        return Promise.resolve({ state: 'SomeNewStatus' });
      }
      return Promise.resolve({ state: 'off' });
    });

    miele = new HomeAssistantMiele({ client: mockClient });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    // Unmapped status falls back to the raw state value
    expect(miele.washer.status).toBe('SomeNewStatus');
    expect(miele.washer.inUse).toBe(true);
  });
});
