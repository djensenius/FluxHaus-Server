import { getPool } from './db';
import { HomeAssistantClient } from './homeassistant-client';
import logger from './logger';

const alertLogger = logger.child({ subsystem: 'alerts' });

export interface AlertRule {
  id: string;
  user_sub: string;
  name: string;
  entity_id: string;
  condition_type: 'threshold_above' | 'threshold_below' | 'state_equals' | 'state_not_equals' | 'state_changed';
  condition_value: { value?: string | number; from?: string; to?: string };
  message_template: string | null;
  cooldown_minutes: number;
  last_triggered_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface EntityStateCache {
  state: string;
  lastChanged: string;
}

const stateCache = new Map<string, EntityStateCache>();
let monitorInterval: ReturnType<typeof setInterval> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AlertCallback = (rule: AlertRule, entityState: any, message: string) => void;
let onAlertTriggered: AlertCallback | null = null;

export function setAlertCallback(cb: AlertCallback): void {
  onAlertTriggered = cb;
}

function evaluateCondition(
  rule: AlertRule,
  currentState: string,
  previousState: string | undefined,
): boolean {
  const { condition_type: type, condition_value: cond } = rule;

  switch (type) {
  case 'threshold_above': {
    const num = parseFloat(currentState);
    return !Number.isNaN(num) && num > Number(cond.value);
  }
  case 'threshold_below': {
    const num = parseFloat(currentState);
    return !Number.isNaN(num) && num < Number(cond.value);
  }
  case 'state_equals':
    return currentState === String(cond.value);
  case 'state_not_equals':
    return currentState !== String(cond.value);
  case 'state_changed':
    if (previousState === undefined) return false;
    if (cond.from && previousState !== cond.from) return false;
    if (cond.to && currentState !== cond.to) return false;
    return previousState !== currentState;
  default:
    return false;
  }
}

function buildAlertMessage(rule: AlertRule, state: string): string {
  if (rule.message_template) {
    return rule.message_template
      .replace('{{entity_id}}', rule.entity_id)
      .replace('{{state}}', state)
      .replace('{{name}}', rule.name);
  }
  return `Alert "${rule.name}": ${rule.entity_id} is ${state}`;
}

function isInCooldown(rule: AlertRule): boolean {
  if (!rule.last_triggered_at) return false;
  const lastTriggered = new Date(rule.last_triggered_at).getTime();
  const cooldownMs = rule.cooldown_minutes * 60 * 1000;
  return Date.now() - lastTriggered < cooldownMs;
}

async function checkRules(haClient: HomeAssistantClient): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const result = await pool.query('SELECT * FROM alert_rules WHERE enabled = true');
  const rules = result.rows as AlertRule[];
  if (rules.length === 0) return;

  // Collect unique entity IDs and fetch their states
  const entityIds = [...new Set(rules.map((r) => r.entity_id))];

  for (const entityId of entityIds) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const states = await haClient.getState(entityId);
      if (!states || (Array.isArray(states) && states.length === 0)) continue;

      const entity = Array.isArray(states) ? states[0] : states;
      const currentState = String(entity.state);
      const cached = stateCache.get(entityId);
      const previousState = cached?.state;

      stateCache.set(entityId, { state: currentState, lastChanged: new Date().toISOString() });

      // Evaluate rules for this entity
      const matchingRules = rules.filter((r) => r.entity_id === entityId);
      for (const rule of matchingRules) {
        if (isInCooldown(rule)) continue;

        if (evaluateCondition(rule, currentState, previousState)) {
          const message = buildAlertMessage(rule, currentState);
          alertLogger.info({ ruleId: rule.id, name: rule.name, entityId, state: currentState }, 'Alert triggered');

          // Update last_triggered_at
          // eslint-disable-next-line no-await-in-loop
          await pool.query(
            'UPDATE alert_rules SET last_triggered_at = NOW(), updated_at = NOW() WHERE id = $1',
            [rule.id],
          );

          if (onAlertTriggered) {
            onAlertTriggered(rule, entity, message);
          }
        }
      }
    } catch (err) {
      alertLogger.error({ entityId, err }, 'Failed to check entity state');
    }
  }
}

export function startMonitor(
  haClient: HomeAssistantClient,
  intervalMs = 30_000,
): void {
  if (monitorInterval) return;

  alertLogger.info({ intervalMs }, 'Starting alert monitor');
  monitorInterval = setInterval(() => {
    checkRules(haClient).catch((err) => {
      alertLogger.error({ err }, 'Alert monitor cycle failed');
    });
  }, intervalMs);

  // Run once immediately
  checkRules(haClient).catch((err) => {
    alertLogger.error({ err }, 'Initial alert check failed');
  });
}

export function stopMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    alertLogger.info('Alert monitor stopped');
  }
}

// ── CRUD helpers ──

export async function listAlertRules(userSub?: string): Promise<AlertRule[]> {
  const pool = getPool();
  if (!pool) return [];
  const query = userSub
    ? { text: 'SELECT * FROM alert_rules WHERE user_sub = $1 ORDER BY created_at DESC', values: [userSub] }
    : { text: 'SELECT * FROM alert_rules ORDER BY created_at DESC', values: [] };
  const result = await pool.query(query.text, query.values);
  return result.rows;
}

export async function getAlertRule(id: string): Promise<AlertRule | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM alert_rules WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function createAlertRule(
  data: {
    user_sub: string;
    name: string;
    entity_id: string;
    condition_type: string;
    condition_value: Record<string, unknown>;
    message_template?: string;
    cooldown_minutes?: number;
    enabled?: boolean;
  },
): Promise<AlertRule> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    `INSERT INTO alert_rules (user_sub, name, entity_id, condition_type, condition_value, message_template, cooldown_minutes, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.user_sub, data.name, data.entity_id, data.condition_type,
      JSON.stringify(data.condition_value), data.message_template || null,
      data.cooldown_minutes ?? 60, data.enabled ?? true,
    ],
  );
  return result.rows[0];
}

export async function updateAlertRule(
  id: string,
  data: Partial<{
    name: string;
    entity_id: string;
    condition_type: string;
    condition_value: Record<string, unknown>;
    message_template: string;
    cooldown_minutes: number;
    enabled: boolean;
  }>,
): Promise<AlertRule | null> {
  const pool = getPool();
  if (!pool) return null;

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx}`); values.push(data.name); idx += 1; }
  if (data.entity_id !== undefined) { sets.push(`entity_id = $${idx}`); values.push(data.entity_id); idx += 1; }
  if (data.condition_type !== undefined) { sets.push(`condition_type = $${idx}`); values.push(data.condition_type); idx += 1; }
  if (data.condition_value !== undefined) { sets.push(`condition_value = $${idx}`); values.push(JSON.stringify(data.condition_value)); idx += 1; }
  if (data.message_template !== undefined) { sets.push(`message_template = $${idx}`); values.push(data.message_template); idx += 1; }
  if (data.cooldown_minutes !== undefined) { sets.push(`cooldown_minutes = $${idx}`); values.push(data.cooldown_minutes); idx += 1; }
  if (data.enabled !== undefined) { sets.push(`enabled = $${idx}`); values.push(data.enabled); idx += 1; }
  sets.push('updated_at = NOW()');

  if (sets.length === 1) return getAlertRule(id);

  values.push(id);
  const result = await pool.query(
    `UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [...values.slice(0, -1), id],
  );
  return result.rows[0] || null;
}

export async function deleteAlertRule(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM alert_rules WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
