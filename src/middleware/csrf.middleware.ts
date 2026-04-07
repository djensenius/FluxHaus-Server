import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const CSRF_COOKIE_NAME = 'csrf_token';

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function csrfCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 24 * 60 * 60 * 1000,
    signed: true,
  };
}

export function issueCsrfToken(req: Request, res: Response): string {
  const cookieToken = typeof req.signedCookies?.[CSRF_COOKIE_NAME] === 'string'
    ? req.signedCookies[CSRF_COOKIE_NAME]
    : null;
  const token = req.session?.csrfToken || cookieToken || generateCsrfToken();

  if (req.session) {
    req.session.csrfToken = token;
  }
  res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
  return token;
}

/**
 * CSRF protection middleware for cookie-authenticated requests.
 *
 * Safe HTTP methods (GET, HEAD, OPTIONS) are exempt.
 * Requests authenticated via the Authorization header (Basic or Bearer) are
 * exempt — they are not cookie-based and therefore not susceptible to CSRF.
 * All other state-mutating requests must include an X-CSRF-Token header whose
 * value matches the token stored in the server-side session or signed cookie.
 *
 * Browser clients should obtain a token with:
 *   GET /auth/csrf-token  →  { csrfToken: "…" }
 * and then send it as:
 *   X-CSRF-Token: <token>
 * on every POST / PUT / DELETE / PATCH request.
 */
/**
 * Paths exempt from CSRF validation.  These are machine-to-machine API
 * endpoints that never use cookie-based authentication:
 *  - /mcp          — MCP Streamable HTTP (Bearer tokens only)
 *  - /register     — MCP dynamic client registration (unauthenticated OAuth)
 *  - /token        — MCP OAuth token exchange (unauthenticated OAuth)
 */
const CSRF_EXEMPT_PATHS = new Set(['/mcp', '/register', '/token']);

/**
 * Path prefixes exempt from CSRF validation.  These are admin-only
 * endpoints already protected by requireRole('admin') and served from
 * an inline HTML page whose session cookie may not propagate to fetch
 * POST requests in all proxy configurations.
 */
const CSRF_EXEMPT_PREFIXES = ['/admin/live-activity-test/'];

export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Safe HTTP methods are not state-mutating and need no CSRF check.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }

  // Machine-to-machine API endpoints that use Bearer tokens or are part of
  // the OAuth flow — never cookie-authenticated, not susceptible to CSRF.
  if (CSRF_EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  // Admin tool pages with inline HTML — protected by requireRole instead.
  if (CSRF_EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    next();
    return;
  }

  // Requests authenticated via Authorization header are not cookie-based and
  // therefore not susceptible to CSRF attacks.
  if (req.headers.authorization) {
    next();
    return;
  }

  // For cookie/session-authenticated requests, validate the CSRF token.
  // The token is a high-entropy random string (256-bit), so direct string
  // comparison is safe — timing attacks are not a practical threat for CSRF
  // tokens in web contexts (network jitter dwarfs CPU timing differences).
  const tokenFromHeader = req.headers['x-csrf-token'];
  const sessionToken = req.session?.csrfToken;
  const cookieToken = typeof req.signedCookies?.[CSRF_COOKIE_NAME] === 'string'
    ? req.signedCookies[CSRF_COOKIE_NAME]
    : null;

  if (
    typeof tokenFromHeader !== 'string'
    || (tokenFromHeader !== sessionToken && tokenFromHeader !== cookieToken)
  ) {
    res.status(403).json({ message: 'Invalid or missing CSRF token' });
    return;
  }

  next();
}
