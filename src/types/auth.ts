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
  /** Set only when authenticated with a scoped MCP API key on /mcp. */
  authMethod?: 'mcp_api_key';
  /** MCP access level granted by the API key scope. */
  mcpAccess?: 'read' | 'full';
  /** Database id of the MCP API key used. */
  mcpKeyId?: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    csrfToken?: string;
  }
}
