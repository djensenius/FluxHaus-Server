import HomeAssistantRobot from '../homeassistant-robot';
import { HomeAssistantClient } from '../homeassistant-client';
import logger from '../logger';

// Mock HomeAssistantClient
jest.mock('../homeassistant-client');
jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: jest.fn(),
  },
}));

describe('HomeAssistantRobot', () => {
  let mockClient: jest.Mocked<HomeAssistantClient>;
  let robot: HomeAssistantRobot;
  let mockRobotLogger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock };
  const entityId = 'vacuum.test_robot';

  beforeEach(() => {
    jest.clearAllMocks();
    mockRobotLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    (logger.child as jest.Mock).mockReturnValue(mockRobotLogger);
    // Don't use fake timers globally, only where needed

    mockClient = new HomeAssistantClient({ url: 'http://test', token: 'token' }) as jest.Mocked<HomeAssistantClient>;
    mockClient.getState = jest.fn().mockResolvedValue({
      state: 'docked',
      attributes: {
        battery_level: 100,
        bin_full: false,
      },
    });
    mockClient.callService = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (robot) {
      robot.stop();
    }
    jest.useRealTimers();
  });

  it('should poll status on initialization', async () => {
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    expect(mockClient.getState).toHaveBeenCalledWith(entityId);
  });

  it('should update cachedStatus based on state', async () => {
    mockClient.getState.mockResolvedValue({
      state: 'cleaning',
      attributes: {
        battery_level: 85,
        bin_full: true,
      },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    // Wait for the async poll to complete
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(robot.cachedStatus.running).toBe(true);
    expect(robot.cachedStatus.batteryLevel).toBe(85);
    expect(robot.cachedStatus.binFull).toBe(true);
    expect(robot.cachedStatus.docking).toBe(false);
  });

  it('should use battery entity if provided', async () => {
    const batteryEntityId = 'sensor.test_battery';
    mockClient.getState.mockImplementation((id) => {
      if (id === entityId) {
        return Promise.resolve({
          state: 'docked',
          attributes: { bin_full: false },
        });
      }
      if (id === batteryEntityId) {
        return Promise.resolve({
          state: '75',
          attributes: {},
        });
      }
      return Promise.reject(new Error('Unknown entity'));
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      batteryEntityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(mockClient.getState).toHaveBeenCalledWith(entityId);
    expect(mockClient.getState).toHaveBeenCalledWith(batteryEntityId);
    expect(robot.cachedStatus.batteryLevel).toBe(75);
  });

  it('should handle charging state', async () => {
    mockClient.getState.mockResolvedValue({
      state: 'docked',
      attributes: {
        battery_level: 50,
      },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(robot.cachedStatus.charging).toBe(true);
    expect(robot.cachedStatus.docked).toBe(true);
    expect(robot.cachedStatus.running).toBe(false);
    expect(HomeAssistantRobot.dockedStatus(robot.cachedStatus)).toBe('CONTACT_DETECTED');
  });

  it('should handle docked but full battery (not charging)', async () => {
    mockClient.getState.mockResolvedValue({
      state: 'docked',
      attributes: {
        battery_level: 100,
      },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(robot.cachedStatus.charging).toBe(false);
    expect(robot.cachedStatus.docked).toBe(true);
    expect(HomeAssistantRobot.dockedStatus(robot.cachedStatus)).toBe('CONTACT_DETECTED');
  });

  it('should turn on the robot', async () => {
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOn();

    expect(mockClient.callService).toHaveBeenCalledWith('vacuum', 'start', { entity_id: entityId });
    // Should trigger a poll
    expect(mockClient.getState).toHaveBeenCalledTimes(2); // 1 from init, 1 from turnOn
  });

  it('should handle poll errors gracefully', async () => {
    mockClient.getState.mockRejectedValue(new Error('Network error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(mockRobotLogger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to poll robot Test Robot:',
    );
  });

  it('should handle turn on errors', async () => {
    mockClient.callService.mockRejectedValue(new Error('Service error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOn();

    expect(mockRobotLogger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to turn on robot Test Robot:',
    );
  });

  it('should handle turn off errors', async () => {
    mockClient.callService.mockRejectedValue(new Error('Service error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOff();

    expect(mockRobotLogger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to turn off robot Test Robot:',
    );
  });

  it('should identify (warn only)', () => {
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    robot.identify();
    expect(mockRobotLogger.warn).toHaveBeenCalledWith('Identify not implemented for Home Assistant robot');
  });

  it('should stop polling when requested', () => {
    jest.useFakeTimers();
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
      pollInterval: 1000,
    });

    expect(mockClient.getState).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    expect(mockClient.getState).toHaveBeenCalledTimes(2);

    robot.stop();

    jest.advanceTimersByTime(1000);
    expect(mockClient.getState).toHaveBeenCalledTimes(2); // Should not increase
  });

  it('should report active status correctly', () => {
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    // Default is inactive
    expect(robot.isActive()).toBe(false);

    // Simulate running
    robot.cachedStatus.running = true;
    expect(robot.isActive()).toBe(true);

    // Simulate docking
    robot.cachedStatus.running = false;
    robot.cachedStatus.docking = true;
    expect(robot.isActive()).toBe(true);
  });

  it('should report docked status correctly when battery entity is missing', async () => {
    const testRobot = new HomeAssistantRobot({
      name: 'TestRobot',
      entityId: 'vacuum.test',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: mockClient as any,
    });

    const mockState = {
      state: 'docked',
      attributes: {
        battery_level: undefined,
      },
    };

    (mockClient.getState as jest.Mock).mockResolvedValue(mockState);

    // Trigger poll
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (testRobot as any).poll();

    expect(testRobot.cachedStatus.docked).toBe(true);
    expect(HomeAssistantRobot.dockedStatus(testRobot.cachedStatus)).toBe('CONTACT_DETECTED');
  });

  it('should handle undefined bin_full attribute', async () => {
    mockClient.getState.mockResolvedValue({
      state: 'docked',
      attributes: {
        battery_level: 100,
        // bin_full is missing
      },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(robot.cachedStatus.binFull).toBeUndefined();
    expect(HomeAssistantRobot.binStatus(robot.cachedStatus)).toBeUndefined();
  });

  it('should calculate timeStarted from cleaning_time attribute', async () => {
    const cleaningTime = 60; // 1 minute
    mockClient.getState.mockResolvedValue({
      state: 'cleaning',
      attributes: {
        battery_level: 80,
        cleaning_time: cleaningTime,
      },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(robot.cachedStatus.running).toBe(true);
    expect(robot.cachedStatus.timeStarted).toBeDefined();
    expect(robot.cachedStatus.timeStarted?.getTime()).toBe(now - cleaningTime * 1000);

    jest.restoreAllMocks();
  });

  it('should set timeStarted when starting to run if cleaning_time is missing', async () => {
    // Start as docked
    mockClient.getState.mockResolvedValueOnce({
      state: 'docked',
      attributes: { battery_level: 100 },
    });

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(robot.cachedStatus.running).toBe(false);
    expect(robot.cachedStatus.timeStarted).toBeUndefined();

    // Transition to cleaning
    mockClient.getState.mockResolvedValueOnce({
      state: 'cleaning',
      attributes: { battery_level: 99 },
    });

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    // Trigger poll manually or wait for interval (but we mocked timers in other tests,
    // here we rely on manual poll or just calling updateStatus logic via poll)
    // Since we can't easily trigger the interval without fake timers which might conflict
    // with other tests if not careful,
    // let's just call poll manually via casting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (robot as any).poll();

    expect(robot.cachedStatus.running).toBe(true);
    expect(robot.cachedStatus.timeStarted).toBeDefined();
    expect(robot.cachedStatus.timeStarted?.getTime()).toBe(now);

    jest.restoreAllMocks();
  });
});
