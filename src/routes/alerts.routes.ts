import { Request, Response, Router } from 'express';
import { requireRole } from '../middleware/auth.middleware';
import {
  createAlertRule, deleteAlertRule, getAlertRule, listAlertRules, updateAlertRule,
} from '../alert-monitor';

const router = Router();

router.get('/alerts', requireRole('admin'), async (_req: Request, res: Response) => {
  const rules = await listAlertRules();
  res.json(rules);
});

router.get('/alerts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const rule = await getAlertRule(req.params.id);
  if (!rule) {
    res.status(404).json({ error: 'Alert rule not found' });
    return;
  }
  res.json(rule);
});

router.post('/alerts', requireRole('admin'), async (req: Request, res: Response) => {
  const {
    name,
    entity_id: entityId,
    condition_type: conditionType,
    condition_value: conditionValue,
    message_template: messageTemplate,
    cooldown_minutes: cooldownMinutes,
    enabled,
  } = req.body as {
    name?: string;
    entity_id?: string;
    condition_type?: string;
    condition_value?: Record<string, unknown>;
    message_template?: string;
    cooldown_minutes?: number;
    enabled?: boolean;
  };

  if (!name || !entityId || !conditionType || !conditionValue) {
    res.status(400).json({ error: 'name, entity_id, condition_type, and condition_value are required' });
    return;
  }

  const rule = await createAlertRule({
    user_sub: req.user?.sub || 'admin',
    name,
    // eslint-disable-next-line camelcase
    entity_id: entityId,
    // eslint-disable-next-line camelcase
    condition_type: conditionType,
    // eslint-disable-next-line camelcase
    condition_value: conditionValue,
    // eslint-disable-next-line camelcase
    message_template: messageTemplate,
    // eslint-disable-next-line camelcase
    cooldown_minutes: cooldownMinutes,
    enabled,
  });
  res.status(201).json(rule);
});

router.put('/alerts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const rule = await updateAlertRule(req.params.id, req.body);
  if (!rule) {
    res.status(404).json({ error: 'Alert rule not found' });
    return;
  }
  res.json(rule);
});

router.delete('/alerts/:id', requireRole('admin'), async (req: Request, res: Response) => {
  const deleted = await deleteAlertRule(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Alert rule not found' });
    return;
  }
  res.status(204).send();
});

export default router;
