export interface AuthenticatedUser {
  role: 'admin' | 'demo' | 'rhizome';
  username: string;
  sub?: string;
  email?: string;
  name?: string;
  /**
   * OIDC issuer that validated this user's identity. Only set for users
   * authenticated via a validated OIDC login/token (or an MCP token minted
   * from one). Undefined for Basic-auth users and legacy sessions.
   */
  issuer?: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    csrfToken?: string;
  }
}
