import http2 from 'http2';
import fs from 'fs';
import { SignJWT, importPKCS8 } from 'jose';
import { getPool } from './db';
import logger from './logger';

const channelLogger = logger.child({ subsystem: 'apns-channels' });

const ACTIVITY_TYPES = ['dishwasher', 'washer', 'dryer', 'broombot', 'mopbot'];

const DISPLAY_NAMES: Record<string, string> = {
  dishwasher: 'Dishwasher',
  washer: 'Washer',
  dryer: 'Dryer',
  broombot: 'BroomBot',
  mopbot: 'MopBot',
};

function getApnsChannelHost(): string {
  const env = process.env.APNS_ENVIRONMENT;
  return env === 'development'
    ? 'https://api-manage-broadcast.sandbox.push.apple.com:443'
    : 'https://api-manage-broadcast.push.apple.com:443';
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
): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = await generateApnsJwt();
  if (!token) {
    throw new Error('Cannot generate APNs JWT — missing config');
  }

  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const host = getApnsChannelHost();

  return new Promise((resolve, reject) => {
    const client = http2.connect(host);
    client.on('error', reject);

    const headers: Record<string, string> = {
      ':method': method,
      ':path': path,
      'apns-topic': bundleId,
      'apns-push-type': 'channel-management',
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
    };

    const req = client.request(headers);

    let responseData = '';
    let status = 0;

    req.on('response', (hdrs) => {
      status = hdrs[':status'] as number || 0;
    });

    req.on('data', (chunk: Buffer) => {
      responseData += chunk.toString();
    });

    req.on('end', () => {
      client.close();
      try {
        const data = responseData ? JSON.parse(responseData) : {};
        resolve({ status, data });
      } catch {
        resolve({ status, data: { raw: responseData } });
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

async function createChannel(activityType: string): Promise<string | null> {
  const bundleId = process.env.APNS_BUNDLE_ID || 'org.davidjensenius.FluxHaus';
  const path = `/1/apps/${bundleId}/channels`;
  const displayName = DISPLAY_NAMES[activityType] || activityType;

  try {
    const { status, data } = await makeChannelRequest('POST', path, {
      displayName: `FluxHaus ${displayName}`,
      messageStoragePolicy: 'medium',
    });

    if (status === 200 || status === 201) {
      const channelId = data.channelId as string;
      channelLogger.info(
        { activityType, channelId: channelId?.substring(0, 16) },
        'Channel created',
      );
      return channelId;
    }

    channelLogger.error({ status, data, activityType }, 'Failed to create channel');
    return null;
  } catch (err) {
    channelLogger.error({ err, activityType }, 'Channel creation error');
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
  // Check DB first
  const stored = await getStoredChannelId(activityType);
  if (stored) return stored;

  // Create new channel
  const channelId = await createChannel(activityType);
  if (channelId) {
    const displayName = DISPLAY_NAMES[activityType] || activityType;
    await storeChannelId(activityType, channelId, displayName);
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

  await Promise.all(ACTIVITY_TYPES.map(async (type) => {
    const stored = await getStoredChannelId(type);
    if (stored) {
      existing += 1;
      return;
    }

    const channelId = await createChannel(type);
    if (channelId) {
      await storeChannelId(type, channelId, DISPLAY_NAMES[type] || type);
      created += 1;
    }
  }));

  channelLogger.info(
    { created, existing, total: ACTIVITY_TYPES.length },
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
