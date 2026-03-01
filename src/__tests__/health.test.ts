import request from 'supertest';
import fs from 'fs';
import express from 'express';
import { createServer } from '../server';
import HomeAssistantRobot from '../homeassistant-robot';
import Car from '../car';
import Miele from '../miele';
import HomeConnect from '../homeconnect';

jest.mock('fs');
jest.mock('../homeassistant-robot');
jest.mock('../car');
jest.mock('../miele');
jest.mock('../homeconnect');
jest.mock('../homeassistant-client');
jest.mock('../db');
jest.mock('../middleware/auth.middleware', () => ({
  authMiddleware: (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ) => {
    next();
  },
}));

global.fetch = jest.fn(() => Promise.resolve({
  json: () => Promise.resolve({}),
})) as jest.Mock;

describe('Health endpoint', () => {
  let app: express.Express;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.RHIZOME_PASSWORD = 'rhizomepassword';
    process.env.DEMO_PASSWORD = 'demopassword';
    process.env.mieleAppliances = 'Washer, Dryer';
    process.env.favouriteHomeKit = 'Light, Switch';
    process.env.MODERN_DOG_URL = 'https://moddogkitchener.portal.gingrapp.com/api/v1/reservations';

    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (fs.readFileSync as jest.Mock).mockReturnValue('{}');

    const mockBroombot = { cachedStatus: {}, turnOn: jest.fn(), turnOff: jest.fn() };
    const mockMopbot = { cachedStatus: {}, turnOn: jest.fn(), turnOff: jest.fn() };
    (HomeAssistantRobot as unknown as jest.Mock).mockImplementation((config: { name: string }) => {
      if (config.name === 'Broombot') return mockBroombot;
      return mockMopbot;
    });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (HomeAssistantRobot as any).batteryLevelStatus = jest.fn().mockReturnValue(100);
    (HomeAssistantRobot as any).binStatus = jest.fn().mockReturnValue('OK');
    (HomeAssistantRobot as any).runningStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).chargingStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockingStatus = jest.fn().mockReturnValue(false);
    (HomeAssistantRobot as any).dockedStatus = jest.fn().mockReturnValue('Docked');
    (HomeAssistantRobot as any).batteryStatus = jest.fn().mockReturnValue('Normal');
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const mockCar = { status: {}, odometer: 0, setStatus: jest.fn().mockResolvedValue(undefined) };
    (Car as unknown as jest.Mock).mockImplementation(() => mockCar);
    (Miele as unknown as jest.Mock).mockImplementation(() => ({
      getActivePrograms: jest.fn(),
      listenEvents: jest.fn(),
      washer: {},
      dryer: {},
    }));
    (HomeConnect as unknown as jest.Mock).mockImplementation(() => ({
      getActiveProgram: jest.fn(),
      listenEvents: jest.fn(),
      dishwasher: {},
    }));

    app = await createServer();
  });

  it('should return healthy response without authentication', async () => {
    const response = await request(app).get('/health').expect(200);

    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('timestamp');
  });

  it('should be accessible without an Authorization header', async () => {
    await request(app).get('/health').expect(200);
  });
});
