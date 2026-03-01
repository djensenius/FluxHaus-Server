export interface AuthenticatedUser {
  role: 'admin' | 'demo' | 'rhizome';
  username: string;
  sub?: string;
  email?: string;
}
