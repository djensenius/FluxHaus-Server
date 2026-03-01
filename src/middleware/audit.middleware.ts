import { NextFunction, Request, Response } from 'express';
import { logEvent } from '../audit';

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
  }).catch(() => {
    // Non-blocking: ignore errors
  });

  next();
}

export default auditMiddleware;
