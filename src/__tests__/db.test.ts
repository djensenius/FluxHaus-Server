import { closePool, initDatabase, pool } from '../db';

jest.mock('pg', () => {
  const mockQuery = jest.fn().mockResolvedValue({});
  const mockRelease = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  const mockEnd = jest.fn().mockResolvedValue(undefined);
  const MockPool = jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    end: mockEnd,
  }));
  return { Pool: MockPool };
});

describe('db', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockPool: any;
  let mockClient: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = pool as unknown as {
      connect: jest.Mock; end: jest.Mock;
    };
  });

  it('should export a pool instance', () => {
    expect(pool).toBeDefined();
    expect(typeof pool.connect).toBe('function');
  });

  it('initDatabase should create tables', async () => {
    mockClient = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
    mockPool.connect = jest.fn().mockResolvedValue(mockClient);
    await initDatabase();
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('initDatabase should release client even on error', async () => {
    mockClient = {
      query: jest.fn().mockRejectedValueOnce(new Error('DB error')),
      release: jest.fn(),
    };
    mockPool.connect = jest.fn().mockResolvedValue(mockClient);
    await expect(initDatabase()).rejects.toThrow('DB error');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('closePool should end the pool', async () => {
    mockPool.end = jest.fn().mockResolvedValue(undefined);
    await closePool();
    expect(mockPool.end).toHaveBeenCalled();
  });
});
