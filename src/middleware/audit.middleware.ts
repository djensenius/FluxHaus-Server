import { NextFunction, Request, Response } from 'express';
import basicAuth from 'express-basic-auth';
import { logEvent } from '../audit';
import logger from '../logger';

const middlewareLogger = logger.child({ subsystem: 'audit-middleware' });

const ROUTE_ACTION_MAP: Record<string, string> = {
  '/': 'view:dashboard',
  '/turnOnBroombot': 'robot:broombot:on',
  '/turnOffBroombot': 'robot:broombot:off',
  '/turnOnMopbot': 'robot:mopbot:on',
  '/turnOffMopbot': 'robot:mopbot:off',
  '/turnOnDeepClean': 'robot:deep_clean:on',
  '/turnOffDeepClean': 'robot:deep_clean:off',
  '/startCar': 'car:start',
  '/stopCar': 'car:stop',
  '/resyncCar': 'car:resync',
  '/lockCar': 'car:lock',
  '/unlockCar': 'car:unlock',
  '/audit': 'view:audit',
};

export function deriveAction(path: string): string {
  return ROUTE_ACTION_MAP[path] ?? `request:${path.replace(/^\//, '').replace(/\//g, ':')}`;
}

const auditMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (req.path === '/health') {
    next();
    return;
  }

  const authReq = req as basicAuth.IBasicAuthedRequest;
  const username = req.user?.username ?? authReq.auth?.user ?? 'unknown';
  const role = req.user?.role ?? authReq.auth?.user ?? 'unknown';
  const userSub = req.user?.sub;

  res.on('finish', () => {
    logEvent({
      userSub,
      username,
      role,
      action: deriveAction(req.path),
      route: req.path,
      method: req.method,
      ip: req.ip,
      details: { status: res.statusCode },
    }).catch((err: unknown) => {
      middlewareLogger.error({ err }, 'Failed to write audit log');
    });
  });

  next();
};

export default auditMiddleware;
