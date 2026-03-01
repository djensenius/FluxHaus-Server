import { InfluxDB, Point, WriteApi } from '@influxdata/influxdb-client';

let writeApi: WriteApi | null = null;

function isConfigured(): boolean {
  return !!(
    process.env.INFLUXDB_URL
    && process.env.INFLUXDB_TOKEN
    && process.env.INFLUXDB_ORG
    && process.env.INFLUXDB_BUCKET
  );
}

function getWriteApi(): WriteApi {
  if (!writeApi) {
    const url = process.env.INFLUXDB_URL || '';
    const token = process.env.INFLUXDB_TOKEN || '';
    const org = process.env.INFLUXDB_ORG || '';
    const bucket = process.env.INFLUXDB_BUCKET || '';
    const client = new InfluxDB({ url, token });
    writeApi = client.getWriteApi(org, bucket, 'ns');
    writeApi.useDefaultTags({ host: 'fluxhaus-server' });
  }
  return writeApi;
}

export function writePoint(
  measurement: string,
  fields: Record<string, number | string | boolean>,
  tags?: Record<string, string>,
): void {
  if (!isConfigured()) {
    return;
  }
  const point = new Point(measurement);
  if (tags) {
    Object.entries(tags).forEach(([key, value]) => {
      point.tag(key, value);
    });
  }
  Object.entries(fields).forEach(([key, value]) => {
    if (typeof value === 'number') {
      point.floatField(key, value);
    } else if (typeof value === 'boolean') {
      point.booleanField(key, value);
    } else {
      point.stringField(key, value);
    }
  });
  getWriteApi().writePoint(point);
}

export async function flushPoints(): Promise<void> {
  if (!writeApi) {
    return;
  }
  await writeApi.flush();
}

export async function closeInflux(): Promise<void> {
  if (!writeApi) {
    return;
  }
  await writeApi.close();
  writeApi = null;
}
