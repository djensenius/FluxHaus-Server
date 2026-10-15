import { Request, Response } from 'express';
import notFoundHandler from '../not-found.middleware';

describe('Not Found Middleware', () => {
  it('should return 404 and "Resource not found" message', () => {
    const req = {} as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const next = vi.fn();

    notFoundHandler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Not Found',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
