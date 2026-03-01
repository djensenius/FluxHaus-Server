import { NextFunction, Request, Response } from 'express';
import basicAuth from 'express-basic-auth';

function mapBasicAuthToUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authReq = req as basicAuth.IBasicAuthedRequest;
  if (authReq.auth?.user) {
    req.user = { name: authReq.auth.user, role: authReq.auth.user };
  }
  next();
}

export default mapBasicAuthToUser;
