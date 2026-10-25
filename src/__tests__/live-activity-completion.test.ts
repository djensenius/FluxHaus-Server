import * as apns from '../apns';
import * as channels from '../apns-channels';
import * as subscriptions from '../la-subscriptions';
import * as tokens from '../push-token-store';

vi.mock('../apns');
vi.mock('../apns-channels');
vi.mock('../la-subscriptions');
vi.mock('../push-token-store');
vi.mock('../logger', () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

let hooks: typeof import('../live-activity-hooks');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(channels.getChannelId).mockResolvedValue('consolidated-channel');
  vi.mocked(apns.sendMultiDeviceBroadcast).mockResolvedValue(true);
  vi.mocked(apns.sendMultiDeviceDirectUpdate).mockResolvedValue(true);
  vi.mocked(tokens.getAllActivityTokens).mockResolvedValue([]);
  vi.mocked(tokens.getAllApnsTokens).mockResolvedValue([]);
  vi.mocked(subscriptions.getSubscribedDeviceTokens).mockResolvedValue([]);
  vi.mocked(subscriptions.getApnsTokensForDeviceType).mockResolvedValue([]);
  hooks = await import('../live-activity-hooks');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function initializeIdle() {
  await hooks.onMieleStatusChange('washer', { name: 'Washer', timeRemaining: 0, inUse: false });
  await hooks.onMieleStatusChange('dryer', { name: 'Dryer', timeRemaining: 0, inUse: false });
  await hooks.onDishwasherStatusChange({ operationState: 'Inactive', doorState: 'Closed' });
  await hooks.onRobotStatusChange('Cleanbot', { running: false });
}

describe('completion delivery', () => {
  it('does not arm idle cleanup after a lookup failure before sources initialize', async () => {
    vi.mocked(channels.getChannelId).mockRejectedValue(new Error('database unavailable'));
    await hooks.onMieleStatusChange('washer', { name: 'Washer', timeRemaining: 0, inUse: false });
    expect(channels.getChannelId).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(channels.getChannelId).toHaveBeenCalledTimes(1);
    expect(apns.sendMultiDeviceBroadcast).not.toHaveBeenCalled();
  });

  it.each(['activity', 'apns'])('retries failed %s token reads rather than treating them as empty', async (store) => {
    vi.mocked(channels.getChannelId).mockResolvedValue(null);
    if (store === 'activity') {
      vi.mocked(tokens.getAllActivityTokens).mockRejectedValueOnce(new Error('database unavailable'));
    } else {
      vi.mocked(tokens.getAllApnsTokens).mockRejectedValueOnce(new Error('database unavailable'));
    }
    await initializeIdle();
    vi.mocked(tokens.getAllActivityTokens).mockResolvedValue([
      { activityToken: 'recovered', userSub: 'user' },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apns.sendMultiDeviceDirectUpdate).toHaveBeenCalledWith(
      [{ activityToken: 'recovered', userSub: 'user' }], { devices: [] }, 'end',
    );
    expect(tokens.getAllActivityTokens).toHaveBeenCalledWith({ strict: true });
    expect(tokens.getAllApnsTokens).toHaveBeenCalledWith({ strict: true });
  });

  it('does not reconcile idle startup while the robot source is unavailable', async () => {
    await hooks.onMieleStatusChange('washer', { name: 'Washer', timeRemaining: 0, inUse: false });
    await hooks.onMieleStatusChange('dryer', { name: 'Dryer', timeRemaining: 0, inUse: false });
    await hooks.onDishwasherStatusChange({ operationState: 'Inactive', doorState: 'Closed' });
    await hooks.onRobotStatusChange('Cleanbot', { running: false, stateKnown: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(apns.sendMultiDeviceBroadcast).not.toHaveBeenCalled();
    await hooks.onRobotStatusChange('Cleanbot', { running: false, stateKnown: true });
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [] }, 'end',
    );
  });

  it('preserves a running dishwasher during an unavailable operation-state reading', async () => {
    await initializeIdle();
    await hooks.onDishwasherStatusChange({ operationState: 'Run', doorState: 'Closed', programProgress: 80 });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    vi.setSystemTime(Date.now() + 120_000);
    await hooks.onDishwasherStatusChange({ operationState: 'Run', doorState: 'Closed', stateKnown: false });
    expect(subscriptions.getApnsTokensForDeviceType).not.toHaveBeenCalled();
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [expect.objectContaining({ name: 'Dishwasher', running: true })] }, 'update',
    );
  });

  it('cleans up surviving activities after restart when every source reports idle', async () => {
    await initializeIdle();
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [] }, 'end',
    );
    expect(apns.sendAlertToAll).not.toHaveBeenCalled();
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await hooks.onRobotStatusChange('Cleanbot', { running: false });
    expect(apns.sendMultiDeviceBroadcast).not.toHaveBeenCalled();
  });

  it.each(['Not Connected', 'unknown', 'unavailable'])('does not report completion during a sensor outage: %s', async (status) => {
    await initializeIdle();
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'Running', timeRemaining: 20, inUse: true,
    });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    vi.setSystemTime(Date.now() + 120_000);
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status, timeRemaining: undefined, inUse: false,
    });
    expect(subscriptions.getApnsTokensForDeviceType).not.toHaveBeenCalled();
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [expect.objectContaining({
        name: 'Washer', running: true, shortText: 'Offline', endsAt: undefined,
      })] }, 'update',
    );
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'End programmed', timeRemaining: 20, inUse: true,
    });
    expect(subscriptions.getApnsTokensForDeviceType).toHaveBeenCalledWith('washer');
  });

  it('retries failed idle cleanup with backoff and stops after successful delivery', async () => {
    vi.mocked(apns.sendMultiDeviceBroadcast).mockResolvedValue(false);
    await initializeIdle();
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledTimes(1);
    await hooks.onRobotStatusChange('Cleanbot', { running: false });
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledTimes(2);
    vi.mocked(apns.sendMultiDeviceBroadcast).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledTimes(3);
    expect(apns.sendAlertToAll).not.toHaveBeenCalled();
  });

  it('cancels idle cleanup retries when a new job starts', async () => {
    vi.mocked(apns.sendMultiDeviceBroadcast).mockResolvedValue(false);
    await initializeIdle();
    await hooks.onRobotStatusChange('Cleanbot', { running: true });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apns.sendMultiDeviceBroadcast).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'end',
    );
  });

  it('does not send Done or end the activity on pause or return-to-dock', async () => {
    await initializeIdle();
    await hooks.onRobotStatusChange('Cleanbot', { running: true });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await hooks.onRobotStatusChange('Cleanbot', { running: false, paused: true });
    await hooks.onRobotStatusChange('Cleanbot', { running: false, docking: true });
    expect(subscriptions.getApnsTokensForDeviceType).not.toHaveBeenCalled();
    expect(apns.sendMultiDeviceBroadcast).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'end',
    );
    await hooks.onRobotStatusChange('Cleanbot', { running: false, docking: false });
    expect(subscriptions.getApnsTokensForDeviceType).toHaveBeenCalledWith('cleanbot');
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [] }, 'end',
    );
  });

  it('ends the activity even when the completion alert fails', async () => {
    await initializeIdle();
    await hooks.onRobotStatusChange('Cleanbot', { running: true });
    vi.mocked(subscriptions.getApnsTokensForDeviceType).mockRejectedValueOnce(new Error('store unavailable'));
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await hooks.onRobotStatusChange('Cleanbot', { running: false });
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel', { devices: [] }, 'end',
    );
  });

  it('removes a finished washer immediately while the robot keeps running', async () => {
    await initializeIdle();
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'Running', timeRemaining: 1, inUse: true,
    });
    await hooks.onRobotStatusChange('Cleanbot', { running: true });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'End programmed', timeRemaining: 1, inUse: true,
    });
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel',
      { devices: [expect.objectContaining({ name: 'Cleanbot' })] },
      'update',
    );
  });

  it('removes a stopped robot immediately while the washer keeps running', async () => {
    await initializeIdle();
    await hooks.onRobotStatusChange('Cleanbot', { running: true });
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'Running', timeRemaining: 20, inUse: true,
    });
    vi.mocked(apns.sendMultiDeviceBroadcast).mockClear();
    await hooks.onRobotStatusChange('Cleanbot', { running: false });
    expect(apns.sendMultiDeviceBroadcast).toHaveBeenCalledWith(
      'consolidated-channel',
      { devices: [expect.objectContaining({ name: 'Washer' })] },
      'update',
    );
  });

  it('ends via direct tokens without a broadcast channel when the last device finishes', async () => {
    await initializeIdle();
    vi.mocked(channels.getChannelId).mockResolvedValue(null);
    vi.mocked(tokens.getAllActivityTokens).mockResolvedValue([
      { activityToken: 'activity-token' } as Awaited<ReturnType<typeof tokens.getAllActivityTokens>>[number],
    ]);
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'Running', timeRemaining: 1, inUse: true,
    });
    vi.mocked(apns.sendMultiDeviceDirectUpdate).mockClear();
    await hooks.onMieleStatusChange('washer', {
      name: 'Washer', status: 'Off', timeRemaining: 1, inUse: false,
    });
    expect(apns.sendMultiDeviceDirectUpdate).toHaveBeenCalledWith(
      [{ activityToken: 'activity-token' }], { devices: [] }, 'end',
    );
  });
});

describe('authoritative appliance status', () => {
  it.each([
    'Off', 'On', 'Idle', 'End programmed', 'program_ended',
    'Finished', 'Programmed', 'waiting_to_start', 'Delayed start',
  ])('does not keep a completed or unstarted Miele cycle active: %s', (status) => {
    const { device } = hooks.buildMieleContentState('Washer', 'washer', {
      name: 'Washer', status, timeRunning: 59, timeRemaining: 1, inUse: true,
    });
    expect(device.running).toBe(false);
    expect(device.endsAt).toBeUndefined();
    expect(device.startedAt).toBeUndefined();
  });

  it.each(['Pause', 'Rinse hold', 'Failure'])('keeps an actionable cycle visible: %s', (status) => {
    const { device } = hooks.buildMieleContentState('Washer', 'washer', {
      name: 'Washer', status, timeRemaining: 20, inUse: true,
    });
    expect(device.running).toBe(true);
    expect(device.endsAt).toBeUndefined();
  });

  it.each(['Finished', 'Inactive', 'Ready', 'DelayedStart'])('ignores retained dishwasher progress: %s', (operationState) => {
    const { device } = hooks.buildDishwasherContentState({
      operationState, doorState: 'Closed', programProgress: 100, remainingTime: 60,
    });
    expect(device.running).toBe(false);
  });
});

it.each([
  { paused: true, expected: 'Paused' },
  { docking: true, expected: 'Returning to dock' },
])('keeps interrupted robot cycles visible without a countdown: $expected', (status) => {
  const { device } = hooks.buildRobotContentState('Cleanbot', {
    ...status, running: false, estimatedRemainingMinutes: 10,
  });
  expect(device.running).toBe(true);
  expect(device.shortText).toBe(status.expected);
  expect(device.endsAt).toBeUndefined();
});

it('uses cleaning progress, not remaining battery, in robot pushes', () => {
  const { device } = hooks.buildRobotContentState('Cleanbot', {
    running: true, batteryLevel: 81, progressPercent: 32,
    estimatedRemainingMinutes: 14, currentRoom: 'Kitchen',
  });
  expect(device.progress).toBe(32);
  expect(device.battery).toBe(81);
  expect(device.shortText).toBe('32%');
  expect(device.trailingText).toBe('~14 min · Kitchen');
});
