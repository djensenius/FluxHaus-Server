import 'dotenv/config';
import fs from 'fs';
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import nocache from 'nocache';
import cors, { CorsOptions } from 'cors';
import notFoundHandler from './middleware/not-found.middleware';
import { authMiddleware } from './middleware/auth.middleware';
import auditMiddleware from './middleware/audit.middleware';
import { createAuthRouter, getOidcIssuer, initOidc } from './middleware/oidc.middleware';
import {
  closePool, getPool, initDatabase, initPool,
} from './db';
import { closeClient as closeInflux, flushWrites, initInflux } from './influx';
import HomeAssistantRobot from './homeassistant-robot';
import { HomeAssistantClient } from './homeassistant-client';
import Car, { CarConfig, CarStartOptions } from './car';
import Miele from './miele';
import HomeConnect from './homeconnect';
import adminRouter from './routes/admin.routes';
import logger from './logger';

const serverLogger = logger.child({ subsystem: 'server' });

const port = process.env.PORT || 8888;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

export async function createServer(): Promise<Express> {
  const app: Express = express();

  // Trust reverse proxy (needed for secure cookies behind SSL termination)
  app.set('trust proxy', 1);

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10000,
    limit: 10000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const sessionSecret = process.env.SESSION_SECRET || 'fluxhaus-dev-secret';

  app.use(
    limiter,
    nocache(),
    cookieParser(sessionSecret),
    express.urlencoded({ extended: true }),
  );

  // PG-backed session store (for server-side session tracking/revocation)
  const PgStore = connectPgSimple(session);
  const pool = getPool();
  const sessionConfig: session.SessionOptions = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax',
    },
  };
  if (pool) {
    sessionConfig.store = new PgStore({ pool, createTableIfMissing: true });
  }
  app.use(session(sessionConfig));

  const allowedOrigins = (
    process.env.CORS_ORIGINS || 'http://localhost:8080,https://haus.fluxhaus.io'
  ).split(',').map((o) => o.trim());

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

  // Health check — unauthenticated, before auth middleware
  app.get('/health', async (_req, res) => {
    const services: Record<string, string> = {};
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    const dbPool = getPool();
    if (dbPool) {
      try {
        const timeoutP = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 3000);
        });
        await Promise.race([dbPool.query('SELECT 1'), timeoutP]);
        services.postgres = 'up';
      } catch {
        services.postgres = 'down';
        overallStatus = 'unhealthy';
      }
    } else {
      services.postgres = 'not_configured';
    }

    if (process.env.INFLUXDB_URL) {
      try {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${process.env.INFLUXDB_URL}/health`, { signal: controller.signal });
        clearTimeout(to);
        services.influxdb = resp.ok ? 'up' : 'down';
        if (!resp.ok && overallStatus === 'healthy') overallStatus = 'degraded';
      } catch {
        services.influxdb = 'down';
        if (overallStatus === 'healthy') overallStatus = 'degraded';
      }
    } else {
      services.influxdb = 'not_configured';
    }

    if (process.env.OIDC_ISSUER_URL) {
      services.oidc = getOidcIssuer() ? 'up' : 'down';
      if (!getOidcIssuer() && overallStatus === 'healthy') overallStatus = 'degraded';
    } else {
      services.oidc = 'not_configured';
    }

    res.status(overallStatus === 'unhealthy' ? 503 : 200).json({
      status: overallStatus,
      version,
      timestamp: new Date().toISOString(),
      services,
    });
  });

  // OIDC auth routes (login, callback, logout) — unauthenticated
  app.use(createAuthRouter());

  // Auth middleware
  app.use(authMiddleware);
  app.use(auditMiddleware);

  const homeAssistantClient = new HomeAssistantClient({
    url: (process.env.HOMEASSISTANT_URL || 'http://homeassistant.local:8123').trim(),
    token: (process.env.HOMEASSISTANT_TOKEN || '').trim(),
  });

  serverLogger.info('Using Home Assistant for robots');
  const broombot = new HomeAssistantRobot({
    name: 'Broombot',
    entityId: (process.env.BROOMBOT_ENTITY_ID || 'vacuum.broombot').trim(),
    batteryEntityId: (process.env.BROOMBOT_BATTERY_ENTITY_ID || '').trim(),
    client: homeAssistantClient,
  });

  const mopbot = new HomeAssistantRobot({
    name: 'Mopbot',
    entityId: (process.env.MOPBOT_ENTITY_ID || 'vacuum.mopbot').trim(),
    batteryEntityId: (process.env.MOPBOT_BATTERY_ENTITY_ID || '').trim(),
    client: homeAssistantClient,
  });

  let cleanTimeout: ReturnType<typeof setTimeout> | null = null;

  const carConfig: CarConfig = {
    client: homeAssistantClient,
    entityPrefix: process.env.CAR_ENTITY_PREFIX || 'kia',
  };

  const car = new Car(carConfig);
  await car.setStatus();
  const cameraURL = process.env.CAMERA_URL || '';
  const clientId = process.env.mieleClientId || '';
  const secretId = process.env.mieleSecretId || '';
  const mieleClient = new Miele(clientId, secretId);
  mieleClient.getActivePrograms();
  mieleClient.listenEvents();
  setInterval(() => {
    mieleClient.getActivePrograms();
  }, 600000);
  mieleClient.listenEvents();

  const homeConnectClientId = process.env.boschClientId || '';
  const homeConnectSecretId = process.env.boschSecretId || '';
  const hc = new HomeConnect(homeConnectClientId, homeConnectSecretId);
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
    res.setHeader('Content-Type', 'application/json');
    const evStatus = car.status?.evStatus ?? null;
    const role = req.user?.role;

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

    if (role === 'admin') {
      const RobotClass = HomeAssistantRobot;
      const broomData: Record<string, unknown> = {
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
      };
      const bBattLevel = RobotClass.batteryLevelStatus(broombot.cachedStatus);
      if (bBattLevel !== undefined) broomData.batteryLevel = bBattLevel;

      const mopData: Record<string, unknown> = {
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
      };
      const mBattLevel = RobotClass.batteryLevelStatus(mopbot.cachedStatus);
      if (mBattLevel !== undefined) mopData.batteryLevel = mBattLevel;

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
        broombot: broomData,
        mopbot: mopData,
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
      const RobotClass = HomeAssistantRobot;
      const broomData: Record<string, unknown> = {
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
      };
      const bBattLevel = RobotClass.batteryLevelStatus(broombot.cachedStatus);
      if (bBattLevel !== undefined) broomData.batteryLevel = bBattLevel;

      const mopData: Record<string, unknown> = {
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
      };
      const mBattLevel = RobotClass.batteryLevelStatus(mopbot.cachedStatus);
      if (mBattLevel !== undefined) mopData.batteryLevel = mBattLevel;

      data = {
        version,
        timestamp: new Date(),
        favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
        broombot: broomData,
        mopbot: mopData,
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
    if (req.user?.role === 'admin') {
      await mopbot.turnOn();
    }
    res.send('Mopbot is turned on.');
  });

  // Route handler for turning off mopbot
  app.get('/turnOffMopbot', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      await mopbot.turnOff();
    }
    res.send('Mopbot is turned off.');
  });

  // Route handler for turning on broombot
  app.get('/turnOnBroombot', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOn();
    }
    res.send('Broombot is turned on.');
  });

  // Route handler for turning off broombot
  app.get('/turnOffBroombot', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOff();
    }
    res.send('Broombot is turned off.');
  });

  // Route handler for starting a deep clean
  app.get('/turnOnDeepClean', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOn();
    }
    cleanTimeout = setTimeout(() => {
      mopbot.turnOn();
    }, 1200000);
    res.send('Broombot is turned on.');
  });

  // Route handler for stopping a deep clean
  app.get('/turnOffDeepClean', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOff();
    }
    if (cleanTimeout) {
      clearTimeout(cleanTimeout);
    }
    await mopbot.turnOff();
    res.send('Broombot is turned off.');
  });

  app.get('/startCar', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
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
    if (req.user?.role === 'admin') {
      const result = car.stop();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.get('/resyncCar', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      car.resync();
    }
    res.send('Resyncing car');
  });

  app.get('/lockCar', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      const result = car.lock();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.get('/unlockCar', cors(corsOptions), async (req, res) => {
    if (req.user?.role === 'admin') {
      const result = car.unlock();
      res.send(result);
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.use(adminRouter);
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

  (async () => {
    initPool();
    await initDatabase();
    initInflux();
    await initOidc();

    const app = await createServer();
    const server = app.listen(port, () => {
      serverLogger.info({ port }, 'Server is running');
    });

    const shutdown = async (signal: string) => {
      serverLogger.info({ signal }, 'Shutting down gracefully');
      const forceExit = setTimeout(() => {
        serverLogger.error('Forced exit after timeout');
        process.exit(1);
      }, 10000);
      forceExit.unref();

      server.close(async () => {
        await flushWrites();
        await closeInflux();
        await closePool();
        serverLogger.info('Shutdown complete');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })();
}
