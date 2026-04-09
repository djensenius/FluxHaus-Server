import { Router } from 'express';
import { getPool } from '../db';
import { writePoint } from '../influx';
import logger from '../logger';

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
        bms1_voltage: sample.bms1Voltage ?? 0,
        bms1_current: sample.bms1Current ?? 0,
        bms1_soc: sample.bms1SOC ?? 0,
        bms1_temp: sample.bms1Temp ?? 0,
        bms2_voltage: sample.bms2Voltage ?? 0,
        bms2_current: sample.bms2Current ?? 0,
        bms2_soc: sample.bms2SOC ?? 0,
        bms2_temp: sample.bms2Temp ?? 0,
        body_temp: sample.bodyTemp ?? 0,
        gear_mode: sample.gearMode ?? 0,
        trip_distance: sample.tripDistance ?? 0,
        range_estimate: sample.estimatedRange ?? 0,
        latitude: sample.latitude ?? 0,
        longitude: sample.longitude ?? 0,
        altitude: sample.altitude ?? 0,
        roughness_score: sample.roughnessScore ?? 0,
        heart_rate: sample.heartRate ?? 0,
      }, { scooter: 'GT3Pro' });
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
    await pool.query(
      `INSERT INTO gt3_snapshots (user_sub, serial_number, odometer, total_runtime, total_ride_time,
        bms1_cycle_count, bms2_cycle_count, bms1_energy_throughput, bms2_energy_throughput,
        firmware_versions, settings, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userSub, s.serialNumber, s.odometer, s.totalRuntime, s.totalRideTime,
        s.bms1CycleCount, s.bms2CycleCount, s.bms1EnergyThroughput, s.bms2EnergyThroughput,
        s.firmwareVersions || {}, s.settings || {}, s.timestamp || new Date()],
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
        battery_used, start_battery, end_battery, gps_track, health_data, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [userSub, r.startTime, r.endTime, r.distance, r.maxSpeed, r.avgSpeed,
        r.batteryUsed, r.startBattery, r.endBattery,
        r.gpsTrack || null, r.healthData || null, r.metadata || null],
    );
    const rideId = result.rows[0]?.id;
    writePoint('gt3_ride', {
      distance: r.distance ?? 0,
      max_speed: r.maxSpeed ?? 0,
      avg_speed: r.avgSpeed ?? 0,
      battery_used: r.batteryUsed ?? 0,
      duration: r.duration ?? 0,
    }, { scooter: 'GT3Pro', ride_id: rideId || 'unknown' });
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
        battery_used, start_battery, end_battery, health_data, metadata, created_at
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

export default router;
