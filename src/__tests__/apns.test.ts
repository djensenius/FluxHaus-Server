import { EventEmitter } from 'events';
import * as http2 from 'http2';
import fs from 'fs';
import { importPKCS8 } from 'jose';
import { closeApns, initApns, sendAlertNotification, sendMultiDeviceDirectUpdate } from '../apns';
import { deleteActivityToken, deleteApnsToken } from '../push-token-store';

vi.mock('fs');
vi.mock('http2', () => ({
  connect: vi.fn(),
  constants: { NGHTTP2_CANCEL: 8 },
}));
vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue('imported-key'),
  SignJWT: vi.fn().mockImplementation(function () { return {
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuer: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('signed-jwt'),
  }; }),
}));
vi.mock('../push-token-store', () => ({
  deleteActivityToken: vi.fn(),
  deleteApnsToken: vi.fn(),
  deleteDeviceToken: vi.fn(),
  deletePushToken: vi.fn(),
  getAllActivityTokens: vi.fn().mockResolvedValue([]),
}));
vi.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

type MockRequestRecord = {
  headers: Record<string, string>;
  body: string;
  stream?: EventEmitter & { close: vi.Mock; write: vi.Mock; end: vi.Mock };
};

function mockApnsResponse(status: number, body = ''): MockRequestRecord {
  const record: MockRequestRecord = { headers: {}, body: '' };
  (http2.connect as vi.Mock).mockImplementation(() => {
    const client = new EventEmitter() as EventEmitter & {
      close: vi.Mock;
      request: vi.Mock;
    };
    client.close = vi.fn();
    client.request = vi.fn((headers: Record<string, string>) => {
      record.headers = headers;
      const req = new EventEmitter() as EventEmitter & { close: vi.Mock; write: vi.Mock; end: vi.Mock };
      req.close = vi.fn(() => req.emit('close'));
      req.write = vi.fn((chunk: string) => {
        record.body += chunk;
      });
      req.end = vi.fn(() => {
        req.emit('response', { ':status': status });
        if (body) req.emit('data', Buffer.from(body));
        req.emit('end');
      });
      record.stream = req;
      return req;
    });
    return client;
  });
  return record;
}

describe('APNs HTTP/2 transport', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      APNS_KEY_PATH: '/tmp/AuthKey_TEST.p8',
      APNS_KEY_ID: 'KEY123',
      APNS_TEAM_ID: 'TEAM123',
      APNS_ENVIRONMENT: 'development',
      APNS_BUNDLE_ID: 'org.example.FluxHaus',
    };
    (fs.readFileSync as vi.Mock).mockReturnValue('-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----');
    (importPKCS8 as vi.Mock).mockResolvedValue('imported-key');
    closeApns();
  });

  afterEach(() => {
    closeApns();
    process.env = originalEnv;
  });

  it.each([
    { status: 200, reason: '', completed: true },
    { status: 503, reason: 'ServiceUnavailable', completed: false },
    { status: 410, reason: 'Unregistered', completed: true },
  ])('reports direct cleanup delivery outcome for APNs $status', async ({ status, reason, completed }) => {
    mockApnsResponse(status, reason ? JSON.stringify({ reason }) : '');
    initApns();
    await expect(sendMultiDeviceDirectUpdate(
      [{ activityToken: 'activity' }], { devices: [] }, 'end',
    )).resolves.toBe(completed);
    if (status === 410) expect(deleteActivityToken).toHaveBeenCalledWith('activity');
  });

  it('sends alert pushes with direct APNs HTTP/2 headers and payload', async () => {
    const record = mockApnsResponse(200);
    initApns();

    const sent = await sendAlertNotification('device-token', 'Washer done', 'Cycle finished', 'appliance_done');

    expect(sent).toBe(true);
    expect(http2.connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com:443');
    expect(record.headers).toMatchObject({
      ':method': 'POST',
      ':path': '/3/device/device-token',
      'apns-topic': 'org.example.FluxHaus',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      authorization: 'bearer signed-jwt',
      'content-type': 'application/json',
    });
    expect(JSON.parse(record.body)).toEqual({
      aps: {
        sound: 'default',
        alert: { title: 'Washer done', body: 'Cycle finished' },
      },
      category: 'appliance_done',
    });
  });

  it('deletes invalid alert tokens on definitive APNs token failures', async () => {
    mockApnsResponse(400, JSON.stringify({ reason: 'BadDeviceToken' }));
    initApns();

    const sent = await sendAlertNotification('bad-token', 'Title', 'Body');

    expect(sent).toBe(false);
    expect(deleteApnsToken).toHaveBeenCalledWith('bad-token');
  });

  it('reuses the bounded APNs HTTP/2 session for multiple pushes', async () => {
    mockApnsResponse(200);
    initApns();

    await sendAlertNotification('device-token-1', 'Title 1', 'Body 1');
    await sendAlertNotification('device-token-2', 'Title 2', 'Body 2');

    expect(http2.connect).toHaveBeenCalledTimes(1);
  });

  it('times out stalled APNs requests and closes the stream', async () => {
    vi.useFakeTimers();
    const record: MockRequestRecord = { headers: {}, body: '' };
    (http2.connect as vi.Mock).mockImplementation(() => {
      const client = new EventEmitter() as EventEmitter & { close: vi.Mock; request: vi.Mock };
      client.close = vi.fn();
      client.request = vi.fn((headers: Record<string, string>) => {
        record.headers = headers;
        const req = new EventEmitter() as EventEmitter & { close: vi.Mock; write: vi.Mock; end: vi.Mock };
        req.close = vi.fn(() => req.emit('close'));
        req.write = vi.fn((chunk: string) => { record.body += chunk; });
        req.end = vi.fn();
        record.stream = req;
        return req;
      });
      return client;
    });
    initApns();

    const sentPromise = sendAlertNotification('stalled-token', 'Title', 'Body');
    await vi.advanceTimersByTimeAsync(10_000);
    const sent = await sentPromise;

    expect(sent).toBe(false);
    expect(record.stream?.close).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
