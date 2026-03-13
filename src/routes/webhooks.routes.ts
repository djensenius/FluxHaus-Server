import { Request, Response, Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import { logEvent } from '../audit';
import {
  createToken, deleteToken, hasScope, listTokens, toggleToken, validateToken,
} from '../webhook-tokens';
import { executeAICommand } from '../ai-command';
import { FluxHausServices } from '../services';

export default function createWebhooksRouter(services: FluxHausServices): Router {
  const router = Router();

  // ── Token management (admin-only) ──

  router.get('/webhooks', requireRole('admin'), async (_req: Request, res: Response) => {
    const tokens = await listTokens();
    res.json(tokens);
  });

  router.post('/webhooks', requireRole('admin'), async (req: Request, res: Response) => {
    const { name, scopes } = req.body as { name?: string; scopes?: string[] };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const { token, webhook } = await createToken({
      user_sub: req.user?.sub || 'admin',
      name,
      scopes,
    });

    // Return the raw token ONCE — it's never shown again
    res.status(201).json({ ...webhook, token });
  });

  router.delete('/webhooks/:id', requireRole('admin'), async (req: Request, res: Response) => {
    const deleted = await deleteToken(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Webhook token not found' });
      return;
    }
    res.status(204).send();
  });

  router.patch('/webhooks/:id', requireRole('admin'), async (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (enabled === undefined) {
      res.status(400).json({ error: 'enabled is required' });
      return;
    }
    const updated = await toggleToken(req.params.id, enabled);
    if (!updated) {
      res.status(404).json({ error: 'Webhook token not found' });
      return;
    }
    res.json({ id: req.params.id, enabled });
  });

  // ── Trigger endpoint (authenticated via webhook token) ──

  router.post('/webhooks/trigger', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }

    const token = authHeader.slice(7);
    const webhook = await validateToken(token);
    if (!webhook) {
      res.status(401).json({ error: 'Invalid or disabled token' });
      return;
    }

    if (!hasScope(webhook, 'command')) {
      res.status(403).json({ error: 'Token does not have "command" scope' });
      return;
    }

    const { command } = req.body as { command?: string };
    if (!command || typeof command !== 'string') {
      res.status(400).json({ error: 'command is required' });
      return;
    }

    // Audit log
    logEvent({
      user_sub: webhook.user_sub,
      username: `webhook:${webhook.name}`,
      role: 'webhook',
      action: 'webhook_trigger',
      route: '/webhooks/trigger',
      method: 'POST',
      ip: req.ip,
      details: { webhookId: webhook.id, command: command.substring(0, 200) },
    }).catch(() => {});

    try {
      const response = await executeAICommand(command, services);
      res.json({ response });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
