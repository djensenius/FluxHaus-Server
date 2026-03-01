import { Router } from 'express';
import cors, { CorsOptions } from 'cors';
import Car, { CarStartOptions } from '../car';
import requireRole from '../middleware/require-role.middleware';

export interface CarRouteDeps {
  car: Car;
  corsOptions: CorsOptions;
}

export function createCarRouter(deps: CarRouteDeps): Router {
  const { car, corsOptions } = deps;
  const router = Router();

  router.get(
    '/startCar',
    cors(corsOptions),
    requireRole('admin'),
    async (req, res) => {
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
    },
  );

  router.get(
    '/stopCar',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      const result = car.stop();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    },
  );

  router.get(
    '/resyncCar',
    cors(corsOptions),
    requireRole('admin'),
    (_req, res) => {
      car.resync();
      res.send('Resyncing car');
    },
  );

  router.get(
    '/lockCar',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      const result = car.lock();
      res.send(JSON.stringify({ result }));
      setTimeout(() => {
        car.resync();
      }, 5000);
    },
  );

  router.get(
    '/unlockCar',
    cors(corsOptions),
    requireRole('admin'),
    async (_req, res) => {
      const result = car.unlock();
      res.send(result);
      setTimeout(() => {
        car.resync();
      }, 5000);
    },
  );

  return router;
}
