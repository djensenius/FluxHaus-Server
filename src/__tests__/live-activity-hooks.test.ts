import { onDishwasherStatusChange, onMieleStatusChange, onRobotStatusChange } from '../live-activity-hooks';
import * as apns from '../apns';
import * as apnsChannels from '../apns-channels';
import * as pushStore from '../push-token-store';
import * as laSubs from '../la-subscriptions';

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
const mockBroadcast = apns.sendBroadcastUpdate as jest.Mock;
const mockPushToStartAll = apns.pushToStartAll as jest.Mock;
const mockGetDeviceTokens = pushStore.getAllDeviceTokens as jest.Mock;
const mockGetApnsTokens = pushStore.getAllApnsTokens as jest.Mock;
const mockMultiDeviceBroadcast = apns.sendMultiDeviceBroadcast as jest.Mock;
const mockSendAlertToAll = apns.sendAlertToAll as jest.Mock;
const mockGetSubscribedTokens = laSubs.getSubscribedDeviceTokens as jest.Mock;

beforeEach(() => {
  mockGetChannelId.mockReset();
  mockBroadcast.mockReset();
  mockPushToStartAll.mockReset();
  mockGetDeviceTokens.mockReset();
  mockGetApnsTokens.mockReset();
  mockMultiDeviceBroadcast.mockReset();
  mockSendAlertToAll.mockReset();
  mockGetSubscribedTokens.mockReset();
  mockBroadcast.mockResolvedValue(true);
  mockPushToStartAll.mockResolvedValue(undefined);
  mockGetDeviceTokens.mockResolvedValue([]);
  mockGetApnsTokens.mockResolvedValue([]);
  mockMultiDeviceBroadcast.mockResolvedValue(true);
  mockSendAlertToAll.mockResolvedValue(undefined);
  mockGetSubscribedTokens.mockResolvedValue([]);
});

describe('live-activity-hooks (broadcast)', () => {
  describe('onMieleStatusChange', () => {
    it('broadcasts update when washer is running', async () => {
      mockGetChannelId.mockResolvedValue('ch-washer');
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 30,
        timeRemaining: 60,
        programName: 'Cottons',
        status: 'In use',
        inUse: true,
      });
      expect(mockGetChannelId).toHaveBeenCalledWith('washer');
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      const [channelId, contentState, event] = mockBroadcast.mock.calls[0];
      expect(channelId).toBe('ch-washer');
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Washer');
      expect(contentState.device.running).toBe(true);
    });

    it('sends end event when dryer finishes', async () => {
      mockGetChannelId.mockResolvedValue('ch-dryer');
      await onMieleStatusChange('dryer', {
        name: 'Tumble dryer',
        timeRunning: 0,
        timeRemaining: 0,
        programName: '',
        status: 'Off',
        inUse: false,
      });
      expect(mockBroadcast.mock.calls[0][2]).toBe('end');
    });

    it('skips when no channel exists', async () => {
      mockGetChannelId.mockResolvedValue(null);
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 30,
        timeRemaining: 60,
        inUse: true,
      });
      expect(mockBroadcast).not.toHaveBeenCalled();
    });
  });

  describe('onDishwasherStatusChange', () => {
    it('broadcasts update when dishwasher is running', async () => {
      mockGetChannelId.mockResolvedValue('ch-dishwasher');
      await onDishwasherStatusChange({
        operationState: 'Run',
        doorState: 'Closed',
        programProgress: 45,
        remainingTime: 1800,
        activeProgram: 'Auto2',
      });
      expect(mockGetChannelId).toHaveBeenCalledWith('dishwasher');
      const [, contentState, event] = mockBroadcast.mock.calls[0];
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Dishwasher');
      expect(contentState.device.progress).toBe(45);
    });

    it('sends end event when dishwasher finishes', async () => {
      mockGetChannelId.mockResolvedValue('ch-dishwasher');
      await onDishwasherStatusChange({
        operationState: 'Finished',
        doorState: 'Closed',
        programProgress: 0,
      });
      expect(mockBroadcast.mock.calls[0][2]).toBe('end');
    });
  });

  describe('onRobotStatusChange', () => {
    it('broadcasts update when robot is cleaning', async () => {
      mockGetChannelId.mockResolvedValue('ch-broombot');
      await onRobotStatusChange('Broombot', {
        running: true,
        batteryLevel: 75,
        timeStarted: new Date(),
      });
      expect(mockGetChannelId).toHaveBeenCalledWith('broombot');
      const [, contentState, event] = mockBroadcast.mock.calls[0];
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Broombot');
      expect(contentState.device.running).toBe(true);
      expect(contentState.device.progress).toBe(75);
    });

    it('sends end event when robot stops', async () => {
      mockGetChannelId.mockResolvedValue('ch-mopbot');
      await onRobotStatusChange('Mopbot', {
        running: false,
        batteryLevel: 90,
      });
      expect(mockBroadcast.mock.calls[0][2]).toBe('end');
    });
  });
});
