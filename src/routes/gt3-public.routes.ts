import { Router } from 'express';
import { getPool } from '../db';
import logger from '../logger';

const gt3PublicLogger = logger.child({ subsystem: 'gt3-public' });

const router = Router();

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

type ShareRow = {
  token: string;
  ride_id: string;
  expires_at: Date | null;
  revoked_at: Date | null;
};

async function resolveValidShare(token: string): Promise<ShareRow | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    `SELECT token, ride_id, expires_at, revoked_at
     FROM gt3_ride_shares
     WHERE token = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [token],
  );
  return result.rows[0] ?? null;
}

function bumpAccess(token: string): void {
  const pool = getPool();
  if (!pool) return;
  pool
    .query(
      `UPDATE gt3_ride_shares
       SET access_count = access_count + 1, last_accessed_at = NOW()
       WHERE token = $1`,
      [token],
    )
    .catch((err: unknown) => gt3PublicLogger.warn({ err, token }, 'Failed to bump share access stats'));
}

// GET /gt3/shared/:token — public ride detail
router.get('/shared/:token', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const share = await resolveValidShare(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found or expired' });

    const rideResult = await pool.query(
      `SELECT id, start_time, end_time, distance, max_speed, avg_speed,
              battery_used, start_battery, end_battery, gear_mode,
              gps_track, health_data, metadata,
              weather_temp, weather_feels_like, weather_humidity, weather_wind_speed,
              weather_wind_direction, weather_condition, weather_uv_index, weather_pressure,
              created_at
       FROM gt3_rides WHERE id = $1`,
      [share.ride_id],
    );
    if (rideResult.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });

    const ride = rideResult.rows[0];
    const track = ride.gps_track;
    if (track && Array.isArray(track) && track.length > 1) {
      ride.gps_distance = parseFloat(gpsDistanceFromTrack(track).toFixed(2));
      if (!ride.distance || ride.distance < 0.5) {
        ride.distance = ride.gps_distance;
      }
    }

    bumpAccess(share.token);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({
      ride,
      share: {
        token: share.token,
        expiresAt: share.expires_at,
      },
    });
  } catch (err) {
    gt3PublicLogger.error({ err }, 'Failed to get shared ride');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/shared/:token/geojson — public GeoJSON
router.get('/shared/:token/geojson', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const share = await resolveValidShare(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found or expired' });

    const result = await pool.query(
      'SELECT gps_track, distance, max_speed FROM gt3_rides WHERE id = $1',
      [share.ride_id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    const row = result.rows[0];
    if (!row.gps_track) return res.status(404).json({ error: 'No GPS data for this ride' });

    bumpAccess(share.token);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: row.gps_track },
      properties: { ride_id: share.ride_id, distance: row.distance, max_speed: row.max_speed },
    });
  } catch (err) {
    gt3PublicLogger.error({ err }, 'Failed to get shared GeoJSON');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /gt3/shared/:token/samples — public telemetry samples
router.get('/shared/:token/samples', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const share = await resolveValidShare(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found or expired' });

    const pgSamples = await pool.query(
      `SELECT timestamp, speed, battery, bms_voltage, bms_current, bms_soc, bms_temp,
              body_temp, gear_mode, trip_distance, trip_time, range_estimate,
              error_code, warn_code, regen_level, speed_response,
              latitude, longitude, altitude, gps_speed, gps_course,
              horizontal_accuracy, roughness_score, max_acceleration, heart_rate
       FROM gt3_samples WHERE ride_id = $1 ORDER BY timestamp`,
      [share.ride_id],
    );

    const samples = pgSamples.rows.map((row: Record<string, unknown>) => ({
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

    bumpAccess(share.token);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({ samples, rideId: share.ride_id, source: 'postgres' });
  } catch (err) {
    gt3PublicLogger.error({ err }, 'Failed to get shared samples');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
