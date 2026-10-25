import HomeAssistantDishwasher from '../homeassistant-dishwasher';
import HomeAssistantRobot from '../homeassistant-robot';
import { HomeAssistantClient } from '../homeassistant-client';

vi.mock('../logger', () => ({
  default: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['unknown', 'unavailable'])('preserves dishwasher lifecycle on %s, and publishes recovery', async (unavailable) => {
  let state = 'run';
  const client = { getState: vi.fn(async (id: string) => ({
    state: id === 'sensor.dishwasher_operation_state' ? state : 'unknown', attributes: {},
  })) } as unknown as HomeAssistantClient;
  const adapter = new HomeAssistantDishwasher({ client });
  const changed = vi.fn();
  adapter.onStatusChange = changed;
  await vi.advanceTimersByTimeAsync(0);
  expect(adapter.dishwasher.operationState).toBe('Run');
  expect(adapter.dishwasher.stateKnown).toBe(true);
  state = unavailable;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(adapter.dishwasher.operationState).toBe('Run');
  expect(adapter.dishwasher.stateKnown).toBe(false);
  changed.mockClear();
  state = 'run';
  await vi.advanceTimersByTimeAsync(10_000);
  expect(adapter.dishwasher.stateKnown).toBe(true);
  expect(changed).toHaveBeenCalled();
  adapter.stop();
});

it.each(['unknown', 'unavailable'])('preserves robot lifecycle on %s, and publishes recovery', async (unavailable) => {
  let state = 'cleaning';
  const client = { getState: vi.fn(async (id: string) => (id === '' ? [] : { state, attributes: {} })) } as unknown as HomeAssistantClient;
  const adapter = new HomeAssistantRobot({ name: 'Cleanbot', entityId: 'vacuum.test', client });
  await vi.advanceTimersByTimeAsync(0);
  expect(adapter.cachedStatus.running).toBe(true);
  expect(adapter.cachedStatus.stateKnown).toBe(true);
  state = unavailable;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(adapter.cachedStatus.running).toBe(true);
  expect(adapter.cachedStatus.stateKnown).toBe(false);
  state = 'docked';
  await vi.advanceTimersByTimeAsync(10_000);
  expect(adapter.cachedStatus.running).toBe(false);
  expect(adapter.cachedStatus.stateKnown).toBe(true);
  adapter.stop();
});
