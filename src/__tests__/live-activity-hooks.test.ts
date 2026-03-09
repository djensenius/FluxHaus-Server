import { onDishwasherStatusChange, onMieleStatusChange, onRobotStatusChange } from '../live-activity-hooks';
import * as apns from '../apns';
import * as pushStore from '../push-token-store';

jest.mock('../apns');
jest.mock('../push-token-store');
jest.mock('../logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const mockGetTokens = pushStore.getPushTokensByActivityType as jest.Mock;
const mockGetDeviceTokens = pushStore.getAllDeviceTokens as jest.Mock;
const mockPushAll = apns.pushLiveActivityToAll as jest.Mock;
const mockPushToStartAll = apns.pushToStartAll as jest.Mock;

beforeEach(() => {
  mockGetTokens.mockReset();
  mockGetDeviceTokens.mockReset();
  mockPushAll.mockReset();
  mockPushToStartAll.mockReset();
  mockPushAll.mockResolvedValue(undefined);
  mockPushToStartAll.mockResolvedValue(undefined);
  mockGetDeviceTokens.mockResolvedValue([]);
});

describe('live-activity-hooks', () => {
  describe('onMieleStatusChange', () => {
    it('pushes update when washer is running', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 30,
        timeRemaining: 60,
        programName: 'Cottons',
        status: 'In use',
        inUse: true,
      });
      expect(mockGetTokens).toHaveBeenCalledWith('washer');
      expect(mockPushAll).toHaveBeenCalledTimes(1);
      const [tokens, contentState, event] = mockPushAll.mock.calls[0];
      expect(tokens).toEqual([{ pushToken: 'tok1' }]);
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Washer');
      expect(contentState.device.running).toBe(true);
    });

    it('sends end event when dryer finishes', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onMieleStatusChange('dryer', {
        name: 'Tumble dryer',
        timeRunning: 0,
        timeRemaining: 0,
        programName: '',
        status: 'Off',
        inUse: false,
      });
      expect(mockPushAll.mock.calls[0][2]).toBe('end');
    });

    it('skips when no tokens registered', async () => {
      mockGetTokens.mockResolvedValue([]);
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 30,
        timeRemaining: 60,
        inUse: true,
      });
      expect(mockPushAll).not.toHaveBeenCalled();
    });
  });

  describe('onDishwasherStatusChange', () => {
    it('pushes update when dishwasher is running', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onDishwasherStatusChange({
        operationState: 'Run',
        doorState: 'Closed',
        programProgress: 45,
        remainingTime: 1800,
        activeProgram: 'Auto2',
      });
      expect(mockGetTokens).toHaveBeenCalledWith('dishwasher');
      const [, contentState, event] = mockPushAll.mock.calls[0];
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Dishwasher');
      expect(contentState.device.progress).toBe(45);
    });

    it('sends end event when dishwasher finishes', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onDishwasherStatusChange({
        operationState: 'Finished',
        doorState: 'Closed',
        programProgress: 0,
      });
      expect(mockPushAll.mock.calls[0][2]).toBe('end');
    });
  });

  describe('onRobotStatusChange', () => {
    it('pushes update when robot is cleaning', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onRobotStatusChange('Broombot', {
        running: true,
        batteryLevel: 75,
        timeStarted: new Date(),
      });
      expect(mockGetTokens).toHaveBeenCalledWith('broombot');
      const [, contentState, event] = mockPushAll.mock.calls[0];
      expect(event).toBe('update');
      expect(contentState.device.name).toBe('Broombot');
      expect(contentState.device.running).toBe(true);
      expect(contentState.device.progress).toBe(75);
    });

    it('sends end event when robot stops', async () => {
      mockGetTokens.mockResolvedValue([{ pushToken: 'tok1' }]);
      await onRobotStatusChange('Mopbot', {
        running: false,
        batteryLevel: 90,
      });
      expect(mockPushAll.mock.calls[0][2]).toBe('end');
    });
  });

  describe('push-to-start', () => {
    it('sends push-to-start when device starts and no activity tokens exist', async () => {
      // First call: device is not running (establishes baseline)
      mockGetTokens.mockResolvedValue([]);
      mockGetDeviceTokens.mockResolvedValue([]);
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 0,
        timeRemaining: 0,
        inUse: false,
      });

      // Second call: device starts running, no activity tokens, has device tokens
      mockGetTokens.mockResolvedValue([]);
      mockGetDeviceTokens.mockResolvedValue([{ pushToStartToken: 'device-tok' }]);
      await onMieleStatusChange('washer', {
        name: 'Washing machine',
        timeRunning: 1,
        timeRemaining: 60,
        programName: 'Cottons',
        status: 'In use',
        inUse: true,
      });
      expect(mockPushToStartAll).toHaveBeenCalledWith(
        [{ pushToStartToken: 'device-tok' }],
        expect.objectContaining({ device: expect.objectContaining({ name: 'Washer' }) }),
      );
    });

    it('skips push-to-start when activity tokens already exist', async () => {
      // Establish not-running state
      mockGetTokens.mockResolvedValue([]);
      mockGetDeviceTokens.mockResolvedValue([]);
      await onDishwasherStatusChange({
        operationState: 'Inactive',
        doorState: 'Closed',
        programProgress: 0,
      });

      // Now starts running WITH activity tokens already registered
      mockGetTokens.mockResolvedValue([{ pushToken: 'existing-tok' }]);
      mockGetDeviceTokens.mockResolvedValue([{ pushToStartToken: 'device-tok' }]);
      await onDishwasherStatusChange({
        operationState: 'Run',
        doorState: 'Closed',
        programProgress: 10,
        remainingTime: 3600,
        activeProgram: 'Auto2',
      });
      expect(mockPushToStartAll).not.toHaveBeenCalled();
    });

    it('skips push-to-start when no device tokens exist', async () => {
      // Establish not-running state
      mockGetTokens.mockResolvedValue([]);
      mockGetDeviceTokens.mockResolvedValue([]);
      await onRobotStatusChange('Broombot', { running: false, batteryLevel: 100 });

      // Now starts running, but no device tokens
      mockGetTokens.mockResolvedValue([]);
      mockGetDeviceTokens.mockResolvedValue([]);
      await onRobotStatusChange('Broombot', { running: true, batteryLevel: 95 });
      expect(mockPushToStartAll).not.toHaveBeenCalled();
    });
  });
});
