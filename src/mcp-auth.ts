/**
 * Shared MCP auth utilities used by both the OAuth router and auth middleware.
 * Extracted to avoid circular dependencies.
 */
import { JWTPayload, jwtVerify } from 'jose';

/** HMAC key for signing/verifying self-issued MCP access tokens. */
export function getMcpSigningKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET || 'fluxhaus-dev-secret';
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

export interface McpTokenClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
}

/**
 * Verify a self-issued MCP JWT. Returns user claims if valid, null otherwise.
 */
export async function verifyMcpToken(
  token: string,
): Promise<McpTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getMcpSigningKey());
    if (payload.sub && (payload as JWTPayload & { type?: string }).type === 'mcp') {
      return {
        sub: payload.sub as string,
        email: (payload as JWTPayload & { email?: string }).email,
        preferred_username: (payload as JWTPayload & { preferred_username?: string }).preferred_username,
      };
    }
    return null;
  } catch {
    return null;
  }
}
