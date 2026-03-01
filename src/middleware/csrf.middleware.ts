import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * CSRF protection middleware for cookie-authenticated requests.
 *
 * Safe HTTP methods (GET, HEAD, OPTIONS) are exempt.
 * Requests authenticated via the Authorization header (Basic or Bearer) are
 * exempt — they are not cookie-based and therefore not susceptible to CSRF.
 * All other state-mutating requests must include an X-CSRF-Token header whose
 * value matches the token stored in the server-side session.
 *
 * Browser clients should obtain a token with:
 *   GET /auth/csrf-token  →  { csrfToken: "…" }
 * and then send it as:
 *   X-CSRF-Token: <token>
 * on every POST / PUT / DELETE / PATCH request.
 */
export function csrfMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Safe HTTP methods are not state-mutating and need no CSRF check.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
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
  const tokenFromHeader = req.headers['x-csrf-token'];
  const sessionToken = req.session?.csrfToken;

  if (typeof tokenFromHeader !== 'string' || !sessionToken) {
    res.status(403).json({ message: 'Invalid or missing CSRF token' });
    return;
  }

  // Use constant-time comparison to prevent timing-based token inference.
  const headerBuf = Buffer.from(tokenFromHeader, 'utf8');
  const sessionBuf = Buffer.from(sessionToken, 'utf8');
  if (
    headerBuf.length !== sessionBuf.length
    || !crypto.timingSafeEqual(headerBuf, sessionBuf)
  ) {
    res.status(403).json({ message: 'Invalid or missing CSRF token' });
    return;
  }

  next();
}
