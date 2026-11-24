import express from 'express';
import request from 'supertest';
import preferencesRouter from '../routes/preferences.routes';
import { setUserPreferences } from '../user-preferences';

vi.mock('../user-preferences', () => ({
  getUserPreferences: vi.fn(),
  setUserPreferences: vi.fn(),
}));

vi.mock('../middleware/csrf.middleware', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  csrfMiddleware: (_req: any, _res: any, next: () => void) => next(),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { role: 'admin', username: 'u', sub: 'user-1' };
    next();
  });
  app.use(preferencesRouter);
  return app;
}

describe('PATCH /preferences personalMemoryEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (setUserPreferences as vi.Mock).mockImplementation(async (_sub, prefs) => ({
      memoryEnabled: true, personalMemoryEnabled: true, defaultCalendarId: null, ...prefs,
    }));
  });

  it('accepts personalMemoryEnabled alone', async () => {
    const res = await request(makeApp()).patch('/preferences').send({ personalMemoryEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.personalMemoryEnabled).toBe(false);
    expect(setUserPreferences).toHaveBeenCalledWith('user-1', expect.objectContaining({
      personalMemoryEnabled: false,
      memoryEnabled: undefined,
    }));
  });

  it('rejects non-boolean personalMemoryEnabled', async () => {
    const res = await request(makeApp()).patch('/preferences').send({ personalMemoryEnabled: 'no' });
    expect(res.status).toBe(400);
    expect(setUserPreferences).not.toHaveBeenCalled();
  });
});
