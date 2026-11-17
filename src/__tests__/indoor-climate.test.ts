import IndoorClimate from '../indoor-climate';
import { HomeAssistantClient } from '../homeassistant-client';

vi.mock('../homeassistant-client');

vi.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const DISCOVERY = [
  { entity_id: 'climate.home', device_id: 'dev_home', device_name: 'Home', area: 'Hallway' },
  {
    entity_id: 'sensor.home_current_temperature', device_id: 'dev_home', device_name: 'Home', area: 'Hallway',
  },
  { entity_id: 'sensor.home_current_humidity', device_id: 'dev_home', device_name: 'Home' },
  { entity_id: 'binary_sensor.home_occupancy', device_id: 'dev_home', device_name: 'Home' },
  { entity_id: 'sensor.kitchen_temperature', device_id: 'dev_kitchen', device_name: null, area: null },
  { entity_id: 'binary_sensor.kitchen_occupancy', device_id: 'dev_kitchen', device_name: null },
  {
    entity_id: 'sensor.bedroom_temperature', device_id: 'dev_bedroom', device_name: 'Bedroom', area: ' Primary Bedroom ',
  },
  { entity_id: 'binary_sensor.bedroom_occupancy', device_id: 'dev_bedroom', device_name: 'Bedroom' },
  { entity_id: 'weather.home', device_id: 'dev_home', device_name: 'Home' },
];

const STATES: Record<string, unknown> = {
  'climate.home': {
    state: 'heat',
    attributes: {
      friendly_name: 'Home',
      current_temperature: 21.5,
      current_humidity: 40,
      hvac_action: 'heating',
      temperature: 21,
      preset_mode: 'home',
    },
  },
  'sensor.home_current_temperature': {
    state: '21.5',
    attributes: { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'Home Current Temperature' },
    last_updated: '2026-01-01T00:00:00+00:00',
  },
  'sensor.home_current_humidity': { state: '40', attributes: { device_class: 'humidity' } },
  'binary_sensor.home_occupancy': { state: 'off', attributes: { device_class: 'occupancy' } },
  'sensor.kitchen_temperature': {
    state: '20.1',
    attributes: { device_class: 'temperature', friendly_name: 'Kitchen Temperature' },
  },
  'binary_sensor.kitchen_occupancy': { state: 'unavailable', attributes: { device_class: 'occupancy' } },
  'sensor.bedroom_temperature': {
    state: '19.8',
    attributes: { device_class: 'temperature', unit_of_measurement: '°C', friendly_name: 'Bedroom Temperature' },
    last_changed: '2026-01-01T00:05:00+00:00',
  },
  'binary_sensor.bedroom_occupancy': { state: 'on', attributes: { device_class: 'occupancy' } },
};

describe('IndoorClimate', () => {
  let mockClient: vi.Mocked<HomeAssistantClient>;
  let indoorClimate: IndoorClimate | undefined;

  function mockStates(states: Record<string, unknown>) {
    mockClient.getState = vi.fn().mockImplementation((entityId: string) => (
      entityId in states ? Promise.resolve(states[entityId]) : Promise.reject(new Error('Not found'))
    ));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = new HomeAssistantClient({ url: 'http://test', token: 'token' }) as vi.Mocked<HomeAssistantClient>;
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY));
    mockStates(STATES);
  });

  afterEach(() => {
    indoorClimate?.stop();
    indoorClimate = undefined;
  });

  it('discovers integration entities and maps rooms, occupancy and the thermostat', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();

    expect(mockClient.renderTemplate).toHaveBeenCalledWith(expect.stringContaining("integration_entities('ecobee')"));
    expect(mockClient.getState).not.toHaveBeenCalledWith('weather.home');
    expect(indoorClimate.cachedStatus.timestamp.getTime()).toBeGreaterThan(0);
    expect(indoorClimate.cachedStatus.sensors).toEqual([
      {
        entityId: 'sensor.home_current_temperature',
        name: 'Home',
        area: 'Hallway',
        temperature: 21.5,
        unit: '°C',
        available: true,
        occupied: false,
        isThermostat: true,
        lastUpdated: '2026-01-01T00:00:00+00:00',
      },
      {
        entityId: 'sensor.bedroom_temperature',
        name: 'Bedroom',
        area: 'Primary Bedroom',
        temperature: 19.8,
        unit: '°C',
        available: true,
        occupied: true,
        isThermostat: false,
        lastUpdated: '2026-01-01T00:05:00+00:00',
      },
      {
        entityId: 'sensor.kitchen_temperature',
        name: 'Kitchen',
        area: null,
        temperature: 20.1,
        unit: null,
        available: true,
        occupied: null,
        isThermostat: false,
        lastUpdated: null,
      },
    ]);
    expect(indoorClimate.cachedStatus.thermostat).toEqual({
      entityId: 'climate.home',
      name: 'Home',
      area: 'Hallway',
      available: true,
      currentTemperature: 21.5,
      currentHumidity: 40,
      hvacMode: 'heat',
      hvacAction: 'heating',
      targetTemperature: 21,
      targetTemperatureLow: null,
      targetTemperatureHigh: null,
      presetMode: 'home',
    });
    expect(indoorClimate.cachedStatus.unit).toBe('°C');
  });

  it('maps heat_cool set points and falls back to the thermostat humidity sensor', async () => {
    mockStates({
      ...STATES,
      'climate.home': {
        state: 'heat_cool',
        attributes: { current_temperature: 21.5, target_temp_low: 20, target_temp_high: 24 },
      },
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat).toMatchObject({
      hvacMode: 'heat_cool',
      targetTemperature: null,
      targetTemperatureLow: 20,
      targetTemperatureHigh: 24,
      currentHumidity: 40,
    });
  });

  it('flags sensors on any climate device and ignores climate entities without a device', async () => {
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY.filter((e) => e.entity_id !== 'climate.home' && e.entity_id !== 'sensor.kitchen_temperature'),
      { entity_id: 'climate.home', device_id: null, device_name: null, area: null },
      { entity_id: 'climate.upstairs', device_id: 'dev_bedroom', device_name: 'Bedroom', area: null },
      { entity_id: 'sensor.kitchen_temperature', device_id: null, device_name: null, area: null },
    ]));
    mockStates({ ...STATES, 'climate.upstairs': { state: 'off', attributes: {} } });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat?.entityId).toBe('climate.home');
    expect(indoorClimate.cachedStatus.sensors.map((s) => [s.entityId, s.isThermostat])).toEqual([
      ['sensor.bedroom_temperature', true],
      ['sensor.home_current_temperature', false],
      ['sensor.kitchen_temperature', false],
    ]);
  });

  it('exposes Influx object ids for the discovered temperature sensors', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.temperatureObjectIds()).toEqual([
      'home_current_temperature',
      'bedroom_temperature',
      'kitchen_temperature',
    ]);
  });

  it('keeps previously known sensors as unavailable and skips unknown failures', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();

    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY,
      { entity_id: 'sensor.office_temperature', device_id: 'dev_office', device_name: 'Office' },
    ]));
    const states: Record<string, unknown> = {
      ...STATES,
      'sensor.kitchen_temperature': { state: 'unavailable', attributes: {} },
      'climate.home': { state: 'unavailable', attributes: { friendly_name: 'Home' } },
    };
    delete states['sensor.bedroom_temperature'];
    mockStates(states);
    await indoorClimate.refresh();

    const { sensors, thermostat } = indoorClimate.cachedStatus;
    expect(sensors.map((s) => s.entityId)).not.toContain('sensor.office_temperature');
    expect(sensors.find((s) => s.entityId === 'sensor.bedroom_temperature')).toMatchObject({
      name: 'Bedroom', temperature: null, available: false, occupied: true,
    });
    expect(sensors.find((s) => s.entityId === 'sensor.kitchen_temperature')).toMatchObject({
      name: 'Kitchen', temperature: null, available: false,
    });
    expect(thermostat).toMatchObject({ available: false, hvacMode: null, currentTemperature: 21.5 });
  });

  it('treats a getState that never resolves as a failed fetch', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, requestTimeout: 20 });
    await indoorClimate.refresh();
    const respond = mockClient.getState.getMockImplementation()!;
    mockClient.getState = vi.fn().mockImplementation((entityId: string) => (
      entityId === 'sensor.bedroom_temperature' ? new Promise(() => {}) : respond(entityId)
    ));
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.bedroom_temperature'))
      .toMatchObject({ available: false, temperature: null, unit: '°C' });
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.kitchen_temperature'))
      .toMatchObject({ available: true, temperature: 20.1 });
  });

  it('retries discovery until it succeeds and keeps the last good entities on failure', async () => {
    mockClient.renderTemplate = vi.fn().mockRejectedValue(new Error('HA down'));
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors).toEqual([]);
    expect(mockClient.getState).not.toHaveBeenCalled();

    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY));
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors).toHaveLength(3);

    indoorClimate.stop();
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();
    mockClient.renderTemplate = vi.fn().mockResolvedValue('not json');
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).toHaveBeenCalled();
    expect(indoorClimate.cachedStatus.sensors).toHaveLength(3);
  });

  it('keeps the previously discovered sensors when a later discovery renders []', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();
    mockClient.renderTemplate = vi.fn().mockResolvedValue('[]');
    mockStates({
      ...STATES,
      'sensor.bedroom_temperature': { state: '22.4', attributes: { device_class: 'temperature' } },
    });
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).toHaveBeenCalled();
    // The old entities are still polled, so fresh readings come through.
    expect(indoorClimate.cachedStatus.sensors.map((s) => [s.entityId, s.temperature])).toEqual([
      ['sensor.home_current_temperature', 21.5],
      ['sensor.bedroom_temperature', 22.4],
      ['sensor.kitchen_temperature', 20.1],
    ]);
  });

  it('never calls Home Assistant for an invalid integration name', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, integration: "ecobee') }}{{ states" });
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).not.toHaveBeenCalled();
    expect(mockClient.getState).not.toHaveBeenCalled();
    expect(indoorClimate.cachedStatus).toEqual({
      timestamp: new Date(0), thermostat: null, sensors: [], unit: null,
    });
  });
});
