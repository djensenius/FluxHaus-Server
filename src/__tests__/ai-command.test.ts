import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { executeAICommand, executeTool } from '../ai-command';
import { FluxHausServices } from '../services';

// Mock AI SDKs
jest.mock('@anthropic-ai/sdk');
jest.mock('openai');
jest.mock('../homeassistant-client');
jest.mock('../homeassistant-robot');
jest.mock('../car');

describe('executeTool', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockServices: FluxHausServices;
  let mockCar: any;
  let mockBroombot: any;
  let mockMopbot: any;
  let mockHaClient: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.useFakeTimers();

    mockCar = {
      lock: jest.fn().mockResolvedValue('Locked'),
      unlock: jest.fn().mockResolvedValue('Unlocked'),
      start: jest.fn().mockResolvedValue('Started'),
      stop: jest.fn().mockResolvedValue('Stopped'),
      resync: jest.fn().mockResolvedValue(undefined),
      status: {},
      odometer: 0,
    };
    mockBroombot = {
      turnOn: jest.fn().mockResolvedValue(undefined),
      turnOff: jest.fn().mockResolvedValue(undefined),
      cachedStatus: {},
    };
    mockMopbot = {
      turnOn: jest.fn().mockResolvedValue(undefined),
      turnOff: jest.fn().mockResolvedValue(undefined),
      cachedStatus: {},
    };
    mockHaClient = {
      callService: jest.fn().mockResolvedValue({}),
      getState: jest.fn().mockResolvedValue([
        { entity_id: 'scene.relax', attributes: { friendly_name: 'Relax' } },
        { entity_id: 'light.ceiling', attributes: {} },
      ]),
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockServices = {
      homeAssistantClient: mockHaClient,
      broombot: mockBroombot,
      mopbot: mockMopbot,
      car: mockCar,
      mieleClient: {} as any,
      hc: {} as any,
      cameraURL: '',
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lock_car calls car.lock()', async () => {
    const result = await executeTool('lock_car', {}, mockServices);
    expect(mockCar.lock).toHaveBeenCalled();
    expect(result).toBe('Locked');
  });

  it('unlock_car calls car.unlock()', async () => {
    const result = await executeTool('unlock_car', {}, mockServices);
    expect(mockCar.unlock).toHaveBeenCalled();
    expect(result).toBe('Unlocked');
  });

  it('start_car calls car.start() with no args', async () => {
    const result = await executeTool('start_car', {}, mockServices);
    expect(mockCar.start).toHaveBeenCalledWith({});
    expect(result).toBe('Started');
  });

  it('start_car passes temperature and defrost', async () => {
    await executeTool('start_car', { temperature: 22, defrost: true }, mockServices);
    expect(mockCar.start).toHaveBeenCalledWith({ temperature: 22, defrost: true });
  });

  it('start_car passes seat climate settings', async () => {
    await executeTool('start_car', { seatFL: 2, seatFR: 1 }, mockServices);
    expect(mockCar.start).toHaveBeenCalledWith({
      seatClimateSettings: {
        driverSeat: 2,
        passengerSeat: 1,
        rearLeftSeat: 0,
        rearRightSeat: 0,
      },
    });
  });

  it('stop_car calls car.stop()', async () => {
    const result = await executeTool('stop_car', {}, mockServices);
    expect(mockCar.stop).toHaveBeenCalled();
    expect(result).toBe('Stopped');
  });

  it('resync_car calls car.resync()', async () => {
    const result = await executeTool('resync_car', {}, mockServices);
    expect(mockCar.resync).toHaveBeenCalled();
    expect(result).toBe('Car resync initiated');
  });

  it('start_robot starts broombot', async () => {
    const result = await executeTool('start_robot', { robot: 'broombot' }, mockServices);
    expect(mockBroombot.turnOn).toHaveBeenCalled();
    expect(result).toBe('broombot started');
  });

  it('start_robot starts mopbot', async () => {
    const result = await executeTool('start_robot', { robot: 'mopbot' }, mockServices);
    expect(mockMopbot.turnOn).toHaveBeenCalled();
    expect(result).toBe('mopbot started');
  });

  it('stop_robot stops broombot', async () => {
    const result = await executeTool('stop_robot', { robot: 'broombot' }, mockServices);
    expect(mockBroombot.turnOff).toHaveBeenCalled();
    expect(result).toBe('broombot returning to base');
  });

  it('stop_robot stops mopbot', async () => {
    const result = await executeTool('stop_robot', { robot: 'mopbot' }, mockServices);
    expect(mockMopbot.turnOff).toHaveBeenCalled();
    expect(result).toBe('mopbot returning to base');
  });

  it('list_entities returns filtered entities', async () => {
    const result = await executeTool('list_entities', { domain: 'scene' }, mockServices);
    const parsed = JSON.parse(result);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].entity_id).toBe('scene.relax');
  });

  it('get_entity_state returns entity state', async () => {
    mockHaClient.getState.mockResolvedValue({
      entity_id: 'light.bedroom',
      state: 'on',
      attributes: { friendly_name: 'Bedroom Light', brightness: 255 },
    });
    const result = await executeTool('get_entity_state', { entity_id: 'light.bedroom' }, mockServices);
    const parsed = JSON.parse(result);
    expect(parsed.entity_id).toBe('light.bedroom');
    expect(parsed.state).toBe('on');
  });

  it('call_ha_service calls HA callService', async () => {
    const result = await executeTool(
      'call_ha_service',
      { domain: 'light', service: 'turn_on', entity_id: 'light.bedroom' },
      mockServices,
    );
    expect(mockHaClient.callService).toHaveBeenCalledWith('light', 'turn_on', { entity_id: 'light.bedroom' });
    expect(result).toBe('Called light.turn_on on light.bedroom');
  });

  it('unknown tool returns error message', async () => {
    const result = await executeTool('nonexistent', {}, mockServices);
    expect(result).toContain('Unknown tool');
  });
});

describe('executeAICommand', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockServices: FluxHausServices;
  let mockCar: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockCar = {
      lock: jest.fn().mockResolvedValue('Locked'),
      unlock: jest.fn().mockResolvedValue('Unlocked'),
      start: jest.fn().mockResolvedValue('Started'),
      stop: jest.fn().mockResolvedValue('Stopped'),
      resync: jest.fn().mockResolvedValue(undefined),
      status: {},
      odometer: 0,
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockServices = {
      homeAssistantClient: {
        callService: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue([]),
      } as any,
      broombot: { turnOn: jest.fn(), turnOff: jest.fn(), cachedStatus: {} } as any,
      mopbot: { turnOn: jest.fn(), turnOff: jest.fn(), cachedStatus: {} } as any,
      car: mockCar,
      mieleClient: {} as any,
      hc: {} as any,
      cameraURL: '',
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  describe('Anthropic provider', () => {
    beforeEach(() => {
      process.env.AI_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_API_KEY = 'test-key';
    });

    it('returns text when stop_reason is end_turn', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Car locked successfully.' }],
      });
      (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const result = await executeAICommand('Lock my car', mockServices);
      expect(result).toBe('Car locked successfully.');
    });

    it('executes tool_use and returns final text', async () => {
      const mockCreate = jest.fn()
        .mockResolvedValueOnce({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use', id: 'tu_1', name: 'lock_car', input: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done, car is locked.' }],
        });
      (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const result = await executeAICommand('Lock my car', mockServices);
      expect(mockCar.lock).toHaveBeenCalled();
      expect(result).toBe('Done, car is locked.');
    });

    it('throws when ANTHROPIC_API_KEY is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await expect(executeAICommand('hello', mockServices)).rejects.toThrow('ANTHROPIC_API_KEY');
    });

    it('returns Done. when end_turn has no text block', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        stop_reason: 'end_turn',
        content: [],
      });
      (Anthropic as unknown as jest.Mock).mockImplementation(() => ({
        messages: { create: mockCreate },
      }));

      const result = await executeAICommand('Lock my car', mockServices);
      expect(result).toBe('Done.');
    });
  });

  describe('GitHub Copilot provider', () => {
    beforeEach(() => {
      process.env.AI_PROVIDER = 'copilot';
      process.env.GITHUB_TOKEN = 'ghp_test';
    });

    it('returns text on finish_reason stop', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'Broombot started.', tool_calls: undefined },
        }],
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const result = await executeAICommand('Start broombot', mockServices);
      expect(result).toBe('Broombot started.');
    });

    it('includes Copilot-Integration-Id header', async () => {
      let capturedHeaders: Record<string, string> | undefined;
      (OpenAI as unknown as jest.Mock).mockImplementation(
        ({ defaultHeaders }: { defaultHeaders?: Record<string, string> }) => {
          capturedHeaders = defaultHeaders;
          return {
            chat: {
              completions: {
                create: jest.fn().mockResolvedValue({
                  choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
                }),
              },
            },
          };
        },
      );

      await executeAICommand('hello', mockServices);
      expect(capturedHeaders).toMatchObject({ 'Copilot-Integration-Id': 'vscode-chat' });
    });

    it('executes tool_calls and returns final text', async () => {
      const mockCreate = jest.fn()
        .mockResolvedValueOnce({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'lock_car', arguments: '{}' },
              }],
            },
          }],
        })
        .mockResolvedValueOnce({
          choices: [{
            finish_reason: 'stop',
            message: { content: 'Done, car locked.', tool_calls: undefined },
          }],
        });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const result = await executeAICommand('Lock my car', mockServices);
      expect(mockCar.lock).toHaveBeenCalled();
      expect(result).toBe('Done, car locked.');
    });

    it('also works with alias github-copilot', async () => {
      process.env.AI_PROVIDER = 'github-copilot';
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'ok', tool_calls: undefined },
        }],
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const result = await executeAICommand('hello', mockServices);
      expect(result).toBe('ok');
    });

    it('throws when GITHUB_TOKEN is not set', async () => {
      delete process.env.GITHUB_TOKEN;
      await expect(executeAICommand('hello', mockServices)).rejects.toThrow('GITHUB_TOKEN');
    });
  });

  describe('Z.ai provider', () => {
    beforeEach(() => {
      process.env.AI_PROVIDER = 'zai';
      process.env.ZAI_API_KEY = 'zai-key';
    });

    it('uses ZAI_BASE_URL when set', async () => {
      process.env.ZAI_BASE_URL = 'https://custom.z.ai/v1';
      let capturedBaseURL = '';
      (OpenAI as unknown as jest.Mock).mockImplementation(({ baseURL }: { baseURL: string }) => {
        capturedBaseURL = baseURL;
        return {
          chat: {
            completions: {
              create: jest.fn().mockResolvedValue({
                choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              }),
            },
          },
        };
      });

      await executeAICommand('hello', mockServices);
      expect(capturedBaseURL).toBe('https://custom.z.ai/v1');
    });

    it('also works with alias z.ai', async () => {
      process.env.AI_PROVIDER = 'z.ai';
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const result = await executeAICommand('hello', mockServices);
      expect(result).toBe('ok');
    });

    it('throws when ZAI_API_KEY is not set', async () => {
      delete process.env.ZAI_API_KEY;
      await expect(executeAICommand('hello', mockServices)).rejects.toThrow('ZAI_API_KEY');
    });
  });

  describe('OpenAI provider', () => {
    beforeEach(() => {
      process.env.AI_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test';
    });

    it('returns response text', async () => {
      const mockCreate = jest.fn().mockResolvedValue({
        choices: [{ finish_reason: 'stop', message: { content: 'Scene activated.' } }],
      });
      (OpenAI as unknown as jest.Mock).mockImplementation(() => ({
        chat: { completions: { create: mockCreate } },
      }));

      const result = await executeAICommand('Turn on relax scene', mockServices);
      expect(result).toBe('Scene activated.');
    });

    it('throws when OPENAI_API_KEY is not set', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(executeAICommand('hello', mockServices)).rejects.toThrow('OPENAI_API_KEY');
    });
  });

  describe('Unknown provider', () => {
    it('throws for unknown AI_PROVIDER', async () => {
      process.env.AI_PROVIDER = 'unknown-provider';
      await expect(executeAICommand('hello', mockServices)).rejects.toThrow(
        'Unknown AI_PROVIDER',
      );
    });
  });
});
