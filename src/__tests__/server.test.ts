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

// Mock dependencies
jest.mock('fs');
jest.mock('../homeassistant-robot');
jest.mock('../car');
jest.mock('../miele');
jest.mock('../homeconnect');
jest.mock('../homeassistant-client');
jest.mock('../stt', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue('Turn on the lights'),
}));
jest.mock('../tts', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(Buffer.from('fake-audio')),
}));
jest.mock('../ai-command', () => ({
  executeAICommand: jest.fn().mockResolvedValue('Lights are on.'),
}));
jest.mock('../db', () => ({
  initPool: jest.fn(),
  initDatabase: jest.fn(),
  closePool: jest.fn(),
  getPool: jest.fn().mockReturnValue(null),
}));
jest.mock('../influx', () => ({
  initInflux: jest.fn(),
  writePoint: jest.fn(),
  flushWrites: jest.fn(),
  closeClient: jest.fn(),
}));
jest.mock('../middleware/oidc.middleware', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { Router } = require('express');
  return {
    initOidc: jest.fn(),
    getOidcIssuer: jest.fn().mockReturnValue(null),
    validateBearerToken: jest.fn().mockResolvedValue(null),
    isOidcEnabled: jest.fn().mockReturnValue(false),
    createAuthRouter: jest.fn().mockReturnValue(Router()),
  };
});

// Mock global fetch
global.fetch = jest.fn(() => Promise.resolve({
  json: () => Promise.resolve({}),
})) as jest.Mock;

// Helper: base64 encode basic auth credentials
function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('Server', () => {
  let app: express.Express;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockBroombot: any;
  let mockMopbot: any;
  let mockCar: any;
  let mockMiele: any;
  let mockHomeConnect: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.BASIC_AUTH_PASSWORD = 'adminpassword';
    process.env.RHIZOME_PASSWORD = 'rhizomepassword';
    process.env.DEMO_PASSWORD = 'demopassword';
    process.env.mieleAppliances = 'Washer, Dryer';
    process.env.favouriteHomeKit = 'Light, Switch';
    process.env.MODERN_DOG_URL = 'https://moddogkitchener.portal.gingrapp.com/api/v1/reservations';

    // Setup mocks
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('{}');

    mockBroombot = {
      cachedStatus: { batteryLevel: 100 },
      turnOn: jest.fn(),
      turnOff: jest.fn(),
    };
    mockMopbot = {
      cachedStatus: { batteryLevel: 100 },
      turnOn: jest.fn(),
      turnOff: jest.fn(),
    };
    (HomeAssistantRobot as unknown as jest.Mock).mockImplementation((config) => {
      if (config.name === 'Broombot') return mockBroombot;
      return mockMopbot;
    });
    // Mock static methods
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (HomeAssistantRobot as any).batteryLevelStatus = jest.fn().mockReturnValue(100);
    (HomeAssistantRobot as any).binStatus = jest.fn().mockReturnValue('OK');
    (HomeAssistantRobot as any).runningStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).chargingStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockingStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockedStatus = jest.fn().mockReturnValue('Docked');
    (HomeAssistantRobot as any).batteryStatus = jest.fn().mockReturnValue('Normal');
    /* eslint-enable @typescript-eslint/no-explicit-any */

    mockCar = {
      status: {},
      odometer: 1000,
      setStatus: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue('Started'),
      stop: jest.fn().mockResolvedValue('Stopped'),
      lock: jest.fn().mockResolvedValue('Locked'),
      unlock: jest.fn().mockResolvedValue('Unlocked'),
      resync: jest.fn(),
    };
    (Car as unknown as jest.Mock).mockImplementation(() => mockCar);

    mockMiele = {
      getActivePrograms: jest.fn(),
      listenEvents: jest.fn(),
      washer: {},
      dryer: {},
    };
    (Miele as unknown as jest.Mock).mockImplementation(() => mockMiele);

    mockHomeConnect = {
      getActiveProgram: jest.fn(),
      listenEvents: jest.fn(),
      dishwasher: {},
    };
    (HomeConnect as unknown as jest.Mock).mockImplementation(() => mockHomeConnect);

    app = await createServer();
  });

  it('should return 401 without auth', async () => {
    await request(app).get('/').expect(401);
  });

  it('should return data for admin user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);

    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('broombot');
    expect(response.body).toHaveProperty('mopbot');
    expect(response.body).toHaveProperty('car');
  });

  it('should omit missing robot status keys', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (HomeAssistantRobot as any).batteryLevelStatus = jest.fn().mockReturnValue(undefined);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);

    expect(response.body.broombot).not.toHaveProperty('batteryLevel');
  });

  it('should return data for rhizome user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('rhizome', 'rhizomepassword'))
      .expect(200);

    expect(response.body).toHaveProperty('rhizomeSchedule');
    expect(response.body).not.toHaveProperty('broombot');
  });

  it('should return data for demo user', async () => {
    const response = await request(app)
      .get('/')
      .set('Authorization', basicAuthHeader('demo', 'demopassword'))
      .expect(200);

    expect(response.body).toHaveProperty('broombot');
    expect(response.body).not.toHaveProperty('mieleClientId'); // Admin only
  });

  it('should turn on broombot', async () => {
    await request(app)
      .post('/turnOnBroombot')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockBroombot.turnOn).toHaveBeenCalled();
  });

  it('should turn off broombot', async () => {
    await request(app)
      .post('/turnOffBroombot')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockBroombot.turnOff).toHaveBeenCalled();
  });

  it('should turn on mopbot', async () => {
    await request(app)
      .post('/turnOnMopbot')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockMopbot.turnOn).toHaveBeenCalled();
  });

  it('should turn off mopbot', async () => {
    await request(app)
      .post('/turnOffMopbot')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockMopbot.turnOff).toHaveBeenCalled();
  });

  it('should handle deep clean', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await request(app)
      .post('/turnOnDeepClean')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);

    expect(mockBroombot.turnOn).toHaveBeenCalled();

    jest.advanceTimersByTime(1200000);
    expect(mockMopbot.turnOn).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('should stop deep clean', async () => {
    await request(app)
      .post('/turnOffDeepClean')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);

    expect(mockBroombot.turnOff).toHaveBeenCalled();
    expect(mockMopbot.turnOff).toHaveBeenCalled();
  });

  it('should start car', async () => {
    await request(app)
      .post('/startCar')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockCar.start).toHaveBeenCalled();
  });

  it('should stop car', async () => {
    await request(app)
      .post('/stopCar')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockCar.stop).toHaveBeenCalled();
  });

  it('should lock car', async () => {
    await request(app)
      .post('/lockCar')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockCar.lock).toHaveBeenCalled();
  });

  it('should unlock car', async () => {
    await request(app)
      .post('/unlockCar')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
      .expect(200);
    expect(mockCar.unlock).toHaveBeenCalled();
  });

  it('should resync car', async () => {
    await request(app)
      .post('/resyncCar')
      .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
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
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue({ schedule: [] }),
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
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue([{ download_url: 'http://photo.url' }]),
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
    const mockedTranscribeAudio = jest.mocked(transcribeAudio);
    const mockedSynthesizeSpeech = jest.mocked(synthesizeSpeech);
    const mockedExecuteAICommand = jest.mocked(executeAICommand);

    beforeEach(() => {
      mockedTranscribeAudio.mockResolvedValue('Turn on the lights');
      mockedSynthesizeSpeech.mockResolvedValue(Buffer.from('fake-audio'));
      mockedExecuteAICommand.mockResolvedValue('Lights are on.');
    });

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
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
        .send({})
        .expect(400);
    });

    it('processes text input and returns audio/mpeg', async () => {
      const response = await request(app)
        .post('/voice')
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
        .send({ text: 'Turn on the lights' })
        .expect(200);

      expect(response.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(mockedExecuteAICommand).toHaveBeenCalledWith(
        'Turn on the lights',
        expect.anything(),
        [],
      );
      expect(mockedSynthesizeSpeech).toHaveBeenCalledWith('Lights are on.');
      expect(response.headers['x-transcript']).toBe(encodeURIComponent('Turn on the lights'));
      expect(response.headers['x-response']).toBe(encodeURIComponent('Lights are on.'));
    });

    it('processes base64 audio input via STT then returns audio/mpeg', async () => {
      const fakeAudio = Buffer.from('fake audio bytes').toString('base64');
      await request(app)
        .post('/voice')
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
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
      );
    });

    it('defaults filename to audio.webm when not provided', async () => {
      const fakeAudio = Buffer.from('fake').toString('base64');
      await request(app)
        .post('/voice')
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
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
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
        .send({ audio: fakeAudio })
        .expect(500);

      expect(response.body.error).toBe('STT failed');
    });

    it('returns 500 when TTS throws', async () => {
      mockedSynthesizeSpeech.mockRejectedValue(new Error('TTS failed'));
      const response = await request(app)
        .post('/voice')
        .set('Authorization', basicAuthHeader('admin', 'adminpassword'))
        .send({ text: 'hello' })
        .expect(500);

      expect(response.body.error).toBe('TTS failed');
    });
  });
});
