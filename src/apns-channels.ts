import http2 from 'http2';
import fs from 'fs';
import { SignJWT, importPKCS8 } from 'jose';
import { getPool } from './db';
import logger from './logger';

const channelLogger = logger.child({ subsystem: 'apns-channels' });

const ACTIVITY_TYPES = ['dishwasher', 'washer', 'dryer', 'broombot', 'mopbot', 'consolidated'];

const DISPLAY_NAMES: Record<string, string> = {
  dishwasher: 'Dishwasher',
  washer: 'Washer',
  dryer: 'Dryer',
  broombot: 'BroomBot',
  mopbot: 'MopBot',
  consolidated: 'All Appliances',
};

// In-memory cache to avoid repeated DB queries and Apple API calls
const channelCache = new Map<string, string | null>();
// Track failed creation attempts to avoid spamming Apple
const failedAttempts = new Map<string, number>();
const RETRY_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes between retries

function getApnsChannelHost(): string {
  const env = process.env.APNS_ENVIRONMENT;
  return env === 'development'
    ? 'https://api-manage-broadcast.sandbox.push.apple.com:2195'
    : 'https://api-manage-broadcast.push.apple.com:2196';
}

async function generateApnsJwt(): Promise<string | null> {
  const {
    APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID,
  } = process.env;

  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) return null;

  const keyPem = fs.readFileSync(APNS_KEY_PATH, 'utf8');
  const key = await importPKCS8(keyPem, 'ES256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: APNS_KEY_ID })
    .setIssuer(APNS_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

async function makeChannelRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; data: Record<string, unknown> }> {
  const token = await generateApnsJwt();
  if (!token) {
    throw new Error('Cannot generate APNs JWT — missing config');
  }

  const host = getApnsChannelHost();

  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', (err) => {
      client.close();
      reject(err);
    });

    const headers: Record<string, string> = {
      ':method': method,
      ':path': path,
      authorization: `bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    };

    const req = client.request(headers);

    let responseData = '';
    let status = 0;
    const responseHeaders: Record<string, string> = {};

    req.on('response', (hdrs) => {
      status = hdrs[':status'] as number || 0;
      Object.entries(hdrs).forEach(([key, value]) => {
        if (typeof value === 'string') {
          responseHeaders[key] = value;
        }
      });
    });

    req.on('data', (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on('end', () => {
      client.close();
      try {
        const data = responseData ? JSON.parse(responseData) : {};
        resolve({ status, headers: responseHeaders, data });
      } catch {
        resolve({ status, headers: responseHeaders, data: { raw: responseData } });
      }
    });

    req.on('error', (err: Error) => {
      client.close();
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * List all existing broadcast channel IDs from Apple's API.
 */
async function listRemoteChannels(): Promise<string[]> {
  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const path = `/1/apps/${bundleId}/all-channels`;

  try {
    const { status, data } = await makeChannelRequest('GET', path);
    if (status === 200 && Array.isArray(data.channels)) {
      const channels = data.channels as string[];
      channelLogger.info({ count: channels.length }, 'Listed remote channels');
      return channels;
    }
    channelLogger.warn({ status, data }, 'Unexpected response listing channels');
    return [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channelLogger.error({ error: message }, 'Failed to list remote channels');
    return [];
  }
}

async function createChannel(activityType: string): Promise<string | null> {
  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const path = `/1/apps/${bundleId}/channels`;

  try {
    const { status, headers, data } = await makeChannelRequest('POST', path, {
      'message-storage-policy': 1,
      'push-type': 'LiveActivity',
    });

    if (status === 200 || status === 201) {
      const channelId = headers['apns-channel-id'];
      if (!channelId) {
        channelLogger.error({ activityType }, 'Channel created but no apns-channel-id in response');
        return null;
      }
      channelLogger.info(
        { activityType, channelId: channelId.substring(0, 16) },
        'Channel created',
      );
      return channelId;
    }

    channelLogger.error(
      { status, reason: data.reason || data.raw || JSON.stringify(data), activityType },
      'Failed to create channel',
    );
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    channelLogger.error(
      { error: message, activityType },
      'Channel creation error',
    );
    return null;
  }
}

async function getStoredChannelId(activityType: string): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query(
      'SELECT channel_id FROM live_activity_channels WHERE activity_type = $1',
      [activityType],
    );
    return result.rows[0]?.channel_id || null;
  } catch {
    return null;
  }
}

async function storeChannelId(
  activityType: string,
  channelId: string,
  displayName: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO live_activity_channels (activity_type, channel_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (activity_type) DO UPDATE SET
       channel_id = EXCLUDED.channel_id,
       display_name = EXCLUDED.display_name`,
    [activityType, channelId, displayName],
  );
}

export async function getChannelId(activityType: string): Promise<string | null> {
  // Check in-memory cache first
  if (channelCache.has(activityType)) {
    return channelCache.get(activityType) ?? null;
  }

  // Check DB
  const stored = await getStoredChannelId(activityType);
  if (stored) {
    channelCache.set(activityType, stored);
    return stored;
  }

  // Respect backoff for failed creation attempts
  const lastFail = failedAttempts.get(activityType) ?? 0;
  if (Date.now() - lastFail < RETRY_BACKOFF_MS) {
    return null;
  }

  // Create new channel
  const channelId = await createChannel(activityType);
  if (channelId) {
    const displayName = DISPLAY_NAMES[activityType] || activityType;
    await storeChannelId(activityType, channelId, displayName);
    channelCache.set(activityType, channelId);
  } else {
    failedAttempts.set(activityType, Date.now());
    channelCache.set(activityType, null);
  }
  return channelId;
}

export async function ensureAllChannels(): Promise<void> {
  const {
    APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID,
  } = process.env;

  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID) {
    channelLogger.warn('APNs not configured — skipping channel setup');
    return;
  }

  let created = 0;
  let existing = 0;

  // Check which types already exist in DB
  const dbResults = await Promise.all(
    ACTIVITY_TYPES.map(async (actType) => ({
      actType,
      stored: await getStoredChannelId(actType),
    })),
  );

  const missingTypes: string[] = [];
  dbResults.forEach(({ actType, stored }) => {
    if (stored) {
      channelCache.set(actType, stored);
      existing += 1;
    } else {
      missingTypes.push(actType);
    }
  });

  // If any are missing, log how many remote channels exist (can't map back by name)
  if (missingTypes.length > 0) {
    const remoteChannels = await listRemoteChannels();
    if (remoteChannels.length > 0) {
      channelLogger.info(
        { remoteCount: remoteChannels.length, missingTypes },
        'Remote channels exist but cannot map to activity types — creating new ones',
      );
    }
  }

  // Create any that are truly missing (not on Apple's side either)
  const createResults = await Promise.all(
    missingTypes.map(async (actType) => {
      const channelId = await createChannel(actType);
      return { actType, channelId };
    }),
  );

  await Promise.all(
    createResults.map(async ({ actType, channelId }) => {
      if (channelId) {
        await storeChannelId(actType, channelId, DISPLAY_NAMES[actType] || actType);
        channelCache.set(actType, channelId);
        created += 1;
      } else {
        failedAttempts.set(actType, Date.now());
        channelCache.set(actType, null);
      }
    }),
  );

  channelLogger.info(
    {
      created, existing, total: ACTIVITY_TYPES.length,
    },
    'Broadcast channels ready',
  );
}

export async function getAllChannels(): Promise<Record<string, string>> {
  const pool = getPool();
  if (!pool) return {};

  try {
    const result = await pool.query(
      'SELECT activity_type, channel_id FROM live_activity_channels',
    );
    const channels: Record<string, string> = {};
    result.rows.forEach((row: { activity_type: string; channel_id: string }) => {
      channels[row.activity_type] = row.channel_id;
    });
    return channels;
  } catch {
    return {};
  }
}

