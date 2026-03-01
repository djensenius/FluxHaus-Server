export interface AuthenticatedUser {
  role: 'admin' | 'demo' | 'rhizome';
  username: string;
  sub?: string;
  email?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
