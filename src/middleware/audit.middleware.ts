import { NextFunction, Request, Response } from 'express';
import { logEvent } from '../audit';

export default function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const entry = {
      username: req.user?.name,
      action: `${req.method} ${req.path}`,
      resource: req.path,
      status: res.statusCode,
      ip: req.ip,
    };
    logEvent(entry).catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to write audit log:', err);
    });
  });
  next();
}
