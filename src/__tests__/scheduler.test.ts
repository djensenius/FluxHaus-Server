// eslint-disable-next-line import/no-unresolved
import schedule from 'node-schedule';
import { scheduleRoutine, cancelAll, type ScheduledRoutine } from '../scheduler';
import { executeAICommand } from '../ai-command';
import type { FluxHausServices } from '../services';

vi.mock('node-schedule', () => ({
  default: { scheduleJob: vi.fn() },
}));
vi.mock('../ai-command', () => ({
  executeAICommand: vi.fn().mockResolvedValue('done'),
}));
vi.mock('../db', () => ({
  getPool: vi.fn().mockReturnValue(null),
}));

describe('scheduler personal memory gating', () => {
  afterEach(() => {
    cancelAll();
  });

  it('runs routines without a user or options, so personal memory is never offered', async () => {
    let fire: (() => void) | undefined;
    (schedule.scheduleJob as vi.Mock).mockImplementation((_name: string, _cron: string, cb: () => void) => {
      fire = cb;
      return { nextInvocation: () => null, cancel: vi.fn() };
    });
    const routine: ScheduledRoutine = {
      id: 'r1',
      user_sub: 'user-1',
      name: 'Morning',
      cron: '0 7 * * *',
      prompt: 'Good morning summary',
      enabled: true,
      last_run_at: null,
      last_result: null,
      created_at: '',
      updated_at: '',
    };
    const services = {} as FluxHausServices;

    scheduleRoutine(routine, services);
    expect(fire).toBeDefined();
    fire!();
    await vi.waitFor(() => expect(executeAICommand).toHaveBeenCalledTimes(1));

    const call = (executeAICommand as vi.Mock).mock.calls[0];
    expect(call).toEqual(['Good morning summary', services]);
  });
});
