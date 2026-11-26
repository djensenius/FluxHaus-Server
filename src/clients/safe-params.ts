// Validation for caller-supplied values that are interpolated into upstream
// URLs or query languages. MCP tools (including read-only API keys) pass
// model-controlled strings straight to these clients, so anything that could
// change the request's meaning — path traversal (`../`), extra path segments
// or query parameters (`/`, `?`, `&`, `#`), percent-encoding, quotes, or
// control characters — is rejected rather than escaped.

export class UnsafeParameterError extends Error {
  constructor(label: string) {
    super(`Invalid ${label}`);
    this.name = 'UnsafeParameterError';
  }
}

// Opaque IDs/names: letters, digits, `_`, `-`, `.`, `:`, `@`, `~` (leading
// dots allowed, e.g. Forgejo `.profile`); the `.`/`..` dot-segments are
// rejected separately.
const PATH_SEGMENT = /^[A-Za-z0-9._@:~-]{1,256}$/;
const DOT_SEGMENT = /^\.{1,2}$/;
// Home Assistant entity IDs: `<domain>.<object_id>`.
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/i;
// ISO 8601 timestamps (and similar date strings): digits first, then only
// date/time characters.
const TIMESTAMP = /^[0-9][0-9A-Za-z:.+-]{0,63}$/;
// MAC addresses: colon/dash separated, unseparated, or Cisco dotted form.
const MAC_ADDRESS = /^(?:[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}|[0-9a-f]{12}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})$/i;
// InfluxDB bucket names (including system buckets like `_monitoring`):
// letters, digits, space, `_`, `-`, `.`. No quotes, backslashes, `$`, or
// control characters, so the value cannot escape a Flux string literal.
const INFLUX_BUCKET = /^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,254}$/;

function check(pattern: RegExp, value: unknown, label: string): string {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !pattern.test(text)) throw new UnsafeParameterError(label);
  return text;
}

/** A single URL path segment (opaque ID, owner/repo name, integer). */
export function safePathSegment(value: unknown, label: string): string {
  const segment = check(PATH_SEGMENT, value, label);
  if (DOT_SEGMENT.test(segment)) throw new UnsafeParameterError(label);
  return encodeURIComponent(segment);
}

/** A Home Assistant entity ID, for use as a URL path segment. */
export function safeEntityId(value: unknown, label = 'entity_id'): string {
  return encodeURIComponent(check(ENTITY_ID, value, label));
}

/**
 * A timestamp, for use as a URL path segment. A single space between the date
 * and time (`2026-01-01 12:00:00`) is normalised to ISO 8601 `T`.
 */
export function safeTimestamp(value: unknown, label = 'timestamp'): string {
  const normalized = typeof value === 'string'
    ? value.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2')
    : value;
  return encodeURIComponent(check(TIMESTAMP, normalized, label));
}

/** A MAC address, normalised to lowercase colon form (aa:bb:cc:dd:ee:ff). */
export function safeMacAddress(value: unknown, label = 'MAC address'): string {
  const hex = check(MAC_ADDRESS, value, label).replace(/[:.-]/g, '').toLowerCase();
  return hex.match(/../g)!.join(':');
}

/** One of a fixed set of values. */
export function safeEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new UnsafeParameterError(label);
  }
  return value as T;
}

/**
 * A Flux string literal for an InfluxDB bucket name. The charset check rules
 * out quotes, backslashes, `${` interpolation, and newlines; the value is
 * then quoted with Flux escaping as defense in depth.
 */
export function fluxBucketLiteral(value: unknown): string {
  const bucket = check(INFLUX_BUCKET, value, 'bucket name');
  return `"${bucket.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}
