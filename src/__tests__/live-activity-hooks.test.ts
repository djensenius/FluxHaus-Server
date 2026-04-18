import {
  onDishwasherStatusChange, onMieleStatusChange, onPushToStartTokenRegistered, onRobotStatusChange,
} from '../live-activity-hooks';
import * as apns from '../apns';
import * as apnsChannels from '../apns-channels';
import * as laSubs from '../la-subscriptions';
import * as pushTokenStore from '../push-token-store';

jest.mock('../apns');
jest.mock('../apns-channels');
jest.mock('../push-token-store');
jest.mock('../la-subscriptions');
jest.mock('../logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockGetChannelId = apnsChannels.getChannelId as jest.Mock;
const mockGetFilteredApnsTokens = laSubs.getApnsTokensForDeviceType as jest.Mock;
const mockMultiDeviceBroadcast = apns.sendMultiDeviceBroadcast as jest.Mock;
const mockDirectUpdate = apns.sendMultiDeviceDirectUpdate as jest.Mock;
const mockSendAlertToAll = apns.sendAlertToAll as jest.Mock;
const mockGetSubscribedTokens = laSubs.getSubscribedDeviceTokens as jest.Mock;
const mockMultiPushToStart = apns.multiDevicePushToStartAll as jest.Mock;
const mockSendSilentPush = apns.sendSilentPushToAll as jest.Mock;
const mockGetAllApnsTokens = pushTokenStore.getAllApnsTokens as jest.Mock;
const mockGetAllActivityTokens = pushTokenStore.getAllActivityTokens as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockGetChannelId.mockReset();
  mockGetFilteredApnsTokens.mockReset();
  mockMultiDeviceBroadcast.mockReset();
  mockDirectUpdate.mockReset();
  mockSendAlertToAll.mockReset();
  mockGetSubscribedTokens.mockReset();
  mockMultiPushToStart.mockReset();
  mockSendSilentPush.mockReset();
  mockGetAllApnsTokens.mockReset();
  mockGetAllActivityTokens.mockReset();
  mockGetFilteredApnsTokens.mockResolvedValue([]);
  mockMultiDeviceBroadcast.mockResolvedValue(true);
  mockDirectUpdate.mockResolvedValue(undefined);
  mockSendAlertToAll.mockResolvedValue(undefined);
  mockGetSubscribedTokens.mockResolvedValue([]);
  mockMultiPushToStart.mockResolvedValue(undefined);
  mockSendSilentPush.mockResolvedValue(undefined);
  mockGetAllApnsTokens.mockResolvedValue([]);
  mockGetAllActivityTokens.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('live-activity-hooks (consolidated)', () => {
  describe('onMieleStatusChange', () => {
    it('broadcasts consolidated update when washer is running', async () => {
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 30,
        timeRemaining: 60,
        programName: 'Cottons',
        status: 'In use',
        inUse: true,
      });
      expect(mockGetChannelId).toHaveBeenCalledWith('consolidated');
      expect(mockMultiDeviceBroadcast).toHaveBeenCalledTimes(1);
      const [channelId, contentState, event] = mockMultiDeviceBroadcast.mock.calls[0];
      expect(channelId).toBe('ch-consolidated');
      expect(event).toBe('update');
      expect(contentState.devices).toHaveLength(1);
      expect(contentState.devices[0].name).toBe('Washer');
      expect(contentState.devices[0].running).toBe(true);
    });

    it('sends end event when no devices running', async () => {
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });
      mockMultiDeviceBroadcast.mockClear();
      jest.setSystemTime(Date.now() + 120_000);
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      expect(mockMultiDeviceBroadcast).toHaveBeenCalledWith('ch-consolidated', { devices: [] }, 'end');
    });

    it('skips when no consolidated channel exists', async () => {
      mockGetChannelId.mockResolvedValue(null);
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });
      expect(mockMultiDeviceBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('onDishwasherStatusChange', () => {
    it('includes dishwasher in consolidated broadcast', async () => {
      jest.setSystemTime(Date.now() + 120_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      await onDishwasherStatusChange({
        operationState: 'Run',
        doorState: 'Closed',
        programProgress: 45,
        remainingTime: 1800,
        activeProgram: 'Auto2',
      });
      expect(mockMultiDeviceBroadcast).toHaveBeenCalled();
      const [, contentState] = mockMultiDeviceBroadcast.mock.calls[0];
      const dw = contentState.devices.find((d: { name: string }) => d.name === 'Dishwasher');
      expect(dw).toBeDefined();
      expect(dw.progress).toBe(45);
    });
  });

  describe('onRobotStatusChange', () => {
    it('includes robot in consolidated broadcast', async () => {
      jest.setSystemTime(Date.now() + 240_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      await onRobotStatusChange('Broombot', {
        running: true,
        batteryLevel: 75,
        timeStarted: new Date(),
      });
      expect(mockMultiDeviceBroadcast).toHaveBeenCalled();
      const lastCall = mockMultiDeviceBroadcast.mock.calls[
        mockMultiDeviceBroadcast.mock.calls.length - 1
      ];
      const contentState = lastCall[1];
      const bot = contentState.devices.find((d: { name: string }) => d.name === 'Broombot');
      expect(bot).toBeDefined();
      expect(bot.running).toBe(true);
    });
  });

  describe('completion alerts', () => {
    it('sends alert when device stops running', async () => {
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      mockGetFilteredApnsTokens.mockResolvedValue([{ userSub: 'user1', token: 'tok1' }]);
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });
      jest.setSystemTime(Date.now() + 120_000);
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      expect(mockGetFilteredApnsTokens).toHaveBeenCalledWith('washer');
      expect(mockSendAlertToAll).toHaveBeenCalledWith(
        [{ userSub: 'user1', token: 'tok1' }],
        'Washer Done',
        'Your washer has finished.',
        'appliance_done',
      );
    });
  });

  describe('broadcast serialization', () => {
    it('does not throw when overlapping broadcastConsolidated calls are serialized', async () => {
      // Advance well past any throttle from prior tests (module state persists)
      jest.setSystemTime(Date.now() + 300_000);
      mockMultiDeviceBroadcast.mockResolvedValue(true);
      mockGetChannelId.mockResolvedValue('ch');
      mockGetAllActivityTokens.mockResolvedValue([]);

      // Fire two status changes concurrently — they should be serialized, not crash
      const p1 = onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });
      const p2 = onMieleStatusChange('dryer', {
        name: 'Tumble dryer', timeRunning: 10, timeRemaining: 40, inUse: true,
      });

      // Both should resolve without errors
      await expect(Promise.all([p1, p2])).resolves.not.toThrow();

      // At least one broadcast should have been sent
      expect(mockMultiDeviceBroadcast).toHaveBeenCalled();
    });
  });

  describe('catch-up push-to-start cooldown', () => {
    it('sends catch-up push-to-start when devices are running', async () => {
      mockGetChannelId.mockResolvedValue('ch');
      mockGetSubscribedTokens.mockResolvedValue([{ pushToStartToken: 'tok-a' }]);
      mockGetAllApnsTokens.mockResolvedValue([]);

      // Initialize all device types by sending idle statuses, then start one
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      await onMieleStatusChange('dryer', {
        name: 'Tumble dryer', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      await onDishwasherStatusChange({ operationState: 'Inactive', doorState: 'Closed' });
      await onRobotStatusChange('broombot', { running: false });
      await onRobotStatusChange('mopbot', { running: false });
      // Now start washer
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });

      // Advance past cooldown
      jest.setSystemTime(Date.now() + 60_000);
      mockMultiPushToStart.mockClear();

      await onPushToStartTokenRegistered('new-token');

      expect(mockMultiPushToStart).toHaveBeenCalledTimes(1);
      expect(mockMultiPushToStart).toHaveBeenCalledWith(
        [{ pushToStartToken: 'new-token' }],
        expect.objectContaining({ devices: expect.any(Array) }),
        expect.anything(),
      );
    });

    it('skips catch-up for same token within cooldown window', async () => {
      mockGetChannelId.mockResolvedValue('ch');
      mockGetSubscribedTokens.mockResolvedValue([{ pushToStartToken: 'tok-a' }]);
      mockGetAllApnsTokens.mockResolvedValue([]);

      // Initialize all types
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      await onMieleStatusChange('dryer', {
        name: 'Tumble dryer', timeRunning: 0, timeRemaining: 0, inUse: false,
      });
      await onDishwasherStatusChange({ operationState: 'Inactive', doorState: 'Closed' });
      await onRobotStatusChange('broombot', { running: false });
      await onRobotStatusChange('mopbot', { running: false });
      await onMieleStatusChange('washer', {
        name: 'Washing machine', timeRunning: 30, timeRemaining: 60, inUse: true,
      });

      // Advance past cooldown, send first catch-up
      jest.setSystemTime(Date.now() + 60_000);
      await onPushToStartTokenRegistered('same-token');
      mockMultiPushToStart.mockClear();

      // Same token immediately again — should be skipped
      await onPushToStartTokenRegistered('same-token');
      expect(mockMultiPushToStart).not.toHaveBeenCalled();

      // Different token — should work
      await onPushToStartTokenRegistered('different-token');
      expect(mockMultiPushToStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('delayed start - dishwasher', () => {
    it('treats DelayedStart as not running', async () => {
      jest.setSystemTime(Date.now() + 500_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      mockMultiDeviceBroadcast.mockClear();

      await onDishwasherStatusChange({
        operationState: 'DelayedStart',
        doorState: 'Closed',
        programProgress: 0,
        remainingTime: 3600,
        activeProgram: 'Eco50',
      });

      const { calls } = mockMultiDeviceBroadcast.mock;
      if (calls.length > 0) {
        const lastContent = calls[calls.length - 1][1];
        const dw = lastContent.devices?.find((d: { name: string }) => d.name === 'Dishwasher');
        expect(dw).toBeUndefined();
      }
    });

    it('treats DelayedStart with programProgress > 0 as not running', async () => {
      jest.setSystemTime(Date.now() + 500_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      mockMultiDeviceBroadcast.mockClear();

      await onDishwasherStatusChange({
        operationState: 'DelayedStart',
        doorState: 'Closed',
        programProgress: 5,
        remainingTime: 3600,
        activeProgram: 'Eco50',
      });

      const { calls } = mockMultiDeviceBroadcast.mock;
      if (calls.length > 0) {
        const lastContent = calls[calls.length - 1][1];
        const dw = lastContent.devices?.find((d: { name: string }) => d.name === 'Dishwasher');
        expect(dw).toBeUndefined();
      }
    });
  });

  describe('delayed start - Miele', () => {
    it('treats Programmed status as not running', async () => {
      jest.setSystemTime(Date.now() + 600_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      mockMultiDeviceBroadcast.mockClear();

      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 0,
        timeRemaining: 120,
        status: 'Programmed',
        inUse: true,
      });

      const { calls } = mockMultiDeviceBroadcast.mock;
      if (calls.length > 0) {
        const lastContent = calls[calls.length - 1][1];
        const washer = lastContent.devices?.find((d: { name: string }) => d.name === 'Washer');
        expect(washer).toBeUndefined();
      }
    });

    it('treats Waiting to start status as not running', async () => {
      jest.setSystemTime(Date.now() + 600_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');
      mockMultiDeviceBroadcast.mockClear();

      await onMieleStatusChange('dryer', {
        name: 'Tumble dryer',
        timeRunning: 0,
        timeRemaining: 90,
        status: 'Waiting to start',
        inUse: true,
      });

      const { calls } = mockMultiDeviceBroadcast.mock;
      if (calls.length > 0) {
        const lastContent = calls[calls.length - 1][1];
        const dryer = lastContent.devices?.find((d: { name: string }) => d.name === 'Dryer');
        expect(dryer).toBeUndefined();
      }
    });

    it('starts Live Activity when delayed start transitions to running', async () => {
      jest.setSystemTime(Date.now() + 700_000);
      mockGetChannelId.mockResolvedValue('ch-consolidated');

      // First: programmed (not running)
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 0,
        timeRemaining: 120,
        status: 'Programmed',
        inUse: true,
      });

      jest.setSystemTime(Date.now() + 800_000);
      mockMultiDeviceBroadcast.mockClear();

      // Then: transitions to running
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 5,
        timeRemaining: 115,
        status: 'Running',
        inUse: true,
      });

      expect(mockMultiDeviceBroadcast).toHaveBeenCalled();
      const lastCall = mockMultiDeviceBroadcast.mock.calls[
        mockMultiDeviceBroadcast.mock.calls.length - 1
      ];
      const washer = lastCall[1].devices?.find((d: { name: string }) => d.name === 'Washer');
      expect(washer).toBeDefined();
      expect(washer.running).toBe(true);
    });
  });
});
