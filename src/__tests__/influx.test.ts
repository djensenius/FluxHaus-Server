import { InfluxDB, Point } from '@influxdata/influxdb-client';
import { closeInflux, flushPoints, writePoint } from '../influx';

jest.mock('@influxdata/influxdb-client');

const mockWritePoint = jest.fn();
const mockFlush = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockUseDefaultTags = jest.fn();
const mockGetWriteApi = jest.fn().mockReturnValue({
  useDefaultTags: mockUseDefaultTags,
  writePoint: mockWritePoint,
  flush: mockFlush,
  close: mockClose,
});

const mockTag = jest.fn().mockReturnThis();
const mockFloatField = jest.fn().mockReturnThis();
const mockBooleanField = jest.fn().mockReturnThis();
const mockStringField = jest.fn().mockReturnThis();

beforeEach(async () => {
  jest.clearAllMocks();

  (InfluxDB as jest.Mock).mockImplementation(() => ({
    getWriteApi: mockGetWriteApi,
  }));

  mockGetWriteApi.mockReturnValue({
    useDefaultTags: mockUseDefaultTags,
    writePoint: mockWritePoint,
    flush: mockFlush,
    close: mockClose,
  });

  (Point as jest.Mock).mockImplementation(() => ({
    tag: mockTag,
    floatField: mockFloatField,
    booleanField: mockBooleanField,
    stringField: mockStringField,
  }));

  process.env.INFLUXDB_URL = 'http://localhost:8086';
  process.env.INFLUXDB_TOKEN = 'test-token';
  process.env.INFLUXDB_ORG = 'test-org';
  process.env.INFLUXDB_BUCKET = 'test-bucket';

  // Reset internal writeApi state between tests
  await closeInflux();
});

afterEach(() => {
  delete process.env.INFLUXDB_URL;
  delete process.env.INFLUXDB_TOKEN;
  delete process.env.INFLUXDB_ORG;
  delete process.env.INFLUXDB_BUCKET;
});

describe('influx', () => {
  it('should write a point with number fields', () => {
    writePoint('temperature', { value: 22.5 });

    expect(Point).toHaveBeenCalledWith('temperature');
    expect(mockFloatField).toHaveBeenCalledWith('value', 22.5);
    expect(mockWritePoint).toHaveBeenCalled();
  });

  it('should write a point with boolean fields', () => {
    writePoint('switch', { on: true });

    expect(mockBooleanField).toHaveBeenCalledWith('on', true);
    expect(mockWritePoint).toHaveBeenCalled();
  });

  it('should write a point with string fields', () => {
    writePoint('status', { state: 'running' });

    expect(mockStringField).toHaveBeenCalledWith('state', 'running');
    expect(mockWritePoint).toHaveBeenCalled();
  });

  it('should apply tags when provided', () => {
    writePoint('sensor', { value: 1 }, { room: 'living' });

    expect(mockTag).toHaveBeenCalledWith('room', 'living');
    expect(mockWritePoint).toHaveBeenCalled();
  });

  it('should set default tags on write API initialization', () => {
    writePoint('measurement', { value: 1 });

    expect(mockUseDefaultTags).toHaveBeenCalledWith({ host: 'fluxhaus-server' });
  });

  it('should not write when env vars are missing', () => {
    delete process.env.INFLUXDB_URL;

    writePoint('measurement', { value: 1 });

    expect(mockWritePoint).not.toHaveBeenCalled();
  });

  it('should flush points', async () => {
    writePoint('measurement', { value: 1 });
    await flushPoints();

    expect(mockFlush).toHaveBeenCalled();
  });

  it('should not flush when write API is not initialized', async () => {
    await flushPoints();

    expect(mockFlush).not.toHaveBeenCalled();
  });

  it('should close influx client', async () => {
    writePoint('measurement', { value: 1 });
    await closeInflux();

    expect(mockClose).toHaveBeenCalled();
  });

  it('should not close when write API is not initialized', async () => {
    await closeInflux();

    expect(mockClose).not.toHaveBeenCalled();
  });
});
