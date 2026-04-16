import { Router } from 'express';
import { randomBytes } from 'crypto';
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

// ── Helpers ────────────────────────────────────────────────

/** Haversine distance between two coordinates in km. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute total GPS distance from a GeoJSON-style coordinate array [[lon,lat,alt?],...]. */
function gpsDistanceFromTrack(track: number[][]): number {
  let total = 0;
  for (let i = 1; i < track.length; i += 1) {
    const [lon1, lat1] = track[i - 1];
    const [lon2, lat2] = track[i];
    if (Number.isFinite(lat1) && Number.isFinite(lon1) && Number.isFinite(lat2) && Number.isFinite(lon2)) {
      total += haversineKm(lat1, lon1, lat2, lon2);
    }
  }
  return total;
}

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
        speed_response: sample.speedResponse ?? 0,
        latitude: sample.latitude ?? 0,
        longitude: sample.longitude ?? 0,
        altitude: sample.altitude ?? 0,
        gps_speed: sample.gpsSpeed ?? 0,
        gps_course: sample.gpsCourse ?? 0,
        horizontal_accuracy: sample.horizontalAccuracy ?? 0,
        roughness_score: sample.roughnessScore ?? 0,
        max_acceleration: sample.maxAcceleration ?? 0,
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
    if (typeof s.serialNumber !== 'string' || !s.serialNumber.trim()) {
      return res.status(400).json({ error: 'serialNumber must be a non-empty string' });
    }
    let fwVersions;
    let settings;
    try {
      fwVersions = typeof s.firmwareVersions === 'string'
        ? JSON.parse(s.firmwareVersions) : (s.firmwareVersions || {});
      settings = typeof s.settings === 'string'
        ? JSON.parse(s.settings) : (s.settings || {});
    } catch {
      return res.status(400).json({
        error: 'firmwareVersions and settings must be valid JSON when provided as strings',
      });
    }
    await pool.query(
      `INSERT INTO gt3_snapshots (user_sub, serial_number, battery,
        estimated_range, odometer, total_runtime, total_ride_time,
        bms1_cycle_count, bms2_cycle_count, bms1_energy_throughput,
        bms2_energy_throughput, firmware_versions, settings, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [userSub, s.serialNumber, s.battery ?? null, s.estimatedRange ?? null,
        s.odometer, s.totalRuntime, s.totalRideTime,
        s.bms1CycleCount, s.bms2CycleCount, s.bms1EnergyThroughput, s.bms2EnergyThroughput,
        fwVersions, settings, s.timestamp || new Date()],
    );
    const snapshotFields: Record<string, number> = {
      odometer: s.odometer ?? 0,
      total_runtime: s.totalRuntime ?? 0,
      total_ride_time: s.totalRideTime ?? 0,
      bms1_cycles: s.bms1CycleCount ?? 0,
      bms2_cycles: s.bms2CycleCount ?? 0,
    };
    if (s.battery != null) {
      snapshotFields.battery = s.battery;
    }
    if (s.estimatedRange != null) {
      snapshotFields.estimated_range = s.estimatedRange;
    }
    writePoint('gt3_snapshot', snapshotFields, { scooter: s.serialNumber || 'GT3Pro' });
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
  const client = await pool.connect();
  try {
    const r = req.body;
    const userSub = req.user?.sub || 'unknown';

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO gt3_rides (user_sub, start_time, end_time, distance, max_speed, avg_speed,
        battery_used, start_battery, end_battery, gear_mode, gps_track, health_data, metadata,
        weather_temp, weather_feels_like, weather_humidity, weather_wind_speed,
        weather_wind_direction, weather_condition, weather_uv_index, weather_pressure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [userSub, r.startTime, r.endTime, r.distance ?? r.totalDistance, r.maxSpeed, r.avgSpeed,
        r.batteryUsed, r.startBattery, r.endBattery, r.primaryGearMode ?? r.gearMode ?? null,
        r.gpsTrack ? JSON.stringify(r.gpsTrack) : null,
        r.healthData ? JSON.stringify(r.healthData) : null,
        r.metadata ? JSON.stringify(r.metadata) : null,
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

    // Insert per-ride samples into normalized Postgres table (batched)
    if (rideId && Array.isArray(r.samples) && r.samples.length > 0) {
      const BATCH_SIZE = 500;
      const COLS_PER_ROW = 26;

      // Filter and validate samples
      const validSamples = r.samples
        .map((s: Record<string, unknown>) => {
          const ts = s.timestamp ? new Date(s.timestamp as string) : null;
          if (!ts || Number.isNaN(ts.getTime())) return null;
          return { ...s, validTimestamp: ts.toISOString() };
        })
        .filter(Boolean) as Array<Record<string, unknown>>;

      // Build batches
      const batches: Array<{ placeholders: string[]; values: unknown[] }> = [];
      let idx = 0;
      while (idx < validSamples.length) {
        const chunk = validSamples.slice(idx, idx + BATCH_SIZE);
        const batchPlaceholders: string[] = [];
        const batchValues: unknown[] = [];
        chunk.forEach((s, rowIdx) => {
          const p = rowIdx * COLS_PER_ROW + 1;
          batchPlaceholders.push(
            `($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4}`
            + `,$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9}`
            + `,$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14}`
            + `,$${p + 15},$${p + 16},$${p + 17},$${p + 18},$${p + 19}`
            + `,$${p + 20},$${p + 21},$${p + 22},$${p + 23},$${p + 24}`
            + `,$${p + 25})`,
          );
          batchValues.push(
            rideId,
            s.validTimestamp,
            s.speed ?? 0,
            s.battery ?? 0,
            s.bmsVoltage ?? 0,
            s.bmsCurrent ?? 0,
            s.bmsSOC ?? 0,
            s.bmsTemp ?? 0,
            s.bodyTemp ?? 0,
            s.gearMode ?? 0,
            s.tripDistance ?? 0,
            s.tripTime ?? 0,
            s.estimatedRange ?? 0,
            s.errorCode ?? 0,
            s.warnCode ?? 0,
            s.regenLevel ?? 0,
            s.speedResponse ?? 0,
            s.latitude ?? null,
            s.longitude ?? null,
            s.altitude ?? null,
            s.gpsSpeed ?? null,
            s.gpsCourse ?? null,
            s.horizontalAccuracy ?? null,
            s.roughnessScore ?? null,
            s.maxAcceleration ?? null,
            s.heartRate ?? null,
          );
        });
        batches.push({ placeholders: batchPlaceholders, values: batchValues });
        idx += BATCH_SIZE;
      }

      // Execute batch inserts sequentially
      await batches.reduce(
        (chain, batch) => chain.then(() => client.query(
          `INSERT INTO gt3_samples (ride_id, timestamp, speed, battery,
            bms_voltage, bms_current, bms_soc, bms_temp,
            body_temp, gear_mode, trip_distance, trip_time,
            range_estimate, error_code, warn_code,
            regen_level, speed_response,
            latitude, longitude, altitude,
            gps_speed, gps_course, horizontal_accuracy,
            roughness_score, max_acceleration, heart_rate)
           VALUES ${batch.placeholders.join(',')}`,
          batch.values,
        )),
        Promise.resolve() as Promise<unknown>,
      );
      gt3Logger.info({ rideId, sampleCount: r.samples.length }, 'Stored ride samples');
    }

    await client.query('COMMIT');
    gt3Logger.info({ rideId }, 'Stored ride');
    return res.json({ ok: true, id: rideId });
  } catch (err) {
    await client.query('ROLLBACK');
    const detail = err instanceof Error ? err.message : String(err);
    gt3Logger.error({ err }, 'Failed to store ride');
    return res.status(500).json({ error: 'Internal server error', detail });
  } finally {
    client.release();
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
        CASE WHEN distance IS NULL OR distance < 0.5 THEN gps_track ELSE NULL END AS gps_track, created_at
       FROM gt3_rides WHERE user_sub = $1
       ORDER BY start_time DESC LIMIT $2 OFFSET $3`,
      [userSub, limit, offset],
    );
    // Compute GPS distance for rides that have a GPS track
    const rides = result.rows.map((r: Record<string, unknown>) => {
      const track = r.gps_track as number[][] | null;
      const gpsDistance = track && Array.isArray(track) && track.length > 1
        ? gpsDistanceFromTrack(track) : null;
      // Prefer GPS distance when the stored distance looks wrong (< 0.5 km)
      const bestDistance = gpsDistance != null && (
        r.distance == null || (r.distance as number) < 0.5
      ) ? gpsDistance : r.distance as number;
      return {
        ...r,
        gps_track: undefined, // Don't send full track in list response
        gps_distance: gpsDistance != null ? parseFloat(gpsDistance.toFixed(2)) : null,
        distance: bestDistance != null ? parseFloat((bestDistance as number).toFixed(2)) : null,
      };
    });
    return res.json({ rides, page, limit });
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
    const ride = result.rows[0];
    // Compute GPS distance from track if available
    const track = ride.gps_track;
    if (track && Array.isArray(track) && track.length > 1) {
      ride.gps_distance = parseFloat(gpsDistanceFromTrack(track).toFixed(2));
      // Replace bad scooter distance with GPS distance
      if (!ride.distance || ride.distance < 0.5) {
        ride.distance = ride.gps_distance;
      }
    }
    return res.json(ride);
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
    // Verify ride belongs to user
    const rideResult = await pool.query(
      'SELECT start_time, end_time FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (rideResult.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });

    // Try Postgres samples first (normalized table)
    const pgSamples = await pool.query(
      `SELECT timestamp, speed, battery, bms_voltage, bms_current, bms_soc, bms_temp,
        body_temp, gear_mode, trip_distance, trip_time, range_estimate,
        error_code, warn_code, regen_level, speed_response,
        latitude, longitude, altitude, gps_speed, gps_course,
        horizontal_accuracy, roughness_score, max_acceleration, heart_rate
       FROM gt3_samples WHERE ride_id = $1 ORDER BY timestamp`,
      [req.params.id],
    );

    if (pgSamples.rows.length > 0) {
      // Normalize column names to match InfluxDB format for consistent client parsing
      const normalized = pgSamples.rows.map((row: Record<string, unknown>) => ({
        _time: row.timestamp,
        speed: row.speed,
        battery: row.battery,
        bms_voltage: row.bms_voltage,
        bms_current: row.bms_current,
        bms_soc: row.bms_soc,
        bms_temp: row.bms_temp,
        body_temp: row.body_temp,
        gear_mode: row.gear_mode,
        trip_distance: row.trip_distance,
        trip_time: row.trip_time,
        range_estimate: row.range_estimate,
        error_code: row.error_code,
        warn_code: row.warn_code,
        regen_level: row.regen_level,
        speed_response: row.speed_response,
        latitude: row.latitude,
        longitude: row.longitude,
        altitude: row.altitude,
        gps_speed: row.gps_speed,
        gps_course: row.gps_course,
        horizontal_accuracy: row.horizontal_accuracy,
        roughness_score: row.roughness_score,
        max_acceleration: row.max_acceleration,
        heart_rate: row.heart_rate,
      }));
      return res.json({ samples: normalized, rideId: req.params.id, source: 'postgres' });
    }

    // Fallback to InfluxDB for older rides without Postgres samples
    const { start_time: startTime, end_time: endTime } = rideResult.rows[0];

    if (!influxQuery.configured) {
      return res.json({ samples: [], rideId: req.params.id, source: 'none' });
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
    return res.json({ samples, rideId: req.params.id, source: 'influxdb' });
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

// ── Share links ────────────────────────────────────────────

const EXPIRES_IN_PRESETS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

function shareStatus(row: { expires_at: Date | null; revoked_at: Date | null }): 'active' | 'expired' | 'revoked' {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

// POST /gt3/rides/:id/shares — create a share link for a ride
router.post('/rides/:id/shares', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ error: 'Unauthorized' });

  const { expiresIn, expiresAt } = req.body ?? {};

  let expiresAtDate: Date | null = null;
  if (expiresIn === 'never' || (expiresIn == null && expiresAt == null)) {
    expiresAtDate = null;
  } else if (typeof expiresIn === 'string' && EXPIRES_IN_PRESETS[expiresIn] != null) {
    expiresAtDate = new Date(Date.now() + EXPIRES_IN_PRESETS[expiresIn]);
  } else if (typeof expiresAt === 'string') {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'Invalid expiresAt' });
    }
    if (parsed.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'expiresAt must be in the future' });
    }
    expiresAtDate = parsed;
  } else {
    return res.status(400).json({ error: 'Invalid expiresIn / expiresAt' });
  }

  try {
    const rideCheck = await pool.query(
      'SELECT id FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (rideCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const token = generateShareToken();
    const result = await pool.query(
      `INSERT INTO gt3_ride_shares (token, ride_id, user_sub, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING token, expires_at, created_at`,
      [token, req.params.id, userSub, expiresAtDate],
    );
    const row = result.rows[0];
    return res.json({
      token: row.token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      status: 'active',
    });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to create ride share');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/rides/:id/shares — list all share links for a ride
router.get('/rides/:id/shares', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const rideCheck = await pool.query(
      'SELECT id FROM gt3_rides WHERE id = $1 AND user_sub = $2',
      [req.params.id, userSub],
    );
    if (rideCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const result = await pool.query(
      `SELECT token, expires_at, revoked_at, created_at, last_accessed_at, access_count
       FROM gt3_ride_shares
       WHERE ride_id = $1 AND user_sub = $2
       ORDER BY created_at DESC`,
      [req.params.id, userSub],
    );
    const shares = result.rows.map((row: Record<string, unknown>) => ({
      token: row.token,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
      status: shareStatus(row as { expires_at: Date | null; revoked_at: Date | null }),
    }));
    return res.json({ shares });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to list ride shares');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /gt3/rides/:id/shares/:token — revoke a share link
router.delete('/rides/:id/shares/:token', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  const userSub = req.user?.sub;
  if (!userSub) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await pool.query(
      `UPDATE gt3_ride_shares
       SET revoked_at = NOW()
       WHERE token = $1 AND ride_id = $2 AND user_sub = $3 AND revoked_at IS NULL
       RETURNING token`,
      [req.params.token, req.params.id, userSub],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    gt3Logger.error({ err }, 'Failed to revoke ride share');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
