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

export async function initOidc(): Promise<void> {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_REDIRECT_URI;

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
    });

    if (oidcIssuer.metadata.jwks_uri) {
      jwks = createRemoteJWKSet(new URL(oidcIssuer.metadata.jwks_uri));
    }

    oidcLogger.info({ issuer: issuerUrl }, 'OIDC issuer discovered');
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

export async function validateBearerToken(
  token: string,
): Promise<{ sub: string; email?: string; preferred_username?: string } | null> {
  if (!oidcIssuer) return null;

  // Try local JWT validation via JWKS (fast, no network call per request)
  if (jwks) {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: oidcIssuer.metadata.issuer,
      });
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
      oidcLogger.debug({ err }, 'JWT validation failed, trying userinfo fallback');
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
      oidcLogger.debug({ err }, 'Bearer token validation failed');
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

  router.get('/auth/login', (req, res) => {
    if (!oidcClient) {
      res.status(503).json({ message: 'OIDC not configured' });
      return;
    }

    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.oidcCodeVerifier = codeVerifier;

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
        state: req.session.oidcState,
        nonce: req.session.oidcNonce,
        code_verifier: req.session.oidcCodeVerifier,
      });

      const userinfo = await oidcClient.userinfo(tokenSet.access_token!);

      // Clear OIDC flow state
      delete req.session.oidcState;
      delete req.session.oidcNonce;
      delete req.session.oidcCodeVerifier;

      req.session.user = {
        role: 'admin',
        username: (userinfo.preferred_username || userinfo.email || userinfo.sub) as string,
        sub: userinfo.sub,
        email: userinfo.email as string | undefined,
      };

      logEvent({
        user_sub: userinfo.sub,
        username: req.session.user.username,
        role: 'admin',
        action: 'oidc_login',
        route: '/auth/callback',
        method: 'GET',
        ip: req.ip,
      }).catch(() => {});
      writePoint('auth', { count: 1 }, { result: 'success', method: 'oidc' });

      oidcLogger.info({ username: req.session.user.username }, 'OIDC login success');
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
