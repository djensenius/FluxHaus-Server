import { NextFunction, Request, Response } from 'express';
import { Issuer } from 'openid-client';
import { JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';

interface OidcUserInfo {
  sub: string;
  email?: string;
  preferred_username?: string;
  groups?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line no-shadow
    interface Request {
      oidcUser?: OidcUserInfo;
    }
  }
}

type RemoteJWKSetFunction = ReturnType<typeof createRemoteJWKSet>;

let jwks: RemoteJWKSetFunction | null = null;
let oidcIssuer: string | null = null;

export async function initOidc(): Promise<void> {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;

  if (!issuerUrl || !clientId) {
    console.warn(
      'OIDC not configured: OIDC_ISSUER_URL or OIDC_CLIENT_ID is missing. Skipping OIDC initialization.',
    );
    return;
  }

  try {
    const issuer = await Issuer.discover(issuerUrl);
    if (!issuer.metadata.jwks_uri) {
      console.warn('OIDC initialization failed: issuer does not provide a jwks_uri.');
      return;
    }
    jwks = createRemoteJWKSet(new URL(issuer.metadata.jwks_uri));
    oidcIssuer = issuer.metadata.issuer;
    console.warn(`OIDC initialized with issuer: ${oidcIssuer}`);
  } catch (err) {
    console.warn('OIDC initialization failed:', err);
  }
}

export function oidcMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!jwks) {
    res.status(401).json({ message: 'OIDC not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  jwtVerify(token, jwks, { issuer: oidcIssuer ?? undefined })
    .then(({ payload }: { payload: JWTPayload }) => {
      if (!payload.sub) {
        res.status(401).json({ message: 'Token missing required sub claim' });
        return;
      }

      const userInfo: OidcUserInfo = {
        sub: payload.sub,
        email: payload.email as string | undefined,
        preferred_username: payload.preferred_username as string | undefined,
        groups: payload.groups as string[] | undefined,
      };

      req.oidcUser = userInfo;
      next();
    })
    .catch((err: unknown) => {
      console.warn('OIDC token validation failed:', err);
      res.status(401).json({ message: 'Invalid or expired token' });
    });
}
