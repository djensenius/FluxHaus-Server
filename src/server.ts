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
      users: {
        admin: process.env.BASIC_AUTH_PASSWORD!,
        rhizome: process.env.RHIZOME_PASSWORD!,
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

  let cleanTimeout: ReturnType<typeof setTimeout> | null = null;

  const carConfig: CarConfig = {
    username: process.env.carLogin!,
    password: process.env.carPassword!,
    pin: process.env.carPin!,
    region: 'CA',
    useInfo: true,
    brand: 'kia',
  };

  const car = new Car(carConfig);
  const cameraURL = process.env.CAMERA_URL || '';

  app.get('/', cors(corsOptions), (req, res) => {
    const authReq = req as basicAuth.IBasicAuthedRequest;
    res.setHeader('Content-Type', 'application/json');
    // Check if file exists and read it
    let evStatus = null;
    if (fs.existsSync('cache/evStatus.json')) {
      evStatus = JSON.parse(fs.readFileSync('cache/evStatus.json', 'utf8'));
    }

    let rhizomeSchedule = null;
    if (fs.existsSync('cache/rhizome.json')) {
      rhizomeSchedule = JSON.parse(fs.readFileSync('cache/rhizome.json', 'utf8'));
    }

    let rhizomeData = null;
    if (fs.existsSync('cache/rhizomePhotos.json')) {
      rhizomeData = JSON.parse(fs.readFileSync('cache/rhizomePhotos.json', 'utf8'));
    }
    let data = {};

    if (authReq.auth.user === 'admin') {
      data = {
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
        cameraURL,
        rhizomeSchedule,
        rhizomeData,
      };
    } else if (authReq.auth.user === 'rhizome') {
      data = {
        cameraURL,
        rhizomeSchedule,
        rhizomeData,
      };
    }
    res.end(JSON.stringify(data));
  });

  // Route handler for turning on mopbot
  app.get('/turnOnMopbot', cors(corsOptions), async (_req, res) => {
    await mopbot.turnOn();
    res.send('Mopbot is turned on.');
  });

  // Route handler for turning off mopbot
  app.get('/turnOffMopbot', cors(corsOptions), async (_req, res) => {
    await mopbot.turnOff();
    res.send('Mopbot is turned off.');
  });

  // Route handler for turning on broombot
  app.get('/turnOnBroombot', cors(corsOptions), async (_req, res) => {
    await broombot.turnOn();
    res.send('Broombot is turned on.');
  });

  // Route handler for turning off broombot
  app.get('/turnOffBroombot', cors(corsOptions), async (_req, res) => {
    await broombot.turnOff();
    res.send('Broombot is turned off.');
  });

  // Route handler for starting a deep clean
  app.get('/turnOnDeepClean', cors(corsOptions), async (_req, res) => {
    await broombot.turnOn();
    cleanTimeout = setTimeout(() => {
      mopbot.turnOn();
    }, 1200000);
    res.send('Broombot is turned on.');
  });

  // Route handler for stopping a deep clean
  app.get('/turnOffDeepClean', cors(corsOptions), async (_req, res) => {
    await broombot.turnOff();
    if (cleanTimeout) {
      clearTimeout(cleanTimeout);
    }
    await mopbot.turnOff();
    res.send('Broombot is turned off.');
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

const fetchSchedule = () => {
  const startDate = new Date();
  const endDate = new Date();
  endDate.setFullYear(endDate.getFullYear() + 1);

  fetch(`https://us-central1-com-dogtopia-app.cloudfunctions.net/executive/appointments/daycare/${process.env.DOGTOPIA_SCHEDULE_CODE}?startDate=${startDate.getTime()}&endDate=${endDate.getTime()}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'cross-site',
      'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Mode': 'cors',
      Host: 'us-central1-com-dogtopia-app.cloudfunctions.net',
      Origin: 'https://www.dogtopia.com',
      // eslint-disable-next-line max-len
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      Referer: 'https://www.dogtopia.com/',
      Connection: 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      Priority: 'u=3, i',
      Authorization: `Bearer ${process.env.DOGTOPIA_TOKEN}`,
    },
  }).then((response) => response.json())
    .then((json) => {
      fs.writeFileSync(
        'cache/rhizome.json',
        JSON.stringify({ timestamp: new Date(), ...json }, null, 2),
      );
    });
};

fetchSchedule();
setInterval(() => {
  fetchSchedule();
}, 1000 * 60 * 60);

const newsURL = 'https://raw.githubusercontent.com/djensenius/Rhizome-Data/main/news.md';

interface GitHubFile {
  name: string;
  download_url: string;
}

const fetchRhizomePhotos = () => {
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

fetchRhizomePhotos();

setInterval(() => {
  fetchRhizomePhotos();
}, 1000 * 60 * 60);

createServer().then((app) => {
  app.listen(port, () => {
    console.warn(`⚡️[server]: Server is running at https://localhost:${port}`);
  });
});
