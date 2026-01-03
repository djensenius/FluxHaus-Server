import HomeAssistantRobot from './homeassistant-robot';
import { HomeAssistantClient } from './homeassistant-client';

// Mock HomeAssistantClient
jest.mock('./homeassistant-client');

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

  it('should turn off the robot', async () => {
    robot = new HomeAssistantRobot({
      name: 'Test Robot',
      entityId,
      client: mockClient,
    });

    await robot.turnOff();

    expect(mockClient.callService).toHaveBeenCalledWith('vacuum', 'return_to_base', { entity_id: entityId });
    expect(mockClient.getState).toHaveBeenCalledTimes(2);
  });
});
