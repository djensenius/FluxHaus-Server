import 'dotenv/config';
import { HomeAssistantClient } from './homeassistant-client';
import HomeAssistantRobot from './homeassistant-robot';
import Car, { CarConfig } from './car';
import Miele from './miele';
import HomeConnect from './homeconnect';
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
  };
}
