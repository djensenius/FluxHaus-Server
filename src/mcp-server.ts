import fs from 'fs';
// eslint-disable-next-line import/extensions
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FluxHausServices } from './services';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json');

// Wraps server.tool so every handler gets try/catch, logging, and timing.
function wrapToolHandlers(server: McpServer): McpServer['tool'] {
  const originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = (...rawArgs: any[]) => {
    const wrappedArgs = [...rawArgs];
    const name = wrappedArgs[0] as string;
    const handlerIndex = wrappedArgs.length - 1;
    const originalHandler = wrappedArgs[handlerIndex];
    if (typeof originalHandler !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalTool as any)(...rawArgs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrappedArgs[handlerIndex] = async (...handlerArgs: any[]) => {
      const start = Date.now();
      try {
        const result = await originalHandler(...handlerArgs);
        const elapsed = Date.now() - start;
        if (elapsed > 5000) {
          console.warn(`[MCP] ${name} completed in ${elapsed}ms (slow)`);
        }
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MCP] ${name} failed after ${elapsed}ms: ${message}`);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error in ${name}: ${message}` }],
        };
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalTool as any)(...wrappedArgs);
  };
  return wrapped as McpServer['tool'];
}

// Dangerous Jinja2 patterns that could access the HA host system.
const DANGEROUS_TEMPLATE_PATTERNS = [
  /\{%\s*import\b/i,
  /\{%\s*include\b/i,
  /\{%\s*from\b.*import\b/i,
  /__class__/,
  /__subclasses__/,
  /__globals__/,
  /__builtins__/,
  /\bos\.\b/,
  /\bsubprocess\b/,
  /\beval\s*\(/,
  /\bexec\s*\(/,
];
const MAX_TEMPLATE_LENGTH = 4000;

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

  // Wrap all tool handlers with error handling and logging
  server.tool = wrapToolHandlers(server);

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
    {
      domain: z.string().optional().describe(
        'Entity domain filter (e.g. light, switch, scene, climate). Omit to list all.',
      ),
    },
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
    // eslint-disable-next-line camelcase
    { entity_id: z.string().describe('Entity ID (e.g. light.bedroom, switch.porch)') },
    // eslint-disable-next-line camelcase
    async ({ entity_id }) => {
      // eslint-disable-next-line camelcase
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
      entity_id: z.string().describe('Target entity ID (e.g. light.bedroom)'), // eslint-disable-line camelcase
      brightness_pct: z.number().optional().describe('Brightness percentage (0-100), for lights only'),
      color_temp: z.number().optional().describe('Color temperature in mireds, for lights only'),
      temperature: z.number().optional().describe('Target temperature, for climate entities only'),
    },
    async ({
      // eslint-disable-next-line @typescript-eslint/no-shadow
      domain, service, entity_id: entityId, ...extraData
    }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const serviceData: Record<string, any> = { entity_id: entityId };
      Object.entries(extraData).forEach(([key, value]) => {
        if (value !== undefined) { serviceData[key] = value; }
      });
      await homeAssistantClient.callService(domain, service, serviceData);
      return { content: [{ type: 'text' as const, text: `Called ${domain}.${service} on ${entityId}` }] };
    },
  );

  server.tool(
    'get_car_status',
    'Get the car status: battery level, EV range, doors, locks, HVAC, trunk, hood, odometer',
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2),
      }],
    }),
  );

  server.tool(
    'get_robot_status',
    'Get the status of robot vacuums (Broombot and Mopbot): battery, running, charging, bin full',
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          broombot: broombot.cachedStatus,
          mopbot: mopbot.cachedStatus,
        }, null, 2),
      }],
    }),
  );

  server.tool(
    'get_appliance_status',
    'Get the status of home appliances: washer, dryer (Miele), and dishwasher (HomeConnect)',
    async () => {
      const { mieleClient, hc } = services;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            washer: mieleClient.washer,
            dryer: mieleClient.dryer,
            dishwasher: hc.dishwasher,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_entity_history',
    'Get state history for a Home Assistant entity over a time period (e.g. temperature changes, on/off history)',
    {
      entity_id: z.string().describe('Entity ID (e.g. sensor.bedroom_temperature)'), // eslint-disable-line camelcase
      start: z.string().describe('Start time as ISO 8601 timestamp (e.g. 2025-03-01T00:00:00Z)'),
      end: z.string().optional().describe('End time as ISO 8601 timestamp. Defaults to now.'),
    },
    // eslint-disable-next-line camelcase
    async ({ entity_id, start, end }) => {
      // eslint-disable-next-line camelcase
      const history = await homeAssistantClient.getHistory(entity_id, start, end);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(history, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_logbook',
    'Get the Home Assistant logbook — a human-readable event log (e.g. "Light turned on", "Door opened")',
    {
      start: z.string().describe('Start time as ISO 8601 timestamp'),
      end: z.string().optional().describe('End time as ISO 8601 timestamp. Defaults to now.'),
      entity_id: z.string().optional().describe('Filter to a specific entity ID'), // eslint-disable-line camelcase
    },
    // eslint-disable-next-line camelcase
    async ({ start, end, entity_id }) => {
      // eslint-disable-next-line camelcase
      const logbook = await homeAssistantClient.getLogbook(start, end, entity_id);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(logbook, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_calendar_events',
    'Get events from a Home Assistant calendar for a date range',
    {
      calendar_id: z.string().describe('Calendar entity ID (e.g. calendar.family)'), // eslint-disable-line camelcase
      start: z.string().describe('Start time as ISO 8601 timestamp'),
      end: z.string().describe('End time as ISO 8601 timestamp'),
    },
    // eslint-disable-next-line camelcase
    async ({ calendar_id, start, end }) => {
      // eslint-disable-next-line camelcase
      const events = await homeAssistantClient.getCalendarEvents(calendar_id, start, end);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(events, null, 2),
        }],
      };
    },
  );

  server.tool(
    'list_calendars',
    'List all available Home Assistant calendars',
    async () => {
      const calendars = await homeAssistantClient.getCalendars();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(calendars, null, 2),
        }],
      };
    },
  );

  server.tool(
    'render_template',
    'Render a Home Assistant Jinja2 template (e.g. count lights on, compute averages, complex queries)',
    {
      template: z.string().describe(
        'Jinja2 template string (e.g. "{{ states.light '
        + "| selectattr('state', 'eq', 'on') | list | count }} lights on\")",
      ),
    },
    async ({ template }) => {
      if (template.length > MAX_TEMPLATE_LENGTH) {
        const msg = `Template too long (${template.length} chars, max ${MAX_TEMPLATE_LENGTH})`;
        return {
          isError: true,
          content: [{ type: 'text' as const, text: msg }],
        };
      }
      const blocked = DANGEROUS_TEMPLATE_PATTERNS.some((p) => p.test(template));
      if (blocked) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Template contains a disallowed pattern' }],
        };
      }
      const result = await homeAssistantClient.renderTemplate(template);
      return {
        content: [{
          type: 'text' as const,
          text: result,
        }],
      };
    },
  );

  server.tool(
    'activate_scene',
    'Activate a Home Assistant scene (e.g. "Movie Time", "Goodnight")',
    {
      entity_id: z.string().describe( // eslint-disable-line camelcase
        'Scene entity ID (e.g. scene.movie_time). '
        + 'Use list_entities with domain "scene" to discover scenes.',
      ),
    },
    async ({ entity_id: entityId }) => {
      await homeAssistantClient.callService('scene', 'turn_on', { entity_id: entityId });
      return { content: [{ type: 'text' as const, text: `Activated scene: ${entityId}` }] };
    },
  );

  server.tool(
    'get_home_summary',
    'Get a full summary of the home: car, robots, appliances, and active HA entities — useful for a quick overview',
    async () => {
      const { mieleClient, hc } = services;
      let miele = null;
      if (fs.existsSync('cache/miele.json')) {
        miele = JSON.parse(fs.readFileSync('cache/miele.json', 'utf8'));
      }
      let homeconnect = null;
      if (fs.existsSync('cache/homeconnect.json')) {
        homeconnect = JSON.parse(fs.readFileSync('cache/homeconnect.json', 'utf8'));
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            car: { status: car.status, odometer: car.odometer },
            robots: { broombot: broombot.cachedStatus, mopbot: mopbot.cachedStatus },
            appliances: {
              washer: mieleClient.washer,
              dryer: mieleClient.dryer,
              dishwasher: hc.dishwasher,
            },
            miele,
            homeconnect,
          }, null, 2),
        }],
      };
    },
  );

  // ── Plex ──────────────────────────────────────────────────────────────────────

  server.tool(
    'plex_get_sessions',
    'Get current Plex playback sessions — who is watching what',
    async () => {
      if (!services.plex?.configured) {
        return { content: [{ type: 'text' as const, text: 'Plex is not configured' }] };
      }
      const data = await services.plex.getSessions();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'plex_get_libraries',
    'List all Plex media libraries',
    async () => {
      if (!services.plex?.configured) {
        return { content: [{ type: 'text' as const, text: 'Plex is not configured' }] };
      }
      const data = await services.plex.getLibraries();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'plex_get_recently_added',
    'Get recently added media from Plex',
    async () => {
      if (!services.plex?.configured) {
        return { content: [{ type: 'text' as const, text: 'Plex is not configured' }] };
      }
      const data = await services.plex.getRecentlyAdded();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'plex_get_on_deck',
    'Get Plex on-deck items — media that is in progress',
    async () => {
      if (!services.plex?.configured) {
        return { content: [{ type: 'text' as const, text: 'Plex is not configured' }] };
      }
      const data = await services.plex.getOnDeck();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'plex_search',
    'Search across all Plex media libraries',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.plex?.configured) {
        return { content: [{ type: 'text' as const, text: 'Plex is not configured' }] };
      }
      const data = await services.plex.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Overseerr ────────────────────────────────────────────────────────────────

  server.tool(
    'overseerr_search',
    'Search for movies and TV shows in Overseerr',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.overseerr?.configured) {
        return { content: [{ type: 'text' as const, text: 'Overseerr is not configured' }] };
      }
      const data = await services.overseerr.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'overseerr_get_requests',
    'Get media requests from Overseerr, optionally filtered by status',
    { status: z.string().optional().describe('Filter by status (e.g. pending, approved)') },
    async ({ status }) => {
      if (!services.overseerr?.configured) {
        return { content: [{ type: 'text' as const, text: 'Overseerr is not configured' }] };
      }
      const data = await services.overseerr.getRequests(status);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'overseerr_request_media',
    'Request a movie or TV show in Overseerr',
    {
      mediaType: z.string().describe('Type of media: movie or tv'),
      mediaId: z.coerce.number().describe('The media ID from search results'),
      is4k: z.boolean().optional().describe('Request in 4K quality'),
    },
    async ({ mediaType, mediaId, is4k }) => {
      if (!services.overseerr?.configured) {
        return { content: [{ type: 'text' as const, text: 'Overseerr is not configured' }] };
      }
      const data = await services.overseerr.requestMedia(mediaType, mediaId, is4k);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'overseerr_approve_request',
    'Approve a pending media request in Overseerr',
    { requestId: z.coerce.number().describe('The request ID to approve') },
    async ({ requestId }) => {
      if (!services.overseerr?.configured) {
        return { content: [{ type: 'text' as const, text: 'Overseerr is not configured' }] };
      }
      const data = await services.overseerr.approveRequest(requestId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'overseerr_get_status',
    'Get the current Overseerr server status',
    async () => {
      if (!services.overseerr?.configured) {
        return { content: [{ type: 'text' as const, text: 'Overseerr is not configured' }] };
      }
      const data = await services.overseerr.getStatus();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Tautulli ─────────────────────────────────────────────────────────────────

  server.tool(
    'tautulli_get_activity',
    'Get current Plex streaming activity from Tautulli',
    async () => {
      if (!services.tautulli?.configured) {
        return { content: [{ type: 'text' as const, text: 'Tautulli is not configured' }] };
      }
      const data = await services.tautulli.getActivity();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'tautulli_get_history',
    'Get Plex watch history from Tautulli',
    { length: z.number().optional().describe('Number of history items to return') },
    async ({ length }) => {
      if (!services.tautulli?.configured) {
        return { content: [{ type: 'text' as const, text: 'Tautulli is not configured' }] };
      }
      const data = await services.tautulli.getHistory(length);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'tautulli_get_libraries',
    'Get Plex library statistics from Tautulli',
    async () => {
      if (!services.tautulli?.configured) {
        return { content: [{ type: 'text' as const, text: 'Tautulli is not configured' }] };
      }
      const data = await services.tautulli.getLibraries();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'tautulli_get_recently_added',
    'Get recently added media from Tautulli',
    { count: z.number().optional().describe('Number of items to return') },
    async ({ count }) => {
      if (!services.tautulli?.configured) {
        return { content: [{ type: 'text' as const, text: 'Tautulli is not configured' }] };
      }
      const data = await services.tautulli.getRecentlyAdded(count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'tautulli_get_home_stats',
    'Get Tautulli home page statistics (most watched, popular, etc.)',
    async () => {
      if (!services.tautulli?.configured) {
        return { content: [{ type: 'text' as const, text: 'Tautulli is not configured' }] };
      }
      const data = await services.tautulli.getHomeStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Grafana ──────────────────────────────────────────────────────────────────

  server.tool(
    'grafana_list_dashboards',
    'List all Grafana dashboards',
    async () => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      const data = await services.grafana.listDashboards();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'grafana_get_dashboard',
    'Get a Grafana dashboard by UID',
    { uid: z.string().describe('Dashboard UID') },
    async ({ uid }) => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      const data = await services.grafana.getDashboard(uid);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'grafana_list_datasources',
    'List all Grafana data sources',
    async () => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      const data = await services.grafana.listDatasources();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'grafana_query_datasource',
    'Query a Grafana data source directly',
    {
      datasourceId: z.coerce.number().describe('Data source ID'),
      query_json: z.string().describe('Query as JSON string'), // eslint-disable-line camelcase
    },
    // eslint-disable-next-line camelcase
    async ({ datasourceId, query_json }) => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      // eslint-disable-next-line camelcase
      const query = JSON.parse(query_json);
      const data = await services.grafana.queryDatasource(datasourceId, query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'grafana_get_annotations',
    'Get Grafana annotations, optionally filtered by time range',
    {
      from: z.string().optional().describe('Start time as ISO 8601 timestamp'),
      to: z.string().optional().describe('End time as ISO 8601 timestamp'),
    },
    async ({ from, to }) => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      const data = await services.grafana.getAnnotations(from, to);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'grafana_get_alerts',
    'Get active Grafana alerts',
    async () => {
      if (!services.grafana?.configured) {
        return { content: [{ type: 'text' as const, text: 'Grafana is not configured' }] };
      }
      const data = await services.grafana.getAlerts();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── InfluxDB ─────────────────────────────────────────────────────────────────

  server.tool(
    'influxdb_query',
    // eslint-disable-next-line max-len
    'Execute a Flux query against InfluxDB. Home Assistant data is in bucket "home_assistant" with measurements: appliance, vehicle, battery, power, energy, climate, security, media, lighting, shade, motion, occupancy, position, state',
    { flux: z.string().describe('Flux query string') },
    async ({ flux }) => {
      if (!services.influxdb?.configured) {
        return { content: [{ type: 'text' as const, text: 'InfluxDB is not configured' }] };
      }
      const data = await services.influxdb.query(flux);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'influxdb_list_buckets',
    'List all InfluxDB buckets',
    async () => {
      if (!services.influxdb?.configured) {
        return { content: [{ type: 'text' as const, text: 'InfluxDB is not configured' }] };
      }
      const data = await services.influxdb.listBuckets();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'influxdb_list_measurements',
    'List all InfluxDB measurements in a bucket (defaults to configured bucket; HA data is in "home_assistant" bucket)',
    { // eslint-disable-next-line max-len
      bucket: z.string().optional().describe('Bucket name to list measurements from (e.g. "home_assistant"). Defaults to configured bucket.'),
    },
    async ({ bucket }) => {
      if (!services.influxdb?.configured) {
        return { content: [{ type: 'text' as const, text: 'InfluxDB is not configured' }] };
      }
      const data = await services.influxdb.listMeasurements(bucket);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Portainer ────────────────────────────────────────────────────────────────

  server.tool(
    'portainer_list_endpoints',
    'List all Portainer endpoints (Docker environments)',
    async () => {
      if (!services.portainer?.configured) {
        return { content: [{ type: 'text' as const, text: 'Portainer is not configured' }] };
      }
      const data = await services.portainer.listEndpoints();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'portainer_list_containers',
    'List Docker containers on a Portainer endpoint',
    { endpointId: z.coerce.number().describe('Portainer endpoint ID') },
    async ({ endpointId }) => {
      if (!services.portainer?.configured) {
        return { content: [{ type: 'text' as const, text: 'Portainer is not configured' }] };
      }
      const data = await services.portainer.listContainers(endpointId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'portainer_list_stacks',
    'List all Portainer stacks',
    async () => {
      if (!services.portainer?.configured) {
        return { content: [{ type: 'text' as const, text: 'Portainer is not configured' }] };
      }
      const data = await services.portainer.listStacks();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'portainer_get_container',
    'Get details of a specific Docker container on a Portainer endpoint',
    {
      endpointId: z.coerce.number().describe('Portainer endpoint ID'),
      containerId: z.string().describe('Docker container ID'),
    },
    async ({ endpointId, containerId }) => {
      if (!services.portainer?.configured) {
        return { content: [{ type: 'text' as const, text: 'Portainer is not configured' }] };
      }
      const data = await services.portainer.getContainer(endpointId, containerId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'portainer_container_action',
    'Perform an action on a Docker container (start, stop, restart, kill)',
    {
      endpointId: z.coerce.number().describe('Portainer endpoint ID'),
      containerId: z.string().describe('Docker container ID'),
      action: z.string().describe('Action to perform: start, stop, restart, or kill'),
    },
    async ({ endpointId, containerId, action }) => {
      if (!services.portainer?.configured) {
        return { content: [{ type: 'text' as const, text: 'Portainer is not configured' }] };
      }
      const data = await services.portainer.containerAction(endpointId, containerId, action);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Prometheus ───────────────────────────────────────────────────────────────

  server.tool(
    'prometheus_query',
    'Execute an instant PromQL query against Prometheus',
    { promql: z.string().describe('PromQL query expression') },
    async ({ promql }) => {
      if (!services.prometheus?.configured) {
        return { content: [{ type: 'text' as const, text: 'Prometheus is not configured' }] };
      }
      const data = await services.prometheus.query(promql);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'prometheus_query_range',
    'Execute a range PromQL query against Prometheus',
    {
      promql: z.string().describe('PromQL query expression'),
      start: z.string().describe('Start time as ISO 8601 timestamp or Unix epoch'),
      end: z.string().describe('End time as ISO 8601 timestamp or Unix epoch'),
      step: z.string().optional().describe('Query step (e.g. 15s, 1m, 5m)'),
    },
    async ({
      promql, start, end, step,
    }) => {
      if (!services.prometheus?.configured) {
        return { content: [{ type: 'text' as const, text: 'Prometheus is not configured' }] };
      }
      const data = await services.prometheus.queryRange(promql, start, end, step);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'prometheus_get_targets',
    'Get all Prometheus scrape targets and their status',
    async () => {
      if (!services.prometheus?.configured) {
        return { content: [{ type: 'text' as const, text: 'Prometheus is not configured' }] };
      }
      const data = await services.prometheus.getTargets();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'prometheus_get_alerts',
    'Get active Prometheus alerts',
    async () => {
      if (!services.prometheus?.configured) {
        return { content: [{ type: 'text' as const, text: 'Prometheus is not configured' }] };
      }
      const data = await services.prometheus.getAlerts();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'prometheus_get_rules',
    'Get all Prometheus alerting and recording rules',
    async () => {
      if (!services.prometheus?.configured) {
        return { content: [{ type: 'text' as const, text: 'Prometheus is not configured' }] };
      }
      const data = await services.prometheus.getRules();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Komga ────────────────────────────────────────────────────────────────────

  server.tool(
    'komga_list_libraries',
    'List all Komga comic/manga libraries',
    async () => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.listLibraries();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_list_series',
    'List series in Komga, optionally filtered by library',
    { libraryId: z.string().optional().describe('Filter by library ID') },
    async ({ libraryId }) => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.listSeries(libraryId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_get_series',
    'Get details of a specific Komga series',
    { seriesId: z.string().describe('Series ID') },
    async ({ seriesId }) => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.getSeries(seriesId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_list_books',
    'List books in a Komga series',
    { seriesId: z.string().describe('Series ID') },
    async ({ seriesId }) => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.listBooks(seriesId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_search',
    'Search across Komga libraries for series and books',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_get_recently_added',
    'Get recently added series and books from Komga',
    async () => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.getRecentlyAdded();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_get_on_deck',
    'Get on-deck books from Komga — books that are in progress',
    async () => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.getOnDeck();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'komga_get_read_progress',
    'Get read progress for a Komga series',
    { seriesId: z.string().describe('Series ID') },
    async ({ seriesId }) => {
      if (!services.komga?.configured) {
        return { content: [{ type: 'text' as const, text: 'Komga is not configured' }] };
      }
      const data = await services.komga.getReadProgress(seriesId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Booklore ─────────────────────────────────────────────────────────────────

  server.tool(
    'booklore_list_shelves',
    'List all Booklore shelves',
    async () => {
      if (!services.booklore?.configured) {
        return { content: [{ type: 'text' as const, text: 'Booklore is not configured' }] };
      }
      const data = await services.booklore.listShelves();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'booklore_list_books',
    'List books in Booklore, optionally filtered by shelf',
    { shelfId: z.string().optional().describe('Filter by shelf ID') },
    async ({ shelfId }) => {
      if (!services.booklore?.configured) {
        return { content: [{ type: 'text' as const, text: 'Booklore is not configured' }] };
      }
      const data = await services.booklore.listBooks(shelfId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'booklore_get_book',
    'Get details of a specific book in Booklore',
    { bookId: z.string().describe('Book ID') },
    async ({ bookId }) => {
      if (!services.booklore?.configured) {
        return { content: [{ type: 'text' as const, text: 'Booklore is not configured' }] };
      }
      const data = await services.booklore.getBook(bookId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'booklore_search',
    'Search for books in Booklore',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.booklore?.configured) {
        return { content: [{ type: 'text' as const, text: 'Booklore is not configured' }] };
      }
      const data = await services.booklore.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Audiobookshelf ───────────────────────────────────────────────────────────

  server.tool(
    'audiobookshelf_list_libraries',
    'List all Audiobookshelf libraries',
    async () => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.listLibraries();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'audiobookshelf_list_items',
    'List items in an Audiobookshelf library',
    { libraryId: z.string().describe('Library ID') },
    async ({ libraryId }) => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.listItems(libraryId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'audiobookshelf_get_item',
    'Get details of a specific Audiobookshelf item',
    { itemId: z.string().describe('Item ID') },
    async ({ itemId }) => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.getItem(itemId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'audiobookshelf_get_in_progress',
    'Get audiobooks currently in progress from Audiobookshelf',
    async () => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.getInProgress();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'audiobookshelf_get_listening_stats',
    'Get listening statistics from Audiobookshelf',
    async () => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.getListeningStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'audiobookshelf_search',
    'Search for audiobooks in an Audiobookshelf library',
    {
      libraryId: z.string().describe('Library ID to search in'),
      query: z.string().describe('Search query'),
    },
    async ({ libraryId, query }) => {
      if (!services.audiobookshelf?.configured) {
        return { content: [{ type: 'text' as const, text: 'Audiobookshelf is not configured' }] };
      }
      const data = await services.audiobookshelf.search(libraryId, query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── ROMm ─────────────────────────────────────────────────────────────────────

  server.tool(
    'romm_list_platforms',
    'List all gaming platforms in ROMm',
    async () => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.listPlatforms();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'romm_list_roms',
    'List ROMs in ROMm, optionally filtered by platform',
    { platformId: z.coerce.number().optional().describe('Filter by platform ID') },
    async ({ platformId }) => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.listRoms(platformId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'romm_get_rom',
    'Get details of a specific ROM in ROMm',
    { romId: z.coerce.number().describe('ROM ID') },
    async ({ romId }) => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.getRom(romId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'romm_search',
    'Search for ROMs in ROMm',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'romm_get_recently_added',
    'Get recently added ROMs from ROMm',
    async () => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.getRecentlyAdded();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'romm_list_collections',
    'List all ROM collections in ROMm',
    async () => {
      if (!services.romm?.configured) {
        return { content: [{ type: 'text' as const, text: 'ROMm is not configured' }] };
      }
      const data = await services.romm.listCollections();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Immich ───────────────────────────────────────────────────────────────────

  server.tool(
    'immich_list_albums',
    'List all Immich photo albums',
    async () => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.listAlbums();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_get_album',
    'Get details of a specific Immich album',
    { albumId: z.string().describe('Album ID') },
    async ({ albumId }) => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.getAlbum(albumId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_get_statistics',
    'Get Immich server statistics (photo/video counts, storage usage)',
    async () => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.getStatistics();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_search',
    'Search for photos and videos in Immich',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.search(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_list_people',
    'List recognized people in Immich',
    async () => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.listPeople();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_get_person_assets',
    'Get photos and videos of a specific person in Immich',
    { personId: z.string().describe('Person ID') },
    async ({ personId }) => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.getPersonAssets(personId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'immich_get_recent_assets',
    'Get recently added photos and videos from Immich',
    { count: z.number().optional().describe('Number of assets to return') },
    async ({ count }) => {
      if (!services.immich?.configured) {
        return { content: [{ type: 'text' as const, text: 'Immich is not configured' }] };
      }
      const data = await services.immich.getRecentAssets(count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── UniFi ────────────────────────────────────────────────────────────────────

  server.tool(
    'unifi_get_health',
    'Get UniFi network health status',
    async () => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.getHealth();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'unifi_list_clients',
    'List all connected UniFi network clients',
    async () => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.listClients();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'unifi_list_devices',
    'List all UniFi network devices (APs, switches, gateways)',
    async () => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.listDevices();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'unifi_get_device',
    'Get details of a specific UniFi device by MAC address',
    { mac: z.string().describe('Device MAC address') },
    async ({ mac }) => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.getDevice(mac);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'unifi_get_client_stats',
    'Get UniFi client connection statistics',
    async () => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.getClientStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'unifi_get_sysinfo',
    'Get UniFi controller system information',
    async () => {
      if (!services.unifi?.configured) {
        return { content: [{ type: 'text' as const, text: 'UniFi is not configured' }] };
      }
      const data = await services.unifi.getSysinfo();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Forgejo ──────────────────────────────────────────────────────────────────

  server.tool(
    'forgejo_list_repos',
    'List Forgejo repositories, optionally filtered by owner',
    { owner: z.string().optional().describe('Filter by repository owner') },
    async ({ owner }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.listRepos(owner);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_get_repo',
    'Get details of a specific Forgejo repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.getRepo(owner, repo);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_list_issues',
    'List issues in a Forgejo repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.string().optional().describe('Filter by state (open, closed)'),
    },
    async ({ owner, repo, state }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.listIssues(owner, repo, state);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_get_issue',
    'Get details of a specific issue in a Forgejo repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.coerce.number().describe('Issue number'),
    },
    async ({ owner, repo, index }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.getIssue(owner, repo, index);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_list_pull_requests',
    'List pull requests in a Forgejo repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      state: z.string().optional().describe('Filter by state (open, closed)'),
    },
    async ({ owner, repo, state }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.listPullRequests(owner, repo, state);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_get_pull_request',
    'Get details of a specific pull request in a Forgejo repository',
    {
      owner: z.string().describe('Repository owner'),
      repo: z.string().describe('Repository name'),
      index: z.coerce.number().describe('Pull request number'),
    },
    async ({ owner, repo, index }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.getPullRequest(owner, repo, index);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_list_orgs',
    'List all Forgejo organizations',
    async () => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.listOrgs();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'forgejo_search_repos',
    'Search for repositories in Forgejo',
    { query: z.string().describe('Search query') },
    async ({ query }) => {
      if (!services.forgejo?.configured) {
        return { content: [{ type: 'text' as const, text: 'Forgejo is not configured' }] };
      }
      const data = await services.forgejo.searchRepos(query);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // ── Pi-hole ─────────────────────────────────────────────────────────────────

  server.tool(
    'pihole_get_summary',
    'Get Pi-hole DNS statistics summary — queries today, blocked, percentage',
    async () => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getSummary();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_top_domains',
    'Get top permitted domains from Pi-hole',
    { count: z.number().optional().describe('Number of results (default 10)') },
    async ({ count }) => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getTopDomains(count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_top_blocked',
    'Get top blocked domains from Pi-hole',
    { count: z.number().optional().describe('Number of results (default 10)') },
    async ({ count }) => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getTopBlocked(count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_top_clients',
    'Get top DNS client devices from Pi-hole',
    { count: z.number().optional().describe('Number of results (default 10)') },
    async ({ count }) => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getTopClients(count);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_query_types',
    'Get DNS query type distribution from Pi-hole (A, AAAA, CNAME, etc.)',
    async () => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getQueryTypes();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_get_history',
    'Get Pi-hole DNS query history over time',
    async () => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getHistory();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_client_history',
    'Get per-client DNS query history from Pi-hole',
    async () => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getHistoryClients();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pihole_blocking_status',
    'Check if Pi-hole DNS blocking is currently enabled or disabled',
    async () => {
      if (!services.pihole?.configured) {
        return { content: [{ type: 'text' as const, text: 'Pi-hole is not configured' }] };
      }
      const data = await services.pihole.getBlockingStatus();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
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

  server.prompt(
    'system_health',
    'Diagnose the health of home infrastructure: network, containers, DNS, monitoring',
    async () => {
      const sections: string[] = ['Check the following FluxHaus infrastructure and report any issues:\n'];
      if (services.unifi?.configured) {
        sections.push('- Use unifi_get_health and unifi_list_devices to check network status');
      }
      if (services.portainer?.configured) {
        sections.push('- Use portainer_list_containers to check for stopped/unhealthy containers');
      }
      if (services.pihole?.configured) {
        sections.push('- Use pihole_get_summary to check DNS blocking stats');
      }
      if (services.prometheus?.configured) {
        sections.push('- Use prometheus_get_alerts to check for firing alerts');
      }
      if (services.grafana?.configured) {
        sections.push('- Use grafana_get_alerts to check dashboard alerts');
      }
      sections.push(
        '\nFor each service, report: OK / Warning / Critical with a brief explanation.',
      );
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: sections.join('\n'),
          },
        }],
      };
    },
  );

  server.prompt(
    'data_research',
    'Research home data: query InfluxDB, Prometheus, Grafana, or HA history to answer analytical questions',
    {
      question: z.string().describe(
        'The research question (e.g. "average time living room lights were on last month")',
      ),
    },
    async ({ question }) => {
      const availableSources: string[] = [];
      if (services.influxdb?.configured) {
        availableSources.push(
          '## InfluxDB (primary time-series store)\n'
          + '- Bucket: "home_assistant" — contains all HA entity state changes\n'
          + '- Use influxdb_list_measurements to discover available measurements\n'
          + '- Use influxdb_list_buckets to see all buckets\n'
          + '- Use influxdb_query with Flux language to query data\n'
          + '- HA stores data with tags: entity_id, domain, friendly_name\n'
          + '- Fields typically include: value (numeric) or state (string)\n'
          + '### Example Flux queries:\n'
          + '```\n'
          + '// Count hours a light was "on" in the past 30 days\n'
          + 'from(bucket: "home_assistant")\n'
          + '  |> range(start: -30d)\n'
          + '  |> filter(fn: (r) => r.entity_id == "light.living_room")\n'
          + '  |> filter(fn: (r) => r._field == "state")\n'
          + '  |> filter(fn: (r) => r._value == "on")\n'
          + '  |> elapsed(unit: 1h)\n'
          + '  |> sum(column: "elapsed")\n'
          + '```\n'
          + '```\n'
          + '// Average temperature over the past week\n'
          + 'from(bucket: "home_assistant")\n'
          + '  |> range(start: -7d)\n'
          + '  |> filter(fn: (r) => r.entity_id == "sensor.bedroom_temperature")\n'
          + '  |> filter(fn: (r) => r._field == "value")\n'
          + '  |> mean()\n'
          + '```',
        );
      }
      if (services.prometheus?.configured) {
        availableSources.push(
          '## Prometheus (metrics & alerts)\n'
          + '- Use prometheus_get_targets to see what is being monitored\n'
          + '- Use prometheus_query for instant queries (PromQL)\n'
          + '- Use prometheus_query_range for time-range queries\n'
          + '- Use prometheus_get_rules and prometheus_get_alerts for alert status',
        );
      }
      if (services.grafana?.configured) {
        availableSources.push(
          '## Grafana (dashboards & visualization)\n'
          + '- Use grafana_list_dashboards to discover pre-built dashboards\n'
          + '- Use grafana_get_dashboard to see panel queries (reuse them!)\n'
          + '- Use grafana_query_datasource to run queries against any datasource',
        );
      }
      availableSources.push(
        '## Home Assistant History (direct entity history)\n'
        + '- Use get_entity_history for state history of specific entities\n'
        + '- Use list_entities to discover entity IDs (filter by domain)\n'
        + '- Use get_logbook for human-readable event logs\n'
        + '- Use render_template for complex HA Jinja2 calculations',
      );

      const promptText = 'Research the following question using the available data sources:\n\n'
        + `**Question:** ${question}\n\n`
        + '## Approach\n'
        + '1. First, discover what data is available (list measurements, entities, dashboards)\n'
        + '2. Then, formulate and run queries to gather the data\n'
        + '3. Finally, analyze the results and provide a clear answer with numbers\n\n'
        + '## Available Data Sources\n\n'
        + `${availableSources.join('\n\n')}\n\n`
        + '## Guidelines\n'
        + '- Start with discovery tools before writing queries\n'
        + '- If a Flux/PromQL query fails, try adjusting field names or filters\n'
        + '- Show your work: include the queries you ran and key data points\n'
        + '- Provide a clear, specific answer with units and time ranges';

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

  return server;
}
