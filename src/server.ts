import 'dotenv/config';
import fs from 'fs';
import express, { Express } from 'express';
import rateLimit from 'express-rate-limit';
import nocache from 'nocache';
import cors, { CorsOptions } from 'cors';
import basicAuth from 'express-basic-auth';
import notFoundHandler from './middleware/not-found.middleware';
import HomeAssistantRobot from './homeassistant-robot';
import { CarStartOptions } from './car';
import { createServices } from './services';

const port = process.env.PORT || 8888;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

export async function createServer(): Promise<Express> {
  const app: Express = express();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000,
    limit: 10000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use(
    limiter,
    nocache(),
    express.urlencoded({ extended: true }),
    basicAuth({
      users: {
        admin: process.env.BASIC_AUTH_PASSWORD!,
        rhizome: process.env.RHIZOME_PASSWORD!,
        demo: process.env.DEMO_PASSWORD!,
      },
      challenge: true,
      realm: 'fluxhaus',
    }),
  );
  const allowedOrigins = [
    'http://localhost:8080',
    'https://haus.fluxhaus.io',
  ];

  const corsOptions: CorsOptions = {
    allowedHeaders: ['Authorization', 'Content-Type'],
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        const msg = 'The CORS policy for this site does not '
                    + 'allow access from the specified Origin.';
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  };

  const {
    broombot,
    mopbot,
    car,
    mieleClient,
    hc,
    cameraURL,
  } = await createServices();

  let cleanTimeout: ReturnType<typeof setTimeout> | null = null;

  mieleClient.getActivePrograms();
  mieleClient.listenEvents();
  setInterval(() => {
    mieleClient.getActivePrograms();
  }, 600000);
  mieleClient.listenEvents();

  hc.getActiveProgram();
  hc.listenEvents();
  setInterval(() => {
    hc.getActiveProgram();
  }, 600000);

  setInterval(() => {
    fs.writeFileSync(
      'cache/dishwasher.json',
      JSON.stringify(hc.dishwasher),
    );
  }, 1000 * 60 * 60);


  app.get('/', cors(corsOptions), (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    res.setHeader('Content-Type', 'application/json');
    // Check if file exists and read it
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

    if (authReq.auth.user === 'admin') {
      const RobotClass = HomeAssistantRobot;
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
          batteryLevel: RobotClass.batteryLevelStatus(broombot.cachedStatus),
          bin: RobotClass.binStatus(broombot.cachedStatus),
          binFull: broombot.cachedStatus.binFull,
          running: RobotClass.runningStatus(broombot.cachedStatus),
          charging: RobotClass.chargingStatus(broombot.cachedStatus),
          docking: RobotClass.dockingStatus(broombot.cachedStatus),
          docked: RobotClass.dockedStatus(broombot.cachedStatus),
          battery: RobotClass.batteryStatus(broombot.cachedStatus),
          timestamp: broombot.cachedStatus.timestamp,
          paused: broombot.cachedStatus.paused,
          timeStarted: broombot.cachedStatus.timeStarted,
        },
        mopbot: {
          batteryLevel: RobotClass.batteryLevelStatus(mopbot.cachedStatus),
          bin: RobotClass.binStatus(mopbot.cachedStatus),
          binFull: mopbot.cachedStatus.binFull,
          running: RobotClass.runningStatus(mopbot.cachedStatus),
          charging: RobotClass.chargingStatus(mopbot.cachedStatus),
          docking: RobotClass.dockingStatus(mopbot.cachedStatus),
          docked: RobotClass.dockedStatus(mopbot.cachedStatus),
          battery: RobotClass.batteryStatus(mopbot.cachedStatus),
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
    } else if (authReq.auth.user === 'rhizome') {
      data = {
        version,
        cameraURL,
        rhizomeSchedule,
        rhizomeData,
      };
    } else if (authReq.auth.user === 'demo') {
      const RobotClass = HomeAssistantRobot;
      data = {
        version,
        timestamp: new Date(),
        favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
        broombot: {
          batteryLevel: RobotClass.batteryLevelStatus(broombot.cachedStatus),
          bin: RobotClass.binStatus(broombot.cachedStatus),
          binFull: broombot.cachedStatus.binFull,
          running: RobotClass.runningStatus(broombot.cachedStatus),
          charging: RobotClass.chargingStatus(broombot.cachedStatus),
          docking: RobotClass.dockingStatus(broombot.cachedStatus),
          docked: RobotClass.dockedStatus(broombot.cachedStatus),
          battery: RobotClass.batteryStatus(broombot.cachedStatus),
          timestamp: broombot.cachedStatus.timestamp,
          paused: broombot.cachedStatus.paused,
          timeStarted: broombot.cachedStatus.timeStarted,
        },
        mopbot: {
          batteryLevel: RobotClass.batteryLevelStatus(mopbot.cachedStatus),
          bin: RobotClass.binStatus(mopbot.cachedStatus),
          binFull: mopbot.cachedStatus.binFull,
          running: RobotClass.runningStatus(mopbot.cachedStatus),
          charging: RobotClass.chargingStatus(mopbot.cachedStatus),
          docking: RobotClass.dockingStatus(mopbot.cachedStatus),
          docked: RobotClass.dockedStatus(mopbot.cachedStatus),
          battery: RobotClass.batteryStatus(mopbot.cachedStatus),
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

  // Route handler for turning on mopbot
  app.get('/turnOnMopbot', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await mopbot.turnOn();
    }
    res.send('Mopbot is turned on.');
  });

  // Route handler for turning off mopbot
  app.get('/turnOffMopbot', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await mopbot.turnOff();
    }
    res.send('Mopbot is turned off.');
  });

  // Route handler for turning on broombot
  app.get('/turnOnBroombot', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await broombot.turnOn();
    }
    res.send('Broombot is turned on.');
  });

  // Route handler for turning off broombot
  app.get('/turnOffBroombot', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await broombot.turnOff();
    }
    res.send('Broombot is turned off.');
  });

  // Route handler for starting a deep clean
  app.get('/turnOnDeepClean', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await broombot.turnOn();
    }
    cleanTimeout = setTimeout(() => {
      mopbot.turnOn();
    }, 1200000);
    res.send('Broombot is turned on.');
  });

  // Route handler for stopping a deep clean
  app.get('/turnOffDeepClean', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      await broombot.turnOff();
    }
    if (cleanTimeout) {
      clearTimeout(cleanTimeout);
    }
    await mopbot.turnOff();
    res.send('Broombot is turned off.');
  });

  app.get('/startCar', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      const {
        temp,
        heatedFeatures,
        defrost,
        seatFL,
        seatFR,
        seatRL,
        seatRR,
      } = req.query;

      const config: Partial<CarStartOptions> = {};
      if (temp) {
        config.temperature = parseInt(temp as string, 10);
      }
      if (heatedFeatures) {
        config.heatedFeatures = heatedFeatures === 'true';
      }
      if (defrost) {
        config.defrost = defrost === 'true';
      }
      if (seatFL || seatFR || seatRL || seatRR) {
        config.seatClimateSettings = {
          driverSeat: seatFL ? parseInt(seatFL as string, 10) : 0,
          passengerSeat: seatFR ? parseInt(seatFR as string, 10) : 0,
          rearLeftSeat: seatRL ? parseInt(seatRL as string, 10) : 0,
          rearRightSeat: seatRR ? parseInt(seatRR as string, 10) : 0,
        };
      }

      const result = car.start(config);
      res.send(result);
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.get('/stopCar', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      const result = car.stop();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.get('/resyncCar', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      car.resync();
    }
    res.send('Resyncing car');
  });

  app.get('/lockCar', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      const result = car.lock();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.get('/unlockCar', cors(corsOptions), async (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    if (authReq.auth.user === 'admin') {
      const result = car.unlock();
      res.send(result);
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.use(notFoundHandler);

  return app;
}

export const fetchSchedule = () => {
  fetch(process.env.MODERN_DOG_URL || '', {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `bearer ${process.env.MODERN_DOG_TOKEN}`,
      'Sec-Fetch-Site': 'same-origin',
      'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Mode': 'cors',
      // eslint-disable-next-line max-len
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      Referer: 'https://moddogkitchener.portal.gingrapp.com/',
      Connection: 'keep-alive',
      Cookie: process.env.MODERN_DOG_COOKIE || '',
      'Sec-Fetch-Dest': 'empty',
      Priority: 'u=3, i',
    },
  }).then((response) => response.json())
    .then((json) => {
      fs.writeFileSync(
        'cache/rhizome.json',
        JSON.stringify({ timestamp: new Date(), ...json }, null, 2),
      );
    });
};

if (process.env.NODE_ENV !== 'test') {
  fetchSchedule();
  setInterval(() => {
    fetchSchedule();
  }, 1000 * 60 * 60);
}

const newsURL = 'https://raw.githubusercontent.com/djensenius/Rhizome-Data/main/news.md';

interface GitHubFile {
  name: string;
  download_url: string;
}

export const fetchRhizomePhotos = () => {
  fetch('https://api.github.com/repos/djensenius/Rhizome-Data/contents/photos?ref=main')
    .then((response) => response.json())
    .then((json) => {
      const photos = json.map((file: GitHubFile) => file.download_url);
      fs.writeFileSync(
        'cache/rhizomePhotos.json',
        JSON.stringify({ timestamp: new Date(), news: newsURL, photos: [...photos] }, null, 2),
      );
    });
};

if (process.env.NODE_ENV !== 'test') {
  fetchRhizomePhotos();

  setInterval(() => {
    fetchRhizomePhotos();
  }, 1000 * 60 * 60);

  createServer().then((app) => {
    app.listen(port, () => {
      console.warn(`⚡️[server]: Server is running at https://localhost:${port}`);
    });
  });
}
