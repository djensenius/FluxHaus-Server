import { type RequestHandler, Router } from 'express';
import type { InfluxDBClient } from './clients/influxdb';
import type { PrometheusClient } from './clients/prometheus';
import logger from './logger';

const metricsLogger = logger.child({ subsystem: 'metrics' });

export type MetricRange = '1h' | '6h' | '24h' | '7d' | '30d';

const RANGE_SECONDS: Record<MetricRange, number> = {
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
};

const RANGE_WINDOW: Record<MetricRange, string> = {
  '1h': '1m',
  '6h': '5m',
  '24h': '15m',
  '7d': '1h',
  '30d': '6h',
};

interface InfluxMetric {
  id: string;
  title: string;
  unit: string;
  group: string;
  source: 'influx';
  measurement: string;
  field: string;
  seriesTag: string;
  entityIds?: string[];
  aggregateFn?: 'mean' | 'last' | 'max' | 'min' | 'sum';
  // Optional display-name overrides keyed by the resolved series name
  // (e.g. rename the Environment Canada outdoor reading to "Outside" so the
  // app can colour it consistently across every chart).
  seriesRename?: Record<string, string>;
}

interface PrometheusMetric {
  id: string;
  title: string;
  unit: string;
  group: string;
  source: 'prometheus';
  promql: string;
  seriesLabel: string;
}

export type MetricDefinition = InfluxMetric | PrometheusMetric;

export interface MetricPoint {
  t: string;
  v: number;
}

export interface MetricSeries {
  name: string;
  points: MetricPoint[];
}

export interface MetricSeriesResponse {
  metric: string;
  title: string;
  unit: string;
  range: MetricRange;
  series: MetricSeries[];
}

// Server-defined presets. The app only references metric ids — it never sends
// raw Flux/PromQL, so the query surface stays locked down.
export const METRIC_CATALOG: MetricDefinition[] = [
  {
    id: 'temperature',
    title: 'Temperature',
    unit: '°C',
    group: 'Environment',
    source: 'influx',
    measurement: 'climate',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: [
      'bedroom_temperature',
      'kitchen_temperature',
      'living_room_temperature',
      'home_current_temperature',
      'patio_environment_canada_temperature',
    ],
    seriesRename: { 'Environment Canada Temperature': 'Outside' },
  },
  {
    id: 'humidity',
    title: 'Humidity',
    unit: '%',
    group: 'Environment',
    source: 'influx',
    measurement: 'climate',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['home_current_humidity', 'patio_environment_canada_humidity'],
    seriesRename: { 'Environment Canada Humidity': 'Outside' },
  },
  {
    id: 'air_quality',
    title: 'Air Quality (PM2.5)',
    unit: 'µg/m³',
    group: 'Environment',
    source: 'influx',
    measurement: 'μg/m³',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['blue_pure_pm_2_5'],
  },
  {
    id: 'outdoor_air_quality',
    title: 'Outdoor Air Quality (AQHI)',
    unit: 'AQHI',
    group: 'Environment',
    source: 'influx',
    measurement: 'state',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_aqhi'],
    seriesRename: { 'Environment Canada AQHI': 'Outside' },
  },
  {
    id: 'car_battery',
    title: 'Car Battery',
    unit: '%',
    group: 'Car',
    source: 'influx',
    measurement: 'car',
    field: 'battery_level',
    seriesTag: 'vehicle',
  },
  {
    id: 'car_range',
    title: 'Car Range',
    unit: 'km',
    group: 'Car',
    source: 'influx',
    measurement: 'car',
    field: 'ev_range',
    seriesTag: 'vehicle',
  },
  {
    id: 'car_odometer',
    title: 'Car Odometer',
    unit: 'km',
    group: 'Car',
    source: 'influx',
    measurement: 'car',
    field: 'odometer',
    seriesTag: 'vehicle',
    aggregateFn: 'last',
  },
  {
    id: 'power_draw',
    title: 'Power Draw',
    unit: 'W',
    group: 'Energy',
    source: 'influx',
    measurement: 'power',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: [
      'computer_station_power',
      'media_centre_power',
      'server_hardware_power',
    ],
  },
  {
    id: 'energy_total',
    title: 'Energy (Total)',
    unit: 'kWh',
    group: 'Energy',
    source: 'influx',
    measurement: 'energy',
    field: 'value',
    seriesTag: 'friendly_name',
    aggregateFn: 'last',
    entityIds: [
      'computer_station_energy',
      'media_centre_energy',
      'server_hardware_energy',
    ],
  },
  {
    id: 'outdoor_temperature',
    title: 'Outdoor Temperature',
    unit: '°C',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'climate',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_temperature'],
    seriesRename: { 'Environment Canada Temperature': 'Outside' },
  },
  {
    id: 'outdoor_humidity',
    title: 'Outdoor Humidity',
    unit: '%',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'climate',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_humidity'],
    seriesRename: { 'Environment Canada Humidity': 'Outside' },
  },
  {
    id: 'outdoor_dew_point',
    title: 'Dew Point',
    unit: '°C',
    group: 'Outdoor',
    source: 'influx',
    measurement: '°C',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_dew_point'],
    seriesRename: { 'Environment Canada Dew point': 'Outside' },
  },
  {
    id: 'outdoor_humidex',
    title: 'Humidex',
    unit: '°C',
    group: 'Outdoor',
    source: 'influx',
    measurement: '°C',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_humidex'],
    seriesRename: { 'Environment Canada Humidex': 'Outside' },
  },
  {
    id: 'uv_index',
    title: 'UV Index',
    unit: 'UV',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'UV index',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_uv_index'],
    seriesRename: { 'Environment Canada UV index': 'Outside' },
  },
  {
    id: 'aqhi',
    title: 'Air Quality Health Index',
    unit: 'AQHI',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'state',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['patio_environment_canada_aqhi'],
    seriesRename: { 'Environment Canada AQHI': 'Outside' },
  },
  {
    id: 'us_aqi',
    title: 'U.S. Air Quality Index',
    unit: 'AQI',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'state',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['u_s_air_quality_index'],
    seriesRename: { 'U.S. Air quality index': 'Outside' },
  },
  {
    id: 'cn_aqi',
    title: 'Chinese Air Quality Index',
    unit: 'AQI',
    group: 'Outdoor',
    source: 'influx',
    measurement: 'state',
    field: 'value',
    seriesTag: 'friendly_name',
    entityIds: ['chinese_air_quality_index'],
    seriesRename: { 'Chinese Air quality index': 'Outside' },
  },
  {
    id: 'cpu_usage',
    title: 'CPU Usage',
    unit: '%',
    group: 'System',
    source: 'prometheus',
    promql: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
    seriesLabel: 'instance',
  },
  {
    id: 'memory_usage',
    title: 'Memory Usage',
    unit: '%',
    group: 'System',
    source: 'prometheus',
    promql: '100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))',
    seriesLabel: 'instance',
  },
  {
    id: 'disk_usage',
    title: 'Disk Usage',
    unit: '%',
    group: 'System',
    source: 'prometheus',
    promql: '100 - ((node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100)',
    seriesLabel: 'instance',
  },
  {
    id: 'network_rx',
    title: 'Network In',
    unit: 'B/s',
    group: 'Network',
    source: 'prometheus',
    promql: 'sum by (instance) (rate(node_network_receive_bytes_total{device!="lo"}[5m]))',
    seriesLabel: 'instance',
  },
  {
    id: 'network_tx',
    title: 'Network Out',
    unit: 'B/s',
    group: 'Network',
    source: 'prometheus',
    promql: 'sum by (instance) (rate(node_network_transmit_bytes_total{device!="lo"}[5m]))',
    seriesLabel: 'instance',
  },
  {
    id: 'ups_battery',
    title: 'UPS Battery',
    unit: '%',
    group: 'Power',
    source: 'prometheus',
    promql: 'nut_battery_charge * 100',
    seriesLabel: 'ups',
  },
  {
    id: 'ups_load',
    title: 'UPS Load',
    unit: '%',
    group: 'Power',
    source: 'prometheus',
    promql: 'nut_load * 100',
    seriesLabel: 'ups',
  },
  {
    id: 'ups_power',
    title: 'UPS Power Draw',
    unit: 'W',
    group: 'Power',
    source: 'prometheus',
    promql: 'nut_real_power_watts',
    seriesLabel: 'ups',
  },
  {
    id: 'ups_runtime',
    title: 'UPS Runtime',
    unit: 'min',
    group: 'Power',
    source: 'prometheus',
    promql: 'nut_battery_runtime_seconds / 60',
    seriesLabel: 'ups',
  },
  {
    id: 'ups_input_voltage',
    title: 'UPS Input Voltage',
    unit: 'V',
    group: 'Power',
    source: 'prometheus',
    promql: 'nut_input_volts',
    seriesLabel: 'ups',
  },
  {
    id: 'unifi_clients',
    title: 'UniFi Clients',
    unit: 'clients',
    group: 'UniFi',
    source: 'prometheus',
    promql: 'unpoller_site_users{status="ok"}',
    seriesLabel: 'subsystem',
  },
  {
    id: 'unifi_wan_download',
    title: 'UniFi WAN Download',
    unit: 'B/s',
    group: 'UniFi',
    source: 'prometheus',
    promql: 'rate(unpoller_device_wan_receive_bytes_total[5m])',
    seriesLabel: 'name',
  },
  {
    id: 'unifi_wan_upload',
    title: 'UniFi WAN Upload',
    unit: 'B/s',
    group: 'UniFi',
    source: 'prometheus',
    promql: 'rate(unpoller_device_wan_transmit_bytes_total[5m])',
    seriesLabel: 'name',
  },
  {
    id: 'unifi_latency',
    title: 'UniFi WAN Latency',
    unit: 'ms',
    group: 'UniFi',
    source: 'prometheus',
    promql: 'unpoller_site_latency_seconds{subsystem="www"} * 1000',
    seriesLabel: 'site_name',
  },
  {
    id: 'unifi_device_temp',
    title: 'UniFi Device Temp',
    unit: '°C',
    group: 'UniFi',
    source: 'prometheus',
    promql: 'unpoller_device_temperature_celsius{temp_type="cpu"}',
    seriesLabel: 'name',
  },
];

export interface MetricsDeps {
  influxdb?: InfluxDBClient;
  prometheus?: PrometheusClient;
  prometheusServers?: { name: string; client: PrometheusClient }[];
  bucket?: string;
}

function normalizeRange(value: unknown): MetricRange {
  if (typeof value === 'string' && value in RANGE_SECONDS) {
    return value as MetricRange;
  }
  return '24h';
}

async function fetchInflux(
  metric: InfluxMetric,
  range: MetricRange,
  influxdb: InfluxDBClient,
  bucket: string,
): Promise<MetricSeries[]> {
  const window = RANGE_WINDOW[range];
  const aggregateFn = metric.aggregateFn ?? 'mean';
  const entityFilter = metric.entityIds?.length
    ? `\n  |> filter(fn: (r) => contains(value: r.entity_id, set: [${
      metric.entityIds.map((id) => `"${id}"`).join(', ')}]))`
    : '';
  const flux = `from(bucket: "${bucket}")
  |> range(start: -${range})
  |> filter(fn: (r) => r._measurement == "${metric.measurement}" and r._field == "${metric.field}")${entityFilter}
  |> aggregateWindow(every: ${window}, fn: ${aggregateFn}, createEmpty: false)
  |> keep(columns: ["_time", "_value", "${metric.seriesTag}"])`;

  const rows = await influxdb.query(flux);
  const grouped = new Map<string, MetricPoint[]>();
  rows.forEach((row: Record<string, string>) => {
    /* eslint-disable no-underscore-dangle */
    const time = row._time;
    const value = parseFloat(row._value);
    /* eslint-enable no-underscore-dangle */
    if (!time || !Number.isFinite(value)) return;
    const rawName = row[metric.seriesTag] || metric.title;
    const name = metric.seriesRename?.[rawName] ?? rawName;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name)!.push({ t: time, v: value });
  });

  return Array.from(grouped.entries()).map(([name, points]) => ({
    name,
    points: points.sort((a, b) => a.t.localeCompare(b.t)),
  }));
}

async function fetchPrometheusFrom(
  metric: PrometheusMetric,
  window: { start: number; end: number; step: number },
  serverName: string,
  client: PrometheusClient,
  prefix: boolean,
): Promise<MetricSeries[]> {
  const { start, end, step } = window;

  const result = await client.queryRange(metric.promql, String(start), String(end), String(step));
  if (result?.status && result.status !== 'success') {
    const detail = result.error || result.errorType || 'unknown error';
    throw new Error(`Prometheus query error: ${detail}`);
  }
  const series: MetricSeries[] = (result?.data?.result ?? []).map((entry: {
    metric: Record<string, string>;
    values: [number, string][];
  }) => {
    const label = entry.metric?.[metric.seriesLabel]
      || entry.metric?.instance
      || entry.metric?.job
      || metric.title;
    const name = prefix ? `${serverName}: ${label}` : label;
    const points: MetricPoint[] = (entry.values ?? [])
      .map(([ts, val]) => ({ t: new Date(ts * 1000).toISOString(), v: parseFloat(val) }))
      .filter((p) => Number.isFinite(p.v));
    return { name, points };
  });
  return series;
}

async function fetchPrometheus(
  metric: PrometheusMetric,
  range: MetricRange,
  deps: MetricsDeps,
): Promise<MetricSeries[]> {
  const servers = (deps.prometheusServers
    ?? (deps.prometheus ? [{ name: 'prometheus', client: deps.prometheus }] : []))
    .filter((server) => server.client.configured);
  const multiple = servers.length > 1;

  const end = Math.floor(Date.now() / 1000);
  const start = end - RANGE_SECONDS[range];
  const step = Math.max(15, Math.floor(RANGE_SECONDS[range] / 120));
  const window = { start, end, step };

  const results = await Promise.allSettled(
    servers.map((server) => fetchPrometheusFrom(metric, window, server.name, server.client, multiple)),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      metricsLogger.warn(
        { err: result.reason, server: servers[index].name, metric: metric.id },
        'Prometheus query failed',
      );
    }
  });

  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<MetricSeries[]> => r.status === 'fulfilled',
  );

  // If every configured backend failed, surface the outage instead of
  // returning an empty result that looks like "no data".
  if (servers.length > 0 && fulfilled.length === 0) {
    throw new Error('All Prometheus backends failed');
  }

  return fulfilled.flatMap((r) => r.value);
}

export async function fetchMetricSeries(
  metricId: string,
  rangeInput: unknown,
  deps: MetricsDeps,
): Promise<MetricSeriesResponse> {
  const metric = METRIC_CATALOG.find((m) => m.id === metricId);
  if (!metric) {
    const error = new Error(`Unknown metric: ${metricId}`);
    error.name = 'UnknownMetricError';
    throw error;
  }
  const range = normalizeRange(rangeInput);

  let series: MetricSeries[] = [];
  if (metric.source === 'influx') {
    if (deps.influxdb?.configured) {
      series = await fetchInflux(metric, range, deps.influxdb, deps.bucket ?? 'fluxhaus');
    }
  } else {
    series = await fetchPrometheus(metric, range, deps);
  }

  series.sort((a, b) => a.name.localeCompare(b.name));

  return {
    metric: metric.id,
    title: metric.title,
    unit: metric.unit,
    range,
    series,
  };
}

export function createMetricsRouter(deps: MetricsDeps, cors: RequestHandler): Router {
  const router = Router();

  router.get('/metrics/catalog', cors, (_req, res) => {
    res.json({
      metrics: METRIC_CATALOG.map((m) => ({
        id: m.id,
        title: m.title,
        unit: m.unit,
        group: m.group,
      })),
    });
  });

  router.get('/metrics/series', cors, async (req, res) => {
    const metricId = String(req.query.metric ?? '');
    try {
      const response = await fetchMetricSeries(metricId, req.query.range, deps);
      res.json(response);
    } catch (err) {
      if ((err as Error).name === 'UnknownMetricError') {
        metricsLogger.warn({ metricId }, 'Requested unknown metric');
        res.status(400).json({ error: (err as Error).message });
      } else {
        metricsLogger.error({ err, metricId }, 'Failed to fetch metric series');
        res.status(502).json({ error: 'Failed to fetch metric series' });
      }
    }
  });

  return router;
}
