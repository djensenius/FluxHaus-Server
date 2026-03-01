import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export default logger;
