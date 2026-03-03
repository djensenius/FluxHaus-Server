import 'dotenv/config';
import { HomeAssistantClient } from './homeassistant-client';
import HomeAssistantRobot from './homeassistant-robot';
import Car, { CarConfig } from './car';
import Miele from './miele';
import HomeConnect from './homeconnect';
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
import logger from './logger';

const servicesLogger = logger.child({ subsystem: 'services' });

export interface FluxHausServices {
  homeAssistantClient: HomeAssistantClient;
  broombot: HomeAssistantRobot;
  mopbot: HomeAssistantRobot;
  car: Car;
  mieleClient: Miele;
  hc: HomeConnect;
  cameraURL: string;
  plex?: PlexClient;
  overseerr?: OverseerrClient;
  tautulli?: TautulliClient;
  grafana?: GrafanaClient;
  influxdb?: InfluxDBClient;
  portainer?: PortainerClient;
  prometheus?: PrometheusClient;
  komga?: KomgaClient;
  booklore?: BookloreClient;
  audiobookshelf?: AudiobookshelfClient;
  romm?: RommClient;
  immich?: ImmichClient;
  unifi?: UniFiClient;
  forgejo?: ForgejoClient;
  pihole?: PiHoleClient;
}

export async function createServices(): Promise<FluxHausServices> {
  const homeAssistantClient = new HomeAssistantClient({
    url: (process.env.HOMEASSISTANT_URL || 'http://homeassistant.local:8123').trim(),
    token: (process.env.HOMEASSISTANT_TOKEN || '').trim(),
  });

  // eslint-disable-next-line no-console
  servicesLogger.info('Using Home Assistant for robots');
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

  const mieleClient = new Miele(
    process.env.mieleClientId || '',
    process.env.mieleSecretId || '',
  );

  const hc = new HomeConnect(
    process.env.boschClientId || '',
    process.env.boschSecretId || '',
  );

  return {
    homeAssistantClient,
    broombot,
    mopbot,
    car,
    mieleClient,
    hc,
    cameraURL: process.env.CAMERA_URL || '',
    plex: new PlexClient({
      url: (process.env.PLEX_URL || '').trim(),
      token: (process.env.PLEX_TOKEN || '').trim(),
    }),
    overseerr: new OverseerrClient({
      url: (process.env.OVERSEERR_URL || '').trim(),
      apiKey: (process.env.OVERSEERR_API_KEY || '').trim(),
    }),
    tautulli: new TautulliClient({
      url: (process.env.TAUTULLI_URL || '').trim(),
      apiKey: (process.env.TAUTULLI_API_KEY || '').trim(),
    }),
    grafana: new GrafanaClient({
      url: (process.env.GRAFANA_URL || '').trim(),
      user: (process.env.GRAFANA_USER || '').trim(),
      password: (process.env.GRAFANA_PASSWORD || '').trim(),
    }),
    influxdb: new InfluxDBClient({
      url: (process.env.INFLUXDB_URL || '').trim(),
      token: (process.env.INFLUXDB_TOKEN || '').trim(),
      org: (process.env.INFLUXDB_ORG || 'fluxhaus').trim(),
      bucket: (process.env.INFLUXDB_BUCKET || 'fluxhaus').trim(),
    }),
    portainer: new PortainerClient({
      url: (process.env.PORTAINER_URL || '').trim(),
      apiKey: (process.env.PORTAINER_API_KEY || '').trim(),
    }),
    prometheus: new PrometheusClient({
      url: (process.env.PROMETHEUS_URL || '').trim(),
    }),
    komga: new KomgaClient({
      url: (process.env.KOMGA_URL || '').trim(),
      user: (process.env.KOMGA_USER || '').trim(),
      password: (process.env.KOMGA_PASSWORD || '').trim(),
      apiKey: (process.env.KOMGA_API_KEY || '').trim() || undefined,
    }),
    booklore: new BookloreClient({
      url: (process.env.BOOKLORE_URL || '').trim(),
      user: (process.env.BOOKLORE_USER || '').trim(),
      password: (process.env.BOOKLORE_PASSWORD || '').trim(),
    }),
    audiobookshelf: new AudiobookshelfClient({
      url: (process.env.AUDIOBOOKSHELF_URL || '').trim(),
      apiKey: (process.env.AUDIOBOOKSHELF_API_KEY || '').trim(),
    }),
    romm: new RommClient({
      url: (process.env.ROMM_URL || '').trim(),
      user: (process.env.ROMM_USER || '').trim(),
      password: (process.env.ROMM_PASSWORD || '').trim(),
    }),
    immich: new ImmichClient({
      url: (process.env.IMMICH_URL || '').trim(),
      apiKey: (process.env.IMMICH_API_KEY || '').trim(),
    }),
    unifi: new UniFiClient({
      url: (process.env.UNIFI_URL || '').trim(),
      user: (process.env.UNIFI_USER || '').trim(),
      password: (process.env.UNIFI_PASSWORD || '').trim(),
      site: (process.env.UNIFI_SITE || 'default').trim(),
      isUdm: process.env.UNIFI_IS_UDM === 'true',
      apiKey: (process.env.UNIFI_API_KEY || '').trim() || undefined,
    }),
    forgejo: new ForgejoClient({
      url: (process.env.FORGEJO_URL || '').trim(),
      token: (process.env.FORGEJO_TOKEN || '').trim(),
    }),
    pihole: new PiHoleClient({
      url: (process.env.PIHOLE_URL || '').trim(),
      password: (process.env.PIHOLE_PASSWORD || '').trim(),
    }),
  };
}
