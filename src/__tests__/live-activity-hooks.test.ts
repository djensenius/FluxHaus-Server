import { onDishwasherStatusChange, onMieleStatusChange, onRobotStatusChange } from '../live-activity-hooks';
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
const mockSendAlertToAll = apns.sendAlertToAll as jest.Mock;
const mockGetSubscribedTokens = laSubs.getSubscribedDeviceTokens as jest.Mock;
const mockMultiPushToStart = apns.multiDevicePushToStartAll as jest.Mock;
const mockSendSilentPush = apns.sendSilentPushToAll as jest.Mock;
const mockGetAllApnsTokens = pushTokenStore.getAllApnsTokens as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  mockGetChannelId.mockReset();
  mockGetFilteredApnsTokens.mockReset();
  mockMultiDeviceBroadcast.mockReset();
  mockSendAlertToAll.mockReset();
  mockGetSubscribedTokens.mockReset();
  mockMultiPushToStart.mockReset();
  mockSendSilentPush.mockReset();
  mockGetAllApnsTokens.mockReset();
  mockGetFilteredApnsTokens.mockResolvedValue([]);
  mockMultiDeviceBroadcast.mockResolvedValue(true);
  mockSendAlertToAll.mockResolvedValue(undefined);
  mockGetSubscribedTokens.mockResolvedValue([]);
  mockMultiPushToStart.mockResolvedValue(undefined);
  mockSendSilentPush.mockResolvedValue(undefined);
  mockGetAllApnsTokens.mockResolvedValue([]);
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
      expect(contentState.devices.length).toBe(1);
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
});
