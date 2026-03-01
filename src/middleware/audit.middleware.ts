import { NextFunction, Request, Response } from 'express';
import { logEvent } from '../audit';
import { writePoint } from '../influx';
import logger from '../logger';

const auditLogger = logger.child({ subsystem: 'audit-middleware' });

function auditMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const { path } = req;
  if (path === '/health') {
    next();
    return;
  }

  const { user } = req;
  logEvent({
    user_sub: user?.sub,
    username: user?.username,
    role: user?.role ?? 'anonymous',
    action: req.method,
    route: req.path,
    method: req.method,
    ip: req.ip,
  }).catch((err) => {
    auditLogger.debug({ err }, 'Audit log write failed');
  });

  writePoint('request', { count: 1 }, { route: req.path, method: req.method, role: user?.role ?? 'anonymous' });

  next();
}

export default auditMiddleware;
