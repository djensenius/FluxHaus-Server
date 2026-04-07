import { NextFunction, Request, Response } from 'express';
import {
  CSRF_COOKIE_NAME,
  csrfMiddleware,
  issueCsrfToken,
} from '../csrf.middleware';

function mockRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  return res;
}

describe('csrfMiddleware', () => {
  it('allows mutation requests with a matching signed CSRF cookie', () => {
    const req = {
      method: 'POST',
      path: '/calendar-sources',
      headers: { 'x-csrf-token': 'token-123' },
      signedCookies: { [CSRF_COOKIE_NAME]: 'token-123' },
      session: {},
    } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = jest.fn();

    csrfMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects mutation requests when header matches neither session nor cookie token', () => {
    const req = {
      method: 'POST',
      path: '/calendar-sources',
      headers: { 'x-csrf-token': 'wrong-token' },
      signedCookies: { [CSRF_COOKIE_NAME]: 'token-123' },
      session: { csrfToken: 'token-456' },
    } as unknown as Request;
    const res = mockRes() as Response;
    const next: NextFunction = jest.fn();

    csrfMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or missing CSRF token' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('issueCsrfToken', () => {
  it('reuses the signed cookie token and mirrors it into the session', () => {
    const req = {
      signedCookies: { [CSRF_COOKIE_NAME]: 'token-123' },
      session: {},
    } as unknown as Request;
    const res = mockRes() as Response;

    const token = issueCsrfToken(req, res);

    expect(token).toBe('token-123');
    expect(req.session.csrfToken).toBe('token-123');
    expect(res.cookie).toHaveBeenCalledWith(
      CSRF_COOKIE_NAME,
      'token-123',
      expect.objectContaining({ httpOnly: true, signed: true }),
    );
  });
});
