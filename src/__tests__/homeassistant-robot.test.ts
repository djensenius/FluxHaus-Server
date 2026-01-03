import HomeAssistantRobot from '../homeassistant-robot';
import { HomeAssistantClient } from '../homeassistant-client';

// Mock HomeAssistantClient
jest.mock('../homeassistant-client');

describe('HomeAssistantRobot', () => {
  let mockClient: jest.Mocked<HomeAssistantClient>;
  let robot: HomeAssistantRobot;
  const entityId = 'vacuum.test_robot';

  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(robot.cachedStatus.running).toBe(false);
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
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockClient.getState.mockRejectedValue(new Error('Network error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(consoleSpy).toHaveBeenCalledWith('Failed to poll robot Test Robot:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should handle turn on errors', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockClient.callService.mockRejectedValue(new Error('Service error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOn();

    expect(consoleSpy).toHaveBeenCalledWith('Failed to turn on robot Test Robot:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should handle turn off errors', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockClient.callService.mockRejectedValue(new Error('Service error'));

    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOff();

    expect(consoleSpy).toHaveBeenCalledWith('Failed to turn off robot Test Robot:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('should identify (warn only)', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    robot.identify();
    expect(consoleSpy).toHaveBeenCalledWith('Identify not implemented for Home Assistant robot');
    consoleSpy.mockRestore();
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
});
