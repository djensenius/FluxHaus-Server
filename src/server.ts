import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import rateLimit from 'express-rate-limit';
import nocache from 'nocache';
import cors, { CorsOptions } from 'cors';
// eslint-disable-next-line import/extensions
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import notFoundHandler from './middleware/not-found.middleware';
import { authMiddleware, requireOidcForMutations } from './middleware/auth.middleware';
import auditMiddleware from './middleware/audit.middleware';
import { csrfMiddleware, issueCsrfToken } from './middleware/csrf.middleware';
import { createAuthRouter, getOidcIssuer, initOidc } from './middleware/oidc.middleware';
import createMcpOAuthRouter from './routes/mcp-oauth.routes';
import {
  closePool, getPool, initDatabase, initPool,
} from './db';
import { closeClient as closeInflux, flushWrites, initInflux } from './influx';
import HomeAssistantRobot from './homeassistant-robot';
import { HomeAssistantClient } from './homeassistant-client';
import Car, { CarConfig, CarStartOptions } from './car';
import HomeAssistantMiele from './homeassistant-miele';
import HomeAssistantDishwasher from './homeassistant-dishwasher';
import adminRouter from './routes/admin.routes';
import pushRouter from './routes/push.routes';
import liveActivityTestRouter from './routes/live-activity-test.routes';
import alertsRouter from './routes/alerts.routes';
import radarRouter from './routes/radar.routes';
import createRoutinesRouter from './routes/routines.routes';
import createWebhooksRouter from './routes/webhooks.routes';
import preferencesRouter from './routes/preferences.routes';
import calendarSourcesRouter from './routes/calendar-sources.routes';
import createCalendarSettingsRouter from './routes/calendar-settings.routes';
import memoryRouter from './routes/memory.routes';
import conversationSearchRouter from './routes/conversation-search.routes';
import gt3Router from './routes/gt3.routes';
import createMcpServer from './mcp-server';
import { ConversationMessage, ProgressCallback, executeAICommand } from './ai-command';
import { loadAndScheduleAll } from './scheduler';
import { setAlertCallback, startMonitor } from './alert-monitor';
import transcribeAudio from './stt';
import synthesizeSpeech from './tts';
import { decrypt, encrypt } from './encryption';
import { getUserPreferences } from './user-preferences';
import { buildMemoryPrompt } from './memory';
import logger from './logger';
import { PlexClient } from './clients/plex';
import { OverseerrClient } from './clients/overseerr';
import { TautulliClient } from './clients/tautulli';
import { GrafanaClient } from './clients/grafana';
import { InfluxDBClient } from './clients/influxdb';
import { PortainerClient } from './clients/portainer';
import { PrometheusClient } from './clients/prometheus';
import { KomgaClient } from './clients/komga';
import { BookloreClient } from './clients/booklore';
import { AudiobookshelfClient } from './clients/audiobookshelf';
import { RommClient } from './clients/romm';
import { ImmichClient } from './clients/immich';
import { UniFiClient } from './clients/unifi';
import { ForgejoClient } from './clients/forgejo';
import { PiHoleClient } from './clients/pihole';
import { KagiClient } from './clients/kagi';
import { closeApns, initApns } from './apns';
import { ensureAllChannels } from './apns-channels';
import { onDishwasherStatusChange, onMieleStatusChange, onRobotStatusChange } from './live-activity-hooks';
import { createCalendarService } from './calendar';

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
    express.json({ limit: '10mb' }),
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
  app.use(csrfMiddleware);

  const allowedOrigins = (
    process.env.CORS_ORIGINS || 'http://localhost:8080,https://haus.fluxhaus.io'
  ).split(',').map((o) => o.trim());

  const corsOptions: CorsOptions = {
    allowedHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
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

  // Serve static files (HTML/JS/CSS dashboards) — no auth required
  app.use(express.static(path.join(__dirname, 'public')));

  // OIDC auth routes (login, callback, logout) — unauthenticated
  app.use(createAuthRouter());

  // MCP OAuth proxy routes (authorize, token, metadata) — unauthenticated
  app.use(createMcpOAuthRouter());

  // Auth middleware
  app.use(authMiddleware);
  app.use(requireOidcForMutations(['/webhooks/trigger']));
  app.use(auditMiddleware);

  // CSRF token endpoint — returns (or lazily generates) the per-session CSRF
  // token for cookie-authenticated browser clients. API clients using the
  // Authorization header do not need this.
  app.get('/auth/csrf-token', (req, res) => {
    res.json({ csrfToken: issueCsrfToken(req, res) });
  });

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
  broombot.onStatusChange = (name, status) => {
    onRobotStatusChange(name, status).catch(() => {});
  };

  const mopbot = new HomeAssistantRobot({
    name: 'Mopbot',
    entityId: (process.env.MOPBOT_ENTITY_ID || 'vacuum.mopbot').trim(),
    batteryEntityId: (process.env.MOPBOT_BATTERY_ENTITY_ID || '').trim(),
    client: homeAssistantClient,
  });
  mopbot.onStatusChange = (name, status) => {
    onRobotStatusChange(name, status).catch(() => {});
  };

  let cleanTimeout: ReturnType<typeof setTimeout> | null = null;

  const carConfig: CarConfig = {
    client: homeAssistantClient,
    entityPrefix: process.env.CAR_ENTITY_PREFIX || 'kia',
  };

  const car = new Car(carConfig);
  await car.setStatus();
  const cameraURL = process.env.CAMERA_URL || '';
  const romperURL = process.env.CAMERA_ROMPER_URL || '';
  const gymURL = process.env.CAMERA_GYM_URL || '';
  const mieleClient = new HomeAssistantMiele({
    client: homeAssistantClient,
    pollInterval: 10_000,
  });
  mieleClient.onStatusChange = (deviceType, device) => {
    onMieleStatusChange(deviceType, device).catch(() => {});
  };

  const dishwasher = new HomeAssistantDishwasher({
    client: homeAssistantClient,
    pollInterval: 10_000,
  });
  dishwasher.onStatusChange = (dw) => {
    onDishwasherStatusChange(dw).catch(() => {});
  };

  setInterval(() => {
    fs.writeFileSync(
      'cache/dishwasher.json',
      JSON.stringify(dishwasher.dishwasher),
    );
  }, 1000 * 60 * 60);

  // External service clients (optional — tools degrade gracefully when unconfigured)
  const plex = new PlexClient({
    url: (process.env.PLEX_URL || '').trim(),
    token: (process.env.PLEX_TOKEN || '').trim(),
  });
  const overseerr = new OverseerrClient({
    url: (process.env.OVERSEERR_URL || '').trim(),
    apiKey: (process.env.OVERSEERR_API_KEY || '').trim(),
  });
  const tautulli = new TautulliClient({
    url: (process.env.TAUTULLI_URL || '').trim(),
    apiKey: (process.env.TAUTULLI_API_KEY || '').trim(),
  });
  const grafana = new GrafanaClient({
    url: (process.env.GRAFANA_URL || '').trim(),
    user: (process.env.GRAFANA_USER || '').trim(),
    password: (process.env.GRAFANA_PASSWORD || '').trim(),
  });
  const influxdb = new InfluxDBClient({
    url: (process.env.INFLUXDB_URL || '').trim(),
    token: (process.env.INFLUXDB_TOKEN || '').trim(),
    org: (process.env.INFLUXDB_ORG || 'fluxhaus').trim(),
    bucket: (process.env.INFLUXDB_BUCKET || 'fluxhaus').trim(),
  });
  const portainer = new PortainerClient({
    url: (process.env.PORTAINER_URL || '').trim(),
    apiKey: (process.env.PORTAINER_API_KEY || '').trim(),
  });
  const prometheus = new PrometheusClient({
    url: (process.env.PROMETHEUS_URL || '').trim(),
  });
  const komga = new KomgaClient({
    url: (process.env.KOMGA_URL || '').trim(),
    user: (process.env.KOMGA_USER || '').trim(),
    password: (process.env.KOMGA_PASSWORD || '').trim(),
    apiKey: (process.env.KOMGA_API_KEY || '').trim() || undefined,
  });
  const booklore = new BookloreClient({
    url: (process.env.BOOKLORE_URL || '').trim(),
    user: (process.env.BOOKLORE_USER || '').trim(),
    password: (process.env.BOOKLORE_PASSWORD || '').trim(),
  });
  const audiobookshelf = new AudiobookshelfClient({
    url: (process.env.AUDIOBOOKSHELF_URL || '').trim(),
    apiKey: (process.env.AUDIOBOOKSHELF_API_KEY || '').trim(),
  });
  const romm = new RommClient({
    url: (process.env.ROMM_URL || '').trim(),
    user: (process.env.ROMM_USER || '').trim(),
    password: (process.env.ROMM_PASSWORD || '').trim(),
  });
  const immich = new ImmichClient({
    url: (process.env.IMMICH_URL || '').trim(),
    apiKey: (process.env.IMMICH_API_KEY || '').trim(),
  });
  const unifi = new UniFiClient({
    url: (process.env.UNIFI_URL || '').trim(),
    user: (process.env.UNIFI_USER || '').trim(),
    password: (process.env.UNIFI_PASSWORD || '').trim(),
    site: (process.env.UNIFI_SITE || 'default').trim(),
    isUdm: process.env.UNIFI_IS_UDM === 'true',
    apiKey: (process.env.UNIFI_API_KEY || '').trim() || undefined,
  });
  const forgejo = new ForgejoClient({
    url: (process.env.FORGEJO_URL || '').trim(),
    token: (process.env.FORGEJO_TOKEN || '').trim(),
  });
  const pihole = new PiHoleClient({
    url: (process.env.PIHOLE_URL || '').trim(),
    password: (process.env.PIHOLE_PASSWORD || '').trim(),
  });
  const kagi = new KagiClient({
    apiKey: (process.env.KAGI_API_KEY || '').trim(),
  });
  const calendar = createCalendarService(homeAssistantClient);

  // Shared services object — used by MCP, /command, and /voice endpoints
  const allServices = {
    homeAssistantClient,
    broombot,
    mopbot,
    car,
    mieleClient,
    dishwasher,
    cameraURL,
    romperURL,
    gymURL,
    plex,
    overseerr,
    tautulli,
    grafana,
    influxdb,
    portainer,
    prometheus,
    komga,
    booklore,
    audiobookshelf,
    romm,
    immich,
    unifi,
    forgejo,
    pihole,
    kagi,
    calendar,
  };

  app.get('/', cors(corsOptions), async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const evStatus = car.status?.evStatus ?? null;
    const role = req.user?.role;

    let scooterSummary = null;
    const dbPool = getPool();
    if (dbPool) {
      try {
        const [snapshotResult, lastRideResult] = await Promise.all([
          dbPool.query(
            `SELECT odometer, total_ride_time, bms1_cycle_count, bms2_cycle_count, timestamp
             FROM gt3_snapshots WHERE user_sub = $1 ORDER BY timestamp DESC LIMIT 1`,
            [req.user?.sub || 'unknown'],
          ),
          dbPool.query(
            `SELECT start_time, end_time, distance, max_speed, avg_speed,
               battery_used, start_battery, end_battery, gear_mode
             FROM gt3_rides WHERE user_sub = $1 ORDER BY start_time DESC LIMIT 1`,
            [req.user?.sub || 'unknown'],
          ),
        ]);
        const snapshot = snapshotResult.rows[0];
        const lastRide = lastRideResult.rows[0];
        if (snapshot || lastRide) {
          scooterSummary = {
            timestamp: snapshot?.timestamp || new Date().toISOString(),
            odometer: snapshot?.odometer ?? null,
            totalRideTime: snapshot?.total_ride_time ?? null,
            batteryCycles: (snapshot?.bms1_cycle_count ?? 0) + (snapshot?.bms2_cycle_count ?? 0),
            lastRide: lastRide ? {
              date: lastRide.start_time,
              endDate: lastRide.end_time,
              distance: lastRide.distance,
              maxSpeed: lastRide.max_speed,
              avgSpeed: lastRide.avg_speed,
              batteryUsed: lastRide.battery_used,
              startBattery: lastRide.start_battery,
              endBattery: lastRide.end_battery,
              gearMode: lastRide.gear_mode,
            } : null,
          };
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_err) {
        // Non-fatal — just skip scooter data
      }
    }

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
      try {
        homeConnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
      } catch { /* ignore */ }
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
        mieleAppliances: process.env.mieleAppliances?.split(', ') ?? [],
        boschClientId: process.env.boschClientId,
        boschSecretId: process.env.boschSecretId,
        boschAppliance: process.env.boschAppliance,
        favouriteHomeKit: process.env.favouriteHomeKit!.split(', '),
        favouriteScenes: process.env.favouriteScenes?.split(', ') ?? [],
        broombot: broomData,
        mopbot: mopData,
        car: car.status,
        carEvStatus: evStatus,
        carOdometer: car.odometer,
        scooter: scooterSummary,
        cameraURL,
        romperURL,
        gymURL,
        rhizomeSchedule,
        rhizomeData,
        miele,
        homeConnect,
        dishwasher: dishwasher.dishwasher,
        washer: mieleClient.washer,
        dryer: mieleClient.dryer,
      };
    } else if (role === 'rhizome') {
      data = {
        version,
        cameraURL,
        romperURL,
        gymURL,
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
        favouriteScenes: process.env.favouriteScenes?.split(', ') ?? [],
        broombot: broomData,
        mopbot: mopData,
        car: car.status,
        carEvStatus: evStatus,
        carOdometer: car.odometer,
        scooter: scooterSummary,
        miele,
        homeConnect,
        dishwasher: dishwasher.dishwasher,
        washer: mieleClient.washer,
        dryer: mieleClient.dryer,
      };
    }
    res.end(JSON.stringify(data));
  });

  // Route handler for turning on mopbot
  app.post('/turnOnMopbot', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await mopbot.turnOn();
    }
    res.send('Mopbot is turned on.');
  });

  // Route handler for turning off mopbot
  app.post('/turnOffMopbot', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await mopbot.turnOff();
    }
    res.send('Mopbot is turned off.');
  });

  // Route handler for turning on broombot
  app.post('/turnOnBroombot', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOn();
    }
    res.send('Broombot is turned on.');
  });

  // Route handler for turning off broombot
  app.post('/turnOffBroombot', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOff();
    }
    res.send('Broombot is turned off.');
  });

  // Route handler for starting a deep clean
  app.post('/turnOnDeepClean', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOn();
    }
    cleanTimeout = setTimeout(() => {
      mopbot.turnOn();
    }, 1200000);
    res.send('Broombot is turned on.');
  });

  // Route handler for stopping a deep clean
  app.post('/turnOffDeepClean', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      await broombot.turnOff();
    }
    if (cleanTimeout) {
      clearTimeout(cleanTimeout);
    }
    await mopbot.turnOff();
    res.send('Broombot is turned off.');
  });

  app.post('/startCar', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      const {
        temp,
        heatedFeatures,
        defrost,
        seatFL,
        seatFR,
        seatRL,
        seatRR,
      } = (req.body ?? {}) as {
        temp?: string;
        heatedFeatures?: string;
        defrost?: string;
        seatFL?: string;
        seatFR?: string;
        seatRL?: string;
        seatRR?: string;
      };

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

  app.post('/stopCar', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      const result = car.stop();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.post('/resyncCar', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      car.resync();
    }
    res.send('Resyncing car');
  });

  app.post('/lockCar', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      const result = car.lock();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  app.post('/unlockCar', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role === 'admin') {
      const result = car.unlock();
      res.send(result);
      setTimeout(() => {
        car.resync();
      }, 5000);
    }
  });

  // ── Scene endpoints ──────────────────────────────────────────────────────

  app.get('/scenes', cors(corsOptions), async (req, res) => {
    try {
      const states = await homeAssistantClient.getState('');
      const allStates = Array.isArray(states) ? states : [];

      // Build lookup for stateful scene switches (switch.<scene_slug>)
      const switchStates = new Map<string, string>();
      allStates
        .filter((s) => {
          const sid = s.entity_id as string;
          return sid?.startsWith('switch.') && typeof s.state === 'string';
        })
        .forEach((s) => {
          switchStates.set(s.entity_id as string, s.state as string);
        });

      const scenes = allStates
        .filter((s: Record<string, unknown>) => typeof s.entity_id === 'string'
          && s.entity_id.startsWith('scene.'))
        .map((s: Record<string, unknown>) => {
          const sceneId = s.entity_id as string;
          // scene.good_morning → switch.good_morning
          const switchId = sceneId.replace('scene.', 'switch.');
          const switchState = switchStates.get(switchId);
          return {
            entityId: sceneId,
            name: (s.attributes as Record<string, unknown>)?.friendly_name || sceneId,
            isActive: switchState === 'on',
          };
        });
      res.json(scenes);
    } catch (err) {
      serverLogger.error(err, 'Failed to fetch scenes');
      res.status(502).json({ error: 'Failed to fetch scenes' });
    }
  });

  app.post(
    '/scenes/activate',
    cors(corsOptions),
    csrfMiddleware,
    async (req, res) => {
      const { entityId } = req.body as { entityId?: string };
      if (!entityId || !entityId.startsWith('scene.')) {
        res.status(400).json({ error: 'Invalid entityId' });
        return;
      }
      try {
        // Check if a stateful scene switch exists before toggling
        const switchId = entityId.replace('scene.', 'switch.');
        let usedSwitch = false;
        try {
          const switchState = await homeAssistantClient.getState(switchId);
          if (switchState && switchState.state) {
            /* eslint-disable camelcase */
            await homeAssistantClient.callService('switch', 'toggle', { entity_id: switchId });
            /* eslint-enable camelcase */
            usedSwitch = true;
          }
        } catch {
          // Switch doesn't exist — fall through to scene activation
        }
        if (!usedSwitch) {
          /* eslint-disable camelcase */
          await homeAssistantClient.callService('scene', 'turn_on', { entity_id: entityId });
          /* eslint-enable camelcase */
        }
        res.json({ success: true });
      } catch (err) {
        serverLogger.error(err, 'Failed to activate scene');
        res.status(502).json({ error: 'Failed to activate scene' });
      }
    },
  );

  // ── Conversation CRUD ─────────────────────────────────────────────────────

  // Search must be registered before :id param route
  app.use(conversationSearchRouter);

  app.get('/conversations', cors(corsOptions), async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    try {
      const result = await db.query(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                COUNT(m.id)::int AS message_count
         FROM conversations c
         LEFT JOIN conversation_messages m ON m.conversation_id = c.id
         WHERE c.user_sub = $1
         GROUP BY c.id
         ORDER BY c.updated_at DESC`,
        [req.user.sub],
      );
      const conversations = result.rows.map((row) => ({
        ...row,
        title: row.title ? decrypt(row.title, req.user!.sub!) : null,
      }));
      res.json({ conversations });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  app.post('/conversations', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    const { title } = req.body as { title?: string };
    try {
      const encTitle = title ? encrypt(title, req.user.sub) : null;
      const result = await db.query(
        'INSERT INTO conversations (user_sub, title) VALUES ($1, $2) RETURNING id, created_at, updated_at',
        [req.user.sub, encTitle],
      );
      res.status(201).json({
        id: result.rows[0].id,
        title: title || null,
        created_at: result.rows[0].created_at,
        updated_at: result.rows[0].updated_at,
        message_count: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  app.get('/conversations/:id', cors(corsOptions), async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    try {
      const convResult = await db.query(
        'SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1 AND user_sub = $2',
        [req.params.id, req.user.sub],
      );
      if (convResult.rows.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      const conv = convResult.rows[0];
      const msgResult = await db.query(
        `SELECT id, role, content, is_voice, created_at
         FROM conversation_messages
         WHERE conversation_id = $1 ORDER BY created_at`,
        [req.params.id],
      );
      const messages = msgResult.rows.map((m) => ({
        ...m,
        content: decrypt(m.content, req.user!.sub!),
      }));
      res.json({
        id: conv.id,
        title: conv.title ? decrypt(conv.title, req.user.sub) : null,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  app.patch('/conversations/:id', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    const { title } = req.body as { title?: string };
    if (!title) { res.status(400).json({ error: 'title is required' }); return; }
    try {
      const encTitle = encrypt(title, req.user.sub);
      const result = await db.query(
        'UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_sub = $3 RETURNING id',
        [encTitle, req.params.id, req.user.sub],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.json({ id: result.rows[0].id, title });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  app.delete('/conversations/:id', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    try {
      const result = await db.query(
        'DELETE FROM conversations WHERE id = $1 AND user_sub = $2 RETURNING id',
        [req.params.id, req.user.sub],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  app.post('/conversations/:id/generate-title', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({ error: 'OIDC authentication required' });
      return;
    }
    const db = getPool();
    if (!db) { res.status(503).json({ error: 'Database unavailable' }); return; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      const history = await loadConversationHistory(req.params.id, req.user.sub);
      if (history.length === 0) {
        res.status(400).json({ error: 'No messages to generate title from' });
        return;
      }

      const snippet = history.slice(0, 4).map((m) => `${m.role}: ${m.content.substring(0, 150)}`).join('\n');
      const titlePrompt = 'Generate a concise title (3-6 words) for this conversation. '
        + `Return ONLY the title text, nothing else. No quotes, no punctuation at the end.\n\n${snippet}`;

      const title = await executeAICommand(titlePrompt, allServices);
      const cleanTitle = title.replace(/^["']|["']$/g, '').trim().substring(0, 80);
      const encTitle = encrypt(cleanTitle, req.user.sub);
      await db.query(
        'UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_sub = $3',
        [encTitle, req.params.id, req.user.sub],
      );
      res.json({ title: cleanTitle });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // ── AI command & voice endpoints ──────────────────────────────────────────

  /**
   * Load conversation history for an optional conversationId.
   * Returns decrypted messages for LLM context.
   */
  async function loadConversationHistory(
    conversationId: string,
    userSub: string,
  ): Promise<ConversationMessage[]> {
    const db = getPool();
    if (!db) return [];
    const result = await db.query(
      'SELECT role, content FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId],
    );
    return result.rows.map((m) => {
      const decrypted = decrypt(m.content, userSub);
      // Try to parse as JSON envelope (new format with images)
      try {
        const parsed = JSON.parse(decrypted);
        if (parsed && typeof parsed.text === 'string') {
          return {
            role: m.role as 'user' | 'assistant',
            content: parsed.text,
            images: parsed.images || undefined,
          };
        }
      } catch { /* plain text — fall through */ }
      return {
        role: m.role as 'user' | 'assistant',
        content: decrypted,
      };
    });
  }

  /**
   * Use AI to generate a concise conversation title from the first exchange.
   */
  async function generateAndSaveTitle(
    conversationId: string,
    userSub: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    const db = getPool();
    if (!db) return;

    try {
      const titlePrompt = 'Generate a concise title (3-6 words) for this conversation. '
        + 'Return ONLY the title text, nothing else. No quotes, no punctuation at the end.\n\n'
        + `User: ${userMessage.substring(0, 200)}\n`
        + `Assistant: ${assistantMessage.substring(0, 200)}`;

      const title = await executeAICommand(titlePrompt, allServices, [], undefined, undefined, undefined, userSub);
      const cleanTitle = title.replace(/^["']|["']$/g, '').trim().substring(0, 80);

      if (cleanTitle) {
        const encTitle = encrypt(cleanTitle, userSub);
        await db.query(
          'UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2',
          [encTitle, conversationId],
        );
      }
    } catch (err) {
      // Fallback to truncated user message
      const fallback = encrypt(userMessage.substring(0, 50), userSub);
      await db.query(
        'UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2',
        [fallback, conversationId],
      );
      serverLogger.warn({ err }, 'AI title generation failed, using fallback');
    }
  }

  /**
   * Store a user+assistant message pair in an existing conversation (encrypted).
   * Auto-generates title using AI from first user message if conversation has no title.
   */
  async function storeMessages(
    conversationId: string,
    userSub: string,
    userContent: string,
    assistantContent: string,
    isVoice: boolean,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    images?: Array<{ mediaType: string; base64: string }>,
  ): Promise<void> {
    const db = getPool();
    if (!db) return;
    // Wrap user content in JSON envelope if images are present
    const userPayload = images?.length
      ? JSON.stringify({ text: userContent, images })
      : userContent;
    const encUser = encrypt(userPayload, userSub);
    const encAssistant = encrypt(assistantContent, userSub);
    await db.query(
      `INSERT INTO conversation_messages (conversation_id, role, content, is_voice)
       VALUES ($1, 'user', $2, $3), ($1, 'assistant', $4, false)`,
      [conversationId, encUser, isVoice, encAssistant],
    );
    // Auto-title from first message if no title exists
    const conv = await db.query(
      'SELECT title FROM conversations WHERE id = $1',
      [conversationId],
    );
    if (conv.rows.length > 0 && !conv.rows[0].title) {
      // Generate title asynchronously — don't block the response
      generateAndSaveTitle(conversationId, userSub, userContent, assistantContent).catch(() => {});
    } else {
      await db.query(
        'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
        [conversationId],
      );
    }
  }

  /**
   * If memory is enabled and memories exist, return a system prompt fragment
   * to append to the base system prompt. The ai-command module will append it.
   * Returns undefined if no memories or memory disabled.
   */
  async function getMemoryContext(userSub?: string): Promise<string | undefined> {
    if (!userSub) return undefined;
    try {
      const prefs = await getUserPreferences(userSub);
      if (!prefs.memoryEnabled) return undefined;
      const fragment = await buildMemoryPrompt(userSub);
      return fragment || undefined;
    } catch {
      return undefined;
    }
  }

  app.post('/command', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const { command, conversationId, images } = req.body as {
      command?: string;
      conversationId?: string;
      images?: Array<{ mediaType: string; base64: string }>;
    };
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' });
      return;
    }
    try {
      const services = allServices;
      const userSub = req.user?.sub;
      let history: ConversationMessage[] = [];
      if (conversationId && userSub) {
        history = await loadConversationHistory(conversationId, userSub);
      }
      const memoryFragment = await getMemoryContext(userSub);
      const response = await executeAICommand(command, services, history, undefined, images, memoryFragment, userSub);
      if (conversationId && userSub) {
        await storeMessages(conversationId, userSub, command, response, false, images);
      }
      res.json({ response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // POST /command/stream — SSE streaming variant of /command
  // Sends progress events as the AI works through tool calls, then a final response.
  // Events: { type: "progress", text: "..." }, { type: "tool_call", tool: "..." },
  //         { type: "done", text: "..." }, { type: "error", text: "..." }
  app.post('/command/stream', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const { command, conversationId, images } = req.body as {
      command?: string;
      conversationId?: string;
      images?: Array<{ mediaType: string; base64: string }>;
    };
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onProgress: ProgressCallback = (event) => {
      if (event.type !== 'done') {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      const services = allServices;
      const userSub = req.user?.sub;
      let history: ConversationMessage[] = [];
      if (conversationId && userSub) {
        history = await loadConversationHistory(conversationId, userSub);
      }
      const memoryFragment = await getMemoryContext(userSub);
      const response = await executeAICommand(command, services, history, onProgress, images, memoryFragment, userSub);
      if (conversationId && userSub) {
        await storeMessages(conversationId, userSub, command, response, false, images);
      }
      res.write(`data: ${JSON.stringify({ type: 'done', text: response })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.write(`data: ${JSON.stringify({ type: 'error', text: message })}\n\n`);
    }
    res.end();
  });

  // POST /voice — voice-in/voice-out or text-in/voice-out
  // Pipeline: STT (OpenAI Whisper) → LLM (AI_PROVIDER) → TTS (OpenAI TTS)
  // Request body (JSON):
  //   { audio: "<base64>", filename?: "recording.webm" }  — voice input
  //   { text:  "Turn on the lights" }                     — text input
  // Response: audio/mpeg binary. X-Transcript and X-Response headers carry the
  //   transcribed input and LLM text reply for clients that want to display them.
  app.post('/voice', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const {
      audio, filename, text, conversationId,
    } = req.body as {
      audio?: string;
      filename?: string;
      text?: string;
      conversationId?: string;
    };
    if (!audio && !text) {
      res.status(400).json({ error: 'Either audio (base64) or text is required' });
      return;
    }
    try {
      let command: string;
      if (audio) {
        const audioBuffer = Buffer.from(audio, 'base64');
        command = await transcribeAudio(audioBuffer, filename || 'audio.webm');
      } else {
        command = text as string;
      }
      const services = allServices;
      const userSub = req.user?.sub;
      let history: ConversationMessage[] = [];
      if (conversationId && userSub) {
        history = await loadConversationHistory(conversationId, userSub);
      }
      const memCtx = await getMemoryContext(userSub);
      const response = await executeAICommand(command, services, history, undefined, undefined, memCtx, userSub);
      if (conversationId && userSub) {
        await storeMessages(conversationId, userSub, command, response, true);
      }
      const audioResponse = await synthesizeSpeech(response);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('X-Transcript', encodeURIComponent(command));
      res.setHeader('X-Response', encodeURIComponent(response));
      res.send(audioResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // POST /voice/stream — SSE streaming variant of /voice
  // Sends progress events during AI processing, then a final event with audio.
  // Events: { type: "transcript", text }, { type: "progress", text },
  //         { type: "tool_call", tool }, { type: "done", text, audio },
  //         { type: "error", text }
  app.post('/voice/stream', cors(corsOptions), csrfMiddleware, async (req, res) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const {
      audio, filename, text, conversationId,
    } = req.body as {
      audio?: string;
      filename?: string;
      text?: string;
      conversationId?: string;
    };
    if (!audio && !text) {
      res.status(400).json({ error: 'Either audio (base64) or text is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      let command: string;
      if (audio) {
        const audioBuffer = Buffer.from(audio, 'base64');
        command = await transcribeAudio(audioBuffer, filename || 'audio.webm');
      } else {
        command = text as string;
      }
      res.write(`data: ${JSON.stringify({ type: 'transcript', text: command })}\n\n`);

      const services = allServices;
      const userSub = req.user?.sub;
      let history: ConversationMessage[] = [];
      if (conversationId && userSub) {
        history = await loadConversationHistory(conversationId, userSub);
      }

      const onProgress: ProgressCallback = (event) => {
        if (event.type !== 'done') {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      const memCtx = await getMemoryContext(userSub);
      const response = await executeAICommand(command, services, history, onProgress, undefined, memCtx, userSub);
      if (conversationId && userSub) {
        await storeMessages(conversationId, userSub, command, response, true);
      }

      const audioResponse = await synthesizeSpeech(response);
      const audioBase64 = audioResponse.toString('base64');
      res.write(`data: ${JSON.stringify({
        type: 'done', text: response, audio: audioBase64,
      })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.write(`data: ${JSON.stringify({ type: 'error', text: message })}\n\n`);
    }
    res.end();
  });

  // MCP HTTP endpoint (Streamable HTTP transport, stateless mode)
  // Uses open CORS so Claude and other remote MCP clients can connect.
  // CSRF is exempted via CSRF_EXEMPT_PATHS in csrf.middleware.ts since
  // MCP clients use Bearer tokens, not cookies.
  const mcpCors = cors();
  app.options('/mcp', mcpCors);
  app.post('/mcp', mcpCors, async (req, res) => {
    if (!req.user?.sub) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Authentication required' },
        id: null,
      });
      return;
    }
    try {
      const mcpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcpServer = createMcpServer(allServices, { userSub: req.user.sub });
      res.on('close', () => {
        mcpTransport.close();
        mcpServer.close();
      });
      await mcpServer.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message },
          id: null,
        });
      }
    }
  });

  // GET /mcp — not supported in stateless mode (per MCP Streamable HTTP spec)
  app.get('/mcp', mcpCors, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  });

  // DELETE /mcp — not supported in stateless mode
  app.delete('/mcp', mcpCors, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode' },
      id: null,
    });
  });

  app.use(adminRouter);
  app.use(pushRouter);
  app.use(preferencesRouter);
  app.use(calendarSourcesRouter);
  app.use(createCalendarSettingsRouter(allServices));
  app.use(memoryRouter);
  app.use(liveActivityTestRouter);
  app.use(alertsRouter);
  app.use(radarRouter);
  app.use(createRoutinesRouter(allServices));
  app.use(createWebhooksRouter(allServices));
  app.use('/gt3', gt3Router);

  // Start background services
  loadAndScheduleAll(allServices).catch((err) => {
    serverLogger.error({ err }, 'Failed to load scheduled routines');
  });

  startMonitor(allServices.homeAssistantClient, 30_000);
  setAlertCallback((rule, _entity, message) => {
    serverLogger.info({ ruleId: rule.id, message }, 'Alert triggered');
    // TODO: send push notification when simple alert push is implemented
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
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`fetchSchedule: HTTP ${response.status}`);
    }
    return response.json();
  })
    .then((json) => {
      fs.writeFileSync(
        'cache/rhizome.json',
        JSON.stringify({ timestamp: new Date(), ...json }, null, 2),
      );
    })
    .catch((err) => {
      serverLogger.error({ err: err.message }, 'Failed to fetch schedule');
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
    .then((response) => {
      if (!response.ok) {
        throw new Error(`fetchRhizomePhotos: HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((json) => {
      const photos = json.map((file: GitHubFile) => file.download_url);
      fs.writeFileSync(
        'cache/rhizomePhotos.json',
        JSON.stringify({ timestamp: new Date(), news: newsURL, photos: [...photos] }, null, 2),
      );
    })
    .catch((err) => {
      serverLogger.error({ err: err.message }, 'Failed to fetch Rhizome photos');
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
    initApns();
    await ensureAllChannels();
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
        closeApns();
        await closePool();
        serverLogger.info('Shutdown complete');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })();
}
