import { Router } from 'express';
import crypto from 'crypto';
import cors from 'cors';
import { getOidcIssuer } from '../middleware/oidc.middleware';
import logger from '../logger';

const oauthLogger = logger.child({ subsystem: 'mcp-oauth' });

interface PendingAuth {
  claudeRedirectUri: string;
  claudeState: string;
  claudeCodeChallenge: string;
  claudeCodeChallengeMethod: string;
  pkceVerifier: string;
  createdAt: number;
}

interface AuthCode {
  accessToken: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
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
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function serverOrigin(req: { protocol: string; get(name: string): string | undefined }): string {
  // Force https in production — reverse proxies don't always forward X-Forwarded-Proto
  const proto = process.env.NODE_ENV === 'production' ? 'https' : req.protocol;
  return `${proto}://${req.get('host')}`;
}

export default function createMcpOAuthRouter(): Router {
  const router = Router();
  const oidcClientId = process.env.OIDC_CLIENT_ID;
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;

  // Allow cross-origin requests from Claude and other MCP clients
  const openCors = cors();

  // RFC 8414 — Authorization Server Metadata
  router.get('/.well-known/oauth-authorization-server', openCors, (req, res) => {
    const origin = serverOrigin(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
  });

  // Authorization endpoint — stores Claude's params, redirects to Authentik
  router.get('/authorize', (req, res) => {
    const {
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    } = req.query as Record<string, string>;

    const issuer = getOidcIssuer();
    if (!issuer?.metadata.authorization_endpoint) {
      res.status(503).json({ error: 'OIDC provider not configured' });
      return;
    }
    if (!redirectUri || !state || !codeChallenge) {
      res.status(400).json({ error: 'Missing required parameters' });
      return;
    }

    // PKCE pair for the Authentik leg
    const pkceVerifier = base64url(crypto.randomBytes(32));
    const internalState = base64url(crypto.randomBytes(32));

    pendingAuth.set(internalState, {
      claudeRedirectUri: redirectUri,
      claudeState: state,
      claudeCodeChallenge: codeChallenge,
      claudeCodeChallengeMethod: codeChallengeMethod || 'S256',
      pkceVerifier,
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
    res.redirect(`${issuer.metadata.authorization_endpoint}?${params}`);
  });

  // Callback from Authentik — exchange code, generate our own code, redirect to Claude
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
        oauthLogger.error({ status: tokenRes.status, body }, 'OIDC token exchange failed');
        res.status(502).json({ error: 'Token exchange with OIDC provider failed' });
        return;
      }

      const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

      // Issue our own short-lived auth code for Claude
      const mcpCode = base64url(crypto.randomBytes(32));
      authCodes.set(mcpCode, {
        accessToken,
        codeChallenge: pending.claudeCodeChallenge,
        codeChallengeMethod: pending.claudeCodeChallengeMethod,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const redirectUrl = new URL(pending.claudeRedirectUri);
      redirectUrl.searchParams.set('code', mcpCode);
      redirectUrl.searchParams.set('state', pending.claudeState);

      oauthLogger.info('MCP OAuth complete, redirecting to client');
      res.redirect(redirectUrl.toString());
    } catch (err) {
      oauthLogger.error({ err }, 'MCP OAuth callback failed');
      res.status(500).json({ error: 'Internal error during token exchange' });
    }
  });

  // Token endpoint — Claude exchanges our code for the Authentik access token
  router.options('/token', openCors);
  router.post('/token', openCors, (req, res) => {
    const {
      grant_type: grantType,
      code,
      code_verifier: codeVerifier,
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

    // Verify PKCE (primary security mechanism — no client secret validation needed)
    if (stored.codeChallengeMethod === 'S256') {
      if (s256(codeVerifier) !== stored.codeChallenge) {
        oauthLogger.warn('PKCE verification failed');
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    oauthLogger.info('Token issued successfully');
    res.json({
      access_token: stored.accessToken,
      token_type: 'Bearer',
    });
  });

  return router;
}
