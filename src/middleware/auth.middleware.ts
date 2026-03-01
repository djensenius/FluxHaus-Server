import { NextFunction, Request, Response } from 'express';
import { AuthenticatedUser } from '../types/auth';
import { isOidcEnabled, validateBearerToken } from './oidc.middleware';
import { logEvent } from '../audit';
import { writePoint } from '../influx';
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
  // 1. Check signed auth cookie (set by OIDC callback — immediate, reliable)
  if (req.signedCookies?.auth_user) {
    try {
      const cookieUser = JSON.parse(req.signedCookies.auth_user);
      if (cookieUser.username && cookieUser.role) {
        req.user = cookieUser;
        // Populate session for server-side tracking (non-blocking)
        if (req.session && !req.session.user) {
          req.session.user = cookieUser;
        }
        next();
        return;
      }
    } catch {
      // invalid cookie — fall through
    }
  }

  // 2. Check session (fallback — server-side session store)
  if (req.session?.user) {
    req.user = req.session.user;
    next();
    return;
  }

  // 3. Try Bearer token → OIDC
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

  // 3. Basic auth fallback for demo/rhizome users
  if (authHeader.startsWith('Basic ')) {
    const encoded = authHeader.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const [username, password] = decoded.split(':', 2);

    if (process.env.RHIZOME_PASSWORD && username === 'rhizome' && password === process.env.RHIZOME_PASSWORD) {
      req.user = { role: 'rhizome', username: 'rhizome' };
      next();
      return;
    }
    if (process.env.DEMO_PASSWORD && username === 'demo' && password === process.env.DEMO_PASSWORD) {
      req.user = { role: 'demo', username: 'demo' };
      next();
      return;
    }
    // Legacy admin basic auth (for backward compat during transition)
    if (process.env.BASIC_AUTH_PASSWORD && username === 'admin' && password === process.env.BASIC_AUTH_PASSWORD) {
      req.user = { role: 'admin', username: 'admin' };
      next();
      return;
    }
  }

  // 4. Browser request with OIDC enabled → redirect to login
  // Skip redirect for /auth/* paths to prevent infinite loops
  const acceptsHtml = req.headers.accept?.includes('text/html');
  if (acceptsHtml && isOidcEnabled() && !authHeader && !req.path.startsWith('/auth/')) {
    res.redirect('/auth/login');
    return;
  }

  // 5. No valid auth (API clients get 401)
  logEvent({
    role: 'anonymous',
    action: 'auth_failed',
    route: req.path,
    method: req.method,
    ip: req.ip,
    details: { reason: authHeader ? 'invalid_credentials' : 'no_credentials' },
  }).catch(() => {});
  writePoint('auth', { count: 1 }, { result: 'failed', reason: authHeader ? 'invalid_credentials' : 'no_credentials' });
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).json({ message: 'Unauthorized' });
}
