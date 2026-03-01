import { NextFunction, Request, Response } from 'express';
import { AuthenticatedUser } from '../types/auth';
import { validateBearerToken } from './oidc.middleware';
import logger from '../logger';

const authLogger = logger.child({ subsystem: 'auth' });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line no-shadow
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. Try Bearer token → OIDC
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = await validateBearerToken(token);
    if (claims) {
      req.user = {
        role: 'admin',
        username: claims.preferred_username || claims.email || claims.sub,
        sub: claims.sub,
        email: claims.email,
      };
      authLogger.debug({ username: req.user.username }, 'OIDC auth success');
      next();
      return;
    }
  }

  // 2. Basic auth fallback for demo/rhizome users
  if (authHeader.startsWith('Basic ')) {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [username, password] = decoded.split(':', 2);

    if (username === 'rhizome' && password === process.env.RHIZOME_PASSWORD && process.env.RHIZOME_PASSWORD) {
      req.user = { role: 'rhizome', username: 'rhizome' };
      next();
      return;
    }
    if (username === 'demo' && password === process.env.DEMO_PASSWORD && process.env.DEMO_PASSWORD) {
      req.user = { role: 'demo', username: 'demo' };
      next();
      return;
    }
    // Legacy admin basic auth (for backward compat during transition)
    if (username === 'admin' && password === process.env.BASIC_AUTH_PASSWORD && process.env.BASIC_AUTH_PASSWORD) {
      req.user = { role: 'admin', username: 'admin' };
      next();
      return;
    }
  }

  // 3. No valid auth
  res.setHeader('WWW-Authenticate', 'Basic realm="fluxhaus", Bearer');
  res.status(401).json({ message: 'Unauthorized' });
}
