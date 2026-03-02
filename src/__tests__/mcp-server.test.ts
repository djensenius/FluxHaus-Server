/* eslint-disable no-underscore-dangle */
import fs from 'fs';
import createMcpServer from '../mcp-server';
import { FluxHausServices } from '../services';

jest.mock('fs');
jest.mock('../homeassistant-client');
jest.mock('../homeassistant-robot');
jest.mock('../car');
jest.mock('../miele');
jest.mock('../homeconnect');

// Helpers to access McpServer internals (private in TS, but testable via any cast)
/* eslint-disable @typescript-eslint/no-explicit-any */
const getResources = (server: any) => server._registeredResources;
const getTools = (server: any) => server._registeredTools;
const getPrompts = (server: any) => server._registeredPrompts;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('MCP Server', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let mockServices: FluxHausServices;
  let mockCar: any;
  let mockBroombot: any;
  let mockMopbot: any;
  let mockHaClient: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.clearAllMocks();

    mockCar = {
      status: {
        evStatus: {
          batteryStatus: 60,
          batteryCharge: true,
          batteryPlugin: 1,
          drvDistance: [{
            rangeByFuel: {
              evModeRange: { value: 249 },
              totalAvailableRange: { value: 249 },
            },
          }],
        },
        doorLock: true,
        airCtrlOn: false,
      },
      odometer: 15000,
      lock: jest.fn().mockResolvedValue('Locked'),
      unlock: jest.fn().mockResolvedValue('Unlocked'),
      start: jest.fn().mockResolvedValue('Started'),
      stop: jest.fn().mockResolvedValue('Stopped'),
      resync: jest.fn().mockResolvedValue(undefined),
    };

    mockBroombot = {
      cachedStatus: { running: false, docked: true, batteryLevel: 100 },
      turnOn: jest.fn().mockResolvedValue(undefined),
      turnOff: jest.fn().mockResolvedValue(undefined),
    };

    mockMopbot = {
      cachedStatus: { running: false, docked: true, batteryLevel: 100 },
      turnOn: jest.fn().mockResolvedValue(undefined),
      turnOff: jest.fn().mockResolvedValue(undefined),
    };

    mockHaClient = {
      getState: jest.fn().mockResolvedValue([]),
      callService: jest.fn().mockResolvedValue({}),
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    mockServices = {
      homeAssistantClient: mockHaClient,
      broombot: mockBroombot,
      mopbot: mockMopbot,
      car: mockCar,
      mieleClient: { getActivePrograms: jest.fn(), listenEvents: jest.fn() } as any,
      hc: { getActiveProgram: jest.fn(), listenEvents: jest.fn(), dishwasher: {} } as any,
      cameraURL: 'http://camera.local/stream',
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('should create an MCP server without throwing', () => {
    expect(() => createMcpServer(mockServices)).not.toThrow();
  });

  it('should create an MCP server with underlying server instance', () => {
    const server = createMcpServer(mockServices);
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  describe('Resources', () => {
    // _registeredResources is keyed by URI
    it('should have car-status resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://car/status');
    });

    it('should have appliances-status resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://appliances/status');
    });

    it('should have robots-status resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://robots/status');
    });

    it('should have camera-url resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://camera/url');
    });

    it('should have scenes-list resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://scenes/list');
    });

    it('should have rhizome-photos resource registered', () => {
      const server = createMcpServer(mockServices);
      expect(getResources(server)).toHaveProperty('fluxhaus://rhizome/photos');
    });

    it('car-status resource returns car status JSON', async () => {
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://car/status'];
      const result = await resource.readCallback(new URL('fluxhaus://car/status'), {});
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.status.evStatus.batteryStatus).toBe(60);
      expect(parsed.odometer).toBe(15000);
    });

    it('appliances-status resource reads from cache files when present', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{"washer":{"inUse":true}}');
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://appliances/status'];
      const result = await resource.readCallback(new URL('fluxhaus://appliances/status'), {});
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.miele).toEqual({ washer: { inUse: true } });
    });

    it('robots-status resource returns robot statuses', async () => {
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://robots/status'];
      const result = await resource.readCallback(new URL('fluxhaus://robots/status'), {});
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.broombot.batteryLevel).toBe(100);
      expect(parsed.mopbot.docked).toBe(true);
    });

    it('camera-url resource returns camera URL', async () => {
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://camera/url'];
      const result = await resource.readCallback(new URL('fluxhaus://camera/url'), {});
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.cameraURL).toBe('http://camera.local/stream');
    });

    it('scenes-list resource calls HA and filters scenes', async () => {
      mockHaClient.getState.mockResolvedValue([
        { entity_id: 'scene.living_room_relax', attributes: { friendly_name: 'Living Room Relax' } },
        { entity_id: 'light.ceiling', attributes: { friendly_name: 'Ceiling Light' } },
      ]);
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://scenes/list'];
      const result = await resource.readCallback(new URL('fluxhaus://scenes/list'), {});
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed.scenes).toHaveLength(1);
      expect(parsed.scenes[0].entityId).toBe('scene.living_room_relax');
      expect(parsed.scenes[0].name).toBe('Living Room Relax');
    });

    it('rhizome-photos resource returns null when no cache', async () => {
      const server = createMcpServer(mockServices);
      const resource = getResources(server)['fluxhaus://rhizome/photos'];
      const result = await resource.readCallback(new URL('fluxhaus://rhizome/photos'), {});
      expect(result.contents[0].text).toBe('null');
    });
  });

  describe('Tools', () => {
    // _registeredTools is keyed by tool name; handler is the callback function
    it('should have lock_car tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('lock_car');
    });

    it('should have unlock_car tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('unlock_car');
    });

    it('should have start_car tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('start_car');
    });

    it('should have stop_car tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('stop_car');
    });

    it('should have resync_car tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('resync_car');
    });

    it('should have start_robot tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('start_robot');
    });

    it('should have stop_robot tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('stop_robot');
    });

    it('should have activate_scene tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('activate_scene');
    });

    it('should have list_scenes tool registered', () => {
      const server = createMcpServer(mockServices);
      expect(getTools(server)).toHaveProperty('list_scenes');
    });

    it('lock_car tool calls car.lock()', async () => {
      jest.useFakeTimers();
      const server = createMcpServer(mockServices);
      const result = await getTools(server).lock_car.handler({}, {});
      expect(mockCar.lock).toHaveBeenCalled();
      expect(result.content[0].text).toBe('Locked');
      jest.useRealTimers();
    });

    it('unlock_car tool calls car.unlock()', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).unlock_car.handler({}, {});
      expect(mockCar.unlock).toHaveBeenCalled();
      expect(result.content[0].text).toBe('Unlocked');
    });

    it('start_car tool calls car.start() with defaults', async () => {
      jest.useFakeTimers();
      const server = createMcpServer(mockServices);
      const result = await getTools(server).start_car.handler({}, {});
      expect(mockCar.start).toHaveBeenCalledWith({});
      expect(result.content[0].text).toBe('Started');
      jest.useRealTimers();
    });

    it('start_car tool passes temperature and defrost options', async () => {
      jest.useFakeTimers();
      const server = createMcpServer(mockServices);
      await getTools(server).start_car.handler({ temperature: 22, defrost: true }, {});
      expect(mockCar.start).toHaveBeenCalledWith({ temperature: 22, defrost: true });
      jest.useRealTimers();
    });

    it('start_car tool passes seat climate settings', async () => {
      jest.useFakeTimers();
      const server = createMcpServer(mockServices);
      await getTools(server).start_car.handler({ seatFL: 2, seatFR: 1 }, {});
      expect(mockCar.start).toHaveBeenCalledWith({
        seatClimateSettings: {
          driverSeat: 2,
          passengerSeat: 1,
          rearLeftSeat: 0,
          rearRightSeat: 0,
        },
      });
      jest.useRealTimers();
    });

    it('stop_car tool calls car.stop()', async () => {
      jest.useFakeTimers();
      const server = createMcpServer(mockServices);
      const result = await getTools(server).stop_car.handler({}, {});
      expect(mockCar.stop).toHaveBeenCalled();
      expect(result.content[0].text).toBe('Stopped');
      jest.useRealTimers();
    });

    it('resync_car tool calls car.resync()', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).resync_car.handler({}, {});
      expect(mockCar.resync).toHaveBeenCalled();
      expect(result.content[0].text).toBe('Car resync initiated');
    });

    it('start_robot tool starts broombot', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).start_robot.handler({ robot: 'broombot' }, {});
      expect(mockBroombot.turnOn).toHaveBeenCalled();
      expect(result.content[0].text).toBe('broombot started');
    });

    it('start_robot tool starts mopbot', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).start_robot.handler({ robot: 'mopbot' }, {});
      expect(mockMopbot.turnOn).toHaveBeenCalled();
      expect(result.content[0].text).toBe('mopbot started');
    });

    it('stop_robot tool stops broombot', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).stop_robot.handler({ robot: 'broombot' }, {});
      expect(mockBroombot.turnOff).toHaveBeenCalled();
      expect(result.content[0].text).toBe('broombot returning to base');
    });

    it('activate_scene tool calls HA callService', async () => {
      const server = createMcpServer(mockServices);
      const result = await getTools(server).activate_scene.handler(
        { sceneId: 'scene.living_room_relax' },
        {},
      );
      expect(mockHaClient.callService).toHaveBeenCalledWith(
        'scene',
        'turn_on',
        { entity_id: 'scene.living_room_relax' },
      );
      expect(result.content[0].text).toBe('Scene scene.living_room_relax activated');
    });

    it('list_scenes tool returns filtered scene list', async () => {
      mockHaClient.getState.mockResolvedValue([
        { entity_id: 'scene.bedroom_relax', attributes: { friendly_name: 'Bedroom Relax' } },
        { entity_id: 'input_boolean.something', attributes: {} },
      ]);
      const server = createMcpServer(mockServices);
      const result = await getTools(server).list_scenes.handler({}, {});
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.scenes).toHaveLength(1);
      expect(parsed.scenes[0].name).toBe('Bedroom Relax');
    });
  });

  describe('Prompts', () => {
    it('should have appliance_report prompt registered', () => {
      const server = createMcpServer(mockServices);
      expect(getPrompts(server)).toHaveProperty('appliance_report');
    });

    it('should have leaving_home prompt registered', () => {
      const server = createMcpServer(mockServices);
      expect(getPrompts(server)).toHaveProperty('leaving_home');
    });

    it('should have goodnight prompt registered', () => {
      const server = createMcpServer(mockServices);
      expect(getPrompts(server)).toHaveProperty('goodnight');
    });

    it('appliance_report prompt returns user message with appliance data', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue('{"washer":{"inUse":false}}');
      const server = createMcpServer(mockServices);
      const result = await getPrompts(server).appliance_report.callback({}, {});
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toContain('FluxHaus');
    });

    it('leaving_home prompt includes car lock status check', async () => {
      const server = createMcpServer(mockServices);
      const result = await getPrompts(server).leaving_home.callback({}, {});
      expect(result.messages[0].content.text).toContain('car locked');
    });

    it('goodnight prompt includes all system status', async () => {
      const server = createMcpServer(mockServices);
      const result = await getPrompts(server).goodnight.callback({}, {});
      expect(result.messages[0].content.text).toContain('goodnight');
    });
  });
});
