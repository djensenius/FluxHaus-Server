import fs from 'fs';
import { Router } from 'express';
import cors, { CorsOptions } from 'cors';
import HomeAssistantRobot from '../homeassistant-robot';
import Car from '../car';
import Miele from '../miele';
import HomeConnect from '../homeconnect';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../../package.json');

export interface DataRouteDeps {
  car: Car;
  broombot: HomeAssistantRobot;
  mopbot: HomeAssistantRobot;
  mieleClient: Miele;
  hc: HomeConnect;
  cameraURL: string;
  corsOptions: CorsOptions;
}

export function createDataRouter(deps: DataRouteDeps): Router {
  const {
    car, broombot, mopbot, mieleClient, hc, cameraURL, corsOptions,
  } = deps;
  const router = Router();

  router.get('/', cors(corsOptions), (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const evStatus = car.status?.evStatus ?? null;

    let rhizomeSchedule = null;
    if (fs.existsSync('cache/rhizome.json')) {
      rhizomeSchedule = JSON.parse(fs.readFileSync('cache/rhizome.json', 'utf8'));
    }

    let rhizomeData = null;
    if (fs.existsSync('cache/rhizomePhotos.json')) {
      rhizomeData = JSON.parse(fs.readFileSync('cache/rhizomePhotos.json', 'utf8'));
    }

    let miele = null;
    if (fs.existsSync('cache/miele.json')) {
      miele = JSON.parse(fs.readFileSync('cache/miele.json', 'utf8'));
    }

    let homeConnect = null;
    if (fs.existsSync('cache/homeconnect.json')) {
      homeConnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
    }

    let data = {};
    const { role } = req.user ?? {};

    if (role === 'admin') {
      data = {
        version,
        timestamp: new Date(),
        mieleClientId: process.env.mieleClientId,
        mieleSecretId: process.env.mieleSecretId,
        mieleAppliances: process.env.mieleAppliances!.split(', '),
        boschClientId: process.env.boschClientId,
        boschSecretId: process.env.boschSecretId,
        boschAppliance: process.env.boschAppliance,
        favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
        broombot: {
          batteryLevel: HomeAssistantRobot.batteryLevelStatus(broombot.cachedStatus),
          bin: HomeAssistantRobot.binStatus(broombot.cachedStatus),
          binFull: broombot.cachedStatus.binFull,
          running: HomeAssistantRobot.runningStatus(broombot.cachedStatus),
          charging: HomeAssistantRobot.chargingStatus(broombot.cachedStatus),
          docking: HomeAssistantRobot.dockingStatus(broombot.cachedStatus),
          docked: HomeAssistantRobot.dockedStatus(broombot.cachedStatus),
          battery: HomeAssistantRobot.batteryStatus(broombot.cachedStatus),
          timestamp: broombot.cachedStatus.timestamp,
          paused: broombot.cachedStatus.paused,
          timeStarted: broombot.cachedStatus.timeStarted,
        },
        mopbot: {
          batteryLevel: HomeAssistantRobot.batteryLevelStatus(mopbot.cachedStatus),
          bin: HomeAssistantRobot.binStatus(mopbot.cachedStatus),
          binFull: mopbot.cachedStatus.binFull,
          running: HomeAssistantRobot.runningStatus(mopbot.cachedStatus),
          charging: HomeAssistantRobot.chargingStatus(mopbot.cachedStatus),
          docking: HomeAssistantRobot.dockingStatus(mopbot.cachedStatus),
          docked: HomeAssistantRobot.dockedStatus(mopbot.cachedStatus),
          battery: HomeAssistantRobot.batteryStatus(mopbot.cachedStatus),
          timestamp: mopbot.cachedStatus.timestamp,
          paused: mopbot.cachedStatus.paused,
          timeStarted: mopbot.cachedStatus.timeStarted,
        },
        car: car.status,
        carEvStatus: evStatus,
        carOdometer: car.odometer,
        cameraURL,
        rhizomeSchedule,
        rhizomeData,
        miele,
        homeConnect,
        dishwasher: hc.dishwasher,
        washer: mieleClient.washer,
        dryer: mieleClient.dryer,
      };
    } else if (role === 'rhizome') {
      data = {
        version,
        cameraURL,
        rhizomeSchedule,
        rhizomeData,
      };
    } else if (role === 'demo') {
      data = {
        version,
        timestamp: new Date(),
        favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
        broombot: {
          batteryLevel: HomeAssistantRobot.batteryLevelStatus(broombot.cachedStatus),
          bin: HomeAssistantRobot.binStatus(broombot.cachedStatus),
          binFull: broombot.cachedStatus.binFull,
          running: HomeAssistantRobot.runningStatus(broombot.cachedStatus),
          charging: HomeAssistantRobot.chargingStatus(broombot.cachedStatus),
          docking: HomeAssistantRobot.dockingStatus(broombot.cachedStatus),
          docked: HomeAssistantRobot.dockedStatus(broombot.cachedStatus),
          battery: HomeAssistantRobot.batteryStatus(broombot.cachedStatus),
          timestamp: broombot.cachedStatus.timestamp,
          paused: broombot.cachedStatus.paused,
          timeStarted: broombot.cachedStatus.timeStarted,
        },
        mopbot: {
          batteryLevel: HomeAssistantRobot.batteryLevelStatus(mopbot.cachedStatus),
          bin: HomeAssistantRobot.binStatus(mopbot.cachedStatus),
          binFull: mopbot.cachedStatus.binFull,
          running: HomeAssistantRobot.runningStatus(mopbot.cachedStatus),
          charging: HomeAssistantRobot.chargingStatus(mopbot.cachedStatus),
          docking: HomeAssistantRobot.dockingStatus(mopbot.cachedStatus),
          docked: HomeAssistantRobot.dockedStatus(mopbot.cachedStatus),
          battery: HomeAssistantRobot.batteryStatus(mopbot.cachedStatus),
          timestamp: mopbot.cachedStatus.timestamp,
          paused: mopbot.cachedStatus.paused,
          timeStarted: mopbot.cachedStatus.timeStarted,
        },
        car: car.status,
        carEvStatus: evStatus,
        carOdometer: car.odometer,
        miele,
        homeConnect,
        dishwasher: hc.dishwasher,
        washer: mieleClient.washer,
        dryer: mieleClient.dryer,
      };
    }

    res.end(JSON.stringify(data));
  });

  return router;
}
