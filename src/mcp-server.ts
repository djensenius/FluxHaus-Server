import fs from 'fs';
// eslint-disable-next-line import/extensions
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FluxHausServices } from './services';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

export default function createMcpServer(services: FluxHausServices): McpServer {
  const {
    homeAssistantClient,
    broombot,
    mopbot,
    car,
    cameraURL,
  } = services;

  const server = new McpServer(
    { name: 'fluxhaus', version },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  // ── Resources ────────────────────────────────────────────────────────────────

  server.resource(
    'car-status',
    'fluxhaus://car/status',
    { description: 'Current car status including battery, doors, and EV range', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'fluxhaus://car/status',
        mimeType: 'application/json',
        text: JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2),
      }],
    }),
  );

  server.resource(
    'appliances-status',
    'fluxhaus://appliances/status',
    { description: 'Status of all appliances: washer, dryer, and dishwasher', mimeType: 'application/json' },
    async () => {
      let miele = null;
      if (fs.existsSync('cache/miele.json')) {
        miele = JSON.parse(fs.readFileSync('cache/miele.json', 'utf8'));
      }
      let homeConnect = null;
      if (fs.existsSync('cache/homeconnect.json')) {
        homeConnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
      }
      return {
        contents: [{
          uri: 'fluxhaus://appliances/status',
          mimeType: 'application/json',
          text: JSON.stringify({ miele, homeConnect }, null, 2),
        }],
      };
    },
  );

  server.resource(
    'robots-status',
    'fluxhaus://robots/status',
    { description: 'Status of robot vacuums (Broombot and Mopbot)', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'fluxhaus://robots/status',
        mimeType: 'application/json',
        text: JSON.stringify({
          broombot: broombot.cachedStatus,
          mopbot: mopbot.cachedStatus,
        }, null, 2),
      }],
    }),
  );

  server.resource(
    'camera-url',
    'fluxhaus://camera/url',
    { description: 'Home camera stream URL', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'fluxhaus://camera/url',
        mimeType: 'application/json',
        text: JSON.stringify({ cameraURL }, null, 2),
      }],
    }),
  );

  server.resource(
    'scenes-list',
    'fluxhaus://scenes/list',
    {
      description: 'Available Home Assistant scenes (lighting moods and blinds presets)',
      mimeType: 'application/json',
    },
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allStates: any[] = await homeAssistantClient.getState('');
      const scenes = Array.isArray(allStates)
        ? allStates
          .filter((s) => s.entity_id && s.entity_id.startsWith('scene.'))
          .map((s) => ({
            entityId: s.entity_id,
            name: s.attributes?.friendly_name ?? s.entity_id,
          }))
        : [];
      return {
        contents: [{
          uri: 'fluxhaus://scenes/list',
          mimeType: 'application/json',
          text: JSON.stringify({ scenes }, null, 2),
        }],
      };
    },
  );

  server.resource(
    'rhizome-photos',
    'fluxhaus://rhizome/photos',
    { description: 'Rhizome community photos and news', mimeType: 'application/json' },
    async () => {
      let rhizomeData = null;
      if (fs.existsSync('cache/rhizomePhotos.json')) {
        rhizomeData = JSON.parse(fs.readFileSync('cache/rhizomePhotos.json', 'utf8'));
      }
      return {
        contents: [{
          uri: 'fluxhaus://rhizome/photos',
          mimeType: 'application/json',
          text: JSON.stringify(rhizomeData, null, 2),
        }],
      };
    },
  );

  // ── Tools ─────────────────────────────────────────────────────────────────────

  server.tool('lock_car', 'Lock the car doors', async () => {
    const result = await car.lock();
    return { content: [{ type: 'text' as const, text: result }] };
  });

  server.tool('unlock_car', 'Unlock the car doors', async () => {
    const result = await car.unlock();
    return { content: [{ type: 'text' as const, text: result }] };
  });

  server.tool(
    'start_car',
    'Start the car climate control',
    {
      temperature: z.number()
        .min(16)
        .max(30)
        .optional()
        .describe('Target temperature in Celsius (16-30)'),
      defrost: z.boolean()
        .optional()
        .describe('Enable front windshield defrost'),
      heatedFeatures: z.boolean()
        .optional()
        .describe('Enable heated steering wheel and mirrors'),
      seatFL: z.number()
        .min(0)
        .max(3)
        .optional()
        .describe('Front-left seat heater level (0=off, 1-3)'),
      seatFR: z.number()
        .min(0)
        .max(3)
        .optional()
        .describe('Front-right seat heater level (0=off, 1-3)'),
      seatRL: z.number()
        .min(0)
        .max(3)
        .optional()
        .describe('Rear-left seat heater level (0=off, 1-3)'),
      seatRR: z.number()
        .min(0)
        .max(3)
        .optional()
        .describe('Rear-right seat heater level (0=off, 1-3)'),
    },
    async (args) => {
      const config: {
        temperature?: number;
        defrost?: boolean;
        heatedFeatures?: boolean;
        seatClimateSettings?: {
          driverSeat?: number;
          passengerSeat?: number;
          rearLeftSeat?: number;
          rearRightSeat?: number;
        };
      } = {};
      if (args.temperature !== undefined) config.temperature = args.temperature;
      if (args.defrost !== undefined) config.defrost = args.defrost;
      if (args.heatedFeatures !== undefined) config.heatedFeatures = args.heatedFeatures;
      if (args.seatFL !== undefined || args.seatFR !== undefined
          || args.seatRL !== undefined || args.seatRR !== undefined) {
        config.seatClimateSettings = {
          driverSeat: args.seatFL ?? 0,
          passengerSeat: args.seatFR ?? 0,
          rearLeftSeat: args.seatRL ?? 0,
          rearRightSeat: args.seatRR ?? 0,
        };
      }
      const result = await car.start(config);
      setTimeout(() => car.resync(), 5000);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool('stop_car', 'Stop the car climate control', async () => {
    const result = await car.stop();
    setTimeout(() => car.resync(), 5000);
    return { content: [{ type: 'text' as const, text: result }] };
  });

  server.tool('resync_car', 'Force a status sync from the car', async () => {
    await car.resync();
    return { content: [{ type: 'text' as const, text: 'Car resync initiated' }] };
  });

  server.tool(
    'start_robot',
    'Start a robot vacuum',
    { robot: z.enum(['broombot', 'mopbot']).describe('Which robot to start') },
    async ({ robot }) => {
      if (robot === 'broombot') {
        await broombot.turnOn();
      } else {
        await mopbot.turnOn();
      }
      return { content: [{ type: 'text' as const, text: `${robot} started` }] };
    },
  );

  server.tool(
    'stop_robot',
    'Stop a robot vacuum and return it to base',
    { robot: z.enum(['broombot', 'mopbot']).describe('Which robot to stop') },
    async ({ robot }) => {
      if (robot === 'broombot') {
        await broombot.turnOff();
      } else {
        await mopbot.turnOff();
      }
      return { content: [{ type: 'text' as const, text: `${robot} returning to base` }] };
    },
  );

  server.tool(
    'list_entities',
    'List Home Assistant entities, optionally filtered by domain (light, switch, scene, climate, etc.)',
    { domain: z.string().optional().describe('Entity domain filter (e.g. light, switch, scene, climate). Omit to list all.') },
    async ({ domain }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let allStates: any[] = await homeAssistantClient.getState('');
      if (!Array.isArray(allStates)) allStates = [];
      if (domain) {
        allStates = allStates.filter((s) => s.entity_id?.startsWith(`${domain}.`));
      }
      const entities = allStates.map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        name: s.attributes?.friendly_name ?? s.entity_id,
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ entities }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_entity_state',
    'Get the current state and attributes of a Home Assistant entity',
    { entity_id: z.string().describe('Entity ID (e.g. light.bedroom, switch.porch)') },
    async ({ entity_id }) => {
      const state = await homeAssistantClient.getState(entity_id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            entity_id: state.entity_id,
            state: state.state,
            attributes: state.attributes,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'call_ha_service',
    'Call a Home Assistant service (e.g. turn on a light, toggle a switch, set climate temperature)',
    {
      domain: z.string().describe('Service domain (e.g. light, switch, climate, scene)'),
      service: z.string().describe('Service name (e.g. turn_on, turn_off, toggle)'),
      entity_id: z.string().describe('Target entity ID (e.g. light.bedroom)'),
      brightness_pct: z.number().optional().describe('Brightness percentage (0-100), for lights only'),
      color_temp: z.number().optional().describe('Color temperature in mireds, for lights only'),
      temperature: z.number().optional().describe('Target temperature, for climate entities only'),
    },
    async ({
      // eslint-disable-next-line @typescript-eslint/no-shadow
      domain, service, entity_id, ...extraData
    }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serviceData: Record<string, any> = { entity_id };
      for (const [key, value] of Object.entries(extraData)) {
        if (value !== undefined) serviceData[key] = value;
      }
      await homeAssistantClient.callService(domain, service, serviceData);
      return { content: [{ type: 'text' as const, text: `Called ${domain}.${service} on ${entity_id}` }] };
    },
  );

  // ── Prompts ──────────────────────────────────────────────────────────────────

  server.prompt(
    'appliance_report',
    'Generate a status report for all home appliances',
    async () => {
      let miele = null;
      if (fs.existsSync('cache/miele.json')) {
        miele = JSON.parse(fs.readFileSync('cache/miele.json', 'utf8'));
      }
      let homeConnect = null;
      if (fs.existsSync('cache/homeconnect.json')) {
        homeConnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
      }
      const applianceData = JSON.stringify({ miele, homeConnect }, null, 2);
      const promptText = 'Here is the current appliance data from FluxHaus:\n\n'
        + `${applianceData}\n\n`
        + 'Please provide a concise, friendly summary of what appliances are running, '
        + 'how long they have left, and anything that needs attention.';
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: promptText,
          },
        }],
      };
    },
  );

  server.prompt(
    'leaving_home',
    'Checklist and actions to perform when leaving home',
    async () => {
      const carData = JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2);
      const robotData = JSON.stringify({
        broombot: broombot.cachedStatus,
        mopbot: mopbot.cachedStatus,
      }, null, 2);
      const leavingText = 'I am leaving home. Here is the current FluxHaus status:\n\n'
        + `Car:\n${carData}\n\n`
        + `Robots:\n${robotData}\n\n`
        + 'Please check:\n1. Is the car locked?\n2. Are the robots docked/charging?'
        + '\n3. Are any appliances still running?\nSuggest any actions I should take before leaving.';
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: leavingText,
          },
        }],
      };
    },
  );

  server.prompt(
    'goodnight',
    'Evening checklist for winding down the home',
    async () => {
      const carData = JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2);
      const robotData = JSON.stringify({
        broombot: broombot.cachedStatus,
        mopbot: mopbot.cachedStatus,
      }, null, 2);
      let miele = null;
      if (fs.existsSync('cache/miele.json')) {
        miele = JSON.parse(fs.readFileSync('cache/miele.json', 'utf8'));
      }
      let homeConnect = null;
      if (fs.existsSync('cache/homeconnect.json')) {
        homeConnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
      }
      const appliancesData = JSON.stringify({ miele, homeConnect }, null, 2);
      const goodnightText = 'It is time for bed. Here is the current FluxHaus status:\n\n'
        + `Car:\n${carData}\n\n`
        + `Robots:\n${robotData}\n\n`
        + `Appliances:\n${appliancesData}\n\n`
        + 'Please provide a goodnight summary:\n'
        + '1. Is the car locked and plugged in to charge?\n'
        + '2. Are all appliances off or finished?\n'
        + '3. Are the robots docked and charging for tomorrow?\n'
        + '4. Any suggestions for tonight (e.g. start dishwasher, schedule robot)?';
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: goodnightText,
          },
        }],
      };
    },
  );

  return server;
}
