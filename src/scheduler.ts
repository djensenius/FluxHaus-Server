// eslint-disable-next-line import/no-unresolved
import schedule from 'node-schedule';
import { getPool } from './db';
import { executeAICommand } from './ai-command';
import { FluxHausServices } from './services';
import logger from './logger';

const schedulerLogger = logger.child({ subsystem: 'scheduler' });

export interface ScheduledRoutine {
  id: string;
  user_sub: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  last_run_at: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

const activeJobs = new Map<string, schedule.Job>();

async function runRoutine(
  routine: ScheduledRoutine,
  services: FluxHausServices,
): Promise<void> {
  schedulerLogger.info({ id: routine.id, name: routine.name }, 'Running scheduled routine');

  try {
    const result = await executeAICommand(routine.prompt, services);

    const pool = getPool();
    if (pool) {
      await pool.query(
        'UPDATE scheduled_routines SET last_run_at = NOW(), last_result = $1, updated_at = NOW() WHERE id = $2',
        [result.substring(0, 10_000), routine.id],
      );
    }

    schedulerLogger.info(
      { id: routine.id, name: routine.name, resultLength: result.length },
      'Routine completed',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    schedulerLogger.error({ id: routine.id, err: msg }, 'Routine execution failed');

    const pool = getPool();
    if (pool) {
      await pool.query(
        'UPDATE scheduled_routines SET last_run_at = NOW(), last_result = $1, updated_at = NOW() WHERE id = $2',
        [`Error: ${msg}`, routine.id],
      );
    }
  }
}

export function scheduleRoutine(
  routine: ScheduledRoutine,
  services: FluxHausServices,
): void {
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  unscheduleRoutine(routine.id);

  if (!routine.enabled) return;

  try {
    const job = schedule.scheduleJob(`routine-${routine.id}`, routine.cron, () => {
      runRoutine(routine, services).catch((err) => {
        schedulerLogger.error({ id: routine.id, err }, 'Unhandled error in routine');
      });
    });

    if (job) {
      activeJobs.set(routine.id, job);
      const next = job.nextInvocation();
      schedulerLogger.info(
        {
          id: routine.id,
          name: routine.name,
          cron: routine.cron,
          nextRun: next?.toISOString(),
        },
        'Routine scheduled',
      );
    } else {
      schedulerLogger.warn(
        { id: routine.id, cron: routine.cron },
        'Invalid cron expression — routine not scheduled',
      );
    }
  } catch (err) {
    schedulerLogger.error({ id: routine.id, err }, 'Failed to schedule routine');
  }
}

export function unscheduleRoutine(id: string): void {
  const existing = activeJobs.get(id);
  if (existing) {
    existing.cancel();
    activeJobs.delete(id);
  }
}

export async function loadAndScheduleAll(services: FluxHausServices): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const result = await pool.query(
    'SELECT * FROM scheduled_routines WHERE enabled = true',
  );

  schedulerLogger.info({ count: result.rows.length }, 'Loading scheduled routines');

  result.rows.forEach((row) => {
    scheduleRoutine(row as ScheduledRoutine, services);
  });
}

export function getActiveJobCount(): number {
  return activeJobs.size;
}

export function cancelAll(): void {
  Array.from(activeJobs.entries()).forEach(([id, job]) => {
    job.cancel();
    activeJobs.delete(id);
  });
  schedulerLogger.info('All scheduled routines cancelled');
}

// ── CRUD helpers ──

export async function listRoutines(userSub?: string): Promise<ScheduledRoutine[]> {
  const pool = getPool();
  if (!pool) return [];
  const query = userSub
    ? { text: 'SELECT * FROM scheduled_routines WHERE user_sub = $1 ORDER BY created_at DESC', values: [userSub] }
    : { text: 'SELECT * FROM scheduled_routines ORDER BY created_at DESC', values: [] };
  const result = await pool.query(query.text, query.values);
  return result.rows;
}

export async function getRoutine(id: string): Promise<ScheduledRoutine | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM scheduled_routines WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function createRoutine(
  data: { user_sub: string; name: string; cron: string; prompt: string; enabled?: boolean },
  services: FluxHausServices,
): Promise<ScheduledRoutine> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const result = await pool.query(
    `INSERT INTO scheduled_routines (user_sub, name, cron, prompt, enabled)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.user_sub, data.name, data.cron, data.prompt, data.enabled ?? true],
  );
  const routine = result.rows[0] as ScheduledRoutine;
  scheduleRoutine(routine, services);
  return routine;
}

export async function updateRoutine(
  id: string,
  data: Partial<{ name: string; cron: string; prompt: string; enabled: boolean }>,
  services: FluxHausServices,
): Promise<ScheduledRoutine | null> {
  const pool = getPool();
  if (!pool) return null;

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) { sets.push(`name = $${idx}`); values.push(data.name); idx += 1; }
  if (data.cron !== undefined) { sets.push(`cron = $${idx}`); values.push(data.cron); idx += 1; }
  if (data.prompt !== undefined) { sets.push(`prompt = $${idx}`); values.push(data.prompt); idx += 1; }
  if (data.enabled !== undefined) { sets.push(`enabled = $${idx}`); values.push(data.enabled); idx += 1; }
  sets.push('updated_at = NOW()');

  if (sets.length === 1) return getRoutine(id);

  values.push(id);
  const result = await pool.query(
    `UPDATE scheduled_routines SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  const routine = result.rows[0] as ScheduledRoutine | undefined;
  if (routine) scheduleRoutine(routine, services);
  return routine || null;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  unscheduleRoutine(id);
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM scheduled_routines WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
