import request from 'supertest';
import express from 'express';
import basicAuth from 'express-basic-auth';
import adminRouter from '../admin.routes';

const mockGetAuditLog = jest.fn();

jest.mock('../../audit', () => ({
  getAuditLog: (...args: unknown[]) => mockGetAuditLog(...args),
}));

function buildApp() {
  const app = express();
  app.use(
    basicAuth({
      users: { admin: 'adminpass', rhizome: 'rhizomepass' },
      challenge: true,
    }),
  );
  app.use('/', adminRouter);
  return app;
}

describe('admin routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 403 for non-admin user', async () => {
    await request(app)
      .get('/audit')
      .auth('rhizome', 'rhizomepass')
      .expect(403);
  });

  it('returns audit log for admin user', async () => {
    const mockEntries = [{ id: 1, username: 'admin', action: 'view:dashboard' }];
    mockGetAuditLog.mockResolvedValue(mockEntries);

    const res = await request(app)
      .get('/audit')
      .auth('admin', 'adminpass')
      .expect(200);

    expect(res.body).toEqual(mockEntries);
    expect(mockGetAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      offset: 0,
    }));
  });

  it('passes query parameters to getAuditLog', async () => {
    mockGetAuditLog.mockResolvedValue([]);

    await request(app)
      .get('/audit?limit=100&offset=10&username=alice&action=car%3Astart&since=2026-01-01T00%3A00%3A00Z')
      .auth('admin', 'adminpass')
      .expect(200);

    expect(mockGetAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      limit: 100,
      offset: 10,
      username: 'alice',
      action: 'car:start',
      since: new Date('2026-01-01T00:00:00Z'),
    }));
  });

  it('caps limit at 500', async () => {
    mockGetAuditLog.mockResolvedValue([]);

    await request(app)
      .get('/audit?limit=9999')
      .auth('admin', 'adminpass')
      .expect(200);

    expect(mockGetAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      limit: 500,
    }));
  });

  it('returns 401 without auth', async () => {
    await request(app).get('/audit').expect(401);
  });
});
