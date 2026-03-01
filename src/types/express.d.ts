declare namespace Express {
  interface Request {
    user?: {
      name: string;
      role: string;
    };
  }
}
