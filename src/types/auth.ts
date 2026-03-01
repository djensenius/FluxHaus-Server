export interface AuthenticatedUser {
  role: 'admin' | 'demo' | 'rhizome';
  username: string;
  sub?: string;
  email?: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
  }
}
