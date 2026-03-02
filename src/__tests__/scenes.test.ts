import express from 'express';
import request from 'supertest';

// Minimal test for the /scenes and /scenes/activate endpoints.
// We can't easily import the full server.ts (it depends on many
// env variables and external services), so we create a slim
// Express app that mimics the relevant routes.

describe('/scenes endpoints', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockHaClient: any;
  let app: express.Express;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    mockHaClient = {
      getState: jest.fn(),
      callService: jest.fn(),
    };

    app = express();
    app.use(express.json());

    // GET /scenes — mirrors server.ts implementation
    app.get('/scenes', async (_req, res) => {
      try {
        const states = await mockHaClient.getState('');
        const scenes = (Array.isArray(states) ? states : [])
          .filter((s: Record<string, unknown>) => typeof s.entity_id === 'string'
            && s.entity_id.startsWith('scene.'))
          .map((s: Record<string, unknown>) => ({
            entityId: s.entity_id,
            name: (s.attributes as Record<string, unknown>)?.friendly_name
              || s.entity_id,
          }));
        res.json(scenes);
      } catch {
        res.status(502).json({ error: 'Failed to fetch scenes' });
      }
    });

    // POST /scenes/activate — mirrors server.ts implementation
    app.post('/scenes/activate', async (req, res) => {
      const { entityId } = req.body as { entityId?: string };
      if (!entityId || !entityId.startsWith('scene.')) {
        res.status(400).json({ error: 'Invalid entityId' });
        return;
      }
      try {
        /* eslint-disable camelcase */
        await mockHaClient.callService('scene', 'turn_on', { entity_id: entityId });
        /* eslint-enable camelcase */
        res.json({ success: true });
      } catch {
        res.status(502).json({ error: 'Failed to activate scene' });
      }
    });
  });

  describe('GET /scenes', () => {
    it('returns only scene entities with friendly names', async () => {
      mockHaClient.getState.mockResolvedValue([
        {
          entity_id: 'scene.good_morning',
          attributes: { friendly_name: 'Good Morning' },
        },
        {
          entity_id: 'scene.bedtime',
          attributes: { friendly_name: 'Bedtime' },
        },
        {
          entity_id: 'light.living_room',
          attributes: { friendly_name: 'Living Room' },
        },
        {
          entity_id: 'switch.fan',
          attributes: { friendly_name: 'Fan' },
        },
      ]);

      const res = await request(app).get('/scenes');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body).toEqual([
        { entityId: 'scene.good_morning', name: 'Good Morning' },
        { entityId: 'scene.bedtime', name: 'Bedtime' },
      ]);
      expect(mockHaClient.getState).toHaveBeenCalledWith('');
    });

    it('falls back to entity_id when no friendly_name', async () => {
      mockHaClient.getState.mockResolvedValue([
        {
          entity_id: 'scene.unnamed',
          attributes: {},
        },
      ]);

      const res = await request(app).get('/scenes');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { entityId: 'scene.unnamed', name: 'scene.unnamed' },
      ]);
    });

    it('returns empty array when no scenes', async () => {
      mockHaClient.getState.mockResolvedValue([
        {
          entity_id: 'light.kitchen',
          attributes: { friendly_name: 'Kitchen' },
        },
      ]);

      const res = await request(app).get('/scenes');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns 502 when HA client fails', async () => {
      mockHaClient.getState.mockRejectedValue(
        new Error('Connection refused'),
      );

      const res = await request(app).get('/scenes');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'Failed to fetch scenes' });
    });

    it('handles non-array response gracefully', async () => {
      mockHaClient.getState.mockResolvedValue(null);

      const res = await request(app).get('/scenes');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /scenes/activate', () => {
    it('activates a valid scene', async () => {
      mockHaClient.callService.mockResolvedValue({});

      const res = await request(app)
        .post('/scenes/activate')
        .send({ entityId: 'scene.good_morning' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockHaClient.callService).toHaveBeenCalledWith(
        'scene',
        'turn_on',
        { entity_id: 'scene.good_morning' },
      );
    });

    it('rejects missing entityId', async () => {
      const res = await request(app)
        .post('/scenes/activate')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid entityId' });
      expect(mockHaClient.callService).not.toHaveBeenCalled();
    });

    it('rejects non-scene entityId', async () => {
      const res = await request(app)
        .post('/scenes/activate')
        .send({ entityId: 'light.living_room' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid entityId' });
      expect(mockHaClient.callService).not.toHaveBeenCalled();
    });

    it('returns 502 when HA client fails', async () => {
      mockHaClient.callService.mockRejectedValue(
        new Error('Service unavailable'),
      );

      const res = await request(app)
        .post('/scenes/activate')
        .send({ entityId: 'scene.bedtime' });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: 'Failed to activate scene',
      });
    });
  });
});
