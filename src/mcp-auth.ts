/**
 * Shared MCP auth utilities used by both the OAuth router and auth middleware.
 * Extracted to avoid circular dependencies.
 */
import { createRemoteJWKSet, decodeJwt, JWTPayload, jwtVerify } from 'jose';

export const MCP_SCOPE = 'fluxhaus:mcp';

export class McpConfigurationError extends Error {}
export class McpScopeError extends Error {}

type McpAuthConfig = { mode: 'proxy' } | { mode: 'oidc'; issuer: string; resource: string };

/** Do not normalize operator input: issuer (including its slash) is an identity. */
function trustedUrl(raw: string | undefined): URL {
  if (!raw || !/^https?:\/\//.test(raw)) throw new McpConfigurationError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpConfigurationError();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.href !== raw && url.href !== `${raw}/`)
      || url.username || url.password || raw.includes('?') || raw.includes('#')
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new McpConfigurationError();
  }
  return url;
}

export function getMcpAuthConfig(): McpAuthConfig {
  const mode = process.env.MCP_AUTH_MODE ?? 'proxy';
  if (mode === 'proxy') return { mode };
  if (mode !== 'oidc') throw new McpConfigurationError();
  trustedUrl(process.env.MCP_ISSUER_URL);
  const resource = trustedUrl(process.env.MCP_RESOURCE_URL);
  if (resource.pathname !== '/mcp') throw new McpConfigurationError();
  return { mode, issuer: process.env.MCP_ISSUER_URL as string, resource: resource.href };
}

let discoveryCache: {
  issuer: string;
  expiresAt: number;
  lookup: Promise<ReturnType<typeof createRemoteJWKSet>>;
} | undefined;

/** Only the dedicated, operator-configured issuer may supply the JWKS location. */
async function issuerKeys(issuer: string) {
  if (!discoveryCache || discoveryCache.issuer !== issuer || discoveryCache.expiresAt <= Date.now()) {
    const lookup = (async () => {
      const response = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('MCP discovery unavailable');
      const metadata = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (metadata.issuer !== issuer || typeof metadata.jwks_uri !== 'string') {
        throw new Error('MCP discovery mismatch');
      }
      const jwksUrl = trustedUrl(metadata.jwks_uri);
      return createRemoteJWKSet(jwksUrl, {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 300_000,
      });
    })();
    discoveryCache = { issuer, expiresAt: Date.now() + 300_000, lookup };
    // A failed discovery must not poison subsequent attempts, nor clear newer lookups.
    lookup.catch(() => {
      if (discoveryCache?.lookup === lookup) discoveryCache = undefined;
    });
  }
  return discoveryCache.lookup;
}

/** Deny-only decoding: dedicated MCP tokens must never reach legacy userinfo auth. */
export function isDedicatedMcpToken(token: string): boolean {
  try {
    const payload = decodeJwt(token);
    const issuer = process.env.MCP_ISSUER_URL;
    const resource = process.env.MCP_RESOURCE_URL;
    return Boolean((issuer && payload.iss === issuer)
      || (resource && (payload.aud === resource
        || (Array.isArray(payload.aud) && payload.aud.includes(resource)))));
  } catch {
    return false;
  }
}

/** Public development fallback for SESSION_SECRET — never safe in production. */
export const DEV_SESSION_SECRET = 'fluxhaus-dev-secret';

/** HMAC key for signing/verifying self-issued MCP access tokens. */
export function getMcpSigningKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET || DEV_SESSION_SECRET;
  return new TextEncoder().encode(secret);
}

/** Derive the server's public origin from an Express request. */
export function serverOrigin(
  req: { protocol: string; get(name: string): string | undefined },
): string {
  const proto = process.env.NODE_ENV === 'production'
    ? 'https' : req.protocol;
  return `${proto}://${req.get('host')}`;
}

/** Canonical OAuth resource identifier for this server's MCP endpoint. */
export function mcpResource(
  req: { protocol: string; get(name: string): string | undefined },
): string {
  const config = getMcpAuthConfig();
  if (config.mode === 'oidc') return config.resource;
  return `${serverOrigin(req)}/mcp`;
}

export interface McpTokenClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  /**
   * Exact validating issuer in direct mode, or original OIDC issuer recorded
   * by the proxy. Undefined for proxy tokens minted without one.
   */
  oidcIssuer?: string;
}

/**
 * Verify only the configured mode's JWTs. Proxy tokens remain audience-bound
 * to the request's resource; direct tokens use only operator configuration.
 * Invalid tokens return null; configuration and verified scope failures throw.
 */
export async function verifyMcpToken(
  token: string,
  expectedResource: string,
): Promise<McpTokenClaims | null> {
  const config = getMcpAuthConfig();
  if (config.mode === 'oidc') {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await issuerKeys(config.issuer), {
        algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'],
        issuer: config.issuer,
        audience: config.resource,
        requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      }));
      if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null;
    } catch {
      return null;
    }
    // Only report insufficient scope after validating signature and identity.
    if (typeof payload.scope !== 'string'
        || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(payload.scope)
        || !payload.scope.split(' ').includes(MCP_SCOPE)) throw new McpScopeError();
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      preferred_username: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      oidcIssuer: config.issuer,
    };
  }
  try {
    const issuer = new URL(expectedResource).origin;
    const { payload } = await jwtVerify(token, getMcpSigningKey(), {
      audience: expectedResource,
      issuer,
    });
    if (payload.sub && (payload as JWTPayload & { type?: string }).type === 'mcp') {
      const oidcIss = (payload as JWTPayload & { oidc_iss?: unknown }).oidc_iss;
      return {
        sub: payload.sub as string,
        email: (payload as JWTPayload & { email?: string }).email,
        preferred_username: (payload as JWTPayload & { preferred_username?: string }).preferred_username,
        oidcIssuer: typeof oidcIss === 'string' && oidcIss ? oidcIss : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
