import { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { AuthenticatedUser } from '../types/auth';
import { isOidcEnabled, validateBearerToken } from './oidc.middleware';
import { serverOrigin, verifyMcpToken } from '../mcp-auth';
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Block all state-mutating requests from non-OIDC users (no `sub` claim).
 * Safe methods (GET, HEAD, OPTIONS) and explicitly excluded paths are allowed.
 */
export function requireOidcForMutations(excludePaths: string[] = []) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (excludePaths.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      return next();
    }
    if (!req.user?.sub) {
      return res.status(403).json({ error: 'OIDC authentication required' });
    }
    return next();
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // OPTIONS (CORS preflight) is never authenticated
  if (req.method === 'OPTIONS') {
    next();
    return;
  }

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

  // 3. Try Bearer token → MCP JWT first, then OIDC
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // 3a. Check for self-issued MCP JWT (signed with SESSION_SECRET)
    const mcpClaims = await verifyMcpToken(token);
    if (mcpClaims) {
      req.user = {
        role: 'admin',
        username: mcpClaims.preferred_username
          || mcpClaims.email
          || mcpClaims.sub,
        sub: mcpClaims.sub,
        email: mcpClaims.email,
      };
      authLogger.debug(
        { username: req.user.username },
        'MCP token auth success',
      );
      next();
      return;
    }

    // 3b. OIDC Bearer token validation
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
  const hasBearerToken = authHeader.startsWith('Bearer ');
  let reason = 'no_credentials';
  if (hasBearerToken) {
    reason = 'token_rejected';
  } else if (authHeader) {
    reason = 'invalid_credentials';
  }
  const authFailureLog = {
    route: req.path,
    method: req.method,
    reason,
    hasBearer: hasBearerToken,
    tokenHashPrefix: hasBearerToken
      ? createHash('sha256').update(authHeader.slice(7)).digest('hex').slice(0, 12)
      : undefined,
  };
  if (reason === 'token_rejected') {
    authLogger.warn(authFailureLog, 'Auth failed — returning 401');
  } else {
    authLogger.info(authFailureLog, 'Auth failed — returning 401');
  }
  logEvent({
    role: 'anonymous',
    action: 'auth_failed',
    route: req.path,
    method: req.method,
    ip: req.ip,
    details: { reason },
  }).catch(() => {});
  writePoint('auth', { count: 1 }, { result: 'failed', reason });

  // RFC 9728 — include resource_metadata pointer for MCP clients
  const origin = serverOrigin(req);
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadata}"`,
  );
  res.status(401).json({ message: 'Unauthorized' });
}
