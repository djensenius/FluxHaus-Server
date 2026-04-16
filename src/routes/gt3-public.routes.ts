import { Router } from 'express';
import { createHash } from 'crypto';
import { getPool } from '../db';
import logger from '../logger';
import { gpsDistanceFromTrack } from '../gt3-geo';

const gt3PublicLogger = logger.child({ subsystem: 'gt3-public' });

const router = Router();

function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type ShareRow = {
  id: string;
  ride_id: string;
  expires_at: Date | null;
  revoked_at: Date | null;
};

async function resolveValidShare(token: string): Promise<ShareRow | null> {
  const pool = getPool();
  if (!pool) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  const tokenHash = hashShareToken(token);
  const result = await pool.query(
    `SELECT id, ride_id, expires_at, revoked_at
     FROM gt3_ride_shares
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

function bumpAccess(shareId: string): void {
  const pool = getPool();
  if (!pool) return;
  pool
    .query(
      `UPDATE gt3_ride_shares
       SET access_count = access_count + 1, last_accessed_at = NOW()
       WHERE id = $1`,
      [shareId],
    )
    .catch((err: unknown) => gt3PublicLogger.warn({ err, shareId }, 'Failed to bump share access stats'));
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

    bumpAccess(share.id);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({
      ride,
      share: {
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

    bumpAccess(share.id);
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

    bumpAccess(share.id);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.json({ samples, rideId: share.ride_id, source: 'postgres' });
  } catch (err) {
    gt3PublicLogger.error({ err }, 'Failed to get shared samples');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
