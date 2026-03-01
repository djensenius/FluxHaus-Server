import { NextFunction, Request, Response } from 'express';
import { IBasicAuthedRequest } from 'express-basic-auth';
import auditMiddleware, { deriveAction } from '../audit.middleware';
import * as auditModule from '../../audit';

jest.mock('../../audit', () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../logger', () => ({
  child: jest.fn().mockReturnValue({
    error: jest.fn(),
    info: jest.fn(),
  }),
}));

describe('audit middleware', () => {
  describe('deriveAction', () => {
    it('maps known routes', () => {
      expect(deriveAction('/')).toBe('view:dashboard');
      expect(deriveAction('/turnOnBroombot')).toBe('robot:broombot:on');
      expect(deriveAction('/turnOffBroombot')).toBe('robot:broombot:off');
      expect(deriveAction('/turnOnMopbot')).toBe('robot:mopbot:on');
      expect(deriveAction('/turnOffMopbot')).toBe('robot:mopbot:off');
      expect(deriveAction('/turnOnDeepClean')).toBe('robot:deep_clean:on');
      expect(deriveAction('/turnOffDeepClean')).toBe('robot:deep_clean:off');
      expect(deriveAction('/startCar')).toBe('car:start');
      expect(deriveAction('/stopCar')).toBe('car:stop');
      expect(deriveAction('/resyncCar')).toBe('car:resync');
      expect(deriveAction('/lockCar')).toBe('car:lock');
      expect(deriveAction('/unlockCar')).toBe('car:unlock');
      expect(deriveAction('/audit')).toBe('view:audit');
    });

    it('returns a generic action for unknown routes', () => {
      expect(deriveAction('/some/unknown/path')).toBe('request:some:unknown:path');
    });
  });

  describe('middleware', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: NextFunction;
    let finishCallback: (() => void) | undefined;

    beforeEach(() => {
      jest.clearAllMocks();
      finishCallback = undefined;
      mockRes = {
        statusCode: 200,
        on: jest.fn((event: string, cb: () => void) => {
          if (event === 'finish') finishCallback = cb;
          return mockRes as Response;
        }),
      };
      mockNext = jest.fn();
    });

    it('calls next for non-health routes', () => {
      mockReq = { path: '/', method: 'GET', ip: '127.0.0.1' };
      (mockReq as unknown as IBasicAuthedRequest).auth = { user: 'admin', password: 'x' };
      auditMiddleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it('calls next without logging for /health', () => {
      mockReq = { path: '/health', method: 'GET', ip: '127.0.0.1' };
      auditMiddleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.on).not.toHaveBeenCalled();
    });

    it('fires logEvent on response finish', async () => {
      mockReq = { path: '/', method: 'GET', ip: '127.0.0.1' };
      (mockReq as unknown as IBasicAuthedRequest).auth = { user: 'admin', password: 'x' };
      auditMiddleware(mockReq as Request, mockRes as Response, mockNext);
      expect(finishCallback).toBeDefined();
      finishCallback!();
      await Promise.resolve();
      expect(auditModule.logEvent).toHaveBeenCalledWith(expect.objectContaining({
        username: 'admin',
        action: 'view:dashboard',
        route: '/',
        method: 'GET',
        ip: '127.0.0.1',
      }));
    });

    it('uses req.user when available', async () => {
      mockReq = {
        path: '/audit',
        method: 'GET',
        ip: '10.0.0.1',
        user: { sub: 'sub-123', username: 'alice', role: 'admin' },
      };
      auditMiddleware(mockReq as Request, mockRes as Response, mockNext);
      finishCallback!();
      await Promise.resolve();
      expect(auditModule.logEvent).toHaveBeenCalledWith(expect.objectContaining({
        userSub: 'sub-123',
        username: 'alice',
        role: 'admin',
      }));
    });
  });
});
