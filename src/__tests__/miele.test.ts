import fs from 'fs';
import { fetchEventData } from 'fetch-sse';
import Miele from '../miele';
import { writeError } from '../errors';
import * as tokenStore from '../token-store';

jest.mock('fs');
jest.mock('fetch-sse');
jest.mock('../errors');
jest.mock('../token-store');

// Mock global fetch
global.fetch = jest.fn();

describe('Miele', () => {
  let miele: Miele;
  const mockClientId = 'test-client-id';
  const mockClientSecret = 'test-client-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    miele = new Miele(mockClientId, mockClientSecret);
  });

  it('should initialize correctly', () => {
    expect(miele.washer).toEqual({ name: 'Washer', inUse: false });
    expect(miele.dryer).toEqual({ name: 'Dryer', inUse: false });
  });

  it('should log authorization URL', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    await miele.authorize();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('https://api.mcs3.miele.com/thirdparty/login'));
    consoleSpy.mockRestore();
  });

  it('should get token', async () => {
    const mockResponse = {
      access_token: 'new-token',
      refresh_token: 'new-refresh-token',
      expires_in: 3600,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockResponse),
    });
    (tokenStore.saveToken as jest.Mock).mockResolvedValue(undefined);

    await miele.getToken('auth-code');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.mcs3.miele.com/thirdparty/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('code=auth-code'),
      }),
    );
    expect(tokenStore.saveToken).toHaveBeenCalledWith(
      'miele',
      expect.objectContaining({ access_token: 'new-token' }),
    );
  });

  it('should refresh token', async () => {
    (tokenStore.getToken as jest.Mock).mockResolvedValue({
      refresh_token: 'old-refresh-token',
      timestamp: new Date(),
      access_token: 'old-token',
    });

    const mockResponse = {
      access_token: 'refreshed-token',
      expires_in: 3600,
    };
    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockResponse),
    });
    (tokenStore.saveToken as jest.Mock).mockResolvedValue(undefined);

    await miele.refreshToken();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.mcs3.miele.com/thirdparty/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('grant_type=refresh_token'),
      }),
    );
    expect(tokenStore.saveToken).toHaveBeenCalledWith(
      'miele',
      expect.objectContaining({ access_token: 'refreshed-token' }),
    );
  });

  it('should warn if refreshing token without auth', async () => {
    (tokenStore.getToken as jest.Mock).mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    await miele.refreshToken();

    expect(consoleSpy).toHaveBeenCalledWith('You need to authorize your Miele account first');
    expect(writeError).toHaveBeenCalledWith('Miele', 'Miele needs authorized');
    consoleSpy.mockRestore();
  });

  it('should parse message correctly', () => {
    const mockData = {
      'device-1': {
        ident: { type: { value_localized: 'Washing machine' } },
        state: {
          elapsedTime: [1, 30],
          remainingTime: [0, 45],
          programPhase: { value_localized: 'Wash' },
          ProgramID: { value_localized: 'Cottons' },
          status: { value_localized: 'Running' },
        },
      },
      'device-2': {
        ident: { type: { value_localized: 'Tumble dryer' } },
        state: {
          elapsedTime: [0, 0],
          remainingTime: [0, 0],
          programPhase: { value_localized: '' },
          ProgramID: { value_localized: '' },
          status: { value_localized: 'Off' },
        },
      },
    };

    // @ts-expect-error - Testing private method
    miele.parseMessage(mockData);

    expect(miele.washer.status).toBe('Running');
    expect(miele.washer.inUse).toBe(true);
    expect(miele.dryer.status).toBe('Off');
    expect(miele.dryer.inUse).toBe(false);
  });

  it('should get active programs', async () => {
    (tokenStore.getToken as jest.Mock).mockResolvedValue({
      access_token: 'valid-token',
      timestamp: new Date(),
      expires_in: 3600,
    });

    const mockDevices = {
      'device-1': {
        ident: { type: { value_localized: 'Washing machine' } },
        state: {
          elapsedTime: [0, 0],
          remainingTime: [0, 0],
          programPhase: { value_localized: '' },
          ProgramID: { value_localized: '' },
          status: { value_localized: 'Off' },
        },
      },
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockDevices),
    });

    await miele.getActivePrograms();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.mcs3.miele.com/v1/devices',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
      }),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'cache/miele.json',
      expect.any(String),
    );
  });

  it('should refresh token if expired when getting active programs', async () => {
    (tokenStore.getToken as jest.Mock)
      .mockResolvedValueOnce({
        access_token: 'expired-token',
        timestamp: new Date(Date.now() - 7200000), // 2 hours ago
        expires_in: 3600,
        refresh_token: 'refresh-token',
      })
      .mockResolvedValueOnce({
        refresh_token: 'refresh-token',
        timestamp: new Date(),
        access_token: 'old-token',
      })
      .mockResolvedValue({
        access_token: 'new-token',
        timestamp: new Date(),
        expires_in: 3600,
      });

    // Mock fetch for refresh token and then get devices
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({ access_token: 'new-token' }),
      })
      .mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue({}),
      });
    (tokenStore.saveToken as jest.Mock).mockResolvedValue(undefined);

    await miele.getActivePrograms();

    // Should have called refresh endpoint
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.mcs3.miele.com/thirdparty/token',
      expect.anything(),
    );
  });

  it('should listen events', async () => {
    (tokenStore.getToken as jest.Mock).mockResolvedValue({
      access_token: 'valid-token',
      timestamp: new Date(),
      expires_in: 3600,
    });

    await miele.listenEvents();

    expect(fetchEventData).toHaveBeenCalledWith(
      'https://api.mcs3.miele.com/v1/devices/all/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer valid-token' }),
      }),
    );
  });
});
