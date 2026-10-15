import request from 'supertest';
import fs from 'fs';
import express from 'express';
import { createServer, fetchRhizomePhotos, fetchSchedule } from '../server';
import HomeAssistantRobot from '../homeassistant-robot';
import Car from '../car';
import Miele from '../miele';
import HomeConnect from '../homeconnect';
import transcribeAudio from '../stt';
import synthesizeSpeech from '../tts';
import { executeAICommand } from '../ai-command';
import { getPool } from '../db';

// Mock dependencies
vi.mock('fs');
vi.mock('../homeassistant-robot');
vi.mock('../car');
vi.mock('../miele');
vi.mock('../homeconnect');
vi.mock('../homeassistant-client');
vi.mock('../stt', () => ({
  __esModule: true,
  default: vi.fn().mockResolvedValue('Turn on the lights'),
}));
vi.mock('../tts', () => ({
  __esModule: true,
  default: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
}));
vi.mock('../ai-command', () => ({
  executeAICommand: vi.fn().mockResolvedValue('Lights are on.'),
}));
vi.mock('../db', () => ({
  initPool: vi.fn(),
  initDatabase: vi.fn(),
  closePool: vi.fn(),
  getPool: vi.fn().mockReturnValue(null),
}));
vi.mock('../influx', () => ({
  initInflux: vi.fn(),
  writePoint: vi.fn(),
  flushWrites: vi.fn(),
  closeClient: vi.fn(),
}));
vi.mock('../middleware/oidc.middleware', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { Router } = require('express');
  return {
    initOidc: vi.fn(),
    getOidcIssuer: vi.fn().mockReturnValue(null),
    validateBearerToken: vi.fn().mockImplementation(async (token: string) => {
      if (token === 'test-oidc-token') {
        return {
          sub: 'test-user-123',
          email: 'admin@test.com',
          preferred_username: 'admin',
        };
      }
      return null;
    }),
    isOidcEnabled: vi.fn().mockReturnValue(false),
    createAuthRouter: vi.fn().mockReturnValue(Router()),
  };
});

vi.mock('../mcp-auth', () => ({
  verifyMcpToken: vi.fn().mockResolvedValue(null),
  serverOrigin: vi.fn().mockReturnValue('http://localhost:8888'),
  getMcpSigningKey: vi.fn().mockReturnValue(new Uint8Array(32)),
}));

// Mock global fetch
global.fetch = vi.fn(() => Promise.resolve({
  json: () => Promise.resolve({}),
})) as vi.Mock;

// Helper: base64 encode basic auth credentials
function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// Helper: OIDC Bearer auth header (validates via mocked validateBearerToken)
const oidcAuthHeader = 'Bearer test-oidc-token';

describe('Server', () => {
  let app: express.Express;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockCleanbot: any;
  let mockCar: any;
  let mockMiele: any;
  let mockHomeConnect: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.BASIC_AUTH_PASSWORD = 'adminpassword';
    process.env.RHIZOME_PASSWORD = 'rhizomepassword';
    process.env.DEMO_PASSWORD = 'demopassword';
    process.env.mieleAppliances = 'Washer, Dryer';
    process.env.favouriteHomeKit = 'Light, Switch';
    process.env.favouriteScenes = 'Good Morning, Bedtime';
    process.env.MODERN_DOG_URL = 'https://moddogkitchener.portal.gingrapp.com/api/v1/reservations';

    // Setup mocks
    (fs.existsSync as vi.Mock).mockReturnValue(true);
    (fs.readFileSync as vi.Mock).mockReturnValue('{}');

    mockCleanbot = {
      cachedStatus: { batteryLevel: 100, rooms: [{ id: 2, name: 'Kitchen' }] },
      turnOn: vi.fn(),
      turnOff: vi.fn(),
      cleanRooms: vi.fn(),
    };
    (HomeAssistantRobot as unknown as vi.Mock).mockImplementation(function () { return mockCleanbot; });
    // Mock static methods
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (HomeAssistantRobot as any).batteryLevelStatus = vi.fn().mockReturnValue(100);
    (HomeAssistantRobot as any).binStatus = vi.fn().mockReturnValue('OK');
    (HomeAssistantRobot as any).runningStatus = vi.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).chargingStatus = vi.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockingStatus = vi.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockedStatus = vi.fn().mockReturnValue('Docked');
    (HomeAssistantRobot as any).batteryStatus = vi.fn().mockReturnValue('Normal');
    /* eslint-enable @typescript-eslint/no-explicit-any */

    mockCar = {
      status: {},
      odometer: 1000,
      setStatus: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue('Started'),
      stop: vi.fn().mockResolvedValue('Stopped'),
      lock: vi.fn().mockResolvedValue('Locked'),
      unlock: vi.fn().mockResolvedValue('Unlocked'),
      resync: vi.fn(),
    };
    (Car as unknown as vi.Mock).mockImplementation(function () { return mockCar; });

    mockMiele = {
      getActivePrograms: vi.fn(),
      listenEvents: vi.fn(),
      washer: {},
      dryer: {},
    };
    (Miele as unknown as vi.Mock).mockImplementation(function () { return mockMiele; });

    mockHomeConnect = {
      getActiveProgram: vi.fn(),
      listenEvents: vi.fn(),
      dishwasher: {},
    };
    (HomeConnect as unknown as vi.Mock).mockImplementation(function () { return mockHomeConnect; });

    app = await createServer();
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/').expect(401);
  });

  it('should return data for admin user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', oidcAuthHeader)
      .expect(200);

    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('cleanbot');
    expect(response.body).toHaveProperty('car');
  });

  it('should serve the calendar settings page for authenticated users', async () => {
    const response = await request(app)
      .get('/calendar-settings')
      .set('Authorization', oidcAuthHeader)
      .expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('Calendar Settings');
  });

  it('should omit missing robot status keys', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (HomeAssistantRobot as any).batteryLevelStatus = vi.fn().mockReturnValue(undefined);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const response = await request(app)
      .get('/')
      .set('Authorization', oidcAuthHeader)
      .expect(200);

    expect(response.body.cleanbot).not.toHaveProperty('batteryLevel');
  });

  it('should return data for rhizome user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('rhizome', 'rhizomepassword'))
      .expect(200);

    expect(response.body).toHaveProperty('rhizomeSchedule');
    expect(response.body).not.toHaveProperty('cleanbot');
  });

  it('should return data for demo user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('demo', 'demopassword'))
      .expect(200);

    expect(response.body).toHaveProperty('cleanbot');
    expect(response.body).not.toHaveProperty('mieleClientId'); // Admin only
  });

  it('should turn on cleanbot', async () => {
    await request(app)
      .post('/turnOnCleanbot')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCleanbot.turnOn).toHaveBeenCalled();
  });

  it('should turn off cleanbot', async () => {
    await request(app)
      .post('/turnOffCleanbot')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCleanbot.turnOff).toHaveBeenCalled();
  });


  it('should clean a room by name', async () => {
    await request(app)
      .post('/cleanbot/rooms')
      .set('Authorization', oidcAuthHeader)
      .send({ rooms: ['Kitchen'] })
      .expect(200);
    expect(mockCleanbot.cleanRooms).toHaveBeenCalledWith([2], 1);
  });

  it('should reject unknown cleanbot rooms', async () => {
    await request(app)
      .post('/cleanbot/rooms')
      .set('Authorization', oidcAuthHeader)
      .send({ rooms: ['Garage'] })
      .expect(400);
    expect(mockCleanbot.cleanRooms).not.toHaveBeenCalled();
  });

  it('should reject cleanbot room repeats above three', async () => {
    await request(app)
      .post('/cleanbot/rooms')
      .set('Authorization', oidcAuthHeader)
      .send({ rooms: ['Kitchen'], repeats: 4 })
      .expect(400);
    expect(mockCleanbot.cleanRooms).not.toHaveBeenCalled();
  });

  it('should control the air purifier fan for admin', async () => {
    await request(app)
      .post('/airPurifierFan')
      .set('Authorization', oidcAuthHeader)
      .send({ on: true })
      .expect(200);
  });

  it('should reject air purifier fan control for non-admin', async () => {
    await request(app)
      .post('/airPurifierFan')
      .set('Authorization', basicAuthHeader('demo', 'demopassword'))
      .send({ on: true })
      .expect(403);
  });

  it('should validate air purifier speed input', async () => {
    await request(app)
      .post('/airPurifierSpeed')
      .set('Authorization', oidcAuthHeader)
      .send({})
      .expect(400);
  });

  it('should set the air purifier speed for admin', async () => {
    await request(app)
      .post('/airPurifierSpeed')
      .set('Authorization', oidcAuthHeader)
      .send({ percentage: 50 })
      .expect(200);
  });

  it('should reject air purifier fan control without an on flag', async () => {
    await request(app)
      .post('/airPurifierFan')
      .set('Authorization', oidcAuthHeader)
      .send({})
      .expect(400);
  });

  it('should validate the air purifier preset mode', async () => {
    await request(app)
      .post('/airPurifierPreset')
      .set('Authorization', oidcAuthHeader)
      .send({ mode: 'bad mode!' })
      .expect(400);
  });

  it('should reject an unsupported air purifier preset mode', async () => {
    await request(app)
      .post('/airPurifierPreset')
      .set('Authorization', oidcAuthHeader)
      .send({ mode: 'bogus' })
      .expect(400);
  });

  it('should reject air purifier light control without brightness or on flag', async () => {
    await request(app)
      .post('/airPurifierLight')
      .set('Authorization', oidcAuthHeader)
      .send({ brightness: null })
      .expect(400);
  });

  it('should control the air purifier light for admin', async () => {
    await request(app)
      .post('/airPurifierLight')
      .set('Authorization', oidcAuthHeader)
      .send({ on: true })
      .expect(200);
  });

  it('should handle deep clean', async () => {
    await request(app)
      .post('/turnOnDeepClean')
      .set('Authorization', oidcAuthHeader)
      .expect(200);

    expect(mockCleanbot.turnOn).toHaveBeenCalled();
  });

  it('should stop deep clean', async () => {
    await request(app)
      .post('/turnOffDeepClean')
      .set('Authorization', oidcAuthHeader)
      .expect(200);

    expect(mockCleanbot.turnOff).toHaveBeenCalled();
  });

  it('should start car', async () => {
    await request(app)
      .post('/startCar')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCar.start).toHaveBeenCalled();
  });

  it('should stop car', async () => {
    await request(app)
      .post('/stopCar')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCar.stop).toHaveBeenCalled();
  });

  it('should lock car', async () => {
    await request(app)
      .post('/lockCar')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCar.lock).toHaveBeenCalled();
  });

  it('should unlock car', async () => {
    await request(app)
      .post('/unlockCar')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCar.unlock).toHaveBeenCalled();
  });

  it('should resync car', async () => {
    await request(app)
      .post('/resyncCar')
      .set('Authorization', oidcAuthHeader)
      .expect(200);
    expect(mockCar.resync).toHaveBeenCalled();
  });

  it('should return health status unauthenticated', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);
    expect(response.body).toHaveProperty('status');
    expect(response.body).toHaveProperty('version');
    expect(response.body).toHaveProperty('services');
  });

  it('should fetch schedule', async () => {
    (global.fetch as vi.Mock).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ schedule: [] }),
    });

    await fetchSchedule();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('gingrapp.com'),
      expect.anything(),
    );

    // Wait for promise chain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/rhizome.json',
      expect.anything(),
    );
  });

  it('should fetch rhizome photos', async () => {
    (global.fetch as vi.Mock).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([{ download_url: 'http://photo.url' }]),
    });

    await fetchRhizomePhotos();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('api.github.com'),
    );

    // Wait for promise chain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/rhizomePhotos.json',
      expect.anything(),
    );
  });

  describe('POST /voice', () => {
    const mockedTranscribeAudio = vi.mocked(transcribeAudio);
    const mockedSynthesizeSpeech = vi.mocked(synthesizeSpeech);
    const mockedExecuteAICommand = vi.mocked(executeAICommand);

    beforeEach(() => {
      mockedTranscribeAudio.mockResolvedValue('Turn on the lights');
      mockedSynthesizeSpeech.mockResolvedValue(Buffer.from('fake-audio'));
      mockedExecuteAICommand.mockResolvedValue('Lights are on.');
    });

    // Some tests below enable the memory path by giving getPool a live pool;
    // restore the default (no DB) afterwards so it never leaks into other tests.
    afterEach(() => {
      vi.mocked(getPool).mockReturnValue(null);
    });

    const enableMemoryPool = () => {
      vi.mocked(getPool).mockReturnValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as never);
    };

    it('returns 403 for non-admin', async () => {
      await request(app)
        .post('/voice')
        .set('Authorization', basicAuthHeader('rhizome', 'rhizomepassword'))
        .send({ text: 'hello' })
        .expect(403);
    });

    it('returns 400 when neither audio nor text is provided', async () => {
      await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({})
        .expect(400);
    });

    it('processes text input and returns audio/mpeg', async () => {
      enableMemoryPool();
      const response = await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({ text: 'Turn on the lights' })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(mockedExecuteAICommand).toHaveBeenCalledWith(
        'Turn on the lights',
        expect.anything(),
        [],
        undefined,
        undefined,
        expect.stringContaining('long-term memory'),
        'test-user-123',
      );
      expect(mockedSynthesizeSpeech).toHaveBeenCalledWith('Lights are on.');
      expect(response.headers['x-transcript']).toBe(encodeURIComponent('Turn on the lights'));
      expect(response.headers['x-response']).toBe(encodeURIComponent('Lights are on.'));
    });

    it('processes base64 audio input via STT then returns audio/mpeg', async () => {
      enableMemoryPool();
      const fakeAudio = Buffer.from('fake audio bytes').toString('base64');
      await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({ audio: fakeAudio, filename: 'recording.webm' })
        .expect(200);

      expect(mockedTranscribeAudio).toHaveBeenCalledWith(
        expect.any(Buffer),
        'recording.webm',
      );
      expect(mockedExecuteAICommand).toHaveBeenCalledWith(
        'Turn on the lights',
        expect.anything(),
        [],
        undefined,
        undefined,
        expect.stringContaining('long-term memory'),
        'test-user-123',
      );
    });

    it('defaults filename to audio.webm when not provided', async () => {
      const fakeAudio = Buffer.from('fake').toString('base64');
      await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({ audio: fakeAudio })
        .expect(200);

      expect(mockedTranscribeAudio).toHaveBeenCalledWith(
        expect.any(Buffer),
        'audio.webm',
      );
    });

    it('returns 500 when STT throws', async () => {
      mockedTranscribeAudio.mockRejectedValue(new Error('STT failed'));
      const fakeAudio = Buffer.from('fake').toString('base64');
      const response = await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({ audio: fakeAudio })
        .expect(500);

      expect(response.body.error).toBe('STT failed');
    });

    it('returns 500 when TTS throws', async () => {
      mockedSynthesizeSpeech.mockRejectedValue(new Error('TTS failed'));
      const response = await request(app)
        .post('/voice')
        .set('Authorization', oidcAuthHeader)
        .send({ text: 'hello' })
        .expect(500);

      expect(response.body.error).toBe('TTS failed');
    });
  });
});
