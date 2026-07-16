import Blueair from '../blueair';
import { HomeAssistantClient } from '../homeassistant-client';

jest.mock('../homeassistant-client');

jest.mock('../influx', () => ({
  __esModule: true,
  writePoint: jest.fn(),
}));

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

describe('Blueair', () => {
  let mockClient: jest.Mocked<HomeAssistantClient>;
  let blueair: Blueair;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = new HomeAssistantClient({ url: 'http://test', token: 'token' }) as jest.Mocked<HomeAssistantClient>;
    mockClient.getState = jest.fn().mockResolvedValue({ state: 'off', attributes: {} });
    mockClient.callService = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (blueair) {
      blueair.stop();
    }
  });

  it('initializes with an empty cached status', () => {
    blueair = new Blueair({ client: mockClient });
    expect(blueair.cachedStatus.online).toBe(false);
    expect(blueair.cachedStatus.fanOn).toBe(false);
  });

  it('maps Home Assistant state into cached status', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'fan.blue_pure_fan') {
        return Promise.resolve({
          state: 'on',
          attributes: { percentage: 50, preset_mode: 'auto', preset_modes: ['auto', 'night'] },
        });
      }
      if (entityId === 'light.blue_pure_led_light') {
        return Promise.resolve({ state: 'on', attributes: { brightness: 128 } });
      }
      if (entityId === 'sensor.blue_pure_pm_2_5') {
        return Promise.resolve({ state: '7' });
      }
      if (entityId === 'sensor.blue_pure_filter_life') {
        return Promise.resolve({ state: '80' });
      }
      if (entityId === 'binary_sensor.blue_pure_online') {
        return Promise.resolve({ state: 'on' });
      }
      return Promise.resolve({ state: 'off', attributes: {} });
    });

    blueair = new Blueair({ client: mockClient });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    expect(blueair.cachedStatus.online).toBe(true);
    expect(blueair.cachedStatus.fanOn).toBe(true);
    expect(blueair.cachedStatus.fanSpeed).toBe(50);
    expect(blueair.cachedStatus.presetMode).toBe('auto');
    expect(blueair.cachedStatus.lightOn).toBe(true);
    expect(blueair.cachedStatus.pm25).toBe(7);
    expect(blueair.cachedStatus.filterLife).toBe(80);
  });

  it('normalizes light brightness to a percentage', async () => {
    mockClient.getState = jest.fn().mockImplementation((entityId: string) => {
      if (entityId === 'light.blue_pure_led_light') {
        return Promise.resolve({ state: 'on', attributes: { brightness: 255 } });
      }
      return Promise.resolve({ state: 'off', attributes: {} });
    });
    blueair = new Blueair({ client: mockClient });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(blueair.cachedStatus.brightness).toBe(100);
  });

  it('turns the fan on and off', async () => {
    blueair = new Blueair({ client: mockClient });
    await blueair.setFan(true);
    expect(mockClient.callService).toHaveBeenCalledWith('fan', 'turn_on', { entity_id: 'fan.blue_pure_fan' });
    await blueair.setFan(false);
    expect(mockClient.callService).toHaveBeenCalledWith('fan', 'turn_off', { entity_id: 'fan.blue_pure_fan' });
  });

  it('clamps fan speed to the 0-100 range', async () => {
    blueair = new Blueair({ client: mockClient });
    await blueair.setSpeed(150);
    expect(mockClient.callService).toHaveBeenCalledWith('fan', 'set_percentage', {
      entity_id: 'fan.blue_pure_fan',
      percentage: 100,
    });
  });

  it('rejects an invalid preset mode', async () => {
    blueair = new Blueair({ client: mockClient });
    await expect(blueair.setPreset('bogus')).rejects.toThrow('Invalid preset mode');
    expect(mockClient.callService).not.toHaveBeenCalledWith('fan', 'set_preset_mode', expect.anything());
  });

  it('accepts a valid preset mode', async () => {
    blueair = new Blueair({ client: mockClient });
    const result = await blueair.setPreset('auto');
    expect(mockClient.callService).toHaveBeenCalledWith('fan', 'set_preset_mode', {
      entity_id: 'fan.blue_pure_fan',
      preset_mode: 'auto',
    });
    expect(result).toBe('Preset auto');
  });

  it('controls the LED light and brightness', async () => {
    blueair = new Blueair({ client: mockClient });
    await blueair.setLight(true);
    expect(mockClient.callService).toHaveBeenCalledWith('light', 'turn_on', { entity_id: 'light.blue_pure_led_light' });
    await blueair.setBrightness(200);
    expect(mockClient.callService).toHaveBeenCalledWith('light', 'turn_on', {
      entity_id: 'light.blue_pure_led_light',
      brightness_pct: 100,
    });
  });

  it('stops polling when stopped', () => {
    jest.useFakeTimers();
    const clearSpy = jest.spyOn(global, 'clearInterval');
    blueair = new Blueair({ client: mockClient });
    blueair.stop();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    jest.useRealTimers();
  });
});
