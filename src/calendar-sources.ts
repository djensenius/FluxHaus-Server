import net from 'net';
import { getPool } from './db';
import { decrypt, encrypt } from './encryption';
import logger from './logger';

const sourceLogger = logger.child({ subsystem: 'calendar-sources' });

export type CalendarSourceProvider = 'icloud' | 'm365' | 'ics';

export interface ICloudCalendarSourceConfig {
  serverUrl: string;
  username: string;
  password: string;
}

export interface M365CalendarSourceConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userId?: string;
}

export interface ICSCalendarSourceConfig {
  url: string;
}

export type CalendarSourceConfig =
  | ICloudCalendarSourceConfig
  | M365CalendarSourceConfig
  | ICSCalendarSourceConfig;

export interface CalendarSourceRecord {
  id: string;
  userSub: string;
  provider: CalendarSourceProvider;
  displayName: string;
  enabled: boolean;
  config: CalendarSourceConfig;
  createdAt?: string;
  updatedAt?: string;
}

export interface CalendarSourceInput {
  provider: CalendarSourceProvider;
  displayName: string;
  enabled?: boolean;
  config: CalendarSourceConfig;
}

export interface CalendarSourcePatch {
  displayName?: string;
  enabled?: boolean;
  config?: CalendarSourceConfig;
}

export interface CalendarSourceSummary {
  id: string;
  provider: CalendarSourceProvider;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

function isBlockedIPv4(hostname: string): boolean {
  const octets = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) return false;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '::1'
    || normalized === '::'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

function validateIcsUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('ICS source URL must be a valid absolute URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('ICS source URL must use http or https');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
  ) {
    throw new Error('ICS source URL must use a public hostname');
  }

  const ipVersion = net.isIP(hostname);
  if (
    (ipVersion === 4 && isBlockedIPv4(hostname))
    || (ipVersion === 6 && isBlockedIPv6(hostname))
    || hostname.startsWith('::ffff:')
  ) {
    throw new Error('ICS source URL must not target a private or loopback address');
  }
}

function rowToSource(
  row: {
    id: string;
    user_sub: string;
    provider: CalendarSourceProvider;
    display_name: string;
    enabled: boolean;
    created_at?: string;
    updated_at?: string;
  },
  config: CalendarSourceConfig,
): CalendarSourceRecord {
  return {
    id: row.id,
    userSub: row.user_sub,
    provider: row.provider,
    displayName: row.display_name,
    enabled: row.enabled,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeConfig(
  provider: CalendarSourceProvider,
  config: CalendarSourceConfig,
): Record<string, unknown> {
  switch (provider) {
  case 'icloud':
    return {
      serverUrl: (config as ICloudCalendarSourceConfig).serverUrl,
      username: (config as ICloudCalendarSourceConfig).username,
      passwordConfigured: !!(config as ICloudCalendarSourceConfig).password,
    };
  case 'm365':
    return {
      tenantId: (config as M365CalendarSourceConfig).tenantId,
      clientId: (config as M365CalendarSourceConfig).clientId,
      userId: (config as M365CalendarSourceConfig).userId || 'me',
      clientSecretConfigured: !!(config as M365CalendarSourceConfig).clientSecret,
      refreshTokenConfigured: !!(config as M365CalendarSourceConfig).refreshToken,
    };
  case 'ics':
    return {
      url: (config as ICSCalendarSourceConfig).url,
    };
  default:
    return {};
  }
}

function validateCalendarSourceInput(
  provider: CalendarSourceProvider,
  config: CalendarSourceConfig,
): void {
  switch (provider) {
  case 'icloud': {
    const value = config as ICloudCalendarSourceConfig;
    if (!value.serverUrl || !value.username || !value.password) {
      throw new Error('iCloud sources require serverUrl, username, and password');
    }
    return;
  }
  case 'm365': {
    const value = config as M365CalendarSourceConfig;
    if (!value.tenantId || !value.clientId || !value.clientSecret || !value.refreshToken) {
      throw new Error('M365 sources require tenantId, clientId, clientSecret, and refreshToken');
    }
    return;
  }
  case 'ics': {
    const value = config as ICSCalendarSourceConfig;
    if (!value.url) {
      throw new Error('ICS sources require url');
    }
    validateIcsUrl(value.url);
    return;
  }
  default:
    throw new Error(`Unsupported calendar provider: ${provider satisfies never}`);
  }
}

export async function listCalendarSources(userSub: string): Promise<CalendarSourceRecord[]> {
  const pool = getPool();
  if (!pool) return [];

  const result = await pool.query(
    `SELECT id, user_sub, provider, display_name, enabled, config_encrypted, created_at, updated_at
     FROM calendar_sources
     WHERE user_sub = $1
     ORDER BY created_at ASC`,
    [userSub],
  );

  return result.rows.map((row) => ({
    id: row.id,
    userSub: row.user_sub,
    provider: row.provider,
    displayName: row.display_name,
    enabled: row.enabled,
    config: JSON.parse(decrypt(row.config_encrypted, userSub)) as CalendarSourceConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function listEnabledCalendarSources(userSub?: string): Promise<CalendarSourceRecord[]> {
  if (!userSub) return [];
  const sources = await listCalendarSources(userSub);
  return sources.filter((source) => source.enabled);
}

export async function createCalendarSource(
  userSub: string,
  input: CalendarSourceInput,
): Promise<CalendarSourceRecord> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  validateCalendarSourceInput(input.provider, input.config);

  const result = await pool.query(
    `INSERT INTO calendar_sources (
       user_sub, provider, display_name, enabled, config_encrypted
     )
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_sub, provider, display_name, enabled, created_at, updated_at`,
    [
      userSub,
      input.provider,
      input.displayName,
      input.enabled ?? true,
      encrypt(JSON.stringify(input.config), userSub),
    ],
  );

  sourceLogger.info({ userSub, provider: input.provider }, 'Calendar source created');
  return rowToSource(result.rows[0], input.config);
}

export async function getCalendarSource(userSub: string, sourceId: string): Promise<CalendarSourceRecord> {
  const sources = await listCalendarSources(userSub);
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new Error('Calendar source not found');
  }
  return source;
}

export async function updateCalendarSource(
  userSub: string,
  sourceId: string,
  patch: CalendarSourcePatch,
): Promise<CalendarSourceRecord> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const current = await getCalendarSource(userSub, sourceId);
  const config = patch.config ?? current.config;
  validateCalendarSourceInput(current.provider, config);

  const result = await pool.query(
    `UPDATE calendar_sources
     SET display_name = $1,
         enabled = $2,
         config_encrypted = $3,
         updated_at = NOW()
     WHERE id = $4 AND user_sub = $5
     RETURNING id, user_sub, provider, display_name, enabled, created_at, updated_at`,
    [
      patch.displayName ?? current.displayName,
      patch.enabled ?? current.enabled,
      encrypt(JSON.stringify(config), userSub),
      sourceId,
      userSub,
    ],
  );

  if (result.rows.length === 0) {
    throw new Error('Calendar source not found');
  }

  sourceLogger.info({ userSub, sourceId }, 'Calendar source updated');
  return rowToSource(result.rows[0], config);
}

export async function deleteCalendarSource(userSub: string, sourceId: string): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    'DELETE FROM calendar_sources WHERE id = $1 AND user_sub = $2 RETURNING id',
    [sourceId, userSub],
  );

  if (result.rows.length === 0) {
    throw new Error('Calendar source not found');
  }

  sourceLogger.info({ userSub, sourceId }, 'Calendar source deleted');
}

export function sanitizeCalendarSource(source: CalendarSourceRecord): CalendarSourceSummary {
  return {
    id: source.id,
    provider: source.provider,
    displayName: source.displayName,
    enabled: source.enabled,
    config: sanitizeConfig(source.provider, source.config),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
