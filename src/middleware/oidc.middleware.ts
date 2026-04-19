import { Router } from 'express';
import { Client, Issuer, generators } from 'openid-client';
import { JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import { logEvent } from '../audit';
import { writePoint } from '../influx';
import logger from '../logger';

const oidcLogger = logger.child({ subsystem: 'oidc' });

let oidcClient: Client | null = null;
let oidcIssuer: Issuer<Client> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
// Additional trusted issuers (e.g. mobile app OIDC applications on same Authentik instance)
let trustedIssuers: string[] = [];

export async function initOidc(): Promise<void> {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_REDIRECT_URI;

  // Reset all OIDC state on re-init so config always reflects current env
  oidcClient = null;
  oidcIssuer = null;
  jwks = null;
  trustedIssuers = [];

  if (!issuerUrl || !clientId) {
    oidcLogger.warn('OIDC_ISSUER_URL or OIDC_CLIENT_ID not set — OIDC disabled');
    return;
  }

  try {
    oidcIssuer = await Issuer.discover(issuerUrl);
    oidcClient = new oidcIssuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUri ? [redirectUri] : undefined,
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });

    if (oidcIssuer.metadata.jwks_uri) {
      jwks = createRemoteJWKSet(new URL(oidcIssuer.metadata.jwks_uri));
    }

    oidcLogger.info({ issuer: issuerUrl }, 'OIDC issuer discovered');

    // Support additional issuers from the same Authentik instance (e.g. mobile apps).
    // OIDC_ADDITIONAL_ISSUERS is a comma-separated list of issuer URLs.
    const additionalRaw = process.env.OIDC_ADDITIONAL_ISSUERS;
    if (additionalRaw) {
      trustedIssuers = additionalRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      oidcLogger.info(
        { additionalIssuers: trustedIssuers },
        'Configured additional trusted OIDC issuers',
      );
    }
  } catch (err) {
    oidcLogger.warn({ err }, 'Failed to discover OIDC issuer — OIDC disabled');
  }
}

export function getOidcClient(): Client | null {
  return oidcClient;
}

export function getOidcIssuer(): Issuer<Client> | null {
  return oidcIssuer;
}

// Rate-limit OIDC re-initialization: single-flight + cooldown
let oidcInitPromise: Promise<void> | null = null;
let lastOidcInitAttempt = 0;
const OIDC_REINIT_COOLDOWN_MS = 60_000; // 1 minute

export async function validateBearerToken(
  token: string,
): Promise<{ sub: string; email?: string; preferred_username?: string } | null> {
  if (!oidcIssuer) {
    const { OIDC_ISSUER_URL, OIDC_CLIENT_ID } = process.env;
    if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID) {
      // OIDC intentionally not configured — skip silently
      return null;
    }

    const now = Date.now();
    if (now - lastOidcInitAttempt < OIDC_REINIT_COOLDOWN_MS) {
      return null;
    }

    // Single-flight: reuse in-progress init
    if (!oidcInitPromise) {
      lastOidcInitAttempt = now;
      oidcLogger.warn('validateBearerToken: oidcIssuer is null — attempting re-init');
      oidcInitPromise = initOidc().finally(() => { oidcInitPromise = null; });
    }
    await oidcInitPromise;

    if (!oidcIssuer) {
      oidcLogger.error('validateBearerToken: OIDC re-init failed, rejecting token');
      return null;
    }
  }

  // Try local JWT validation via JWKS (fast, no network call per request)
  if (jwks) {
    // Try primary issuer first, then additional trusted issuers.
    const allIssuers = [
      oidcIssuer.metadata.issuer,
      ...trustedIssuers,
    ].filter(Boolean) as string[];

    const errorState = { last: null as Error | null };
    const tryIssuer = async (
      issuer: string,
    ): Promise<{ sub: string; email?: string; preferred_username?: string } | null> => {
      try {
        const { payload } = await jwtVerify(token, jwks!, { issuer });
        const jwtPayload = payload as JWTPayload & {
          email?: string;
          preferred_username?: string;
        };
        if (!jwtPayload.sub) return null;
        return {
          sub: jwtPayload.sub,
          email: jwtPayload.email,
          preferred_username: jwtPayload.preferred_username,
        };
      } catch (err) {
        const jwtErr = err instanceof Error ? err : new Error(String(err));
        oidcLogger.debug(
          { issuer, err: jwtErr.message },
          'JWT verification failed for issuer',
        );
        errorState.last = jwtErr;
        return null;
      }
    };

    // Try each issuer sequentially, short-circuit on first match
    const results = await allIssuers.reduce(
      async (accP, issuer) => (await accP) ?? tryIssuer(issuer),
      Promise.resolve(
        null as { sub: string; email?: string; preferred_username?: string } | null,
      ),
    );
    if (results) return results;

    // Decode token payload (without verification) to log what the token actually claims
    let tokenClaims: Record<string, unknown> | null = null;
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        tokenClaims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      }
    } catch { /* not a JWT — opaque token */ }

    if (tokenClaims) {
      oidcLogger.warn(
        {
          stage: 'validateBearerToken',
          trustedIssuers: allIssuers,
          tokenIss: tokenClaims.iss,
          tokenAud: tokenClaims.aud,
          tokenExp: tokenClaims.exp,
          tokenExpDate: tokenClaims.exp
            ? new Date((tokenClaims.exp as number) * 1000).toISOString()
            : undefined,
          now: new Date().toISOString(),
          isExpired: tokenClaims.exp
            ? (tokenClaims.exp as number) * 1000 < Date.now()
            : 'no exp claim',
          err: errorState.last?.message,
        },
        'JWT validation failed — token claims vs trusted issuers',
      );
    } else {
      oidcLogger.warn(
        {
          stage: 'validateBearerToken',
          trustedIssuers: allIssuers,
          tokenType: 'opaque (not a JWT)',
          err: errorState.last?.message,
        },
        'JWT validation failed — token is not a decodable JWT, trying userinfo fallback',
      );
    }
  }

  // Fallback to userinfo endpoint for opaque tokens
  if (oidcClient) {
    try {
      const userinfo = await oidcClient.userinfo(token);
      if (!userinfo.sub) return null;
      return {
        sub: userinfo.sub,
        email: userinfo.email as string | undefined,
        preferred_username: userinfo.preferred_username as string | undefined,
      };
    } catch (err) {
      const uiErr = err instanceof Error ? err : new Error(String(err));
      oidcLogger.warn({ err: uiErr.message }, 'Bearer token userinfo validation also failed');
      return null;
    }
  }

  return null;
}

export function isOidcEnabled(): boolean {
  return oidcClient !== null && oidcIssuer !== null;
}

export function createAuthRouter(): Router {
  const router = Router();
  const redirectUri = process.env.OIDC_REDIRECT_URI
    || 'http://localhost:8888/auth/callback';
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: 5 * 60 * 1000, // 5 minutes — just for the login flow
    signed: true,
  };

  router.get('/auth/login', (req, res) => {
    if (!oidcClient) {
      res.status(503).json({ message: 'OIDC not configured' });
      return;
    }

    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    // Store OIDC flow params in signed cookies (more reliable than session for redirects)
    res.cookie('oidc_state', state, cookieOpts);
    res.cookie('oidc_nonce', nonce, cookieOpts);
    res.cookie('oidc_verifier', codeVerifier, cookieOpts);

    const authUrl = oidcClient.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
    });

    res.redirect(authUrl);
  });

  router.get('/auth/callback', async (req, res) => {
    if (!oidcClient) {
      res.status(503).json({ message: 'OIDC not configured' });
      return;
    }

    try {
      const params = oidcClient.callbackParams(req);
      const tokenSet = await oidcClient.callback(redirectUri, params, {
        state: req.signedCookies.oidc_state,
        nonce: req.signedCookies.oidc_nonce,
        code_verifier: req.signedCookies.oidc_verifier,
      });

      const userinfo = await oidcClient.userinfo(tokenSet.access_token!);

      // Clear OIDC flow cookies
      const clearOpts = { httpOnly: true, signed: true };
      res.clearCookie('oidc_state', clearOpts);
      res.clearCookie('oidc_nonce', clearOpts);
      res.clearCookie('oidc_verifier', clearOpts);

      const user = {
        role: 'admin' as const,
        username: (userinfo.preferred_username || userinfo.email || userinfo.sub) as string,
        sub: userinfo.sub,
        email: userinfo.email as string | undefined,
      };

      // Store user in a signed cookie (reliable, unlike PG session store)
      res.cookie('auth_user', JSON.stringify(user), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        signed: true,
      });

      logEvent({
        user_sub: userinfo.sub,
        username: user.username,
        role: 'admin',
        action: 'oidc_login',
        route: '/auth/callback',
        method: 'GET',
        ip: req.ip,
      }).catch(() => {});
      writePoint('auth', { count: 1 }, { result: 'success', method: 'oidc' });

      oidcLogger.info({ username: user.username }, 'OIDC login success');
      res.redirect('/');
    } catch (err) {
      logEvent({
        role: 'anonymous',
        action: 'oidc_login_failed',
        route: '/auth/callback',
        method: 'GET',
        ip: req.ip,
        details: { error: String(err) },
      }).catch(() => {});
      writePoint('auth', { count: 1 }, { result: 'failed', method: 'oidc' });

      oidcLogger.error({ err }, 'OIDC callback failed');
      res.status(401).json({ message: 'Authentication failed' });
    }
  });

  router.get('/auth/logout', (req, res) => {
    const endSessionUrl = oidcIssuer?.metadata.end_session_endpoint;
    const username = req.session?.user?.username;
    logEvent({
      username,
      role: req.session?.user?.role ?? 'anonymous',
      action: 'logout',
      route: '/auth/logout',
      method: 'GET',
      ip: req.ip,
    }).catch(() => {});
    writePoint('auth', { count: 1 }, { result: 'logout' });
    res.clearCookie('auth_user', { httpOnly: true, signed: true });
    req.session.destroy(() => {
      if (endSessionUrl) {
        res.redirect(endSessionUrl);
      } else {
        res.json({ message: 'Logged out' });
      }
    });
  });

  return router;
}
