import 'dotenv/config';
import fs from 'fs';
import express, { Express } from 'express';
import rateLimit from 'express-rate-limit';
import nocache from 'nocache';
import cors, { CorsOptions } from 'cors';
import basicAuth from 'express-basic-auth';
import notFoundHandler from './middleware/not-found.middleware';
import Robot, { AccessoryConfig } from './robots';
import Car, { CarConfig } from './car';

const port = process.env.PORT || 8080;

async function createServer(): Promise<Express> {
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
      users: { admin: process.env.BASIC_AUTH_PASSWORD! },
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

  const broombotConfig: AccessoryConfig = {
    name: 'Broombot',
    model: process.env.broombotModel!,
    serialnum: '',
    blid: process.env.broombotBlid!,
    robotpwd: process.env.broombotPassword!,
    ipaddress: process.env.broombotIp!,
    cleanBehaviour: 'everywhere',
    stopBehaviour: 'home',
    idleWatchInterval: 5,
  };

  const broombot = new Robot(broombotConfig);

  const mopbotConfig: AccessoryConfig = {
    name: 'Mopbot',
    model: process.env.mopbotModel!,
    serialnum: '',
    blid: process.env.mopbotBlid!,
    robotpwd: process.env.mopbotPassword!,
    ipaddress: process.env.mopbotIp!,
    cleanBehaviour: 'everywhere',
    stopBehaviour: 'home',
    idleWatchInterval: 15,
  };

  const mopbot = new Robot(mopbotConfig);

  const carConfig: CarConfig = {
    username: process.env.carLogin!,
    password: process.env.carPassword!,
    pin: process.env.carPin!,
    region: 'CA',
    useInfo: true,
    brand: 'kia',
  };

  const car = new Car(carConfig);

  app.get('/', cors(corsOptions), (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // Check if file exists and read it
    let evStatus = null;
    if (fs.existsSync('cache/evStatus.json')) {
      evStatus = JSON.parse(fs.readFileSync('cache/evStatus.json', 'utf8'));
    }
    const data = {
      mieleClientId: process.env.mieleClientId,
      mieleSecretId: process.env.mieleSecretId,
      mieleAppliances: process.env.mieleAppliances!.split(', '),
      boschClientId: process.env.boschClientId,
      boschSecretId: process.env.boschSecretId,
      boschAppliance: process.env.boschAppliance,
      favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
      broombot: broombot.cachedStatus,
      mopbot: mopbot.cachedStatus,
      car: car.status,
      carEvStatus: evStatus,
      carOdometer: car.odometer,
    };
    res.end(JSON.stringify(data));
  });

  app.get('/startCar', cors(corsOptions), async (_req, res) => {
    const result = car.start();
    res.send(result);
    setTimeout(() => {
      car.resync();
    }, 5000);
  });

  app.get('/stopCar', cors(corsOptions), async (_req, res) => {
    const result = car.stop();
    res.send(JSON.stringify({ result }));
    setTimeout(() => {
      car.resync();
    }, 5000);
  });

  app.get('/resyncCar', cors(corsOptions), async (_req, res) => {
    car.resync();
    res.send('Resyncing car');
  });

  app.get('/lockCar', cors(corsOptions), async (_req, res) => {
    const result = car.lock();
    res.send(JSON.stringify({ result }));
    setTimeout(() => {
      car.resync();
    }, 5000);
  });

  app.get('/unlockCar', cors(corsOptions), async (_req, res) => {
    const result = car.unlock();
    res.send(result);
    setTimeout(() => {
      car.resync();
    }, 5000);
  });

  app.use(notFoundHandler);

  return app;
}

createServer().then((app) => {
  app.listen(port, () => {
    console.warn(`⚡️[server]: Server is running at https://localhost:${port}`);
  });
});
