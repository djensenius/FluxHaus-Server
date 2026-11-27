import IndoorClimate, { ThermostatControlError, ThermostatControls } from '../indoor-climate';
import { ClimatePlacementService } from '../climate-placement-service';
import { HomeAssistantClient, HomeAssistantRequestError } from '../homeassistant-client';

vi.mock('../homeassistant-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../homeassistant-client')>();
  // Mock the client, but keep the real error class so instanceof checks work.
  return { HomeAssistantClient: vi.fn(), HomeAssistantRequestError: actual.HomeAssistantRequestError };
});

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: () => log,
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
    mockClient.getConfig = vi.fn().mockResolvedValue({ unit_system: { temperature: '°C' } });
    mockStates(STATES);
  });

  afterEach(() => {
    indoorClimate?.stop();
    indoorClimate = undefined;
  });

  it('discovers integration entities and maps rooms, occupancy and the thermostat', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();

    expect(mockClient.renderTemplate).toHaveBeenCalledWith(
      expect.stringContaining('integration_entities("ecobee")'),
      { signal: expect.any(AbortSignal) },
    );
    expect(mockClient.getState).toHaveBeenCalledWith('climate.home', { signal: expect.any(AbortSignal) });
    expect(mockClient.getState).not.toHaveBeenCalledWith('weather.home', expect.anything());
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
      hvacModes: [],
      presetModes: [],
      fanMode: null,
      fanModes: [],
      minTemp: null,
      maxTemp: null,
      targetTempStep: null,
      temperatureUnit: '°C',
    });
    expect(indoorClimate.cachedStatus.unit).toBe('°C');
    expect(mockClient.getConfig).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it('reads the thermostat unit from Home Assistant, retrying until it is known', async () => {
    mockClient.getConfig = vi.fn().mockRejectedValue(new Error('HA down'));
    mockStates({
      ...STATES,
      'sensor.home_current_temperature': { state: '70', attributes: { device_class: 'temperature' } },
      'sensor.bedroom_temperature': { state: '68', attributes: { device_class: 'temperature' } },
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat?.temperatureUnit).toBeNull();
    expect(indoorClimate.cachedStatus.unit).toBeNull();

    // Discovery isn't due yet, but the unit is fetched again because it's unknown.
    mockClient.getConfig = vi.fn().mockResolvedValue({ unit_system: { temperature: '°F' } });
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).toHaveBeenCalledTimes(1);
    expect(indoorClimate.cachedStatus.thermostat?.temperatureUnit).toBe('°F');
    // With no sensor reporting a unit, the snapshot falls back to HA's.
    expect(indoorClimate.cachedStatus.unit).toBe('°F');

    await indoorClimate.refresh();
    expect(mockClient.getConfig).toHaveBeenCalledTimes(1);
  });

  it('maps the thermostat control capabilities, keeping only strings and finite numbers', async () => {
    mockStates({
      ...STATES,
      'climate.home': {
        state: 'heat',
        attributes: {
          hvac_modes: ['off', 'heat', 3, null, 'cool'],
          preset_modes: 'home',
          fan_mode: 'auto',
          fan_modes: ['auto', 'on'],
          min_temp: 7,
          max_temp: 'warm',
          target_temp_step: 0.5,
        },
      },
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat).toMatchObject({
      hvacModes: ['off', 'heat', 'cool'],
      presetModes: [],
      fanMode: 'auto',
      fanModes: ['auto', 'on'],
      minTemp: 7,
      maxTemp: null,
      targetTempStep: 0.5,
    });
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

  it('converts the thermostat sensor fallback to the thermostat unit, or drops it', async () => {
    const sensor = (unit: string) => ({
      state: '70', attributes: { device_class: 'temperature', unit_of_measurement: unit },
    });
    const noCurrentTemperature = { state: 'heat', attributes: {} };
    mockStates({ ...STATES, 'climate.home': noCurrentTemperature, 'sensor.home_current_temperature': sensor('°F') });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat).toMatchObject({ currentTemperature: 21.1, temperatureUnit: '°C' });

    mockStates({ ...STATES, 'climate.home': noCurrentTemperature, 'sensor.home_current_temperature': sensor('K') });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat?.currentTemperature).toBeNull();

    // A unitless reading could be on either scale.
    const unitless = { state: '70', attributes: { device_class: 'temperature' } };
    mockStates({ ...STATES, 'climate.home': noCurrentTemperature, 'sensor.home_current_temperature': unitless });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.thermostat?.currentTemperature).toBeNull();
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

  it('associates placement sensors and occupancy by device, not entity names', async () => {
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY.filter((e) => !['sensor.home_current_temperature', 'binary_sensor.home_occupancy'].includes(e.entity_id)),
      { entity_id: 'sensor.renamed_temperature', device_id: 'dev_home', device_name: 'Home' },
      { entity_id: 'binary_sensor.hall_motion', device_id: 'dev_home', device_name: 'Home' },
      { entity_id: 'binary_sensor.renamed_occupancy', device_id: 'dev_kitchen', device_name: 'Kitchen' },
      { entity_id: 'climate.upstairs', device_id: 'dev_upstairs', device_name: 'Upstairs' },
      { entity_id: 'sensor.upstairs_temperature', device_id: 'dev_upstairs', device_name: 'Upstairs' },
      { entity_id: 'binary_sensor.upstairs_occupancy', device_id: 'dev_upstairs', device_name: 'Upstairs' },
    ]));
    mockStates({
      ...STATES,
      'sensor.renamed_temperature': STATES['sensor.home_current_temperature'],
      'binary_sensor.hall_motion': STATES['binary_sensor.home_occupancy'],
      'binary_sensor.renamed_occupancy': STATES['binary_sensor.home_occupancy'],
      'climate.upstairs': { state: 'off', attributes: {} },
      'sensor.upstairs_temperature': STATES['sensor.home_current_temperature'],
      'binary_sensor.upstairs_occupancy': STATES['binary_sensor.bedroom_occupancy'],
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();

    const placement = indoorClimate.placementDiscovery();
    expect(placement.climateEntityId).toBe('climate.home');
    expect(placement.thermostatTemperatureEntityId).toBeNull();
    expect(placement.thermostatOccupancyEntityId).toBe('binary_sensor.hall_motion');
    expect(placement.occupancyByTemperature.get('sensor.renamed_temperature')).toBe('binary_sensor.hall_motion');
    // Two occupancy entities on the Kitchen device are ambiguous, including
    // one whose name resembles the thermostat's renamed temperature.
    expect(placement.occupancyByTemperature.has('sensor.kitchen_temperature')).toBe(false);
    expect(placement.occupancyByTemperature.get('sensor.upstairs_temperature')).toBe('binary_sensor.upstairs_occupancy');
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.upstairs_temperature')!.isThermostat)
      .toBe(true);
  });

  it('does not identify a sole thermostat-device temperature as the reported comfort reading', async () => {
    mockStates({
      ...STATES,
      'climate.home': { state: 'heat', attributes: { current_temperature: 20 } },
      'sensor.home_current_temperature': {
        state: '24', attributes: { device_class: 'temperature', unit_of_measurement: '°C' },
      },
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();

    expect(indoorClimate.cachedStatus.thermostat?.currentTemperature).toBe(20);
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.home_current_temperature'))
      .toMatchObject({ temperature: 24, isThermostat: true });
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().thermostatOccupancyEntityId).toBe('binary_sensor.home_occupancy');

    // A matching snapshot also doesn't establish what the sensor measured
    // throughout its historical series.
    mockStates({
      ...STATES,
      'climate.home': { state: 'heat', attributes: { current_temperature: 20 } },
      'sensor.home_current_temperature': {
        state: '20', attributes: { device_class: 'temperature', unit_of_measurement: '°C' },
      },
    });
    await indoorClimate.refresh();
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
  });

  it('uses the discovered climate attribute history rather than the physical sensor history', async () => {
    mockStates({
      ...STATES,
      'climate.home': { state: 'heat', attributes: { current_temperature: 20 } },
      'sensor.home_current_temperature': {
        state: '24', attributes: { device_class: 'temperature', unit_of_measurement: '°C' },
      },
    });
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    const time = '2026-01-19T06:00:00Z';
    const row = (field: string, value: string) => ({
      _time: time, _field: field, _value: value, domain: 'climate', entity_id: 'home',
    });
    const query = vi.fn(async (flux: string) => {
      if (flux.includes('union(')) return [
        row('state', 'heat'), row('hvac_action_str', 'heating'), row('temperature', '21'),
        { _time: time, _field: 'state', _value: 'home', domain: 'select', entity_id: 'home_current_mode' },
      ];
      if (flux.includes('r._value == "cooling"')) return [];
      if (flux.includes('r._field == "current_temperature"')) return [
        { _time: time, _value: '20', _measurement: 'climate', domain: 'climate', entity_id: 'home' },
      ];
      return [
        { _time: time, _value: '24', _measurement: '°C', entity_id: 'home_current_temperature' },
        { _time: time, _value: '18', _measurement: '°C', entity_id: 'bedroom_temperature' },
        { _time: time, _value: '20', _measurement: '°C', entity_id: 'kitchen_temperature' },
      ];
    });
    const service = new ClimatePlacementService({
      influxdb: { configured: true, query } as never,
      bucket: 'home_assistant',
      indoorClimate,
      now: () => new Date('2026-01-20T00:00:00Z'),
      timeZone: 'UTC',
    });
    const result = await service.getInsights('7', { thermostatHome: 'true' });
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(result.sensors.find((s) => s.id === 'bedroom_temperature')!.periodOffsets.home).toBe(-2);
    expect(result.sensors.find((s) => s.id === 'home_current_temperature')!.verdictSummary).toContain('not known');
    expect(query.mock.calls.some(([flux]) => flux.includes('r.domain == "climate" and r.entity_id == "home"')
      && flux.includes('r._field == "current_temperature"'))).toBe(true);
  });

  it('leaves placement identities unknown when devices or matches are ambiguous', async () => {
    const extra = [
      { entity_id: 'sensor.second_home_temperature', device_id: 'dev_home', device_name: 'Home' },
      { entity_id: 'binary_sensor.second_home_occupancy', device_id: 'dev_home', device_name: 'Home' },
    ];
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([...DISCOVERY, ...extra]));
    mockStates({
      ...STATES,
      'sensor.second_home_temperature': STATES['sensor.home_current_temperature'],
      'binary_sensor.second_home_occupancy': STATES['binary_sensor.home_occupancy'],
    });
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().occupancyByTemperature.has('sensor.home_current_temperature')).toBe(false);

    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY.map((entity) => (
      entity.entity_id === 'climate.home' ? { ...entity, device_id: null } : entity
    ))));
    await indoorClimate.refresh();
    const placement = indoorClimate.placementDiscovery();
    expect(placement.thermostatTemperatureEntityId).toBeNull();
    expect(placement.thermostatOccupancyEntityId).toBeNull();
    // Without the climate's device, no unflagged temperature can safely be
    // distinguished from a thermostat reading for placement analysis.
    expect(placement.unclassifiedTemperatureIds).toEqual(new Set([
      'sensor.home_current_temperature', 'sensor.bedroom_temperature', 'sensor.kitchen_temperature',
    ]));
  });

  it('does not use missing sensor IDs or a device shared by two climates to select a thermostat', async () => {
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY.map((entity) => (
      entity.entity_id === 'sensor.home_current_temperature' ? { ...entity, device_id: null } : entity
    ))));
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().unclassifiedTemperatureIds).toEqual(new Set(['sensor.home_current_temperature']));

    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY,
      { entity_id: 'climate.upstairs', device_id: 'dev_home', device_name: 'Home' },
    ]));
    mockStates({ ...STATES, 'climate.upstairs': { state: 'off', attributes: {} } });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.home_current_temperature')!.isThermostat)
      .toBe(true);
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
  });

  it('retains unreadable discovered sensors as possible unclassified temperatures', async () => {
    const mystery = { entity_id: 'sensor.mystery', device_id: 'dev_unknown', device_name: 'Unknown' };
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([...DISCOVERY, mystery]));
    indoorClimate = new IndoorClimate({ client: mockClient, discoveryInterval: 0 });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors.map((s) => s.entityId)).not.toContain('sensor.mystery');
    expect(indoorClimate.placementDiscovery().unclassifiedTemperatureIds).toEqual(new Set(['sensor.mystery']));
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().thermostatOccupancyEntityId).toBe('binary_sensor.home_occupancy');

    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY, { ...mystery, device_id: 'dev_home' },
    ]));
    await indoorClimate.refresh();
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
  });

  it('does not assume a unique occupancy match when another binary sensor on the device is unreadable', async () => {
    mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([
      ...DISCOVERY,
      { entity_id: 'binary_sensor.unreadable_hall', device_id: 'dev_home', device_name: 'Home' },
    ]));
    indoorClimate = new IndoorClimate({ client: mockClient });
    await indoorClimate.refresh();
    expect(indoorClimate.placementDiscovery().thermostatTemperatureEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().thermostatOccupancyEntityId).toBeNull();
    expect(indoorClimate.placementDiscovery().occupancyByTemperature.has('sensor.home_current_temperature')).toBe(false);
    expect(indoorClimate.placementDiscovery().occupancyByTemperature.get('sensor.bedroom_temperature'))
      .toBe('binary_sensor.bedroom_occupancy');
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

  it('treats a getState that never resolves as a failed fetch and aborts it', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, requestTimeout: 20 });
    await indoorClimate.refresh();
    const respond = mockClient.getState.getMockImplementation()!;
    const signals = new Map<string, AbortSignal>();
    mockClient.getState = vi.fn().mockImplementation((entityId: string, options: { signal: AbortSignal }) => {
      signals.set(entityId, options.signal);
      return entityId === 'sensor.bedroom_temperature' ? new Promise(() => {}) : respond(entityId);
    });
    await indoorClimate.refresh();
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.bedroom_temperature'))
      .toMatchObject({ available: false, temperature: null, unit: '°C' });
    expect(indoorClimate.cachedStatus.sensors.find((s) => s.entityId === 'sensor.kitchen_temperature'))
      .toMatchObject({ available: true, temperature: 20.1 });

    const hung = signals.get('sensor.bedroom_temperature')!;
    expect(hung.aborted).toBe(true);
    expect(hung.reason).toMatchObject({ message: 'sensor.bedroom_temperature timed out after 20ms' });
    // Requests that finished in time have their deadline cleared, not aborted later.
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(signals.get('sensor.kitchen_temperature')!.aborted).toBe(false);
  });

  it('aborts a discovery template that outlives the deadline and reports the timeout', async () => {
    let signal: AbortSignal | undefined;
    mockClient.renderTemplate = vi.fn().mockImplementation((_template: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    indoorClimate = new IndoorClimate({ client: mockClient, requestTimeout: 20 });
    await indoorClimate.refresh();

    expect(signal?.aborted).toBe(true);
    expect(mockClient.getState).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'Discovery template timed out after 20ms' }) }),
      'Indoor climate discovery failed; keeping previously discovered entities',
    );
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

  it('accepts a config-entry title as the integration', async () => {
    indoorClimate = new IndoorClimate({ client: mockClient, integration: 'Ecobee Upstairs' });
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).toHaveBeenCalledWith(
      expect.stringContaining('integration_entities("Ecobee Upstairs")'),
      expect.anything(),
    );
    expect(indoorClimate.cachedStatus.sensors).toHaveLength(3);
  });

  it('embeds quotes and Jinja delimiters as an escaped string literal', async () => {
    const plain = new IndoorClimate({ client: mockClient, integration: 'plain' });
    await plain.refresh();
    plain.stop();
    const plainTemplate: string = mockClient.renderTemplate.mock.calls[0][0];

    const hostile = 'Ecobee "Main" \\ x\') }}{{ states }}{% raw %}{# c #}-%}';
    indoorClimate = new IndoorClimate({ client: mockClient, integration: hostile });
    await indoorClimate.refresh();
    const template: string = mockClient.renderTemplate.mock.calls[1][0];

    // The value appears only as one JSON (= Jinja) string literal, and the rest
    // of the template is identical to the one for an ordinary name.
    const literal = template.match(/integration_entities\(("(?:[^"\\]|\\.)*")\)/)![1];
    expect(JSON.parse(literal)).toBe(hostile);
    expect(template.replace(literal, JSON.stringify('plain'))).toBe(plainTemplate);
  });

  it.each([
    ['an empty value', '  '],
    ['a newline', 'ecobee\n{{ states }}'],
    ['a control character', 'ecobee\u0000'],
    ['more than 100 characters', 'a'.repeat(101)],
  ])('never calls Home Assistant for an integration with %s', async (_label, integration) => {
    indoorClimate = new IndoorClimate({ client: mockClient, integration });
    await indoorClimate.refresh();
    expect(mockClient.renderTemplate).not.toHaveBeenCalled();
    expect(mockClient.getState).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      { integration },
      'Invalid indoor climate integration name; indoor climate disabled',
    );
    expect(indoorClimate.cachedStatus).toEqual({
      timestamp: new Date(0), thermostat: null, sensors: [], unit: null,
    });
  });

  describe('thermostat controls', () => {
    type Control = (climate: IndoorClimate) => Promise<unknown>;

    const CONTROLLABLE = {
      state: 'heat',
      attributes: {
        friendly_name: 'Home',
        current_temperature: 21.5,
        temperature: 21,
        hvac_modes: ['off', 'heat', 'cool', 'heat_cool'],
        preset_modes: ['home', 'away', 'sleep'],
        fan_mode: 'auto',
        fan_modes: ['auto', 'on'],
        min_temp: 7,
        max_temp: 35,
        target_temp_step: 0.5,
      },
    };
    const HEAT_COOL = {
      state: 'heat_cool',
      attributes: {
        ...CONTROLLABLE.attributes, temperature: null, target_temp_low: 20, target_temp_high: 24,
      },
    };

    function withTarget(temperature: number) {
      return { ...CONTROLLABLE, attributes: { ...CONTROLLABLE.attributes, temperature } };
    }

    async function start(
      climateState: unknown = CONTROLLABLE,
      integration?: string,
      options: {
        requestTimeout?: number; confirmAttempts?: number; settleTimeout?: number; discoveryInterval?: number;
      } = {},
    ): Promise<IndoorClimate> {
      mockStates({ ...STATES, 'climate.home': climateState });
      const climate = new IndoorClimate({
        client: mockClient, integration, controlTimeout: 50, confirmDelay: 1, ...options,
      });
      indoorClimate = climate;
      await climate.refresh();
      return climate;
    }

    beforeEach(() => {
      mockClient.callService = vi.fn().mockResolvedValue([]);
    });

    it('sets a single set point and returns the confirmed status from thermostat-only reads', async () => {
      const climate = await start();
      const { sensors } = climate.cachedStatus;
      const onStatusChange = vi.fn();
      climate.onStatusChange = onStatusChange;
      let target = 21;
      mockClient.getState = vi.fn().mockImplementation(async (entityId: string) => (
        entityId === 'climate.home' ? withTarget(target) : STATES[entityId]
      ));
      mockClient.callService = vi.fn().mockImplementation(async () => {
        target = 22.4;
        return [];
      });
      const status = await climate.setTemperature({ temperature: 22.5 });
      expect(mockClient.callService).toHaveBeenCalledWith('climate', 'set_temperature', {
        entity_id: 'climate.home', temperature: 22.5,
      }, { signal: expect.any(AbortSignal) });
      // Within the set-point tolerance, so confirmed on the first read after the call.
      expect(status).toMatchObject({ confirmed: true, thermostat: { targetTemperature: 22.4 } });
      expect(status.thermostat?.temperatureUnit).toBe('°C');
      expect(status.sensors).toBe(sensors);
      expect(climate.cachedStatus.thermostat?.targetTemperature).toBe(22.4);
      expect(onStatusChange).toHaveBeenCalledWith(climate.cachedStatus);
      expect(vi.mocked(mockClient.getState).mock.calls.map(([id]) => id)).toEqual(['climate.home', 'climate.home']);
    });

    it('re-reads the thermostat until it reports the change', async () => {
      const climate = await start();
      vi.mocked(mockClient.getState).mockClear();
      let reads = 0;
      mockClient.callService = vi.fn().mockImplementation(async () => {
        mockClient.getState = vi.fn().mockImplementation(async () => {
          reads += 1;
          return reads < 3 ? CONTROLLABLE : { ...CONTROLLABLE, state: 'cool' };
        });
        return [];
      });
      await expect(climate.setHvacMode('cool')).resolves.toMatchObject({
        confirmed: true, thermostat: { hvacMode: 'cool' },
      });
      expect(reads).toBe(3);
    });

    it('reports a change the thermostat never reflects as unconfirmed', async () => {
      const climate = await start(CONTROLLABLE, undefined, { confirmAttempts: 3 });
      vi.mocked(mockClient.getState).mockClear();
      await expect(climate.setPresetMode('away')).resolves.toMatchObject({
        confirmed: false, thermostat: { presetMode: null },
      });
      // One read before the call and three after it.
      expect(mockClient.getState).toHaveBeenCalledTimes(4);
      expect(log.warn).toHaveBeenCalledWith(
        { domain: 'climate', service: 'set_preset_mode' },
        'Thermostat has not reported a control yet',
      );
    });

    it('runs controls one at a time so each validates the state left by the last', async () => {
      const climate = await start();
      let releaseCall!: () => void;
      mockClient.callService = vi.fn().mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseCall = resolve; });
        mockStates({ ...STATES, 'climate.home': HEAT_COOL });
        return [];
      });
      vi.mocked(mockClient.getState).mockClear();
      const mode = climate.setHvacMode('heat_cool');
      const temperature = climate.setTemperature({ temperature: 21 });
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      // The second control hasn't read the thermostat while the first is sending.
      expect(mockClient.getState).toHaveBeenCalledTimes(1);

      releaseCall();
      await expect(mode).resolves.toMatchObject({ confirmed: true });
      await expect(temperature).rejects.toMatchObject({
        status: 400, message: 'Thermostat is in heat_cool mode; set targetTempLow and targetTempHigh instead',
      });
      expect(mockClient.callService).toHaveBeenCalledTimes(1);

      // A rejected control doesn't block the next one.
      await expect(climate.setFanMode('on')).resolves.toMatchObject({ thermostat: { hvacMode: 'heat_cool' } });
    });

    it('sets the heat and cool set points in heat_cool mode', async () => {
      const climate = await start(HEAT_COOL);
      await climate.setTemperature({ targetTempLow: 19.5, targetTempHigh: 25 });
      expect(mockClient.callService).toHaveBeenCalledWith('climate', 'set_temperature', {
        entity_id: 'climate.home', target_temp_low: 19.5, target_temp_high: 25,
      }, { signal: expect.any(AbortSignal) });
    });

    it.each<[string, Control, string, string, Record<string, unknown>]>([
      ['HVAC mode', (c) => c.setHvacMode('cool'), 'climate', 'set_hvac_mode', { hvac_mode: 'cool' }],
      ['preset mode', (c) => c.setPresetMode('away'), 'climate', 'set_preset_mode', { preset_mode: 'away' }],
      ['fan mode', (c) => c.setFanMode('on'), 'climate', 'set_fan_mode', { fan_mode: 'on' }],
      ['resume program', (c) => c.resumeProgram(), 'ecobee', 'resume_program', { resume_all: false }],
      ['resume all', (c) => c.resumeProgram(true), 'ecobee', 'resume_program', { resume_all: true }],
    ])('sends the %s service call', async (_label, control, domain, service, data) => {
      const climate = await start();
      await control(climate);
      expect(mockClient.callService).toHaveBeenCalledWith(
        domain,
        service,
        { entity_id: 'climate.home', ...data },
        { signal: expect.any(AbortSignal) },
      );
    });

    it('validates HVAC modes against the HA defaults when the thermostat lists none', async () => {
      const climate = await start({ state: 'heat', attributes: {} });
      await climate.setHvacMode('fan_only');
      expect(mockClient.callService).toHaveBeenCalledWith('climate', 'set_hvac_mode', {
        entity_id: 'climate.home', hvac_mode: 'fan_only',
      }, { signal: expect.any(AbortSignal) });
      await expect(climate.setHvacMode('eco')).rejects.toMatchObject({ status: 400 });
    });

    it.each<[string, unknown, Control, string]>([
      ['an out-of-range temperature', CONTROLLABLE, (c) => c.setTemperature({ temperature: 40 }),
        'temperature must be between 7 and 35'],
      ['a temperature below a known minimum', { state: 'heat', attributes: { min_temp: 10 } },
        (c) => c.setTemperature({ temperature: 5 }), 'temperature must be at least 10'],
      ['a non-finite temperature', CONTROLLABLE, (c) => c.setTemperature({ temperature: Number.NaN }),
        'temperature must be a finite number'],
      ['a single temperature in heat_cool mode', HEAT_COOL, (c) => c.setTemperature({ temperature: 21 }),
        'Thermostat is in heat_cool mode; set targetTempLow and targetTempHigh instead'],
      ['low/high set points outside heat_cool mode', CONTROLLABLE,
        (c) => c.setTemperature({ targetTempLow: 20, targetTempHigh: 24 }),
        'targetTempLow and targetTempHigh require heat_cool mode'],
      ['a low set point that is not below the high one', HEAT_COOL,
        (c) => c.setTemperature({ targetTempLow: 24, targetTempHigh: 24 }),
        'targetTempLow must be lower than targetTempHigh'],
      ['a low set point below min_temp', HEAT_COOL,
        (c) => c.setTemperature({ targetTempLow: 5, targetTempHigh: 24 }),
        'targetTempLow must be between 7 and 35'],
      ['only one heat_cool set point', HEAT_COOL, (c) => c.setTemperature({ targetTempLow: 20 }),
        'temperature, or targetTempLow and targetTempHigh, are required'],
      ['an unknown HVAC mode', CONTROLLABLE, (c) => c.setHvacMode('auto'),
        'Unsupported HVAC mode (supported: off, heat, cool, heat_cool)'],
      ['an unknown preset mode', CONTROLLABLE, (c) => c.setPresetMode('vacation'),
        'Unsupported preset mode (supported: home, away, sleep)'],
      ['a preset when none are reported', { state: 'heat', attributes: {} }, (c) => c.setPresetMode('home'),
        'Thermostat does not report any preset modes'],
      ['an unknown fan mode', CONTROLLABLE, (c) => c.setFanMode('circulate'),
        'Unsupported fan mode (supported: auto, on)'],
    ])('rejects %s with a 400 and no service call', async (_label, climateState, control, message) => {
      const climate = await start(climateState);
      const error = await control(climate).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ThermostatControlError);
      expect(error).toMatchObject({ status: 400, message });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it('only supports resume_program for the ecobee integration', async () => {
      const climate = await start(CONTROLLABLE, 'honeywell');
      await expect(climate.resumeProgram()).rejects.toMatchObject({
        status: 400, message: 'Resume program is not supported by this integration',
      });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it.each<[string, string, string | null, boolean]>([
      ['an Ecobee thermostat behind a config-entry title', 'Ecobee Upstairs', 'ecobee', true],
      ['the ecobee domain when HA does not report the platform', 'ecobee', null, true],
      ['a non-Ecobee thermostat even if the selector is ecobee', 'ecobee', 'honeywell_tcc', false],
      ['a config-entry title when HA does not report the platform', 'Ecobee Upstairs', null, false],
    ])('decides resume support from the thermostat integration: %s', async (
      _label,
      integration,
      platform,
      supported,
    ) => {
      mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY.map((entity) => (
        entity.entity_id === 'climate.home' ? { ...entity, platform } : entity
      ))));
      const climate = await start(CONTROLLABLE, integration);
      expect(mockClient.renderTemplate).toHaveBeenCalledWith(
        expect.stringContaining("'platform': config_entry_attr(entry_id, 'domain') if entry_id else none"),
        expect.anything(),
      );
      const result = climate.resumeProgram(true);
      if (supported) {
        await result;
        expect(mockClient.callService).toHaveBeenCalledWith('ecobee', 'resume_program', {
          entity_id: 'climate.home', resume_all: true,
        }, { signal: expect.any(AbortSignal) });
      } else {
        await expect(result).rejects.toMatchObject({ status: 400 });
        expect(mockClient.callService).not.toHaveBeenCalled();
      }
    });

    it('validates against a fresh read of the thermostat, not the cached snapshot', async () => {
      const climate = await start();
      // The thermostat switched to heat_cool after the last poll.
      mockStates({ ...STATES, 'climate.home': HEAT_COOL });
      await expect(climate.setTemperature({ temperature: 21 })).rejects.toMatchObject({
        status: 400, message: 'Thermostat is in heat_cool mode; set targetTempLow and targetTempHigh instead',
      });
      expect(mockClient.getState).toHaveBeenCalledTimes(1);
      expect(mockClient.getState).toHaveBeenCalledWith('climate.home', { signal: expect.any(AbortSignal) });
      expect(mockClient.callService).not.toHaveBeenCalled();

      await climate.setTemperature({ targetTempLow: 19, targetTempHigh: 25 });
      expect(mockClient.callService).toHaveBeenCalledWith('climate', 'set_temperature', {
        entity_id: 'climate.home', target_temp_low: 19, target_temp_high: 25,
      }, { signal: expect.any(AbortSignal) });

      // It went offline after the last poll, which still shows it available.
      vi.mocked(mockClient.callService).mockClear();
      mockStates({ ...STATES, 'climate.home': { state: 'unavailable', attributes: {} } });
      expect(climate.cachedStatus.thermostat?.available).toBe(true);
      await expect(climate.setFanMode('on')).rejects.toMatchObject({ status: 409, message: 'Thermostat unavailable' });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it('waits for an in-flight poll before the fresh read', async () => {
      const climate = await start();
      const respond = mockClient.getState.getMockImplementation()!;
      let releasePoll!: () => void;
      const gate = new Promise<void>((resolve) => { releasePoll = resolve; });
      mockClient.getState = vi.fn().mockImplementation((entityId: string) => gate.then(() => respond(entityId)));
      const poll = climate.refresh();
      const pending = climate.setFanMode('on');
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      const pollReads = DISCOVERY.filter((entity) => !entity.entity_id.startsWith('weather.')).length;
      expect(mockClient.getState).toHaveBeenCalledTimes(pollReads);
      expect(mockClient.callService).not.toHaveBeenCalled();

      releasePoll();
      await poll;
      await pending;
      expect(vi.mocked(mockClient.getState).mock.calls[pollReads][0]).toBe('climate.home');
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the thermostat cannot be read first', async () => {
      const climate = await start(CONTROLLABLE, undefined, { requestTimeout: 20 });
      let signal: AbortSignal | undefined;
      mockClient.getState = vi.fn().mockImplementation((_entityId: string, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => {});
      });
      await expect(climate.setFanMode('on')).rejects.toMatchObject({
        status: 503, message: 'Could not read the thermostat state; no change was sent',
      });
      expect(signal?.aborted).toBe(true);

      mockClient.getState = vi.fn().mockRejectedValue(new Error('Home Assistant request failed: 500'));
      await expect(climate.resumeProgram()).rejects.toMatchObject({ status: 503 });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it.each([
      ['fails', () => Promise.reject(new Error('Home Assistant request failed: 500'))],
      ['times out', () => new Promise(() => {})],
    ])('rejects with 502 when the thermostat read after a sent change %s', async (_label, read) => {
      const climate = await start(CONTROLLABLE, undefined, { requestTimeout: 20 });
      const respond = mockClient.getState.getMockImplementation()!;
      mockClient.callService = vi.fn().mockImplementation(async () => {
        mockClient.getState = vi.fn().mockImplementation((entityId: string) => (
          entityId === 'climate.home' ? read() : respond(entityId)
        ));
        return [];
      });
      const error = await climate.setFanMode('on').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ThermostatControlError);
      expect(error).toMatchObject({
        status: 502, message: 'Thermostat change was sent but its new state could not be read',
      });
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('rejects with 409 when no thermostat is discovered or it is unavailable', async () => {
      mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(
        DISCOVERY.filter((entity) => entity.entity_id !== 'climate.home'),
      ));
      indoorClimate = new IndoorClimate({ client: mockClient });
      await indoorClimate.refresh();
      await expect(indoorClimate.setFanMode('on')).rejects.toMatchObject({
        status: 409, message: 'No thermostat discovered',
      });
      indoorClimate.stop();

      mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify(DISCOVERY));
      const unavailable = await start({ state: 'unavailable', attributes: {} });
      await expect(unavailable.setFanMode('on')).rejects.toMatchObject({
        status: 409, message: 'Thermostat unavailable',
      });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it('waits for the first poll instead of rejecting right after startup', async () => {
      mockStates({ ...STATES, 'climate.home': CONTROLLABLE });
      indoorClimate = new IndoorClimate({ client: mockClient });
      await indoorClimate.setFanMode('on');
      expect(mockClient.callService).toHaveBeenCalledWith('climate', 'set_fan_mode', {
        entity_id: 'climate.home', fan_mode: 'on',
      }, { signal: expect.any(AbortSignal) });
    });

    it('rethrows a refusal from Home Assistant, which changed nothing', async () => {
      const climate = await start();
      const refusal = new HomeAssistantRequestError(400, 'Home Assistant request failed: 400 Bad Request');
      mockClient.callService = vi.fn().mockRejectedValue(refusal);
      await expect(climate.setFanMode('on')).rejects.toBe(refusal);
      // Nothing is left pending, so another kind of control runs straight away.
      mockClient.callService = vi.fn().mockResolvedValue([]);
      await climate.setHvacMode('cool');
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    const UNCERTAIN = 'Could not tell whether the thermostat received the change; it may still be applied, '
      + 'so check its state before retrying';
    it.each<[string, () => Promise<unknown>, number, string]>([
      ['a dropped connection', () => Promise.reject(new TypeError('fetch failed')), 502, UNCERTAIN],
      ['a gateway error', () => Promise.reject(new HomeAssistantRequestError(502, 'Home Assistant request failed: 502')),
        502, UNCERTAIN],
      ['a timeout', () => new Promise(() => {}), 504,
        'Thermostat did not respond in time; the change may still be applied, so check its state before retrying'],
    ])('reports %s as possibly applied and holds back other controls', async (_label, call, status, message) => {
      const climate = await start();
      mockClient.callService = vi.fn().mockImplementation(call);
      const error = await climate.setFanMode('on').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ThermostatControlError);
      expect(error).toMatchObject({ status, message });
      const { signal } = vi.mocked(mockClient.callService).mock.calls[0][3] as { signal: AbortSignal };
      expect(signal.aborted).toBe(status === 504);

      mockClient.callService = vi.fn().mockResolvedValue([]);
      await expect(climate.setHvacMode('cool')).rejects.toMatchObject({ status: 409 });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it('holds back other controls until an unconfirmed change is reported', async () => {
      const climate = await start(CONTROLLABLE, undefined, { confirmAttempts: 2 });
      // The mode change is accepted, but the thermostat keeps reporting heat.
      await expect(climate.setHvacMode('cool')).resolves.toMatchObject({ confirmed: false });
      vi.mocked(mockClient.callService).mockClear();
      vi.mocked(mockClient.getState).mockClear();
      await expect(climate.setTemperature({ temperature: 22 })).rejects.toMatchObject({
        status: 409, message: 'The previous thermostat change has not taken effect yet; try again shortly',
      });
      expect(mockClient.callService).not.toHaveBeenCalled();
      // The fresh read, then one per confirmation attempt.
      expect(mockClient.getState).toHaveBeenCalledTimes(3);

      // Once the thermostat reports cool, the set point is validated against it and sent.
      mockStates({ ...STATES, 'climate.home': { ...CONTROLLABLE, state: 'cool' } });
      await climate.setTemperature({ temperature: 22 });
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('lets a control of the same kind replace an unconfirmed one, which also expires', async () => {
      const climate = await start();
      await expect(climate.setHvacMode('cool')).resolves.toMatchObject({ confirmed: false });
      await expect(climate.setHvacMode('off')).resolves.toMatchObject({ confirmed: false });
      expect(mockClient.callService).toHaveBeenCalledTimes(2);
      climate.stop();

      const expiring = await start(CONTROLLABLE, undefined, { settleTimeout: 0 });
      await expiring.setHvacMode('cool');
      await expiring.setFanMode('on');
      expect(mockClient.callService).toHaveBeenCalledTimes(4);
    });

    it('keeps an unconfirmed change pending when its replacement is rejected or refused', async () => {
      const climate = await start(CONTROLLABLE, undefined, { confirmAttempts: 1 });
      await expect(climate.setHvacMode('heat_cool')).resolves.toMatchObject({ confirmed: false });
      await expect(climate.setHvacMode('dry')).rejects.toMatchObject({ status: 400 });
      mockClient.callService = vi.fn().mockRejectedValue(new HomeAssistantRequestError(400, 'Bad Request'));
      await expect(climate.setHvacMode('cool')).rejects.toBeInstanceOf(HomeAssistantRequestError);
      // heat_cool may still land, so a single set point isn't sent against the old mode.
      mockClient.callService = vi.fn().mockResolvedValue([]);
      await expect(climate.setTemperature({ temperature: 22 })).rejects.toMatchObject({ status: 409 });
      expect(mockClient.callService).not.toHaveBeenCalled();
    });

    it('does not mistake the previous set point for a small change', async () => {
      const climate = await start(withTarget(21), undefined, { confirmAttempts: 2 });
      await expect(climate.setTemperature({ temperature: 21.2 })).resolves.toMatchObject({
        confirmed: false, thermostat: { targetTemperature: 21 },
      });
      // Ecobee's rounding of the new value still counts.
      mockClient.callService = vi.fn().mockImplementation(async () => {
        mockStates({ ...STATES, 'climate.home': withTarget(21.22) });
        return [];
      });
      await expect(climate.setTemperature({ temperature: 21.2 })).resolves.toMatchObject({ confirmed: true });
    });

    it.each<[string, string, string, boolean]>([
      ['a temperature hold ends', 'temp', 'home', true],
      ['a comfort hold ends', 'away', 'home', true],
      ['the preset is unchanged', 'home', 'home', false],
      ['a temperature hold remains', 'temp', 'temp', false],
    ])('confirms resume_program only when %s', async (_label, before, after, confirmed) => {
      const withPreset = (preset: string) => ({
        ...CONTROLLABLE, attributes: { ...CONTROLLABLE.attributes, preset_mode: preset },
      });
      const climate = await start(withPreset(before), undefined, { confirmAttempts: 2 });
      mockClient.callService = vi.fn().mockImplementation(async () => {
        mockStates({ ...STATES, 'climate.home': withPreset(after) });
        return [];
      });
      await expect(climate.resumeProgram()).resolves.toMatchObject({ confirmed, thermostat: { presetMode: after } });
      // An unconfirmed resume may simply have had nothing to cancel, so it doesn't block the next control.
      mockClient.callService = vi.fn().mockResolvedValue([]);
      await climate.setFanMode('on');
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('reads the thermostat fresh for reporting, or returns null', async () => {
      const climate = await start();
      mockStates({ ...STATES, 'climate.home': { ...CONTROLLABLE, state: 'cool' } });
      await expect(climate.currentThermostat()).resolves.toMatchObject({ hvacMode: 'cool', available: true });
      mockClient.getState = vi.fn().mockRejectedValue(new Error('Home Assistant request failed: 500'));
      await expect(climate.currentThermostat()).resolves.toBeNull();
    });

    it('keeps the post-change read when a stale poll finishes after the service call', async () => {
      const climate = await start();
      let current: Record<string, unknown> = { ...STATES, 'climate.home': CONTROLLABLE };
      let gate: Promise<void> | null = null;
      let releasePoll!: () => void;
      // Each read captures the state at request time; reads made while the gate
      // is set wait for it, so the poll started during the call sees the old set point.
      mockClient.getState = vi.fn().mockImplementation((entityId: string) => {
        const snapshot = current[entityId];
        const read = () => snapshot ?? Promise.reject(new Error('Not found'));
        return gate ? gate.then(read) : Promise.resolve().then(read);
      });
      let stalePoll!: Promise<void>;
      mockClient.callService = vi.fn().mockImplementation(async () => {
        gate = new Promise<void>((resolve) => { releasePoll = resolve; });
        stalePoll = climate.refresh();
        await new Promise((resolve) => { setTimeout(resolve, 0); }); // let the poll issue its reads
        gate = null;
        current = { ...current, 'climate.home': withTarget(23) };
        setTimeout(releasePoll, 10); // the stale poll only finishes after the call returns
        return [];
      });

      const status = await climate.setTemperature({ temperature: 23 });
      await stalePoll;
      expect(status.thermostat?.targetTemperature).toBe(23);
    });

    it('runs withControls as one operation and disables its controls afterwards', async () => {
      const climate = await start();
      let thermostat = CONTROLLABLE;
      mockClient.callService = vi.fn().mockImplementation(async (
        _domain: string,
        service: string,
        data: Record<string, string>,
      ) => {
        if (service === 'set_hvac_mode') thermostat = { ...thermostat, state: data.hvac_mode };
        if (service === 'set_fan_mode') {
          thermostat = { ...thermostat, attributes: { ...thermostat.attributes, fan_mode: data.fan_mode } };
        }
        mockStates({ ...STATES, 'climate.home': thermostat });
        return [];
      });
      let passed: ThermostatControls | undefined;
      let other: Promise<unknown> | undefined;
      await climate.withControls(async (controls) => {
        passed = controls;
        other = climate.setFanMode('auto');
        await controls.setHvacMode('cool');
        await controls.setFanMode('on');
      });
      await other;
      expect(vi.mocked(mockClient.callService).mock.calls.map(([, , data]) => data)).toEqual([
        { entity_id: 'climate.home', hvac_mode: 'cool' },
        { entity_id: 'climate.home', fan_mode: 'on' },
        { entity_id: 'climate.home', fan_mode: 'auto' },
      ]);
      await expect(passed!.setHvacMode('heat')).rejects.toThrow('Thermostat controls used after withControls finished');
    });

    it('tells withControls when an unconfirmed step is reported by a later one', async () => {
      const climate = await start(CONTROLLABLE, undefined, { confirmAttempts: 1 });
      await climate.withControls(async (controls) => {
        const mode = await controls.setHvacMode('cool');
        expect(mode.confirmed).toBe(false);
        expect(controls.wasReported(mode)).toBe(false);
        mockStates({ ...STATES, 'climate.home': { ...CONTROLLABLE, state: 'cool' } });
        await controls.setFanMode('on');
        expect(controls.wasReported(mode)).toBe(true);
      });
    });

    const ATTIC = { entity_id: 'climate.attic', device_id: 'dev_attic', device_name: 'Attic' };
    const HOME = { entity_id: 'climate.home' };

    it('stops a withControls operation if another thermostat is selected partway', async () => {
      const climate = await start(CONTROLLABLE, undefined, { discoveryInterval: 0 });
      await expect(climate.withControls(async (controls) => {
        expect(controls.thermostatId()).toBeNull();
        await controls.setHvacMode('cool');
        expect(controls.thermostatId()).toBe('climate.home');
        mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([ATTIC, ...DISCOVERY]));
        mockStates({ ...STATES, 'climate.home': CONTROLLABLE, 'climate.attic': CONTROLLABLE });
        await climate.refresh();
        await controls.setFanMode('on');
      })).rejects.toMatchObject({
        status: 409, message: 'A different thermostat was selected during this operation; this change was not sent',
      });
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('does not confirm a change when a poll switches to another thermostat meanwhile', async () => {
      const climate = await start(CONTROLLABLE, undefined, { discoveryInterval: 0 });
      let poll: Promise<void> | undefined;
      mockClient.callService = vi.fn().mockImplementation(async () => {
        mockStates({ ...STATES, 'climate.home': { ...CONTROLLABLE, state: 'cool' }, 'climate.attic': CONTROLLABLE });
        mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([ATTIC, ...DISCOVERY]));
        poll = climate.refresh();
        return [];
      });
      const status = await climate.setHvacMode('cool');
      await poll;
      expect(status).toMatchObject({ confirmed: false, thermostat: { entityId: 'climate.attic' } });
    });

    it('runs raw thermostat service calls in turn with the controls', async () => {
      const climate = await start();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const batch = climate.withControls(async () => { await gate; order.push('batch'); });
      const raw = climate.runServiceCall('climate', 'turn_off', HOME, async () => { order.push('climate'); });
      await climate.runServiceCall('light', 'turn_on', { entity_id: 'light.hall' }, async () => { order.push('light'); });
      release();
      await Promise.all([batch, raw]);
      expect(order).toEqual(['light', 'batch', 'climate']);
    });

    it('aborts a stalled raw thermostat call so it cannot hold up the controls', async () => {
      const climate = await start();
      let aborted = false;
      const stalled = climate.runServiceCall('ecobee', 'resume_program', HOME, (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
      }));
      const control = climate.setFanMode('on');
      await expect(stalled).rejects.toMatchObject({
        status: 504,
        message: 'ecobee.resume_program did not respond in time; the change may still be applied, '
          + 'so check the thermostat before retrying',
      });
      expect(aborted).toBe(true);
      await expect(control).resolves.toMatchObject({ confirmed: false });
    });

    it('holds a raw thermostat call back while a change of another kind is pending', async () => {
      const climate = await start();
      // The thermostat never reports heat_cool.
      await expect(climate.setHvacMode('heat_cool')).resolves.toMatchObject({ confirmed: false });
      const call = vi.fn().mockResolvedValue([]);
      await expect(climate.runServiceCall('climate', 'set_temperature', { ...HOME, temperature: 22 }, call))
        .rejects.toMatchObject({ status: 409 });
      expect(call).not.toHaveBeenCalled();
      // A call to another thermostat isn't held back.
      await climate.runServiceCall('climate', 'set_temperature', { entity_id: 'climate.attic', temperature: 22 }, call);
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('holds controls of another kind back until a raw thermostat change is reported', async () => {
      const climate = await start();
      await climate.runServiceCall('climate', 'set_hvac_mode', { ...HOME, hvac_mode: 'cool' }, async () => []);
      await expect(climate.setTemperature({ temperature: 22 })).rejects.toMatchObject({ status: 409 });
      expect(mockClient.callService).not.toHaveBeenCalled();
      mockStates({ ...STATES, 'climate.home': { ...CONTROLLABLE, state: 'cool' } });
      await expect(climate.setTemperature({ temperature: 22 })).resolves.toMatchObject({ confirmed: false });
      expect(mockClient.callService).toHaveBeenCalledTimes(1);
    });

    it('does not hold controls back after a raw call Home Assistant refused', async () => {
      const climate = await start();
      const refused = new HomeAssistantRequestError(400, 'Home Assistant request failed: 400 Bad Request');
      await expect(climate.runServiceCall('climate', 'set_hvac_mode', { ...HOME, hvac_mode: 'cool' }, async () => {
        throw refused;
      })).rejects.toBe(refused);
      await expect(climate.setTemperature({ temperature: 22 })).resolves.toMatchObject({ confirmed: false });
    });

    it('refuses a raw toggle when the thermostat mode it starts from cannot be read', async () => {
      const climate = await start();
      mockClient.getState = vi.fn().mockRejectedValue(new Error('offline'));
      const call = vi.fn().mockResolvedValue([]);
      await expect(climate.runServiceCall('climate', 'toggle', HOME, call)).rejects.toMatchObject({
        status: 503, message: 'Could not read the thermostat state; no change was sent',
      });
      expect(call).not.toHaveBeenCalled();
    });

    it('does not give one thermostat the readings of another', async () => {
      const upstairs = { entity_id: 'climate.upstairs', device_id: 'dev_upstairs', device_name: 'Upstairs' };
      mockClient.renderTemplate = vi.fn().mockResolvedValue(JSON.stringify([...DISCOVERY, upstairs]));
      const climate = await start();
      mockStates({ ...STATES, 'climate.home': CONTROLLABLE, 'climate.upstairs': { state: 'cool', attributes: {} } });
      await expect(climate.currentThermostat()).resolves.toMatchObject({
        entityId: 'climate.home', currentTemperature: 21.5, currentHumidity: 40,
      });
      await expect(climate.currentThermostat('climate.upstairs')).resolves.toMatchObject({
        entityId: 'climate.upstairs', currentTemperature: null, currentHumidity: null,
      });
    });

    it('starts the hold-back window once an unconfirmed change is recorded', async () => {
      const climate = await start();
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        // Each read takes 20 s, so the call and its confirmation reads outlast the 60 s window.
        mockClient.getState = vi.fn().mockImplementation(async (entityId: string) => {
          now += 20_000;
          return entityId === 'climate.home' ? CONTROLLABLE : STATES[entityId];
        });
        await expect(climate.setHvacMode('heat_cool')).resolves.toMatchObject({ confirmed: false });
        await expect(climate.setTemperature({ temperature: 22 })).rejects.toMatchObject({ status: 409 });
        expect(mockClient.callService).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    });

    it('keeps a newer poll result over the control read it waited for', async () => {
      const climate = await start();
      let mode = 'heat';
      let target = 21;
      let afterCall = false;
      let poll: Promise<void> | undefined;
      mockClient.getState = vi.fn().mockImplementation(async (entityId: string) => {
        if (entityId !== 'climate.home') return STATES[entityId];
        const snapshot = { ...CONTROLLABLE, state: mode, attributes: { ...CONTROLLABLE.attributes, temperature: target } };
        if (afterCall && !poll) {
          // A poll starts during the confirmation read and sees a later mode change.
          poll = climate.refresh();
          mode = 'cool';
        }
        return snapshot;
      });
      mockClient.callService = vi.fn().mockImplementation(async () => {
        target = 22;
        afterCall = true;
        return [];
      });
      const status = await climate.setTemperature({ temperature: 22 });
      await poll;
      expect(status).toMatchObject({ confirmed: true, thermostat: { hvacMode: 'cool', targetTemperature: 22 } });
      expect(climate.cachedStatus.thermostat?.hvacMode).toBe('cool');
    });
  });
});
