import { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuthenticatedUser } from '../types/auth';

// eslint-disable-next-line import/prefer-default-export
export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="fluxhaus"');
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const oidcIssuer = process.env.OIDC_ISSUER;
    const oidcAudience = process.env.OIDC_AUDIENCE;

    if (!oidcIssuer || !oidcAudience) {
      res.status(500).json({ message: 'OIDC is not configured on this server' });
      return;
    }

    try {
      const JWKS = createRemoteJWKSet(
        new URL(`${oidcIssuer}/.well-known/jwks.json`),
      );
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: oidcIssuer,
        audience: oidcAudience,
      });

      const user: AuthenticatedUser = {
        role: 'admin',
        username: (payload.email as string) || payload.sub || '',
        sub: payload.sub,
        email: payload.email as string | undefined,
      };
      req.user = user;
      next();
      return;
    } catch {
      res.setHeader(
        'WWW-Authenticate',
        'Bearer realm="fluxhaus", error="invalid_token"',
      );
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
  }

  if (authHeader.startsWith('Basic ')) {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex !== -1) {
      const username = decoded.slice(0, colonIndex);
      const password = decoded.slice(colonIndex + 1);

      if (username === 'demo' && password === process.env.DEMO_PASSWORD) {
        req.user = { role: 'demo', username: 'demo' };
        next();
        return;
      }
      if (username === 'rhizome' && password === process.env.RHIZOME_PASSWORD) {
        req.user = { role: 'rhizome', username: 'rhizome' };
        next();
        return;
      }
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="fluxhaus"');
  res.status(401).json({ message: 'Unauthorized' });
};
