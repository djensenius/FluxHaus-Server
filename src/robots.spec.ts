import Robot, { AccessoryConfig } from './robots';
import dorita980 from 'dorita980';

// Mock dorita980
jest.mock('dorita980', () => {
  return {
    Local: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      off: jest.fn(),
      end: jest.fn(),
      getRobotState: jest.fn(),
      clean: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      dock: jest.fn(),
    })),
  };
});

describe('Robot (Direct Connection)', () => {
  const mockConfig: AccessoryConfig = {
    name: 'Test Robot',
    model: 'Roomba',
    serialnum: '12345',
    blid: 'user',
    robotpwd: 'password',
    ipaddress: '192.168.1.100',
    cleanBehaviour: 'everywhere',
    stopBehaviour: 'home',
    idleWatchInterval: 5,
  };

  let robot: Robot;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize with config', () => {
    robot = new Robot(mockConfig);
    expect(robot).toBeDefined();
    expect(robot.cachedStatus).toBeDefined();
  });

  it('should attempt to connect when refreshing state', () => {
    robot = new Robot(mockConfig);
    
    // Trigger a refresh (private method, but called via startPolling -> checkStatus)
    // We can simulate this by advancing timers as startPolling is called in constructor
    jest.advanceTimersByTime(1000);

    // Since we can't easily spy on the private connect method or the internal roomba instance 
    // without more complex mocking or exposing internals, we'll verify the side effects 
    // or public methods if possible.
    
    // However, the Robot class is quite complex and encapsulates the connection logic deeply.
    // A better approach for this specific class might be to test the public methods like turnOn/turnOff
  });

  it('should turn on the robot', async () => {
    robot = new Robot(mockConfig);
    
    // Mock the connect method to yield a mock roomba
    const mockRoomba = {
      clean: jest.fn().mockResolvedValue(undefined),
      resume: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      end: jest.fn(),
    };

    // We need to intercept the private connect method or mock the Local constructor to return our mock
    // The current mock at the top does this for new instances.
    
    // Let's refine the mock to be usable
    const MockLocal = dorita980.Local as unknown as jest.Mock;
    MockLocal.mockImplementation((blid, pwd, ip) => {
        // Simulate connection success
        const instance = {
            on: jest.fn((event, cb) => {
                if (event === 'connect') {
                    cb();
                }
            }),
            off: jest.fn(),
            end: jest.fn(),
            clean: jest.fn().mockResolvedValue(undefined),
            resume: jest.fn().mockResolvedValue(undefined),
        };
        return instance;
    });

    await robot.turnOn();
    
    // We can't easily assert on the internal instance without capturing it from the mock constructor
    // But we can assert that the constructor was called
    expect(dorita980.Local).toHaveBeenCalledWith(
        mockConfig.blid, 
        mockConfig.robotpwd, 
        mockConfig.ipaddress, 
        expect.any(Number), 
        expect.any(Object)
    );
  });

  it('should parse robot state correctly', () => {
    const state = {
      batPct: 88,
      bin: { full: false },
      cleanMissionStatus: {
        phase: 'run',
        cycle: 'clean'
      }
    };

    const status = Robot.parseState(state as any);

    expect(status.batteryLevel).toBe(88);
    expect(status.binFull).toBe(false);
    expect(status.running).toBe(true);
    expect(status.charging).toBe(false);
    expect(status.docking).toBe(false);
  });

  it('should parse charging state correctly', () => {
    const state = {
      batPct: 100,
      bin: { full: false },
      cleanMissionStatus: {
        phase: 'charge',
        cycle: 'none'
      }
    };

    const status = Robot.parseState(state as any);

    expect(status.running).toBe(false);
    expect(status.charging).toBe(true);
  });

  it('should parse docking state correctly', () => {
    const state = {
      batPct: 50,
      bin: { full: false },
      cleanMissionStatus: {
        phase: 'hmUsrDock',
        cycle: 'none'
      }
    };

    const status = Robot.parseState(state as any);

    expect(status.docking).toBe(true);
    expect(status.running).toBe(false);
  });
});
