import HomebridgeRobot from './homebridge-robot';
import { HomebridgeClient } from './homebridge-client';

// Mock HomebridgeClient
jest.mock('./homebridge-client');

describe('HomebridgeRobot', () => {
  let mockClient: jest.Mocked<HomebridgeClient>;
  let robot: HomebridgeRobot;
  const uniqueId = 'test-robot-id';

  const UUIDS = {
    On: '00000025-0000-1000-8000-0026BB765291',
    BatteryLevel: '00000068-0000-1000-8000-0026BB765291',
    ChargingState: '0000008F-0000-1000-8000-0026BB765291',
    FilterChangeIndication: '000000AC-0000-1000-8000-0026BB765291',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Don't use fake timers globally, only where needed
    
    mockClient = new HomebridgeClient({ url: 'http://test' }) as jest.Mocked<HomebridgeClient>;
    mockClient.getAccessory = jest.fn().mockResolvedValue({
      serviceCharacteristics: []
    });
    mockClient.setCharacteristic = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (robot) {
      robot.stop();
    }
    jest.useRealTimers();
  });

  it('should poll status on initialization', async () => {
    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
    });

    expect(mockClient.getAccessory).toHaveBeenCalledWith(uniqueId);
  });

  it('should update cachedStatus based on accessory data', async () => {
    const mockAccessory = {
      serviceCharacteristics: [
        {
          characteristics: [
            { type: UUIDS.On, value: true },
            { type: UUIDS.BatteryLevel, value: 85 },
            { type: UUIDS.ChargingState, value: 1 }, // Charging
            { type: UUIDS.FilterChangeIndication, value: 1 }, // Bin full
          ]
        }
      ]
    };

    mockClient.getAccessory.mockResolvedValue(mockAccessory);

    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
    });

    // Wait for the async poll to complete
    // We can wait for the microtask queue to drain
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(robot.cachedStatus.running).toBe(true);
    expect(robot.cachedStatus.batteryLevel).toBe(85);
    expect(robot.cachedStatus.charging).toBe(true);
    expect(robot.cachedStatus.binFull).toBe(true);
  });

  it('should handle missing characteristics gracefully', async () => {
    const mockAccessory = {
      serviceCharacteristics: [
        {
          characteristics: [
            // Only battery provided
            { type: UUIDS.BatteryLevel, value: 50 },
          ]
        }
      ]
    };

    mockClient.getAccessory.mockResolvedValue(mockAccessory);

    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(robot.cachedStatus.batteryLevel).toBe(50);
    expect(robot.cachedStatus.running).toBe(false); // Default
    expect(robot.cachedStatus.charging).toBe(false); // Default
  });

  it('should turn on the robot', async () => {
    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
    });

    await robot.turnOn();

    expect(mockClient.setCharacteristic).toHaveBeenCalledWith(uniqueId, UUIDS.On, true);
    // Should trigger a poll
    expect(mockClient.getAccessory).toHaveBeenCalledTimes(2); // 1 from init, 1 from turnOn
  });

  it('should turn off the robot', async () => {
    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
    });

    await robot.turnOff();

    expect(mockClient.setCharacteristic).toHaveBeenCalledWith(uniqueId, UUIDS.On, false);
    expect(mockClient.getAccessory).toHaveBeenCalledTimes(2);
  });

  it('should poll periodically', () => {
    jest.useFakeTimers();
    
    robot = new HomebridgeRobot({
      name: 'Test Robot',
      uniqueId,
      client: mockClient,
      pollInterval: 1000,
    });

    expect(mockClient.getAccessory).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    expect(mockClient.getAccessory).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1000);
    expect(mockClient.getAccessory).toHaveBeenCalledTimes(3);
  });
});
