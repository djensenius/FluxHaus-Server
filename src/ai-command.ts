import Anthropic from '@anthropic-ai/sdk';
import OpenAI, { AzureOpenAI } from 'openai';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { FluxHausServices } from './services';
import { deleteMemory, saveMemory } from './memory';
import logger from './logger';

const aiLogger = logger.child({ subsystem: 'ai' });

// ── Shared types ─────────────────────────────────────────────────────────────

export interface ToolResultImage {
  base64: string;
  mediaType: string;
}

export interface ToolResult {
  text: string;
  images?: ToolResultImage[];
}

// ── Shared system prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = 'You are FluxHaus, an AI assistant for a smart home. '
  + 'Always use your tools to fulfill requests about the home — never guess '
  + 'device states or act without calling a tool first. For status queries, '
  + 'call the relevant get_ tools (e.g. get_car_status, get_robot_status, '
  + 'get_appliance_status, get_entity_state). For questions that require '
  + 'up-to-date information from the internet (news, weather, facts, prices, '
  + 'etc.), use the web_search tool. To look at images or camera feeds, use '
  + 'the view_image tool. To create images from descriptions, use generate_image. '
  + 'For general conversation that doesn\'t involve devices, home data, images, '
  + 'or web lookups, you may respond directly. '
  + 'After gathering real data from tools, reply with a concise, friendly summary.';

// ── Provider-agnostic tool definitions ───────────────────────────────────────

interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'lock_car',
    description: 'Lock the car doors',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unlock_car',
    description: 'Unlock the car doors',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_car',
    description: 'Start the car climate control',
    parameters: {
      type: 'object',
      properties: {
        temperature: {
          type: 'number',
          description: 'Target temperature in Celsius (16–30)',
          minimum: 16,
          maximum: 30,
        },
        defrost: { type: 'boolean', description: 'Enable front windshield defrost' },
        heatedFeatures: { type: 'boolean', description: 'Enable heated steering wheel and mirrors' },
        seatFL: {
          type: 'number', description: 'Front-left seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatFR: {
          type: 'number', description: 'Front-right seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatRL: {
          type: 'number', description: 'Rear-left seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
        seatRR: {
          type: 'number', description: 'Rear-right seat heater level (0=off, 1-3)', minimum: 0, maximum: 3,
        },
      },
    },
  },
  {
    name: 'stop_car',
    description: 'Stop the car climate control',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'resync_car',
    description: 'Force a status sync from the car',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'start_robot',
    description: 'Start a robot vacuum',
    parameters: {
      type: 'object',
      properties: {
        robot: {
          type: 'string',
          description: 'Which robot to start',
          enum: ['broombot', 'mopbot'],
        },
      },
      required: ['robot'],
    },
  },
  {
    name: 'stop_robot',
    description: 'Stop a robot vacuum and return it to base',
    parameters: {
      type: 'object',
      properties: {
        robot: {
          type: 'string',
          description: 'Which robot to stop',
          enum: ['broombot', 'mopbot'],
        },
      },
      required: ['robot'],
    },
  },
  {
    name: 'list_entities',
    description: 'List Home Assistant entities, optionally filtered by domain (light, switch, scene, climate, etc.)',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Entity domain filter (e.g. light, switch, scene, climate). Omit to list all.',
        },
      },
    },
  },
  {
    name: 'get_entity_state',
    description: 'Get the current state and attributes of a Home Assistant entity',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID (e.g. light.bedroom, switch.porch)' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'call_ha_service',
    description: 'Call a Home Assistant service (e.g. turn on a light, toggle a switch, set climate temperature)',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain (e.g. light, switch, climate, scene)' },
        service: { type: 'string', description: 'Service name (e.g. turn_on, turn_off, toggle)' },
        entity_id: { type: 'string', description: 'Target entity ID (e.g. light.bedroom)' },
        brightness_pct: { type: 'number', description: 'Brightness percentage (0-100), for lights only' },
        color_temp: { type: 'number', description: 'Color temperature in mireds, for lights only' },
        temperature: { type: 'number', description: 'Target temperature, for climate entities only' },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'get_car_status',
    description: 'Get the current car status: battery level, EV range, doors, locks, HVAC, trunk, hood, odometer.'
      + ' For historical driving stats (distance over time), query InfluxDB. Home Assistant logs odometer in the'
      + ' "home_assistant" bucket (entity_id "sensor.*_odometer"). Also available in the default bucket as "car"'
      + ' measurement (fields: odometer, battery_level, ev_range, total_range, charging; tag: vehicle).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_robot_status',
    description: 'Get the status of robot vacuums (Broombot and Mopbot): battery, running, charging, bin full',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_appliance_status',
    description: 'Get the status of home appliances: washer, dryer (Miele), and dishwasher (HomeConnect)',
    parameters: { type: 'object', properties: {} },
  },

  // ── Home Assistant History/Calendar ──
  {
    name: 'get_entity_history',
    description: 'Get state history for a Home Assistant entity over a time period',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity ID' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601, optional)' },
      },
      required: ['entity_id', 'start'],
    },
  },
  {
    name: 'get_logbook',
    description: 'Get the Home Assistant logbook — a human-readable event log',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601, optional)' },
        entity_id: { type: 'string', description: 'Filter to specific entity (optional)' },
      },
      required: ['start'],
    },
  },
  {
    name: 'list_calendars',
    description: 'List all available calendars across Home Assistant, iCloud, Microsoft 365, and subscriptions',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_calendar_events',
    description: 'Get events from a specific calendar for a date range',
    parameters: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', description: 'Calendar ID from list_calendars' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
      },
      required: ['calendar_id', 'start', 'end'],
    },
  },
  {
    name: 'list_events',
    description: 'List calendar events for a date range, optionally across all configured calendars',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
        calendarId: { type: 'string', description: 'Calendar ID from list_calendars (optional)' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'get_today_agenda',
    description: 'Get today’s agenda, using the default calendar if one is configured',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a calendar event in the specified or default writable calendar',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
        calendarId: { type: 'string', description: 'Calendar ID from list_calendars (optional)' },
        allDay: { type: 'boolean', description: 'Whether this is an all-day event' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        timezone: { type: 'string', description: 'IANA timezone name' },
        url: { type: 'string', description: 'Related URL' },
      },
      required: ['title', 'start', 'end'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Update an existing calendar event by event ID',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event ID from list_events or create_calendar_event' },
        title: { type: 'string', description: 'Updated event title' },
        start: { type: 'string', description: 'Updated start time (ISO 8601)' },
        end: { type: 'string', description: 'Updated end time (ISO 8601)' },
        allDay: { type: 'boolean', description: 'Whether this is an all-day event' },
        description: { type: 'string', description: 'Updated event description' },
        location: { type: 'string', description: 'Updated event location' },
        timezone: { type: 'string', description: 'Updated IANA timezone name' },
        url: { type: 'string', description: 'Updated related URL' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a calendar event by event ID',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event ID from list_events or create_calendar_event' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'render_template',
    description: 'Render a Home Assistant Jinja2 template',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Jinja2 template string' },
      },
      required: ['template'],
    },
  },

  // ── Plex ──
  {
    name: 'plex_get_sessions',
    description: 'Get current Plex streaming sessions (who is watching what)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'plex_get_recently_added',
    description: 'Get recently added media from Plex',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'plex_get_libraries',
    description: 'List all Plex libraries (Movies, TV Shows, Music, etc.)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'plex_search',
    description: 'Search Plex for movies, shows, music, etc.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plex_get_on_deck',
    description: 'Get Plex on-deck items — media that is in progress',
    parameters: { type: 'object', properties: {} },
  },

  // ── Overseerr ──
  {
    name: 'overseerr_search',
    description: 'Search for movies/TV shows to request via Overseerr',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'overseerr_get_requests',
    description: 'Get pending media requests from Overseerr',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'overseerr_request_media',
    description: 'Request a movie or TV show via Overseerr',
    parameters: {
      type: 'object',
      properties: {
        mediaType: { type: 'string', description: 'Type of media', enum: ['movie', 'tv'] },
        mediaId: { type: 'number', description: 'TMDB ID of the media' },
      },
      required: ['mediaType', 'mediaId'],
    },
  },
  {
    name: 'overseerr_approve_request',
    description: 'Approve a pending media request in Overseerr',
    parameters: {
      type: 'object',
      properties: {
        requestId: { type: 'number', description: 'Request ID to approve' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'overseerr_get_status',
    description: 'Get the current Overseerr server status',
    parameters: { type: 'object', properties: {} },
  },

  // ── Tautulli ──
  {
    name: 'tautulli_get_activity',
    description: 'Get current Plex streaming activity via Tautulli',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tautulli_get_history',
    description: 'Get Plex watch history via Tautulli',
    parameters: {
      type: 'object',
      properties: {
        length: { type: 'number', description: 'Number of items (default 10)' },
      },
    },
  },
  {
    name: 'tautulli_get_libraries',
    description: 'Get Plex library statistics from Tautulli',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tautulli_get_recently_added',
    description: 'Get recently added media from Tautulli',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of items' },
      },
    },
  },
  {
    name: 'tautulli_get_home_stats',
    description: 'Get Tautulli home page statistics (most watched, popular, etc.)',
    parameters: { type: 'object', properties: {} },
  },

  // ── Grafana ──
  {
    name: 'grafana_list_dashboards',
    description: 'List all Grafana dashboards',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'grafana_get_dashboard',
    description: 'Get a Grafana dashboard by UID',
    parameters: {
      type: 'object',
      properties: { uid: { type: 'string', description: 'Dashboard UID' } },
      required: ['uid'],
    },
  },
  {
    name: 'grafana_list_datasources',
    description: 'List all Grafana data sources',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'grafana_query_datasource',
    description: 'Query a Grafana data source directly',
    parameters: {
      type: 'object',
      properties: {
        datasourceId: { type: 'number', description: 'Data source ID' },
        query_json: { type: 'string', description: 'Query as JSON string' },
      },
      required: ['datasourceId', 'query_json'],
    },
  },
  {
    name: 'grafana_get_annotations',
    description: 'Get Grafana annotations, optionally filtered by time range',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start time as ISO 8601 timestamp' },
        to: { type: 'string', description: 'End time as ISO 8601 timestamp' },
      },
    },
  },
  {
    name: 'grafana_get_alerts',
    description: 'Get active Grafana alerts',
    parameters: { type: 'object', properties: {} },
  },

  // ── Portainer ──
  {
    name: 'portainer_list_endpoints',
    description: 'List all Portainer endpoints (Docker environments)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'portainer_list_containers',
    description: 'List Docker containers on a Portainer endpoint',
    parameters: {
      type: 'object',
      properties: {
        endpointId: { type: 'number', description: 'Portainer endpoint ID' },
      },
      required: ['endpointId'],
    },
  },
  {
    name: 'portainer_list_stacks',
    description: 'List Docker stacks via Portainer',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'portainer_get_container',
    description: 'Get details of a specific Docker container',
    parameters: {
      type: 'object',
      properties: {
        endpointId: { type: 'number', description: 'Portainer endpoint ID' },
        containerId: { type: 'string', description: 'Docker container ID' },
      },
      required: ['endpointId', 'containerId'],
    },
  },
  {
    name: 'portainer_container_action',
    description: 'Perform an action on a Docker container (start, stop, restart, kill)',
    parameters: {
      type: 'object',
      properties: {
        endpointId: { type: 'number', description: 'Portainer endpoint ID' },
        containerId: { type: 'string', description: 'Docker container ID' },
        action: { type: 'string', description: 'Action: start, stop, restart, or kill' },
      },
      required: ['endpointId', 'containerId', 'action'],
    },
  },

  // ── Prometheus ──
  {
    name: 'prometheus_query',
    description: 'Execute an instant PromQL query',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'PromQL expression' },
      },
      required: ['query'],
    },
  },
  {
    name: 'prometheus_query_range',
    description: 'Execute a range PromQL query over a time period',
    parameters: {
      type: 'object',
      properties: {
        promql: { type: 'string', description: 'PromQL query expression' },
        start: { type: 'string', description: 'Start time (ISO 8601 or Unix epoch)' },
        end: { type: 'string', description: 'End time (ISO 8601 or Unix epoch)' },
        step: { type: 'string', description: 'Query step (e.g. 15s, 1m, 5m)' },
      },
      required: ['promql', 'start', 'end'],
    },
  },
  {
    name: 'prometheus_get_targets',
    description: 'Get all Prometheus scrape targets and their status',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'prometheus_get_alerts',
    description: 'Get active Prometheus alerts',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'prometheus_get_rules',
    description: 'Get all Prometheus alerting and recording rules',
    parameters: { type: 'object', properties: {} },
  },

  // ── Komga ──
  {
    name: 'komga_list_libraries',
    description: 'List all Komga comic/manga libraries',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'komga_list_series',
    description: 'List series in Komga, optionally filtered by library',
    parameters: {
      type: 'object',
      properties: {
        libraryId: { type: 'string', description: 'Filter by library ID' },
      },
    },
  },
  {
    name: 'komga_get_series',
    description: 'Get details of a specific Komga series',
    parameters: {
      type: 'object',
      properties: { seriesId: { type: 'string', description: 'Series ID' } },
      required: ['seriesId'],
    },
  },
  {
    name: 'komga_list_books',
    description: 'List books in a Komga series',
    parameters: {
      type: 'object',
      properties: { seriesId: { type: 'string', description: 'Series ID' } },
      required: ['seriesId'],
    },
  },
  {
    name: 'komga_search',
    description: 'Search Komga for series or books',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'komga_get_recently_added',
    description: 'Get recently added books/comics from Komga',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'komga_get_on_deck',
    description: 'Get on-deck books from Komga (in progress)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'komga_get_read_progress',
    description: 'Get read progress for a Komga series',
    parameters: {
      type: 'object',
      properties: { seriesId: { type: 'string', description: 'Series ID' } },
      required: ['seriesId'],
    },
  },

  // ── Booklore ──
  {
    name: 'booklore_list_shelves',
    description: 'List all Booklore shelves',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'booklore_list_books',
    description: 'List books in Booklore, optionally filtered by shelf',
    parameters: {
      type: 'object',
      properties: { shelfId: { type: 'string', description: 'Filter by shelf ID' } },
    },
  },
  {
    name: 'booklore_get_book',
    description: 'Get details of a specific book in Booklore',
    parameters: {
      type: 'object',
      properties: { bookId: { type: 'string', description: 'Book ID' } },
      required: ['bookId'],
    },
  },
  {
    name: 'booklore_search',
    description: 'Search books in the Booklore library',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },

  // ── Audiobookshelf ──
  {
    name: 'audiobookshelf_list_libraries',
    description: 'List all Audiobookshelf libraries',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'audiobookshelf_list_items',
    description: 'List items in an Audiobookshelf library',
    parameters: {
      type: 'object',
      properties: { libraryId: { type: 'string', description: 'Library ID' } },
      required: ['libraryId'],
    },
  },
  {
    name: 'audiobookshelf_get_item',
    description: 'Get details of a specific Audiobookshelf item',
    parameters: {
      type: 'object',
      properties: { itemId: { type: 'string', description: 'Item ID' } },
      required: ['itemId'],
    },
  },
  {
    name: 'audiobookshelf_get_in_progress',
    description: 'Get audiobooks/podcasts currently in progress',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'audiobookshelf_search',
    description: 'Search Audiobookshelf library',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        libraryId: { type: 'string', description: 'Library ID to search' },
      },
      required: ['query', 'libraryId'],
    },
  },
  {
    name: 'audiobookshelf_get_listening_stats',
    description: 'Get listening statistics from Audiobookshelf',
    parameters: { type: 'object', properties: {} },
  },

  // ── ROMm ──
  {
    name: 'romm_list_platforms',
    description: 'List available gaming platforms in ROMm',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'romm_list_roms',
    description: 'List ROMs in ROMm, optionally filtered by platform',
    parameters: {
      type: 'object',
      properties: { platformId: { type: 'number', description: 'Filter by platform ID' } },
    },
  },
  {
    name: 'romm_get_rom',
    description: 'Get details of a specific ROM in ROMm',
    parameters: {
      type: 'object',
      properties: { romId: { type: 'number', description: 'ROM ID' } },
      required: ['romId'],
    },
  },
  {
    name: 'romm_search',
    description: 'Search for ROMs/games in the ROMm library',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'romm_get_recently_added',
    description: 'Get recently added ROMs from ROMm',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'romm_list_collections',
    description: 'List all ROM collections in ROMm',
    parameters: { type: 'object', properties: {} },
  },

  // ── Immich ──
  {
    name: 'immich_list_albums',
    description: 'List photo albums from Immich',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'immich_get_album',
    description: 'Get details of a specific Immich album',
    parameters: {
      type: 'object',
      properties: { albumId: { type: 'string', description: 'Album ID' } },
      required: ['albumId'],
    },
  },
  {
    name: 'immich_get_statistics',
    description: 'Get Immich photo library statistics',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'immich_search',
    description: 'Search photos in Immich',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'immich_list_people',
    description: 'List recognized people in Immich',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'immich_get_person_assets',
    description: 'Get photos and videos of a specific person in Immich',
    parameters: {
      type: 'object',
      properties: { personId: { type: 'string', description: 'Person ID' } },
      required: ['personId'],
    },
  },
  {
    name: 'immich_get_recent_assets',
    description: 'Get recently added photos and videos from Immich',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of assets to return' } },
    },
  },

  // ── UniFi ──
  {
    name: 'unifi_get_health',
    description: 'Get UniFi network health overview',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unifi_list_clients',
    description: 'List connected UniFi network clients',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unifi_list_devices',
    description: 'List UniFi network devices (APs, switches, gateways)',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unifi_get_device',
    description: 'Get details of a specific UniFi device by MAC address',
    parameters: {
      type: 'object',
      properties: { mac: { type: 'string', description: 'Device MAC address' } },
      required: ['mac'],
    },
  },
  {
    name: 'unifi_get_client_stats',
    description: 'Get UniFi client connection statistics',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'unifi_get_sysinfo',
    description: 'Get UniFi controller system information',
    parameters: { type: 'object', properties: {} },
  },

  // ── Forgejo ──
  {
    name: 'forgejo_list_repos',
    description: 'List Forgejo git repositories',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'forgejo_get_repo',
    description: 'Get details of a specific Forgejo repository',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'forgejo_list_issues',
    description: 'List issues in a Forgejo repository',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state (open, closed)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'forgejo_get_issue',
    description: 'Get details of a specific issue in a Forgejo repository',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        index: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'index'],
    },
  },
  {
    name: 'forgejo_list_pull_requests',
    description: 'List pull requests in a Forgejo repository',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state (open, closed)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'forgejo_get_pull_request',
    description: 'Get details of a specific Forgejo pull request',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        index: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'index'],
    },
  },
  {
    name: 'forgejo_list_orgs',
    description: 'List all Forgejo organizations',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'forgejo_search_repos',
    description: 'Search for repositories in Forgejo',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },

  // ── Pi-hole ──
  {
    name: 'pihole_get_summary',
    description: 'Get Pi-hole DNS blocking summary stats',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pihole_top_domains',
    description: 'Get top permitted domains from Pi-hole',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of results (default 10)' } },
    },
  },
  {
    name: 'pihole_top_blocked',
    description: 'Get top blocked domains from Pi-hole',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of results (default 10)' } },
    },
  },
  {
    name: 'pihole_top_clients',
    description: 'Get top DNS client devices from Pi-hole',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of results (default 10)' } },
    },
  },
  {
    name: 'pihole_query_types',
    description: 'Get DNS query type distribution from Pi-hole',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pihole_get_history',
    description: 'Get Pi-hole DNS query history over time',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pihole_client_history',
    description: 'Get per-client DNS query history from Pi-hole',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pihole_blocking_status',
    description: 'Get Pi-hole blocking status',
    parameters: { type: 'object', properties: {} },
  },

  // ── InfluxDB ──
  {
    name: 'influxdb_query',
    description: 'Query InfluxDB with a Flux query',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Flux query string' } },
      required: ['query'],
    },
  },
  {
    name: 'influxdb_list_buckets',
    description: 'List all InfluxDB buckets',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'influxdb_list_measurements',
    description: 'List all InfluxDB measurements in a bucket (HA data is in "home_assistant" bucket)',
    parameters: {
      type: 'object',
      properties: {
        bucket: { type: 'string', description: 'Bucket name (e.g. "home_assistant"). Defaults to configured bucket.' },
      },
    },
  },
  // ── Kagi Web Search ──
  {
    name: 'web_search',
    description: 'Search the web using Kagi. Use this to look up current information, '
      + 'news, weather, facts, or anything requiring up-to-date knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        limit: { type: 'string', description: 'Maximum number of results to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch the text content of a web page. Use this to read articles, '
      + 'documentation, or any URL from search results. Returns readable text.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the web page to read' },
      },
      required: ['url'],
    },
  },
  {
    name: 'summarize_url',
    description: 'Summarize a web page, article, PDF, or YouTube video using Kagi. '
      + 'Best for long content you need a quick overview of.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to summarize (web page, PDF, YouTube video, etc.)' },
        engine: {
          type: 'string',
          description: 'Summarizer engine: agnes (fast), cecil (balanced, default), muriel (high-quality)',
          enum: ['agnes', 'cecil', 'muriel'],
        },
      },
      required: ['url'],
    },
  },
  // ── Vision & Image Generation ──
  {
    name: 'view_image',
    description: 'Fetch and analyze an image from a URL. Use this to look at camera '
      + 'feeds, photos, or any image the user asks about.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the image to view' },
        question: {
          type: 'string',
          description: 'Optional question about the image (e.g. "What do you see?")',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'generate_image',
    description: 'Generate an image from a text description using DALL·E 3. '
      + 'Returns a URL to the generated image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        size: { type: 'string', description: 'Image size', enum: ['1024x1024', '1792x1024', '1024x1792'] },
        quality: { type: 'string', description: 'Image quality', enum: ['standard', 'hd'] },
      },
      required: ['prompt'],
    },
  },

  // ── User Memory ──
  {
    name: 'save_memory',
    description: 'Save a fact or preference about the user to remember across conversations. '
      + 'Use when the user shares personal preferences, important facts, or asks you to remember something.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or preference to remember' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a previously saved memory by its ID. Use when the user asks you to forget something.',
    parameters: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'The ID of the memory to delete' },
      },
      required: ['memory_id'],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 30_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool "${label}" timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Public API — returns plain text (backward compat for tests and callers)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  services: FluxHausServices,
  userSub?: string,
): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const result = await withTimeout(executeToolInner(name, args, services, userSub), TOOL_TIMEOUT_MS, name);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    aiLogger.error({ tool: name, err: msg }, 'Tool execution failed');
    return `Error: ${msg}`;
  }
}

// Internal — returns rich result with optional images (used by agentic loops)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeToolRich(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  services: FluxHausServices,
  userSub?: string,
): Promise<ToolResult> {
  try {
    // Image-aware tools return ToolResult with images
    if (name === 'view_image') {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return await withTimeout(executeViewImage(args, services), TOOL_TIMEOUT_MS, name);
    }
    if (name === 'generate_image') {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      return await withTimeout(executeGenerateImage(args), TOOL_TIMEOUT_MS, name);
    }
    // All other tools return plain text
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const text = await withTimeout(executeToolInner(name, args, services, userSub), TOOL_TIMEOUT_MS, name);
    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    aiLogger.error({ tool: name, err: msg }, 'Tool execution failed');
    return { text: `Error: ${msg}` };
  }
}

async function executeViewImage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  services: FluxHausServices,
): Promise<ToolResult> {
  const { url } = args;
  if (!url) throw new Error('url is required');

  // If the URL is a relative camera path, resolve against the configured camera URL
  let resolvedUrl = url;
  if (services.cameraURL && !url.startsWith('http')) {
    resolvedUrl = `${services.cameraURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
  }

  aiLogger.info({ url: resolvedUrl }, 'Fetching image for vision');
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const image = await fetchImageAsBase64(resolvedUrl);
  const question = args.question || 'Describe what you see in this image.';

  return {
    text: `Image fetched from ${resolvedUrl}. ${question}`,
    images: [image],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeGenerateImage(args: Record<string, any>): Promise<ToolResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { text: 'Image generation is not configured (set OPENAI_API_KEY for DALL·E 3)' };
  }

  const { prompt } = args;
  if (!prompt) throw new Error('prompt is required');

  const size = args.size || '1024x1024';
  const quality = args.quality || 'standard';

  aiLogger.info({ prompt: prompt.substring(0, 100), size, quality }, 'Generating image with DALL·E 3');

  const client = new OpenAI({ apiKey });
  const response = await client.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size: size as '1024x1024' | '1792x1024' | '1024x1792',
    quality: quality as 'standard' | 'hd',
    response_format: 'url',
  });

  const imageUrl = response.data?.[0]?.url;
  const revisedPrompt = response.data?.[0]?.revised_prompt;

  if (!imageUrl) {
    return { text: 'Image generation failed — no image URL returned.' };
  }

  return {
    text: `Image generated successfully.\n\nURL: ${imageUrl}\n\n`
      + `Revised prompt: ${revisedPrompt || prompt}\n\n`
      + 'Include this image URL in your response using markdown: '
      + `![Generated image](${imageUrl})`,
  };
}

async function fetchImageAsBase64(url: string): Promise<ToolResultImage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const mediaType = contentType.split(';')[0].trim();
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { base64, mediaType };
  } finally {
    clearTimeout(timer);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeToolInner(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  services: FluxHausServices,
  userSub?: string,
): Promise<string> {
  const {
    car, broombot, mopbot, homeAssistantClient, mieleClient, dishwasher,
  } = services;

  switch (name) {
  case 'lock_car':
    return car.lock();

  case 'unlock_car':
    return car.unlock();

  case 'start_car': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: Record<string, any> = {};
    if (args.temperature !== undefined) config.temperature = args.temperature;
    if (args.defrost !== undefined) config.defrost = args.defrost;
    if (args.heatedFeatures !== undefined) config.heatedFeatures = args.heatedFeatures;
    if (
      args.seatFL !== undefined || args.seatFR !== undefined
        || args.seatRL !== undefined || args.seatRR !== undefined
    ) {
      config.seatClimateSettings = {
        driverSeat: args.seatFL ?? 0,
        passengerSeat: args.seatFR ?? 0,
        rearLeftSeat: args.seatRL ?? 0,
        rearRightSeat: args.seatRR ?? 0,
      };
    }
    const result = await car.start(config);
    setTimeout(() => { car.resync().catch(() => {}); }, 5000);
    return result;
  }

  case 'stop_car': {
    const result = await car.stop();
    setTimeout(() => { car.resync().catch(() => {}); }, 5000);
    return result;
  }

  case 'resync_car':
    await car.resync();
    return 'Car resync initiated';

  case 'start_robot':
    if (args.robot === 'broombot') {
      await broombot.turnOn();
    } else {
      await mopbot.turnOn();
    }
    return `${args.robot} started`;

  case 'stop_robot':
    if (args.robot === 'broombot') {
      await broombot.turnOff();
    } else {
      await mopbot.turnOff();
    }
    return `${args.robot} returning to base`;

  case 'list_entities': {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allStates: any[] = await homeAssistantClient.getState('');
    let entities = Array.isArray(allStates) ? allStates : [];
    if (args.domain) {
      entities = entities.filter((s) => s.entity_id?.startsWith(`${args.domain}.`));
    }
    const result = entities.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      name: s.attributes?.friendly_name ?? s.entity_id,
    }));
    return JSON.stringify({ entities: result }, null, 2);
  }

  case 'get_entity_state': {
    const state = await homeAssistantClient.getState(args.entity_id);
    return JSON.stringify({
      entity_id: state.entity_id,
      state: state.state,
      attributes: state.attributes,
    }, null, 2);
  }

  case 'call_ha_service': {
    const {
      domain, service, entity_id: entityId, ...extraData
    } = args;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serviceData: Record<string, any> = { entity_id: entityId };
    Object.entries(extraData).forEach(([key, value]) => {
      if (value !== undefined) { serviceData[key] = value; }
    });
    await homeAssistantClient.callService(domain, service, serviceData);
    return `Called ${domain}.${service} on ${entityId}`;
  }

  case 'get_car_status':
    return JSON.stringify({ status: car.status, odometer: car.odometer }, null, 2);

  case 'get_robot_status':
    return JSON.stringify({
      broombot: broombot.cachedStatus,
      mopbot: mopbot.cachedStatus,
    }, null, 2);

  case 'get_appliance_status':
    return JSON.stringify({
      washer: mieleClient.washer,
      dryer: mieleClient.dryer,
      dishwasher: dishwasher.dishwasher,
    }, null, 2);

  case 'list_calendars':
    return JSON.stringify(await services.calendar?.listCalendars(userSub) || [], null, 2);
  case 'get_calendar_events':
    return JSON.stringify(
      await services.calendar?.listEvents(args.start, args.end, args.calendar_id, userSub) || [],
      null,
      2,
    );
  case 'list_events':
    return JSON.stringify(
      await services.calendar?.listEvents(args.start, args.end, args.calendarId, userSub) || [],
      null,
      2,
    );
  case 'get_today_agenda':
    return JSON.stringify(await services.calendar?.getTodayAgenda(userSub) || [], null, 2);
  case 'create_calendar_event':
    if (!services.calendar) return 'Calendar service is not configured';
    return JSON.stringify(
      await services.calendar?.createEvent({
        calendarId: args.calendarId,
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: args.allDay,
        description: args.description,
        location: args.location,
        timezone: args.timezone,
        url: args.url,
      }, userSub),
      null,
      2,
    );
  case 'update_calendar_event':
    if (!services.calendar) return 'Calendar service is not configured';
    return JSON.stringify(
      await services.calendar?.updateEvent(args.eventId, {
        title: args.title,
        start: args.start,
        end: args.end,
        allDay: args.allDay,
        description: args.description,
        location: args.location,
        timezone: args.timezone,
        url: args.url,
      }, userSub),
      null,
      2,
    );
  case 'delete_calendar_event':
    if (!services.calendar) return 'Calendar service is not configured';
    await services.calendar?.deleteEvent(args.eventId, userSub);
    return `Deleted calendar event: ${args.eventId}`;

  // ── Plex ──
  case 'plex_get_sessions':
    if (!services.plex?.configured) return 'Plex is not configured';
    return JSON.stringify(await services.plex.getSessions(), null, 2);
  case 'plex_get_libraries':
    if (!services.plex?.configured) return 'Plex is not configured';
    return JSON.stringify(await services.plex.getLibraries(), null, 2);
  case 'plex_get_recently_added':
    if (!services.plex?.configured) return 'Plex is not configured';
    return JSON.stringify(await services.plex.getRecentlyAdded(), null, 2);
  case 'plex_search':
    if (!services.plex?.configured) return 'Plex is not configured';
    return JSON.stringify(await services.plex.search(args.query), null, 2);

  // ── Overseerr ──
  case 'overseerr_search':
    if (!services.overseerr?.configured) return 'Overseerr is not configured';
    return JSON.stringify(await services.overseerr.search(args.query), null, 2);
  case 'overseerr_get_requests':
    if (!services.overseerr?.configured) return 'Overseerr is not configured';
    return JSON.stringify(await services.overseerr.getRequests(), null, 2);
  case 'overseerr_request_media':
    if (!services.overseerr?.configured) return 'Overseerr is not configured';
    return JSON.stringify(
      await services.overseerr.requestMedia(args.mediaType, args.mediaId),
      null,
      2,
    );

  // ── Tautulli ──
  case 'tautulli_get_activity':
    if (!services.tautulli?.configured) return 'Tautulli is not configured';
    return JSON.stringify(await services.tautulli.getActivity(), null, 2);
  case 'tautulli_get_history':
    if (!services.tautulli?.configured) return 'Tautulli is not configured';
    return JSON.stringify(
      await services.tautulli.getHistory(args.length),
      null,
      2,
    );

  // ── Grafana ──
  case 'grafana_list_dashboards':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(await services.grafana.listDashboards(), null, 2);
  case 'grafana_get_dashboard':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(await services.grafana.getDashboard(args.uid), null, 2);
  case 'grafana_list_datasources':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(await services.grafana.listDatasources(), null, 2);
  case 'grafana_query_datasource':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(
      await services.grafana.queryDatasource(args.datasourceId, JSON.parse(args.query_json)),
      null,
      2,
    );
  case 'grafana_get_annotations':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(await services.grafana.getAnnotations(args.from, args.to), null, 2);
  case 'grafana_get_alerts':
    if (!services.grafana?.configured) return 'Grafana is not configured';
    return JSON.stringify(await services.grafana.getAlerts(), null, 2);

  // ── Portainer ──
  case 'portainer_list_endpoints':
    if (!services.portainer?.configured) return 'Portainer is not configured';
    return JSON.stringify(await services.portainer.listEndpoints(), null, 2);
  case 'portainer_list_containers':
    if (!services.portainer?.configured) return 'Portainer is not configured';
    return JSON.stringify(
      await services.portainer.listContainers(args.endpointId),
      null,
      2,
    );
  case 'portainer_list_stacks':
    if (!services.portainer?.configured) return 'Portainer is not configured';
    return JSON.stringify(await services.portainer.listStacks(), null, 2);
  case 'portainer_get_container':
    if (!services.portainer?.configured) return 'Portainer is not configured';
    return JSON.stringify(
      await services.portainer.getContainer(args.endpointId, args.containerId),
      null,
      2,
    );
  case 'portainer_container_action':
    if (!services.portainer?.configured) return 'Portainer is not configured';
    return JSON.stringify(
      await services.portainer.containerAction(args.endpointId, args.containerId, args.action),
      null,
      2,
    );

  // ── Prometheus ──
  case 'prometheus_query':
    if (!services.prometheus?.configured) return 'Prometheus is not configured';
    return JSON.stringify(await services.prometheus.query(args.query), null, 2);
  case 'prometheus_query_range':
    if (!services.prometheus?.configured) return 'Prometheus is not configured';
    return JSON.stringify(
      await services.prometheus.queryRange(args.promql, args.start, args.end, args.step),
      null,
      2,
    );
  case 'prometheus_get_targets':
    if (!services.prometheus?.configured) return 'Prometheus is not configured';
    return JSON.stringify(await services.prometheus.getTargets(), null, 2);
  case 'prometheus_get_alerts':
    if (!services.prometheus?.configured) return 'Prometheus is not configured';
    return JSON.stringify(await services.prometheus.getAlerts(), null, 2);
  case 'prometheus_get_rules':
    if (!services.prometheus?.configured) return 'Prometheus is not configured';
    return JSON.stringify(await services.prometheus.getRules(), null, 2);

  // ── Komga ──
  case 'komga_list_libraries':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.listLibraries(), null, 2);
  case 'komga_list_series':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.listSeries(args.libraryId), null, 2);
  case 'komga_get_series':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.getSeries(args.seriesId), null, 2);
  case 'komga_list_books':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.listBooks(args.seriesId), null, 2);
  case 'komga_search':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.search(args.query), null, 2);
  case 'komga_get_recently_added':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.getRecentlyAdded(), null, 2);
  case 'komga_get_on_deck':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.getOnDeck(), null, 2);
  case 'komga_get_read_progress':
    if (!services.komga?.configured) return 'Komga is not configured';
    return JSON.stringify(await services.komga.getReadProgress(args.seriesId), null, 2);

  // ── Booklore ──
  case 'booklore_list_shelves':
    if (!services.booklore?.configured) return 'Booklore is not configured';
    return JSON.stringify(await services.booklore.listShelves(), null, 2);
  case 'booklore_list_books':
    if (!services.booklore?.configured) return 'Booklore is not configured';
    return JSON.stringify(await services.booklore.listBooks(args.shelfId), null, 2);
  case 'booklore_get_book':
    if (!services.booklore?.configured) return 'Booklore is not configured';
    return JSON.stringify(await services.booklore.getBook(args.bookId), null, 2);
  case 'booklore_search':
    if (!services.booklore?.configured) return 'Booklore is not configured';
    return JSON.stringify(await services.booklore.search(args.query), null, 2);

  // ── Audiobookshelf ──
  case 'audiobookshelf_list_libraries':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(await services.audiobookshelf.listLibraries(), null, 2);
  case 'audiobookshelf_list_items':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(await services.audiobookshelf.listItems(args.libraryId), null, 2);
  case 'audiobookshelf_get_item':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(await services.audiobookshelf.getItem(args.itemId), null, 2);
  case 'audiobookshelf_get_in_progress':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(await services.audiobookshelf.getInProgress(), null, 2);
  case 'audiobookshelf_search':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(
      await services.audiobookshelf.search(args.query, args.libraryId),
      null,
      2,
    );
  case 'audiobookshelf_get_listening_stats':
    if (!services.audiobookshelf?.configured) return 'Audiobookshelf is not configured';
    return JSON.stringify(await services.audiobookshelf.getListeningStats(), null, 2);

  // ── ROMm ──
  case 'romm_list_platforms':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.listPlatforms(), null, 2);
  case 'romm_list_roms':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.listRoms(args.platformId), null, 2);
  case 'romm_get_rom':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.getRom(args.romId), null, 2);
  case 'romm_search':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.search(args.query), null, 2);
  case 'romm_get_recently_added':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.getRecentlyAdded(), null, 2);
  case 'romm_list_collections':
    if (!services.romm?.configured) return 'ROMm is not configured';
    return JSON.stringify(await services.romm.listCollections(), null, 2);

  // ── Immich ──
  case 'immich_list_albums':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.listAlbums(), null, 2);
  case 'immich_get_album':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.getAlbum(args.albumId), null, 2);
  case 'immich_get_statistics':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.getStatistics(), null, 2);
  case 'immich_search':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.search(args.query), null, 2);
  case 'immich_list_people':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.listPeople(), null, 2);
  case 'immich_get_person_assets':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.getPersonAssets(args.personId), null, 2);
  case 'immich_get_recent_assets':
    if (!services.immich?.configured) return 'Immich is not configured';
    return JSON.stringify(await services.immich.getRecentAssets(args.count), null, 2);

  // ── UniFi ──
  case 'unifi_get_health':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.getHealth(), null, 2);
  case 'unifi_list_clients':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.listClients(), null, 2);
  case 'unifi_list_devices':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.listDevices(), null, 2);
  case 'unifi_get_device':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.getDevice(args.mac), null, 2);
  case 'unifi_get_client_stats':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.getClientStats(), null, 2);
  case 'unifi_get_sysinfo':
    if (!services.unifi?.configured) return 'UniFi is not configured';
    return JSON.stringify(await services.unifi.getSysinfo(), null, 2);

  // ── Forgejo ──
  case 'forgejo_list_repos':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(await services.forgejo.listRepos(), null, 2);
  case 'forgejo_get_repo':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(await services.forgejo.getRepo(args.owner, args.repo), null, 2);
  case 'forgejo_list_issues':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(
      await services.forgejo.listIssues(args.owner, args.repo, args.state),
      null,
      2,
    );
  case 'forgejo_get_issue':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(
      await services.forgejo.getIssue(args.owner, args.repo, args.index),
      null,
      2,
    );
  case 'forgejo_list_pull_requests':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(
      await services.forgejo.listPullRequests(args.owner, args.repo, args.state),
      null,
      2,
    );
  case 'forgejo_get_pull_request':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(
      await services.forgejo.getPullRequest(args.owner, args.repo, args.index),
      null,
      2,
    );
  case 'forgejo_list_orgs':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(await services.forgejo.listOrgs(), null, 2);
  case 'forgejo_search_repos':
    if (!services.forgejo?.configured) return 'Forgejo is not configured';
    return JSON.stringify(await services.forgejo.searchRepos(args.query), null, 2);

  // ── Pi-hole ──
  case 'pihole_get_summary':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getSummary(), null, 2);
  case 'pihole_top_domains':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getTopDomains(args.count), null, 2);
  case 'pihole_top_blocked':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getTopBlocked(args.count), null, 2);
  case 'pihole_top_clients':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getTopClients(args.count), null, 2);
  case 'pihole_query_types':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getQueryTypes(), null, 2);
  case 'pihole_get_history':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getHistory(), null, 2);
  case 'pihole_client_history':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getHistoryClients(), null, 2);
  case 'pihole_blocking_status':
    if (!services.pihole?.configured) return 'Pi-hole is not configured';
    return JSON.stringify(await services.pihole.getBlockingStatus(), null, 2);

  // ── InfluxDB ──
  case 'influxdb_query':
    if (!services.influxdb?.configured) return 'InfluxDB is not configured';
    return JSON.stringify(await services.influxdb.query(args.query), null, 2);
  case 'influxdb_list_buckets':
    if (!services.influxdb?.configured) return 'InfluxDB is not configured';
    return JSON.stringify(await services.influxdb.listBuckets(), null, 2);
  case 'influxdb_list_measurements':
    if (!services.influxdb?.configured) return 'InfluxDB is not configured';
    return JSON.stringify(await services.influxdb.listMeasurements(args.bucket), null, 2);

  // ── Kagi Web Search ──
  case 'web_search':
    if (!services.kagi?.configured) return 'Kagi web search is not configured (set KAGI_API_KEY)';
    return JSON.stringify(await services.kagi.search(args.query, args.limit ? Number(args.limit) : 5), null, 2);
  case 'fetch_webpage': {
    const pageUrl: string = args.url;
    if (!pageUrl) return 'Error: url is required';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { Accept: 'text/html,text/plain,application/json' },
      });
      if (!resp.ok) return `Error fetching page: ${resp.status} ${resp.statusText}`;
      const html = await resp.text();
      // Use Readability + linkedom for robust content extraction
      const { document } = parseHTML(html);
      const reader = new Readability(document);
      const article = reader.parse();
      const text = (article?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return 'Could not extract readable content from the page.';
      const truncated = text.length > 12_000
        ? `${text.substring(0, 12_000)}\n\n[Content truncated — ${text.length} chars total]`
        : text;
      return truncated;
    } finally {
      clearTimeout(timer);
    }
  }
  case 'summarize_url':
    if (!services.kagi?.configured) return 'Kagi is not configured (set KAGI_API_KEY)';
    return JSON.stringify(
      await services.kagi.summarize(args.url, args.engine || 'cecil'),
      null,
      2,
    );

  // ── Vision & Image Generation (text-only fallback for non-agentic callers) ──
  case 'view_image':
    return `Image at ${args.url} — use the AI command for vision analysis.`;
  case 'generate_image':
    return 'Image generation is only available through the AI command interface.';

  // ── User Memory ──
  case 'save_memory':
    if (!userSub) return 'Memory not available — user not authenticated';
    return JSON.stringify(await saveMemory(userSub, args.content), null, 2);
  case 'delete_memory':
    if (!userSub) return 'Memory not available — user not authenticated';
    return (await deleteMemory(userSub, args.memory_id))
      ? 'Memory deleted successfully'
      : 'Memory not found';

  default:
    return `Unknown tool: ${name}`;
  }
}

// ── Anthropic provider ────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ToolResultImage[];
}

export type ProgressCallback = (event: {
  type: 'progress' | 'tool_call' | 'done';
  text?: string;
  tool?: string;
}) => void;

// Build Anthropic message content with optional images
function toAnthropicContent(
  text: string,
  images?: ToolResultImage[],
): string | Anthropic.ContentBlockParam[] {
  if (!images?.length) return text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.mediaType,
      data: img.base64,
    },
  }));
  blocks.push({ type: 'text', text });
  return blocks;
}

// Build OpenAI message content with optional images
function toOpenAIContent(
  text: string,
  images?: ToolResultImage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): string | any[] {
  if (!images?.length) return text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = images.map((img) => ({
    type: 'image_url',
    image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
  }));
  parts.push({ type: 'text', text });
  return parts;
}

async function executeWithAnthropic(
  command: string,
  services: FluxHausServices,
  conversationHistory: ConversationMessage[],
  onProgress?: ProgressCallback,
  images?: ToolResultImage[],
  systemPrompt?: string,
  userSub?: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = process.env.AI_MODEL || 'claude-3-5-sonnet-20241022';
  const client = new Anthropic({ apiKey });

  const tools: Anthropic.Tool[] = TOOL_DEFINITIONS.map((def) => ({
    name: def.name,
    description: def.description,
    input_schema: def.parameters as Anthropic.Tool['input_schema'],
  }));

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: toAnthropicContent(m.content, m.images),
    })),
    { role: 'user', content: toAnthropicContent(command, images) },
  ];

  aiLogger.info(`[AI] Anthropic model=${model}, tools=${tools.length}, history=${conversationHistory.length}`);

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT + (systemPrompt || ''),
      tools,
      messages,
    });

    aiLogger.info(`[AI] Loop ${i}: stop_reason=${response.stop_reason}, `
      + `content_types=[${response.content.map((b) => b.type).join(',')}]`);

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find((b) => b.type === 'text');
      const text = textBlock ? textBlock.text : 'Done.';
      if (onProgress) onProgress({ type: 'done', text });
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      // Emit any intermediate text the model produced alongside tool calls
      const intermediateText = response.content.find((b) => b.type === 'text');
      if (intermediateText && intermediateText.type === 'text' && onProgress) {
        onProgress({ type: 'progress', text: intermediateText.text });
      }

      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      for (let j = 0; j < toolUseBlocks.length; j += 1) {
        const block = toolUseBlocks[j];
        if (block.type === 'tool_use') {
          aiLogger.info(`[AI] Tool call: ${block.name}(${JSON.stringify(block.input).substring(0, 200)})`);
          if (onProgress) onProgress({ type: 'tool_call', tool: block.name });
          // eslint-disable-next-line no-await-in-loop
          const result = await executeToolRich(
            block.name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            block.input as Record<string, any>,
            services,
            userSub,
          );

          // Build content blocks — include images if the tool returned any
          if (result.images?.length) {
            const contentBlocks: Anthropic.ToolResultBlockParam['content'] = [];
            result.images.forEach((img) => {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: img.base64,
                },
              });
            });
            contentBlocks.push({ type: 'text', text: result.text });
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: contentBlocks });
          } else {
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.text });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      const textBlock = response.content.find((b) => b.type === 'text');
      const text = textBlock ? textBlock.text : 'Done.';
      if (onProgress) onProgress({ type: 'done', text });
      return text;
    }
  }

  aiLogger.warn('[AI] Anthropic: exhausted tool loop (10 iterations)');
  return 'Sorry, I wasn\'t able to complete that request — too many steps. Please try a simpler question.';
}

// ── OpenAI-compatible provider ────────────────────────────────────────────────

async function executeWithOpenAICompatible(
  command: string,
  services: FluxHausServices,
  client: OpenAI,
  defaultModel: string,
  conversationHistory: ConversationMessage[],
  onProgress?: ProgressCallback,
  images?: ToolResultImage[],
  systemPrompt?: string,
  userSub?: string,
): Promise<string> {
  const model = process.env.AI_MODEL || defaultModel;

  const tools: OpenAI.Chat.ChatCompletionTool[] = TOOL_DEFINITIONS.map((def) => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT + (systemPrompt || '') },
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: toOpenAIContent(m.content, m.images),
    })),
    { role: 'user', content: toOpenAIContent(command, images) },
  ];

  aiLogger.info(`[AI] OpenAI-compat model=${model}, tools=${tools.length}, history=${conversationHistory.length}`);

  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await client.chat.completions.create({
      model,
      max_tokens: 4096,
      tools,
      messages,
    });

    const choice = response.choices[0];

    // Copilot API splits Claude responses into multiple choices:
    // Choices[0] may have content, Choices[1] may have tool_calls.
    // Merge them into a single view.
    const allToolCalls = response.choices
      .flatMap((c) => c.message.tool_calls ?? []);
    const allContent = response.choices
      .map((c) => c.message.content)
      .filter(Boolean)
      .join('\n') || null;
    const finishReason = choice.finish_reason;

    aiLogger.info(`[AI] Loop ${i}: finish_reason=${finishReason}, `
      + `tool_calls=${allToolCalls.length}, choices=${response.choices.length}`);

    if (finishReason === 'stop') {
      const text = allContent ?? 'Done.';
      if (onProgress) onProgress({ type: 'done', text });
      return text;
    }

    if (finishReason === 'length') {
      const suffix = '\n\n_(Response was truncated due to length. Try a more specific question.)_';
      const truncated = `${(allContent ?? '').trim()}${suffix}`.trim();
      if (onProgress) onProgress({ type: 'done', text: truncated });
      return truncated;
    }

    if (finishReason === 'tool_calls' && allToolCalls.length > 0) {
      // Emit intermediate text if the model produced any alongside tool calls
      if (allContent && onProgress) {
        onProgress({ type: 'progress', text: allContent });
      }

      // Build a merged message for the conversation history
      const mergedMessage: OpenAI.Chat.ChatCompletionMessage = {
        role: 'assistant',
        content: allContent,
        tool_calls: allToolCalls,
        refusal: null,
      };
      messages.push(mergedMessage);
      const fnCalls = allToolCalls.filter((tc) => tc.type === 'function');
      for (let j = 0; j < fnCalls.length; j += 1) {
        const toolCall = fnCalls[j];
        if (toolCall.type !== 'function') {
          // eslint-disable-next-line no-continue
          continue;
        }
        if (onProgress) onProgress({ type: 'tool_call', tool: toolCall.function.name });
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          aiLogger.warn({ tool: toolCall.function.name }, 'Malformed tool arguments, using empty');
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await executeToolRich(
          toolCall.function.name,
          toolArgs,
          services,
          userSub,
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.text,
        });

        // OpenAI tool messages don't support image blocks — inject as a user message
        if (result.images?.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts: any[] = [
            { type: 'text', text: 'Here is the image from the tool result. Analyze it and respond to the user.' },
          ];
          result.images.forEach((img) => {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
            });
          });
          messages.push({ role: 'user', content: parts });
        }
      }
    } else if (finishReason === 'tool_calls') {
      // Safety net: finish_reason=tool_calls but no tool_calls found across any choice.
      // This should be rare now that we merge all choices. Retry once, then ask AI to
      // answer directly.
      const alreadyRetried = messages.some(
        (m) => m.role === 'user' && typeof m.content === 'string'
          && m.content.includes('only make tool calls'),
      );
      if (alreadyRetried) {
        aiLogger.warn('[AI] Dropped tool_calls persisted after retry — asking for direct answer');
        messages.push({ role: 'assistant', content: allContent ?? '' });
        messages.push({
          role: 'user',
          content: 'Tool calls are unavailable. Please answer the question directly using '
            + 'any information you already have.',
        });
      } else {
        aiLogger.info('[AI] finish_reason=tool_calls but none found, retrying');
        if (allContent && onProgress) {
          onProgress({ type: 'progress', text: allContent });
        }
        messages.push({ role: 'assistant', content: allContent ?? '' });
        messages.push({
          role: 'user',
          content: 'You indicated you would use tools but none were called. '
            + 'Please call the appropriate tools now to fulfill the request. '
            + 'Do not respond with text — only make tool calls.',
        });
      }
    } else {
      const text = choice.message.content ?? 'Done.';
      if (onProgress) onProgress({ type: 'done', text });
      return text;
    }
  }

  aiLogger.warn('[AI] OpenAI: exhausted tool loop (10 iterations)');
  return 'Sorry, I wasn\'t able to complete that request — too many steps. Please try a simpler question.';
}

// ── Public entry point ────────────────────────────────────────────────────────

/* eslint-disable default-param-last */
export async function executeAICommand(
  command: string,
  services: FluxHausServices,
  conversationHistory: ConversationMessage[] = [],
  onProgress?: ProgressCallback,
  images?: ToolResultImage[],
  systemPrompt?: string,
  userSub?: string,
): Promise<string> {
/* eslint-enable default-param-last */
  const provider = (process.env.AI_PROVIDER || 'copilot').toLowerCase();
  const model = process.env.AI_MODEL || '(default)';
  const imgInfo = images?.length ? `, images=${images.length}` : '';
  aiLogger.info(`[AI] Provider: ${provider}, AI_MODEL=${model}${imgInfo}`);
  switch (provider) {
  case 'anthropic':
    return executeWithAnthropic(command, services, conversationHistory, onProgress, images, systemPrompt, userSub);

  case 'copilot':
  case 'github-copilot': {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set for GitHub Copilot provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({
        baseURL: 'https://api.githubcopilot.com',
        apiKey: token,
        defaultHeaders: { 'Copilot-Integration-Id': 'vscode-chat' },
      }),
      'gpt-4o',
      conversationHistory,
      onProgress,
      images,
      systemPrompt,
      userSub,
    );
  }

  case 'zai':
  case 'z.ai': {
    const apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) throw new Error('ZAI_API_KEY is not set for Z.ai provider');
    const baseURL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/v1';
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({ baseURL, apiKey }),
      'glm-4-flash',
      conversationHistory,
      onProgress,
      images,
      systemPrompt,
      userSub,
    );
  }

  case 'openai': {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set for OpenAI provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new OpenAI({ apiKey }),
      'gpt-4o',
      conversationHistory,
      onProgress,
      images,
      systemPrompt,
      userSub,
    );
  }

  case 'azure-openai': {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
    if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set for azure-openai provider');
    if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is not set for azure-openai provider');
    return executeWithOpenAICompatible(
      command,
      services,
      new AzureOpenAI({
        apiKey, endpoint, apiVersion,
      }),
      deployment,
      conversationHistory,
      onProgress,
      images,
      systemPrompt,
      userSub,
    );
  }

  default:
    throw new Error(
      `Unknown AI_PROVIDER "${provider}". Supported values: anthropic, copilot, zai, openai, azure-openai`,
    );
  }
}
