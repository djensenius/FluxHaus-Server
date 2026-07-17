import AirQuality, {
  computeAqhi,
  no2Ugm3ToPpb,
  ozoneUgm3ToPpb,
} from '../air-quality';
import { HomeAssistantClient } from '../homeassistant-client';
import { writePoint } from '../influx';

jest.mock('../homeassistant-client');
jest.mock('../influx', () => ({
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

describe('computeAqhi', () => {
  it('applies the Environment Canada formula and rounds', () => {
    // O3 30 ppb, NO2 10 ppb, PM2.5 10 µg/m³ -> ~2.87 -> 3
    expect(computeAqhi(30, 10, 10)).toBe(3);
  });

  it('floors the index at 1 for near-zero concentrations', () => {
    expect(computeAqhi(0, 0, 0)).toBe(1);
  });

  it('increases with higher pollutant concentrations', () => {
    expect(computeAqhi(120, 60, 80)).toBeGreaterThan(computeAqhi(30, 10, 10));
  });
});

describe('unit conversions', () => {
  it('converts ozone µg/m³ to ppb', () => {
    expect(ozoneUgm3ToPpb(48)).toBeCloseTo(24.45, 2);
  });

  it('converts NO₂ µg/m³ to ppb', () => {
    expect(no2Ugm3ToPpb(46.01)).toBeCloseTo(24.45, 2);
  });
});

describe('AirQuality collector', () => {
  let mockClient: jest.Mocked<HomeAssistantClient>;
  let aq: AirQuality;

  const hourly = (hours: number) => {
    const time: string[] = [];
    const now = Date.now();
    for (let i = hours - 1; i >= 0; i -= 1) {
      const d = new Date(now - i * 3600 * 1000);
      time.push(`${d.toISOString().slice(0, 13)}:00`);
    }
    return {
      time,
      pm2_5: time.map(() => 10),
      nitrogen_dioxide: time.map(() => 20),
      ozone: time.map(() => 60),
    };
  };

  const mockFetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ hourly: hourly(6) }),
  })) as unknown as typeof fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = new HomeAssistantClient({ url: 'http://test', token: 'token' }) as jest.Mocked<HomeAssistantClient>;
    mockClient.getState = jest.fn().mockResolvedValue({ state: '4' });
  });

  afterEach(() => {
    if (aq) aq.stop();
  });

  it('writes both AQHI series on collect', async () => {
    aq = new AirQuality({ client: mockClient, fetchFn: mockFetch, pollInterval: 60_000 });
    await aq.collect();

    const entities = (writePoint as jest.Mock).mock.calls.map((c) => c[2].entity_id);
    expect(entities).toContain('aqhi_open_meteo');
    expect(entities).toContain('patio_environment_canada_aqhi');
  });

  it('computes a plausible AQHI from Open-Meteo data', async () => {
    aq = new AirQuality({ client: mockClient, fetchFn: mockFetch, pollInterval: 60_000 });
    const value = await aq.fetchOpenMeteoAqhi();
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThanOrEqual(1);
    expect(value as number).toBeLessThan(11);
  });

  it('normalizes a bare ECCC entity id and ignores NaN coordinates', async () => {
    aq = new AirQuality({
      client: mockClient,
      fetchFn: mockFetch,
      ecccEntityId: 'patio_environment_canada_aqhi',
      latitude: NaN,
      longitude: NaN,
      pollInterval: 60_000,
    });
    await aq.collect();
    expect(mockClient.getState).toHaveBeenCalledWith('sensor.patio_environment_canada_aqhi');
    const url = String((mockFetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('latitude=43.4468');
    expect(url).toContain('longitude=-80.4906');
  });
});
