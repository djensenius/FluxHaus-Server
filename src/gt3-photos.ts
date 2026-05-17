import { Response } from 'express';
import { createHash } from 'crypto';

export const GT3_PHOTO_MIME_TYPE = 'image/jpeg';
export const MAX_GT3_PHOTO_BYTES = 7_500_000;
export const MAX_GT3_PHOTOS_PER_RIDE = 200;

export type RidePhotoPayload = {
  capturedAt?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  mimeType?: unknown;
  imageData?: unknown;
};

export type ValidRidePhotoPayload = {
  capturedAt: Date;
  latitude: number | null;
  longitude: number | null;
  mimeType: typeof GT3_PHOTO_MIME_TYPE;
  imageData: Buffer;
};

export type RidePhotoMetadataRow = {
  id: string;
  captured_at: Date;
  latitude: number | null;
  longitude: number | null;
  mime_type: string;
  byte_length: string | number;
  created_at: Date;
};

export type RidePhotoBytesRow = {
  id: string;
  captured_at: Date;
  mime_type: string;
  image_data: Buffer;
  created_at: Date;
};

export function ridePhotoMetadata(row: RidePhotoMetadataRow): Record<string, unknown> {
  return {
    id: row.id,
    capturedAt: row.captured_at,
    latitude: row.latitude,
    longitude: row.longitude,
    mimeType: row.mime_type,
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
  };
}

function parseOptionalCoordinate(
  value: unknown,
  min: number,
  max: number,
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return { ok: false, error: `coordinate must be a finite number between ${min} and ${max}` };
  }
  return { ok: true, value };
}

function decodeBase64Image(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const maxEncodedLength = Math.ceil(MAX_GT3_PHOTO_BYTES / 3) * 4;
  let base64 = value.trim();
  if (base64.startsWith('data:')) {
    const dataUriMatch = base64.match(/^data:(image\/(?:jpeg|jpg));base64,(.+)$/i);
    if (!dataUriMatch) return null;
    [, base64] = dataUriMatch.slice(1);
  }
  base64 = base64.replace(/\s+/g, '');
  if (base64.length > maxEncodedLength) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_GT3_PHOTO_BYTES) return null;
  if (decoded.toString('base64') !== base64) return null;
  return decoded;
}

function isJPEG(data: Buffer): boolean {
  return data.length >= 3
    && data[0] === 0xff
    && data[1] === 0xd8
    && data[2] === 0xff;
}

function isISO8601DateTime(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function validateRidePhotoPayload(
  payload: RidePhotoPayload,
): { ok: true; value: ValidRidePhotoPayload } | { ok: false; status: number; error: string } {
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.trim().toLowerCase() : '';
  if (mimeType !== GT3_PHOTO_MIME_TYPE && mimeType !== 'image/jpg') {
    return { ok: false, status: 400, error: 'mimeType must be image/jpeg' };
  }

  if (typeof payload.capturedAt !== 'string') {
    return { ok: false, status: 400, error: 'capturedAt must be an ISO8601 string' };
  }
  if (!isISO8601DateTime(payload.capturedAt)) {
    return { ok: false, status: 400, error: 'capturedAt must be an ISO8601 string' };
  }
  const capturedAt = new Date(payload.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    return { ok: false, status: 400, error: 'capturedAt must be a valid date' };
  }
  const earliest = new Date('2020-01-01T00:00:00Z');
  const latest = Date.now() + 24 * 60 * 60 * 1000;
  if (capturedAt < earliest || capturedAt.getTime() > latest) {
    return { ok: false, status: 400, error: 'capturedAt is outside the accepted range' };
  }

  const lat = parseOptionalCoordinate(payload.latitude, -90, 90);
  if (!lat.ok) return { ok: false, status: 400, error: `latitude ${lat.error}` };
  const lon = parseOptionalCoordinate(payload.longitude, -180, 180);
  if (!lon.ok) return { ok: false, status: 400, error: `longitude ${lon.error}` };
  if ((lat.value === null) !== (lon.value === null)) {
    return { ok: false, status: 400, error: 'latitude and longitude must be provided together' };
  }

  const imageData = decodeBase64Image(payload.imageData);
  if (!imageData) {
    return { ok: false, status: 400, error: 'imageData must be valid base64 JPEG data' };
  }
  if (!isJPEG(imageData)) {
    return { ok: false, status: 400, error: 'imageData must contain JPEG bytes' };
  }

  return {
    ok: true,
    value: {
      capturedAt,
      latitude: lat.value,
      longitude: lon.value,
      mimeType: GT3_PHOTO_MIME_TYPE,
      imageData,
    },
  };
}

export function sendRidePhotoBytes(res: Response, row: RidePhotoBytesRow): Response {
  const data = row.image_data;
  const contentHash = createHash('sha256').update(data).digest('hex');
  const etag = `"gt3-photo-${row.id}-${contentHash}"`;
  if (res.req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('Content-Disposition', `inline; filename="${row.id}.jpg"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', new Date(row.created_at).toUTCString());
  return res.send(data);
}
