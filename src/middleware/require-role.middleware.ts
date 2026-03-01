import { NextFunction, Request, Response } from 'express';

export default function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || req.user.role !== role) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    next();
  };
}
