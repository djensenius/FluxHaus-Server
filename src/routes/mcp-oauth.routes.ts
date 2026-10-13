import { Router } from 'express';
import crypto from 'crypto';
import cors from 'cors';
import { SignJWT, decodeJwt } from 'jose';
import { getOidcIssuer } from '../middleware/oidc.middleware';
import { getMcpSigningKey, mcpResource, serverOrigin } from '../mcp-auth';
import logger from '../logger';

const oauthLogger = logger.child({ subsystem: 'mcp-oauth' });

const MCP_TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

interface PendingAuth {
  claudeRedirectUri: string;
  claudeState: string;
  claudeCodeChallenge: string;
  claudeCodeChallengeMethod: string;
  pkceVerifier: string;
  resource: string;
  clientId: string;
  createdAt: number;
}

interface UserClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
}

interface AuthCode {
  userClaims: UserClaims;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
}

interface RegisteredClient {
  redirectUris: string[];
}

// Short-lived in-memory stores (single-instance server)
const pendingAuth = new Map<string, PendingAuth>();
const authCodes = new Map<string, AuthCode>();

// Purge expired entries every 60 s
setInterval(() => {
  const now = Date.now();
  [...pendingAuth.entries()]
    .filter(([, v]) => now - v.createdAt > 10 * 60 * 1000)
    .forEach(([k]) => pendingAuth.delete(k));
  [...authCodes.entries()]
    .filter(([, v]) => now > v.expiresAt)
    .forEach(([k]) => authCodes.delete(k));
}, 60_000).unref();

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function s256(verifier: string): string {
  return base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
}

function signClientPayload(payload: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(getMcpSigningKey()))
    .update(payload)
    .digest('base64url');
}

function createClientId(redirectUris: string[]): string {
  const payload = base64url(Buffer.from(JSON.stringify({ redirectUris }), 'utf8'));
  const signature = signClientPayload(payload);
  return `mcp-client-v1.${payload}.${signature}`;
}

function parseClientId(clientId: string): RegisteredClient | null {
  const match = /^mcp-client-v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(clientId);
  if (!match) return null;
  const [, payload, signature] = match;
  const expected = signClientPayload(payload);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RegisteredClient;
    if (!Array.isArray(parsed.redirectUris)
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        || parsed.redirectUris.some((uri) => typeof uri !== 'string' || !isAllowedRedirectUri(uri))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function allowedRedirectOrigins(): string[] {
  return (process.env.MCP_ALLOWED_REDIRECT_ORIGINS
    || 'http://localhost,http://127.0.0.1,http://[::1],https://claude.ai,https://github.com,https://github.dev,https://vscode.dev')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function isLoopbackRedirect(uri: URL): boolean {
  if (uri.protocol !== 'http:') return false;
  const host = uri.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isAllowedRedirectUri(rawUri: string): boolean {
  try {
    const uri = new URL(rawUri);
    if (isLoopbackRedirect(uri)) return true;
    const origin = uri.origin.replace(/\/$/, '');
    return allowedRedirectOrigins().includes(origin);
  } catch {
    return false;
  }
}

export default function createMcpOAuthRouter(): Router {
  const router = Router();
  const oidcClientId = process.env.OIDC_CLIENT_ID;
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;

  // Allow cross-origin requests from Claude and other MCP clients
  const openCors = cors();

  // RFC 9728 — Protected Resource Metadata (MCP spec MUST)
  router.get(
    '/.well-known/oauth-protected-resource',
    openCors,
    (req, res) => {
      const origin = serverOrigin(req);
      res.json({
        resource: mcpResource(req),
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
      });
    },
  );

  router.get(
    '/.well-known/oauth-protected-resource/mcp',
    openCors,
    (req, res) => {
      const origin = serverOrigin(req);
      res.json({
        resource: mcpResource(req),
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
      });
    },
  );

  // RFC 8414 — Authorization Server Metadata
  router.get(
    '/.well-known/oauth-authorization-server',
    openCors,
    (req, res) => {
      const origin = serverOrigin(req);
      res.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    },
  );

  // RFC 7591 — Dynamic Client Registration (single-instance in-memory store)
  router.options('/register', openCors);
  router.post('/register', openCors, (req, res) => {
    const {
      client_name: clientName,
      redirect_uris: redirectUris,
    } = req.body || {};
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10
        || redirectUris.some((uri) => typeof uri !== 'string' || uri.length > 2048 || !isAllowedRedirectUri(uri))) {
      res.status(400).json({ error: 'invalid_redirect_uri' });
      return;
    }
    const clientId = createClientId(redirectUris);
    oauthLogger.info({ clientName, clientId }, 'Dynamic client registered');
    res.status(201).json({
      client_id: clientId,
      client_name: clientName || 'MCP Client',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    });
  });

  // Authorization endpoint — stores Claude's params, redirects to OIDC
  router.get('/authorize', (req, res) => {
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      resource,
    } = req.query as Record<string, string>;

    const issuer = getOidcIssuer();
    if (!issuer?.metadata.authorization_endpoint) {
      res.status(503).json({ error: 'OIDC provider not configured' });
      return;
    }
    if (!clientId || !redirectUri || !state || !codeChallenge) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }
    const registeredClient = parseClientId(clientId);
    if (!registeredClient || !registeredClient.redirectUris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_client' });
      return;
    }
    if ((codeChallengeMethod || 'S256') !== 'S256') {
      res.status(400).json({ error: 'invalid_request', error_description: 'Only S256 PKCE is supported' });
      return;
    }

    const expectedResource = mcpResource(req);
    if (resource && resource !== expectedResource) {
      res.status(400).json({ error: 'invalid_target' });
      return;
    }

    const pkceVerifier = base64url(crypto.randomBytes(32));
    const internalState = base64url(crypto.randomBytes(32));

    pendingAuth.set(internalState, {
      claudeRedirectUri: redirectUri,
      claudeState: state,
      claudeCodeChallenge: codeChallenge,
      claudeCodeChallengeMethod: codeChallengeMethod || 'S256',
      pkceVerifier,
      resource: expectedResource,
      clientId,
      createdAt: Date.now(),
    });

    const origin = serverOrigin(req);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oidcClientId!,
      redirect_uri: `${origin}/oauth/mcp-callback`,
      scope: 'openid email profile',
      state: internalState,
      code_challenge: s256(pkceVerifier),
      code_challenge_method: 'S256',
    });

    oauthLogger.info('Redirecting to OIDC provider for MCP authorization');
    res.redirect(
      `${issuer.metadata.authorization_endpoint}?${params}`,
    );
  });

  // Callback from OIDC provider — exchange code, extract user claims,
  // issue our own auth code, redirect to MCP client
  router.get('/oauth/mcp-callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      oauthLogger.error({ error }, 'OIDC provider returned error');
      res.status(400).json({ error });
      return;
    }

    const pending = pendingAuth.get(state);
    if (!pending) {
      res.status(400).json({ error: 'Invalid or expired state' });
      return;
    }
    pendingAuth.delete(state);

    const issuer = getOidcIssuer();
    if (!issuer?.metadata.token_endpoint) {
      res.status(503).json({ error: 'OIDC provider not configured' });
      return;
    }

    try {
      const origin = serverOrigin(req);
      const tokenRes = await fetch(issuer.metadata.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${origin}/oauth/mcp-callback`,
          client_id: oidcClientId!,
          client_secret: oidcClientSecret || '',
          code_verifier: pending.pkceVerifier,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        oauthLogger.error(
          { status: tokenRes.status, body },
          'OIDC token exchange failed',
        );
        res.status(502).json({
          error: 'Token exchange with OIDC provider failed',
        });
        return;
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        id_token?: string;
      };

      // Extract user claims — prefer id_token, fall back to userinfo
      let userClaims: UserClaims | null = null;

      if (tokenData.id_token) {
        try {
          const payload = decodeJwt(tokenData.id_token);
          if (payload.sub) {
            userClaims = {
              sub: payload.sub,
              email: payload.email as string | undefined,
              preferred_username: payload
                .preferred_username as string | undefined,
            };
          }
        } catch {
          oauthLogger.debug('Failed to decode id_token');
        }
      }

      if (!userClaims && issuer.metadata.userinfo_endpoint) {
        try {
          const uiRes = await fetch(
            issuer.metadata.userinfo_endpoint,
            {
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
              },
            },
          );
          if (uiRes.ok) {
            const ui = (await uiRes.json()) as Record<string, unknown>;
            if (ui.sub) {
              userClaims = {
                sub: ui.sub as string,
                email: ui.email as string | undefined,
                preferred_username: ui
                  .preferred_username as string | undefined,
              };
            }
          }
        } catch {
          oauthLogger.debug('Userinfo fallback failed');
        }
      }

      if (!userClaims) {
        oauthLogger.error('Could not extract user claims');
        res.status(502).json({
          error: 'Could not determine user identity',
        });
        return;
      }

      const mcpCode = base64url(crypto.randomBytes(32));
      authCodes.set(mcpCode, {
        userClaims,
        codeChallenge: pending.claudeCodeChallenge,
        codeChallengeMethod: pending.claudeCodeChallengeMethod,
        resource: pending.resource,
        clientId: pending.clientId,
        redirectUri: pending.claudeRedirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const redirectUrl = new URL(pending.claudeRedirectUri);
      redirectUrl.searchParams.set('code', mcpCode);
      redirectUrl.searchParams.set('state', pending.claudeState);

      oauthLogger.info(
        { sub: userClaims.sub },
        'MCP OAuth complete, redirecting to client',
      );
      res.redirect(redirectUrl.toString());
    } catch (err) {
      oauthLogger.error({ err }, 'MCP OAuth callback failed');
      res.status(500).json({
        error: 'Internal error during token exchange',
      });
    }
  });

  // Token endpoint — exchanges our auth code for a self-issued JWT
  router.options('/token', openCors);
  router.post('/token', openCors, async (req, res) => {
    const {
      grant_type: grantType,
      code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
    } = req.body;

    oauthLogger.info({ grantType }, 'Token request received');

    if (grantType !== 'authorization_code') {
      oauthLogger.warn({ grantType }, 'Unsupported grant type');
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const stored = authCodes.get(code);
    if (!stored || Date.now() > stored.expiresAt) {
      if (stored) authCodes.delete(code);
      oauthLogger.warn('Invalid or expired auth code');
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    authCodes.delete(code);

    if (clientId !== stored.clientId || redirectUri !== stored.redirectUri) {
      oauthLogger.warn('Client or redirect_uri mismatch on MCP token request');
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
      oauthLogger.warn('Missing or invalid PKCE verifier');
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Missing or invalid PKCE verifier',
      });
      return;
    }

    if (stored.codeChallengeMethod === 'S256' && s256(codeVerifier) !== stored.codeChallenge) {
      oauthLogger.warn('PKCE verification failed');
      res.status(400).json({
        error: 'invalid_grant',
        error_description: 'PKCE verification failed',
      });
      return;
    }

    if (resource && resource !== stored.resource) {
      oauthLogger.warn({ resource }, 'Resource mismatch on MCP token request');
      res.status(400).json({
        error: 'invalid_target',
        error_description: 'resource does not match authorization request',
      });
      return;
    }

    // Issue our own JWT (no token passthrough per MCP spec). The token is
    // audience-bound to the MCP endpoint so it cannot be replayed as a general
    // FluxHaus admin/API bearer token.
    const jwt = await new SignJWT({
      sub: stored.userClaims.sub,
      email: stored.userClaims.email,
      preferred_username: stored.userClaims.preferred_username,
      type: 'mcp',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(new URL(stored.resource).origin)
      .setAudience(stored.resource)
      .setIssuedAt()
      .setExpirationTime(`${MCP_TOKEN_EXPIRY_SECONDS}s`)
      .sign(getMcpSigningKey());

    oauthLogger.info(
      { sub: stored.userClaims.sub },
      'MCP token issued',
    );
    res.json({
      access_token: jwt,
      token_type: 'Bearer',
      expires_in: MCP_TOKEN_EXPIRY_SECONDS,
    });
  });

  return router;
}
