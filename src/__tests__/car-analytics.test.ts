import {
  CarAnalyticsService,
  aggregationWindow,
  buildCarTelemetryQuery,
  buildChargingQuery,
  buildEarliestCarQuery,
  calculateCarAnalytics,
  detectChargingSessions,
  isCarAnalyticsInputError,
  normalizeCarAnalyticsRequest,
} from '../car-analytics';

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

const date = (value: string) => new Date(value);

describe('car analytics request handling', () => {
  it('normalizes all retained history without inventing a requested start date', () => {
    const request = normalizeCarAnalyticsRequest(
      { range: 'all', timezone: 'America/Toronto' },
      date('2026-09-10T12:00:00Z'),
    );
    expect(request.range).toBe('all');
    expect(request.start.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(request.requestedStart).toBeNull();
    expect(request.includeComparison).toBe(false);
  });

  it('accepts explicit custom date bounds', () => {
    const request = normalizeCarAnalyticsRequest({
      start: '2026-01-01T00:00:00Z',
      end: '2026-02-01T00:00:00Z',
      comparison: 'none',
    }, date('2026-09-10T12:00:00Z'));
    expect(request.range).toBe('custom');
    expect(request.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects unsupported ranges and future end dates', () => {
    expect(() => normalizeCarAnalyticsRequest(
      { range: 'forever' },
      date('2026-09-10T12:00:00Z'),
    )).toThrow('Unsupported range');
    try {
      normalizeCarAnalyticsRequest({
        start: '2026-09-01T00:00:00Z',
        end: '2027-01-01T00:00:00Z',
      }, date('2026-09-10T12:00:00Z'));
      throw new Error('Expected future date validation to fail');
    } catch (error) {
      expect(isCarAnalyticsInputError(error)).toBe(true);
    }
  });

  it('uses adaptive windows for long retained ranges', () => {
    expect(aggregationWindow(date('2026-09-01T00:00:00Z'), date('2026-09-10T00:00:00Z'))).toBe('5m');
    expect(aggregationWindow(date('2026-07-01T00:00:00Z'), date('2026-09-10T00:00:00Z'))).toBe('15m');
    expect(aggregationWindow(date('2026-01-01T00:00:00Z'), date('2026-09-10T00:00:00Z'))).toBe('1h');
    expect(aggregationWindow(date('2020-01-01T00:00:00Z'), date('2026-09-10T00:00:00Z'))).toBe('1d');
  });
});

describe('charging session detection', () => {
  it('debounces brief false readings without splitting a session', () => {
    const charging = [
      { time: date('2026-09-01T00:00:00Z'), charging: true },
      { time: date('2026-09-01T00:30:00Z'), charging: false },
      { time: date('2026-09-01T00:40:00Z'), charging: true },
      { time: date('2026-09-01T01:00:00Z'), charging: false },
      { time: date('2026-09-01T01:20:00Z'), charging: false },
      { time: date('2026-09-01T02:00:00Z'), charging: true },
      { time: date('2026-09-01T02:30:00Z'), charging: false },
      { time: date('2026-09-01T02:50:00Z'), charging: false },
    ];
    const telemetry = [
      { time: date('2026-09-01T00:00:00Z'), batteryLevel: 20 },
      { time: date('2026-09-01T01:00:00Z'), batteryLevel: 70 },
      { time: date('2026-09-01T02:00:00Z'), batteryLevel: 40 },
      { time: date('2026-09-01T02:30:00Z'), batteryLevel: 60 },
    ];
    const sessions = detectChargingSessions(charging, telemetry);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-01T01:00:00.000Z',
      batteryAddedPercent: 50,
    });
  });
});

describe('car analytics calculations', () => {
  it('prefers measured energy and ignores invalid odometer resets', () => {
    const analysis = calculateCarAnalytics({
      telemetry: [
        {
          time: date('2026-09-01T00:00:00Z'),
          odometer: 1000,
          batteryLevel: 80,
          energyTotalKWh: 500,
        },
        {
          time: date('2026-09-01T01:00:00Z'),
          odometer: 1050,
          batteryLevel: 70,
          energyTotalKWh: 510,
        },
        {
          time: date('2026-09-01T02:00:00Z'),
          odometer: 10,
          batteryLevel: 65,
          energyTotalKWh: 510,
        },
      ],
      charging: [],
      weather: [{ time: date('2026-09-01T00:30:00Z'), temperatureC: -5 }],
    }, '7d', date('2026-09-01T00:00:00Z'), date('2026-09-08T00:00:00Z'), '5m');

    expect(analysis.usage.distanceKm).toBe(50);
    expect(analysis.usage.energyKWh).toBe(10);
    expect(analysis.usage.efficiency).toMatchObject({
      method: 'measured_kwh',
      value: 20,
      unit: 'kWh/100 km',
    });
    expect(analysis.dataQuality.warnings).toContain('1 invalid odometer deltas were ignored.');
  });

  it('returns a labeled battery proxy and compares cold with mild driving', () => {
    const analysis = calculateCarAnalytics({
      telemetry: [
        { time: date('2026-09-01T00:00:00Z'), odometer: 1000, batteryLevel: 90 },
        { time: date('2026-09-01T01:00:00Z'), odometer: 1050, batteryLevel: 80 },
        { time: date('2026-09-01T02:00:00Z'), odometer: 1100, batteryLevel: 75 },
      ],
      charging: [],
      weather: [
        { time: date('2026-09-01T00:30:00Z'), temperatureC: -5 },
        { time: date('2026-09-01T01:30:00Z'), temperatureC: 10 },
      ],
    }, '7d', date('2026-09-01T00:00:00Z'), date('2026-09-08T00:00:00Z'), '5m');

    expect(analysis.usage.efficiency).toMatchObject({
      method: 'battery_proxy',
      value: 15,
      unit: '%/100 km',
    });
    expect(analysis.weather.estimatedImpactPercent).toBe(100);
    expect(analysis.weather.efficiencyMethod).toBe('battery_proxy');
    expect(analysis.dataQuality.warnings).toContain(
      'Efficiency is a battery-use estimate because measured kWh telemetry is unavailable.',
    );
  });

  it('uses pre-aggregated discharge and window-aware weather for daily history', () => {
    const analysis = calculateCarAnalytics({
      telemetry: [
        {
          time: date('2025-01-01T00:00:00Z'),
          odometer: 1000,
          batteryLevel: 90,
          batteryUsedPercent: 0,
        },
        {
          time: date('2025-01-02T00:00:00Z'),
          odometer: 1100,
          batteryLevel: 85,
          batteryUsedPercent: 20,
        },
      ],
      charging: [],
      weather: [{ time: date('2025-01-02T00:00:00Z'), temperatureC: -5 }],
    }, 'all', date('2025-01-01T00:00:00Z'), date('2025-01-02T00:00:00Z'), '1d');

    expect(analysis.usage.batteryUsedPercent).toBe(20);
    expect(analysis.usage.efficiency.value).toBe(20);
    expect(analysis.weather.bands.find((band) => band.id === 'cold')?.distanceKm).toBe(100);
  });

  it('falls back to the proxy when measured energy covers too little distance', () => {
    const analysis = calculateCarAnalytics({
      telemetry: [
        { time: date('2026-09-01T00:00:00Z'), odometer: 1000, batteryLevel: 90 },
        { time: date('2026-09-01T01:00:00Z'), odometer: 1110, batteryLevel: 70 },
        {
          time: date('2026-09-01T02:00:00Z'),
          odometer: 1120,
          batteryLevel: 68,
          energyTotalKWh: 500,
        },
        {
          time: date('2026-09-01T03:00:00Z'),
          odometer: 1130,
          batteryLevel: 66,
          energyTotalKWh: 502,
        },
      ],
      charging: [],
      weather: [],
    }, '7d', date('2026-09-01T00:00:00Z'), date('2026-09-08T00:00:00Z'), '5m');

    expect(analysis.usage.distanceKm).toBe(130);
    expect(analysis.usage.measuredEnergyDistanceKm).toBe(10);
    expect(analysis.dataQuality.energyCoveragePercent).toBe(7.7);
    expect(analysis.usage.efficiency.method).toBe('battery_proxy');
    expect(analysis.dataQuality.warnings).toContain(
      'Measured energy coverage is below 75 percent; efficiency uses the battery estimate.',
    );
  });

  it('does not count energy across an invalid odometer reset', () => {
    const analysis = calculateCarAnalytics({
      telemetry: [
        {
          time: date('2026-09-01T00:00:00Z'),
          odometer: 1000,
          energyTotalKWh: 500,
        },
        {
          time: date('2026-09-01T01:00:00Z'),
          odometer: 10,
          energyTotalKWh: 510,
        },
        {
          time: date('2026-09-01T02:00:00Z'),
          odometer: 20,
          energyTotalKWh: 512,
        },
      ],
      charging: [],
      weather: [],
    }, '7d', date('2026-09-01T00:00:00Z'), date('2026-09-08T00:00:00Z'), '5m');

    expect(analysis.usage.distanceKm).toBe(10);
    expect(analysis.usage.energyKWh).toBe(2);
    expect(analysis.usage.efficiency.value).toBe(20);
  });

  it('calculates preset coverage against the full requested period', () => {
    const telemetry = Array.from({ length: 13 }, (_, index) => ({
      time: new Date(date('2026-09-01T00:00:00Z').getTime() + index * 5 * 60 * 1000),
      odometer: 1000,
      batteryLevel: 80,
    }));
    const analysis = calculateCarAnalytics({
      telemetry,
      charging: [],
      weather: [],
    }, '7d', date('2026-09-01T00:00:00Z'), date('2026-09-08T00:00:00Z'), '5m');

    expect(analysis.dataQuality.coveragePercent).toBeLessThan(1);
    expect(analysis.dataQuality.warnings).toContain('Car telemetry coverage is below 75 percent.');
  });
});

describe('CarAnalyticsService', () => {
  it('builds only server-owned queries and parses a response', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([
        {
          _time: '2026-09-01T00:00:00Z',
          odometer: '1000',
          battery_level: '80',
          energy_total_kwh: '500',
        },
        {
          _time: '2026-09-01T01:00:00Z',
          odometer: '1050',
          battery_level: '70',
          energy_total_kwh: '510',
        },
      ])
      .mockResolvedValueOnce([
        { _time: '2026-09-01T00:00:00Z', _value: 'false' },
      ])
      .mockResolvedValueOnce([
        { _time: '2026-09-01T00:30:00Z', _value: '8' },
      ]);
    const service = new CarAnalyticsService({
      influxdb: { configured: true, query } as never,
      bucket: 'fluxhaus',
      vehicle: 'kia_ev6',
      now: () => date('2026-09-10T12:00:00Z'),
    });
    const response = await service.analyze({ range: '30d', comparison: 'none' });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain('r.vehicle == "kia_ev6"');
    expect(query.mock.calls[0][0]).toContain('energy_total_kwh');
    expect(query.mock.calls[1][0]).toContain('aggregateWindow(every: 5m');
    expect(response.usage.efficiency.method).toBe('measured_kwh');
    expect(response.period.aggregationWindow).toBe('5m');
  });

  it('escapes bucket and vehicle names in generated Flux', () => {
    const query = buildCarTelemetryQuery(
      'bucket"name',
      'vehicle"name',
      date('2026-09-01T00:00:00Z'),
      date('2026-09-02T00:00:00Z'),
      '5m',
    );
    expect(query).toContain('bucket\\"name');
    expect(query).toContain('vehicle\\"name');
    expect(buildChargingQuery(
      'fluxhaus',
      'kia',
      date('2026-09-01T00:00:00Z'),
      date('2026-09-02T00:00:00Z'),
    )).toContain('r._field == "charging"');
    expect(buildEarliestCarQuery(
      'fluxhaus',
      'kia',
      date('2026-09-02T00:00:00Z'),
    )).toContain('|> first()');
  });

  it('chooses the all-history window from the earliest retained car sample', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ _time: '2026-07-01T00:00:00Z' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new CarAnalyticsService({
      influxdb: { configured: true, query } as never,
      bucket: 'fluxhaus',
      now: () => date('2026-09-10T12:00:00Z'),
    });

    const response = await service.analyze({ range: 'all' });

    expect(query).toHaveBeenCalledTimes(4);
    expect(response.period.aggregationWindow).toBe('15m');
    expect(query.mock.calls[1][0]).toContain('aggregateWindow(every: 15m');
  });

  it('suppresses previous-period changes when either period has poor coverage', async () => {
    const currentTelemetry = [
      { _time: '2026-09-09T00:00:00Z', odometer: '1000', battery_level: '80' },
      { _time: '2026-09-09T01:00:00Z', odometer: '1010', battery_level: '78' },
    ];
    const previousTelemetry = [
      { _time: '2026-09-02T00:00:00Z', odometer: '900', battery_level: '80' },
      { _time: '2026-09-02T01:00:00Z', odometer: '905', battery_level: '79' },
    ];
    const query = jest.fn()
      .mockResolvedValueOnce(currentTelemetry)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(previousTelemetry)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = new CarAnalyticsService({
      influxdb: { configured: true, query } as never,
      bucket: 'fluxhaus',
      now: () => date('2026-09-10T12:00:00Z'),
    });

    const response = await service.analyze({ range: '7d' });

    expect(response.comparison?.previousCoveragePercent).toBeLessThan(1);
    expect(response.comparison?.distanceChangePercent).toBeNull();
    expect(response.comparison?.chargingFrequencyChangePercent).toBeNull();
    expect(response.comparison?.efficiencyChangePercent).toBeNull();
  });
});
