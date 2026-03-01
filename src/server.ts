import 'dotenv/config';
import fs from 'fs';
import express, { Express } from 'express';
import rateLimit from 'express-rate-limit';
import nocache from 'nocache';
import { CorsOptions } from 'cors';
import basicAuth from 'express-basic-auth';
import notFoundHandler from './middleware/not-found.middleware';
import mapBasicAuthToUser from './middleware/auth.middleware';
import HomeAssistantRobot from './homeassistant-robot';
import { HomeAssistantClient } from './homeassistant-client';
import Car, { CarConfig } from './car';
import Miele from './miele';
import HomeConnect from './homeconnect';
import { createDataRouter } from './routes/data.routes';
import { createRobotRouter } from './routes/robot.routes';
import { createCarRouter } from './routes/car.routes';
import adminRouter from './routes/admin.routes';

const port = process.env.PORT || 8888;

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
    mapBasicAuthToUser,
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

  const homeAssistantClient = new HomeAssistantClient({
    url: (process.env.HOMEASSISTANT_URL || 'http://homeassistant.local:8123').trim(),
    token: (process.env.HOMEASSISTANT_TOKEN || '').trim(),
  });

  // eslint-disable-next-line no-console
  console.log('Using Home Assistant for robots');
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


  app.use(createDataRouter({
    car, broombot, mopbot, mieleClient, hc, cameraURL, corsOptions,
  }));

  app.use(createRobotRouter({ broombot, mopbot, corsOptions }));

  app.use(createCarRouter({ car, corsOptions }));

  app.use('/admin', adminRouter);

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
