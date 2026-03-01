import fs from 'fs';
import Car, { CarConfig } from '../car';
import { HomeAssistantClient } from '../homeassistant-client';

jest.mock('fs');
jest.mock('../homeassistant-client');

describe('Car', () => {
  let car: Car;
  let mockClient: jest.Mocked<HomeAssistantClient>;

  const entityPrefix = 'kia_ev6';

  const defaultStates: Record<string, string> = {
    [`sensor.${entityPrefix}_ev_battery_level`]: '75',
    [`binary_sensor.${entityPrefix}_ev_battery_charge`]: 'off',
    [`binary_sensor.${entityPrefix}_ev_battery_plug`]: 'off',
    [`sensor.${entityPrefix}_ev_range`]: '200',
    [`sensor.${entityPrefix}_total_driving_range`]: '200',
    [`binary_sensor.${entityPrefix}_air_conditioner`]: 'off',
    [`lock.${entityPrefix}_door_lock`]: 'locked',
    [`binary_sensor.${entityPrefix}_front_left_door`]: 'off',
    [`binary_sensor.${entityPrefix}_front_right_door`]: 'off',
    [`binary_sensor.${entityPrefix}_back_left_door`]: 'off',
    [`binary_sensor.${entityPrefix}_back_right_door`]: 'off',
    [`binary_sensor.${entityPrefix}_trunk`]: 'off',
    [`binary_sensor.${entityPrefix}_hood`]: 'off',
    [`binary_sensor.${entityPrefix}_defrost`]: 'off',
    [`binary_sensor.${entityPrefix}_engine`]: 'off',
    [`sensor.${entityPrefix}_odometer`]: '15000',
    [`sensor.${entityPrefix}_last_updated_at`]: '2025-01-17T17:25:52.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockClient = {
      getState: jest.fn().mockImplementation(
        (entityId: string) => Promise.resolve({ state: defaultStates[entityId] ?? 'unavailable' }),
      ),
      callService: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<HomeAssistantClient>;

    (fs.existsSync as jest.Mock).mockReturnValue(false);

    const config: CarConfig = {
      client: mockClient,
      entityPrefix,
    };

    car = new Car(config);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should fetch status on initialization', async () => {
    // setStatus is called in constructor, wait for it
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClient.getState).toHaveBeenCalledWith(`sensor.${entityPrefix}_ev_battery_level`);
    expect(mockClient.getState).toHaveBeenCalledWith(`lock.${entityPrefix}_door_lock`);
  });

  it('should populate status from HA entities', async () => {
    await car.setStatus();

    expect(car.status).toBeDefined();
    expect(car.status!.doorLock).toBe(true);
    expect(car.status!.airCtrlOn).toBe(false);
    expect(car.status!.evStatus.batteryStatus).toBe(75);
    expect(car.status!.evStatus.batteryCharge).toBe(false);
    expect(car.status!.evStatus.batteryPlugin).toBe(0);
    expect(car.status!.evStatus.drvDistance[0].rangeByFuel.evModeRange.value).toBe(200);
    expect(car.odometer).toBe(15000);
  });

  it('should preserve cached range when HA returns zero', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      drvDistance: [{ rangeByFuel: { evModeRange: { value: 150, unit: 1 } }, type: 2 }],
    }));

    // Override ev_range to return 0
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === `sensor.${entityPrefix}_ev_range`) {
        return Promise.resolve({ state: '0' });
      }
      return Promise.resolve({ state: defaultStates[entityId] ?? 'unavailable' });
    });

    await car.setStatus();

    expect(car.status!.evStatus.drvDistance[0].rangeByFuel.evModeRange.value).toBe(150);
  });

  it('should write evStatus to cache', async () => {
    await car.setStatus();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/evStatus.json',
      expect.any(String),
    );
  });

  it('should handle lock', async () => {
    const result = await car.lock();

    expect(result).toBe('Locked');
    expect(mockClient.callService).toHaveBeenCalledWith('lock', 'lock', {
      entity_id: `lock.${entityPrefix}_door_lock`,
    });
  });

  it('should handle unlock', async () => {
    const result = await car.unlock();

    expect(result).toBe('Unlocked');
    expect(mockClient.callService).toHaveBeenCalledWith('lock', 'unlock', {
      entity_id: `lock.${entityPrefix}_door_lock`,
    });
  });

  it('should handle start with defaults', async () => {
    const result = await car.start();

    expect(result).toBe('Started');
    expect(mockClient.callService).toHaveBeenCalledWith('kia_uvo', 'start_climate', expect.objectContaining({
      temperature: 21,
      defrost: false,
      heating: false,
    }));
  });

  it('should handle start with config overrides', async () => {
    const result = await car.start({
      temperature: 24,
      heatedFeatures: true,
      defrost: true,
    });

    expect(result).toBe('Started');
    expect(mockClient.callService).toHaveBeenCalledWith('kia_uvo', 'start_climate', expect.objectContaining({
      temperature: 24,
      defrost: true,
      heating: true,
    }));
  });

  it('should handle stop', async () => {
    const result = await car.stop();

    expect(result).toBe('Stopped');
    expect(mockClient.callService).toHaveBeenCalledWith('kia_uvo', 'stop_climate', {
      entity_id: `lock.${entityPrefix}_door_lock`,
    });
  });

  it('should handle resync', async () => {
    await car.resync();

    expect(mockClient.callService).toHaveBeenCalledWith('kia_uvo', 'force_update', {
      entity_id: `lock.${entityPrefix}_door_lock`,
    });
  });

  it('should handle errors gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockClient.getState = jest.fn().mockRejectedValue(new Error('HA unavailable'));

    await car.setStatus();

    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch car status from Home Assistant:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('should keep last good status when all values are unavailable', async () => {
    // First, populate with good data
    await car.setStatus();
    const goodStatus = car.status;
    expect(goodStatus).toBeDefined();
    expect(goodStatus!.evStatus.batteryStatus).toBe(75);

    // Now return all unavailable
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockClient.getState = jest.fn().mockResolvedValue({ state: 'unavailable' });

    await car.setStatus();

    expect(car.status).toEqual(goodStatus);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Car status returned all zeros/unavailable, keeping last good status',
    );
    consoleSpy.mockRestore();
  });

  it('should keep last good status when all values are zero', async () => {
    // First, populate with good data
    await car.setStatus();
    const goodStatus = car.status;

    // Now return all zeros
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockClient.getState = jest.fn().mockResolvedValue({ state: '0' });

    await car.setStatus();

    expect(car.status).toEqual(goodStatus);
    consoleSpy.mockRestore();
  });
});
