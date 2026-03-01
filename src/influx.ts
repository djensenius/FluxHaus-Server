import { InfluxDB, Point, WriteApi } from '@influxdata/influxdb-client';
import logger from './logger';

const influxLogger = logger.child({ subsystem: 'influx' });

let writeApi: WriteApi | null = null;

export function initInflux(): void {
  const url = process.env.INFLUXDB_URL;
  const token = process.env.INFLUXDB_TOKEN;
  const org = process.env.INFLUXDB_ORG || 'fluxhaus';
  const bucket = process.env.INFLUXDB_BUCKET || 'fluxhaus';

  if (!url || !token) {
    influxLogger.warn('INFLUXDB_URL or INFLUXDB_TOKEN not set — InfluxDB disabled');
    return;
  }

  const client = new InfluxDB({ url, token });
  writeApi = client.getWriteApi(org, bucket, 'ns');
  influxLogger.info('InfluxDB client initialized');
}

export function writePoint(
  measurement: string,
  fields: Record<string, number | boolean | string>,
  tags: Record<string, string> = {},
): void {
  if (!writeApi) return;
  try {
    const point = new Point(measurement);
    Object.entries(tags).forEach(([k, v]) => point.tag(k, v));
    Object.entries(fields).forEach(([k, v]) => {
      if (typeof v === 'number') point.floatField(k, v);
      else if (typeof v === 'boolean') point.booleanField(k, v);
      else point.stringField(k, v);
    });
    writeApi.writePoint(point);
  } catch (err) {
    influxLogger.error({ err }, 'Failed to write InfluxDB point');
  }
}

export async function flushWrites(): Promise<void> {
  if (!writeApi) return;
  try {
    await writeApi.flush();
  } catch (err) {
    influxLogger.error({ err }, 'Failed to flush InfluxDB writes');
  }
}

export async function closeClient(): Promise<void> {
  if (!writeApi) return;
  try {
    await writeApi.close();
    writeApi = null;
    influxLogger.info('InfluxDB client closed');
  } catch (err) {
    influxLogger.error({ err }, 'Failed to close InfluxDB client');
  }
}
