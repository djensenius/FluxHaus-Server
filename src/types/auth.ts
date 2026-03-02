export interface AuthenticatedUser {
  role: 'admin' | 'demo' | 'rhizome';
  username: string;
  sub?: string;
  email?: string;
}

declare module 'express-session' {
  interface SessionData {
    user?: AuthenticatedUser;
    csrfToken?: string;
  }
}
