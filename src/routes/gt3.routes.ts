import { Router } from 'express';
import { getPool } from '../db';
import { writePoint } from '../influx';
import { InfluxDBClient } from '../clients/influxdb';
import logger from '../logger';
import { sendGT3PushToStart } from '../apns';
import { getDeviceTokensByUserAndBundle } from '../push-token-store';

const influxQuery = new InfluxDBClient({
  url: (process.env.INFLUXDB_URL || '').trim(),
  token: (process.env.INFLUXDB_TOKEN || '').trim(),
  org: (process.env.INFLUXDB_ORG || 'fluxhaus').trim(),
  bucket: (process.env.INFLUXDB_BUCKET || 'fluxhaus').trim(),
});

const gt3Logger = logger.child({ subsystem: 'gt3' });

const router = Router();

// POST /gt3/telemetry — batch telemetry samples → InfluxDB
router.post('/telemetry', async (req, res) => {
  try {
    const { samples } = req.body;
    if (!Array.isArray(samples)) {
      return res.status(400).json({ error: 'samples must be an array' });
    }
    samples.forEach((sample: Record<string, number>) => {
      writePoint('gt3_telemetry', {
        speed: sample.speed ?? 0,
        battery: sample.battery ?? 0,
        bms_voltage: sample.bmsVoltage ?? sample.bms2Voltage ?? 0,
        bms_current: sample.bmsCurrent ?? sample.bms2Current ?? 0,
        bms_soc: sample.bmsSOC ?? sample.bms2SOC ?? 0,
        bms_temp: sample.bmsTemp ?? sample.bms2Temp ?? 0,
        body_temp: sample.bodyTemp ?? 0,
        gear_mode: sample.gearMode ?? 0,
        trip_distance: sample.tripDistance ?? 0,
        trip_time: sample.tripTime ?? 0,
        range_estimate: sample.estimatedRange ?? 0,
        error_code: sample.errorCode ?? 0,
        warn_code: sample.warnCode ?? 0,
        regen_level: sample.regenLevel ?? 0,
        latitude: sample.latitude ?? 0,
        longitude: sample.longitude ?? 0,
        altitude: sample.altitude ?? 0,
        gps_speed: sample.gpsSpeed ?? 0,
        roughness_score: sample.roughnessScore ?? 0,
        heart_rate: sample.heartRate ?? 0,
      }, { scooter: 'GT3Pro' });

      if (sample.heartRate && sample.heartRate > 0) {
        writePoint('gt3_health', {
          heart_rate: sample.heartRate,
          calories_active: sample.caloriesActive ?? 0,
        }, { scooter: 'GT3Pro' });
      }
    });
    gt3Logger.info({ count: samples.length }, 'Wrote telemetry batch');
    return res.json({ ok: true, count: samples.length });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to write telemetry');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /gt3/snapshot — cumulative scooter data → PostgreSQL + InfluxDB
router.post('/snapshot', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const s = req.body;
    const userSub = req.user?.sub || 'unknown';
    if (!s.serialNumber) {
      return res.status(400).json({ error: 'serialNumber is required' });
    }
    // firmwareVersions/settings may arrive as JSON strings from the app
    const fwVersions = typeof s.firmwareVersions === 'string'
      ? JSON.parse(s.firmwareVersions) : (s.firmwareVersions || {});
    const settings = typeof s.settings === 'string'
      ? JSON.parse(s.settings) : (s.settings || {});
    await pool.query(
      `INSERT INTO gt3_snapshots (user_sub, serial_number, odometer, total_runtime, total_ride_time,
        bms1_cycle_count, bms2_cycle_count, bms1_energy_throughput, bms2_energy_throughput,
        firmware_versions, settings, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userSub, s.serialNumber, s.odometer, s.totalRuntime, s.totalRideTime,
        s.bms1CycleCount, s.bms2CycleCount, s.bms1EnergyThroughput, s.bms2EnergyThroughput,
        fwVersions, settings, s.timestamp || new Date()],
    );
    writePoint('gt3_snapshot', {
      odometer: s.odometer ?? 0,
      total_runtime: s.totalRuntime ?? 0,
      total_ride_time: s.totalRideTime ?? 0,
      bms1_cycles: s.bms1CycleCount ?? 0,
      bms2_cycles: s.bms2CycleCount ?? 0,
    }, { scooter: s.serialNumber || 'GT3Pro' });
    gt3Logger.info('Stored snapshot');
    return res.json({ ok: true });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to store snapshot');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /gt3/ride — completed ride with GPS track → PostgreSQL + InfluxDB
router.post('/ride', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const r = req.body;
    const userSub = req.user?.sub || 'unknown';
    const result = await pool.query(
      `INSERT INTO gt3_rides (user_sub, start_time, end_time, distance, max_speed, avg_speed,
        battery_used, start_battery, end_battery, gear_mode, gps_track, health_data, metadata,
        weather_temp, weather_feels_like, weather_humidity, weather_wind_speed,
        weather_wind_direction, weather_condition, weather_uv_index, weather_pressure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [userSub, r.startTime, r.endTime, r.distance ?? r.totalDistance, r.maxSpeed, r.avgSpeed,
        r.batteryUsed, r.startBattery, r.endBattery, r.primaryGearMode ?? r.gearMode ?? null,
        r.gpsTrack || null, r.healthData || null, r.metadata || null,
        r.weather?.temp ?? null, r.weather?.feelsLike ?? null, r.weather?.humidity ?? null,
        r.weather?.windSpeed ?? null, r.weather?.windDirection ?? null,
        r.weather?.condition ?? null, r.weather?.uvIndex ?? null, r.weather?.pressure ?? null],
    );
    const rideId = result.rows[0]?.id;
    const rideFields: Record<string, number> = {
      distance: r.distance ?? r.totalDistance ?? 0,
      max_speed: r.maxSpeed ?? 0,
      avg_speed: r.avgSpeed ?? 0,
      battery_used: r.batteryUsed ?? 0,
      duration: r.duration ?? 0,
      gear_mode: r.primaryGearMode ?? r.gearMode ?? 0,
    };
    if (r.healthData) {
      rideFields.avg_heart_rate = r.healthData.avgHeartRate ?? 0;
      rideFields.total_calories = r.healthData.totalCalories ?? 0;
    }
    if (r.weather) {
      rideFields.weather_temp = r.weather.temp ?? 0;
      rideFields.weather_humidity = r.weather.humidity ?? 0;
      rideFields.weather_wind_speed = r.weather.windSpeed ?? 0;
    }
    writePoint('gt3_ride', rideFields, { scooter: 'GT3Pro', ride_id: rideId || 'unknown' });
    gt3Logger.info({ rideId }, 'Stored ride');
    return res.json({ ok: true, id: rideId });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to store ride');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/rides — list rides for authenticated user
router.get('/rides', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const offset = (page - 1) * limit;
    const result = await pool.query(
      `SELECT id, start_time, end_time, distance, max_speed, avg_speed,
        battery_used, start_battery, end_battery, gear_mode, health_data, metadata,
        weather_temp, weather_feels_like, weather_humidity, weather_wind_speed,
        weather_wind_direction, weather_condition, weather_uv_index, weather_pressure,
        created_at
       FROM gt3_rides WHERE user_sub = $1
       ORDER BY start_time DESC LIMIT $2 OFFSET $3`,
      [userSub, limit, offset],
    );
    return res.json({ rides: result.rows, page, limit });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to list rides');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/rides/:id — ride detail including GPS track
router.get('/rides/:id', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    const result = await pool.query(
      'SELECT * FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    return res.json(result.rows[0]);
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to get ride');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/rides/:id/geojson — GPS track as GeoJSON
router.get('/rides/:id/geojson', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    const result = await pool.query(
      'SELECT gps_track, distance, max_speed FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    const row = result.rows[0];
    if (!row.gps_track) return res.status(404).json({ error: 'No GPS data for this ride' });
    return res.json({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: row.gps_track },
      properties: { ride_id: req.params.id, distance: row.distance, max_speed: row.max_speed },
    });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to get GeoJSON');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/status — latest snapshot
router.get('/status', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    const result = await pool.query(
      'SELECT * FROM gt3_snapshots WHERE user_sub = $1 ORDER BY timestamp DESC LIMIT 1',
      [userSub],
    );
    return res.json(result.rows[0] || null);
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to get status');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/rides/:id/samples — telemetry samples for charting
router.get('/rides/:id/samples', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    // Get the ride's time range from PostgreSQL
    const rideResult = await pool.query(
      'SELECT start_time, end_time FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (rideResult.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    const { start_time: startTime, end_time: endTime } = rideResult.rows[0];

    if (!influxQuery.configured) {
      return res.status(503).json({ error: 'InfluxDB not configured' });
    }

    const startISO = new Date(startTime).toISOString();
    const endISO = endTime ? new Date(endTime).toISOString() : new Date().toISOString();

    const flux = `from(bucket: "${(process.env.INFLUXDB_BUCKET || 'fluxhaus').trim()}")
  |> range(start: ${startISO}, stop: ${endISO})
  |> filter(fn: (r) => r._measurement == "gt3_telemetry")
  |> filter(fn: (r) => r.scooter == "GT3Pro")
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"])`;

    const samples = await influxQuery.query(flux);
    return res.json({ samples, rideId: req.params.id });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to get ride samples');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/stats — aggregate ride statistics
router.get('/stats', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const userSub = req.user?.sub || 'unknown';
    const result = await pool.query(
      `SELECT
        COUNT(*) as total_rides,
        COALESCE(SUM(distance), 0) as total_distance,
        COALESCE(AVG(avg_speed), 0) as overall_avg_speed,
        COALESCE(MAX(max_speed), 0) as all_time_max_speed,
        COALESCE(AVG(battery_used), 0) as avg_battery_per_ride,
        COALESCE(AVG(CASE WHEN distance > 0
          THEN battery_used::float / distance ELSE NULL END), 0) as avg_battery_per_km,
        COALESCE(MIN(start_time), NOW()) as first_ride,
        COALESCE(MAX(start_time), NOW()) as last_ride
      FROM gt3_rides WHERE user_sub = $1`,
      [userSub],
    );
    // Monthly breakdown
    const monthly = await pool.query(
      `SELECT
        date_trunc('month', start_time) as month,
        COUNT(*) as rides,
        COALESCE(SUM(distance), 0) as distance,
        COALESCE(AVG(avg_speed), 0) as avg_speed,
        COALESCE(AVG(battery_used), 0) as avg_battery_used
      FROM gt3_rides WHERE user_sub = $1
      GROUP BY date_trunc('month', start_time)
      ORDER BY month`,
      [userSub],
    );
    // By gear mode
    const byGear = await pool.query(
      `SELECT
        gear_mode,
        COUNT(*) as rides,
        COALESCE(AVG(avg_speed), 0) as avg_speed,
        COALESCE(AVG(battery_used), 0) as avg_battery_used,
        COALESCE(AVG(CASE WHEN distance > 0 THEN battery_used::float / distance ELSE NULL END), 0) as avg_battery_per_km
      FROM gt3_rides WHERE user_sub = $1 AND gear_mode IS NOT NULL
      GROUP BY gear_mode
      ORDER BY gear_mode`,
      [userSub],
    );
    return res.json({
      summary: result.rows[0],
      monthly: monthly.rows,
      byGearMode: byGear.rows,
    });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to get stats');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Live Activity push-to-start ---

router.post('/activity/start', async (req, res) => {
  const userSub = req.user?.sub;
  if (!userSub) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const gt3BundleId = 'org.davidjensenius.GT3Companion';
  try {
    const tokens = await getDeviceTokensByUserAndBundle(userSub, gt3BundleId);
    if (tokens.length === 0) {
      gt3Logger.warn({ userSub }, 'No GT3 push-to-start tokens found');
      return res.status(404).json({ error: 'No push-to-start token registered' });
    }

    const contentState = {
      speed: 0,
      battery: 0,
      tripDistance: 0,
      estimatedRange: 0,
      gearMode: 0,
      bmsTemp: 0,
      isCharging: false,
      isAwake: false,
      isConnected: true,
    };

    const results = await Promise.allSettled(
      tokens.map((t) => sendGT3PushToStart(t.pushToStartToken, contentState)),
    );

    const sent = results.filter(
      (r) => r.status === 'fulfilled' && r.value === true,
    ).length;

    gt3Logger.info({ userSub, sent, total: tokens.length }, 'GT3 push-to-start dispatched');
    return res.json({ success: sent > 0, sent, total: tokens.length });
  } catch (err) {
    gt3Logger.error({ err, userSub }, 'Failed to send GT3 push-to-start');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
