import fs from 'fs';
import { fetchEventData } from 'fetch-sse';
import HomeConnect from '../homeconnect';
import { writeError } from '../errors';
import logger from '../logger';

jest.mock('fs');
jest.mock('fetch-sse');
jest.mock('../errors');
jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    child: jest.fn(),
  },
}));

// Mock global fetch
global.fetch = jest.fn();

describe('HomeConnect', () => {
  let homeConnect: HomeConnect;
  let mockHCLogger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock };
  const mockClientId = 'test-client-id';
  const mockClientSecret = 'test-client-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockHCLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    (logger.child as jest.Mock).mockReturnValue(mockHCLogger);
    homeConnect = new HomeConnect(mockClientId, mockClientSecret);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should initialize correctly', () => {
    expect(homeConnect.dishwasher).toEqual({
      operationState: 'Inactive',
      doorState: 'Closed',
    });
  });

  it('should log authorization URL', async () => {
    const mockResponse = {
      verification_uri_complete: 'http://auth.url',
      user_code: '1234',
      device_code: 'device-code',
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockResponse),
    });

    await homeConnect.authorize();

    expect(mockHCLogger.warn).toHaveBeenCalledWith(expect.stringContaining('http://auth.url'));
    expect(mockHCLogger.warn).toHaveBeenCalledWith(expect.stringContaining('1234'));
  });

  it('should get token', async () => {
    const mockResponse = {
      access_token: 'new-token',
      expires_in: 3600,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockResponse),
    });

    // Start getToken
    homeConnect.getToken();

    // Fast-forward time to trigger interval
    // We need to await the interval callback execution
    // Since getToken uses setInterval, we need to advance time and wait for promises

    // Advance time
    jest.advanceTimersByTime(10000);

    // Wait for any pending promises to resolve
    await Promise.resolve();
    await Promise.resolve();

    // We can't easily await the promise returned by getToken because it never resolves
    // until the interval clears, but the interval clears inside the async callback.
    // So we just check if the side effects happened.

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/security/oauth/token'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('grant_type=device_code'),
      }),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/homeconnect-token.json',
      expect.stringContaining('new-token'),
    );
  });

  it('should refresh token', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      refresh_token: 'old-refresh-token',
    }));

    const mockResponse = {
      access_token: 'refreshed-token',
      id_token: 'new-id-token',
      expires_in: 3600,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockResponse),
    });

    await homeConnect.refreshToken();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/security/oauth/token'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('grant_type=refresh_token'),
      }),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/homeconnect-token.json',
      expect.stringContaining('refreshed-token'),
    );
  });

  it('should warn if refreshing token without auth', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    await homeConnect.refreshToken();

    expect(mockHCLogger.warn).toHaveBeenCalledWith('You need to authorize your HomeConnect account first');
    expect(writeError).toHaveBeenCalledWith('HomeConnect', 'HomeConnect needs authorized');
  });

  it('should get status', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      id_token: 'valid-token',
      timestamp: new Date().toISOString(),
      expires_in: 3600,
    }));

    const mockStatus = {
      data: {
        status: [
          { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Run' },
          { key: 'BSH.Common.Status.DoorState', value: 'BSH.Common.EnumType.DoorState.Open' },
        ],
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockStatus),
    });

    await homeConnect.getStatus();

    expect(homeConnect.dishwasher.operationState).toBe('Run');
    expect(homeConnect.dishwasher.doorState).toBe('Open');
  });

  it('should parse message correctly', () => {
    const mockMsg = {
      event: 'STATUS',
      data: JSON.stringify({
        items: [
          { key: 'BSH.Common.Status.OperationState', value: 'BSH.Common.EnumType.OperationState.Run' },
        ],
      }),
    };

    // @ts-expect-error - Testing private method
    homeConnect.parseMessage(mockMsg);

    expect(homeConnect.dishwasher.operationState).toBe('Run');
  });

  it('should handle ProgramFinished event', () => {
    const mockMsg = {
      event: 'EVENT',
      data: JSON.stringify({
        items: [
          { key: 'BSH.Common.Event.ProgramFinished' },
        ],
      }),
    };

    // @ts-expect-error - Testing private method
    homeConnect.parseMessage(mockMsg);

    expect(homeConnect.dishwasher.operationState).toBe('Inactive');
    expect(homeConnect.dishwasher.doorState).toBe('Closed');
  });

  it('should get active program', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      id_token: 'valid-token',
      timestamp: new Date().toISOString(),
      expires_in: 3600,
    }));

    const mockProgram = {
      data: { key: 'Dishcare.Dishwasher.Program.Eco50' },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockProgram),
    });

    await homeConnect.getActiveProgram();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/programs/active'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
      }),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/homeconnect.json',
      expect.any(String),
    );
  });

  it('should listen events', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      id_token: 'valid-token',
      timestamp: new Date().toISOString(),
      expires_in: 3600,
    }));

    // Mock getStatus to avoid failure
    const mockStatus = { data: { status: [] } };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockStatus),
    });

    await homeConnect.listenEvents();

    expect(fetchEventData).toHaveBeenCalledWith(
      expect.stringContaining('/api/homeappliances/events'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
      }),
    );
  });
});
