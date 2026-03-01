import { Router } from 'express';
import cors, { CorsOptions } from 'cors';
import HomeAssistantRobot from '../homeassistant-robot';
import requireRole from '../middleware/require-role.middleware';

export interface RobotRouteDeps {
  broombot: HomeAssistantRobot;
  mopbot: HomeAssistantRobot;
  corsOptions: CorsOptions;
}

export function createRobotRouter(deps: RobotRouteDeps): Router {
  const { broombot, mopbot, corsOptions } = deps;
  const router = Router();
  let cleanTimeout: ReturnType<typeof setTimeout> | null = null;

  router.get(
    '/turnOnMopbot',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await mopbot.turnOn();
      res.send('Mopbot is turned on.');
    },
  );

  router.get(
    '/turnOffMopbot',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await mopbot.turnOff();
      res.send('Mopbot is turned off.');
    },
  );

  router.get(
    '/turnOnBroombot',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await broombot.turnOn();
      res.send('Broombot is turned on.');
    },
  );

  router.get(
    '/turnOffBroombot',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await broombot.turnOff();
      res.send('Broombot is turned off.');
    },
  );

  router.get(
    '/turnOnDeepClean',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await broombot.turnOn();
      cleanTimeout = setTimeout(() => {
        mopbot.turnOn();
      }, 1200000);
      res.send('Broombot is turned on.');
    },
  );

  router.get(
    '/turnOffDeepClean',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      await broombot.turnOff();
      if (cleanTimeout) {
        clearTimeout(cleanTimeout);
      }
      await mopbot.turnOff();
      res.send('Broombot is turned off.');
    },
  );

  return router;
}
