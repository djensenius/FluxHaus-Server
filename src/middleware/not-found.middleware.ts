import { NextFunction, Request, Response } from 'express';

const notFoundHandler = (
  _request: Request,
  response: Response,
  _next: NextFunction,
) => {
  const message = 'Not Found';

  response.status(404).json({ message });
};

export default notFoundHandler;
