import fs from 'fs';
import { BlueLinky } from 'bluelinky';
import Car, { CarConfig } from '../car';

jest.mock('fs');
jest.mock('bluelinky');

describe('Car', () => {
  let car: Car;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockClient: any;
  let mockVehicle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const mockConfig: CarConfig = {
    username: 'testuser',
    password: 'testpassword',
    region: 'CA',
    brand: 'kia',
    pin: '1234',
    useInfo: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockVehicle = {
      status: jest.fn(),
      odometer: jest.fn(),
      lock: jest.fn(),
      unlock: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    };

    mockClient = {
      on: jest.fn(),
      login: jest.fn(),
    };

    (BlueLinky as unknown as jest.Mock).mockImplementation(() => mockClient);

    car = new Car(mockConfig);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize correctly', () => {
    expect(BlueLinky).toHaveBeenCalledWith({
      username: mockConfig.username,
      password: mockConfig.password,
      region: mockConfig.region,
      brand: mockConfig.brand,
      pin: mockConfig.pin,
    });
    expect(mockClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
  });

  it('should handle onReadyHandler', async () => {
    const onReadyHandler = mockClient.on.mock.calls[0][1];
    mockVehicle.status.mockResolvedValue({
      lastStatusDate: '20230101120000',
      evStatus: {
        drvDistance: [{ rangeByFuel: { evModeRange: { unit: 100 } } }],
      },
    });
    mockVehicle.odometer.mockResolvedValue({ unit: 10000 });
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      drvDistance: [{ rangeByFuel: { evModeRange: { unit: 50 } } }],
    }));

    await onReadyHandler([mockVehicle]);

    expect(car.vehicle).toBe(mockVehicle);
    expect(mockVehicle.status).toHaveBeenCalled();
    expect(mockVehicle.odometer).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('should handle setStatus with refresh', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.status.mockResolvedValue({
      lastStatusDate: '20230101120000',
    });

    await car.setStatus(true);

    expect(mockVehicle.status).toHaveBeenCalledWith({
      refresh: true,
      parsed: false,
      useInfo: true,
    });
  });

  it('should handle lock', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.lock.mockResolvedValue('Locked');

    const result = await car.lock();

    expect(result).toBe('Locked');
    expect(mockVehicle.lock).toHaveBeenCalled();
  });

  it('should return "No vehicle found" for lock if no vehicle', async () => {
    const result = await car.lock();
    expect(result).toBe('No vehicle found');
  });

  it('should handle unlock', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.unlock.mockResolvedValue('Unlocked');

    const result = await car.unlock();

    expect(result).toBe('Unlocked');
    expect(mockVehicle.unlock).toHaveBeenCalled();
  });

  it('should return "No vehicle found" for unlock if no vehicle', async () => {
    const result = await car.unlock();
    expect(result).toBe('No vehicle found');
  });

  it('should handle start', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.start.mockResolvedValue('Started');

    const result = await car.start();

    expect(result).toBe('Started');
    expect(mockVehicle.start).toHaveBeenCalledWith({
      hvac: true,
      temperature: 21,
      duration: 120,
      defrost: false,
      heatedFeatures: false,
      unit: 'C',
    });
  });

  it('should return "No vehicle found" for start if no vehicle', async () => {
    const result = await car.start();
    expect(result).toBe('No vehicle found');
  });

  it('should handle stop', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.stop.mockResolvedValue('Stopped');

    const result = await car.stop();

    expect(result).toBe('Stopped');
    expect(mockVehicle.stop).toHaveBeenCalled();
  });

  it('should return "No vehicle found" for stop if no vehicle', async () => {
    const result = await car.stop();
    expect(result).toBe('No vehicle found');
  });

  it('should handle resync', async () => {
    car.vehicle = mockVehicle;
    mockVehicle.status.mockResolvedValue({
      lastStatusDate: '20230101120000',
    });

    await car.resync();

    expect(mockVehicle.status).toHaveBeenCalledWith({
      refresh: true,
      parsed: false,
      useInfo: true,
    });
  });

  it('should handle interval login', () => {
    jest.advanceTimersByTime(1000 * 60 * 60 * 12);
    expect(mockClient.login).toHaveBeenCalled();
  });
});
