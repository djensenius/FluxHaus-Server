import type { AuthenticatedUser } from './types/auth';

/**
 * Access level for an MCP session.
 * - `full`: every registered tool, resource, and prompt (OIDC/proxy MCP tokens
 *   and `full` API keys).
 * - `read`: only the explicit allowlists below (`read` API keys).
 */
export type McpAccess = 'read' | 'full';

/**
 * Tools available to `read` access. Each entry was verified to only perform
 * reads against its backing service (GET requests, search/query endpoints
 * that do not change state, or in-memory cached status).
 *
 * Adding a tool to mcp-server.ts without classifying it here or in
 * MCP_FULL_ONLY_TOOLS fails the classification test, and unclassified tools
 * are denied to `read` access (fail closed).
 */
export const MCP_READ_TOOLS: ReadonlySet<string> = new Set([
  // Home Assistant / home state
  'list_entities',
  'get_entity_state',
  'get_car_status',
  'get_robot_status',
  'get_appliance_status',
  'get_entity_history',
  'get_logbook',
  'get_home_summary',
  // Calendar reads
  'get_calendar_events',
  'list_calendars',
  'list_events',
  'get_today_agenda',
  // Plex
  'plex_get_sessions',
  'plex_get_libraries',
  'plex_get_recently_added',
  'plex_get_on_deck',
  'plex_search',
  // Overseerr reads
  'overseerr_search',
  'overseerr_get_requests',
  'overseerr_get_status',
  // Tautulli
  'tautulli_get_activity',
  'tautulli_get_history',
  'tautulli_get_libraries',
  'tautulli_get_recently_added',
  'tautulli_get_home_stats',
  // Grafana (metadata reads only; datasource queries are full-only)
  'grafana_list_dashboards',
  'grafana_get_dashboard',
  'grafana_list_datasources',
  'grafana_get_annotations',
  'grafana_get_alerts',
  // InfluxDB metadata (arbitrary Flux queries are full-only)
  'influxdb_list_buckets',
  'influxdb_list_measurements',
  // Portainer: Docker's container list (ContainerSummary) has no Env/Config.
  'portainer_list_containers',
  // Prometheus (PromQL HTTP query API is read-only)
  'prometheus_query',
  'prometheus_query_range',
  'prometheus_get_targets',
  'prometheus_get_alerts',
  'prometheus_get_rules',
  // Komga
  'komga_list_libraries',
  'komga_list_series',
  'komga_get_series',
  'komga_list_books',
  'komga_search',
  'komga_get_recently_added',
  'komga_get_on_deck',
  'komga_get_read_progress',
  // Booklore
  'booklore_list_shelves',
  'booklore_list_books',
  'booklore_get_book',
  'booklore_search',
  // Audiobookshelf
  'audiobookshelf_list_libraries',
  'audiobookshelf_list_items',
  'audiobookshelf_get_item',
  'audiobookshelf_get_in_progress',
  'audiobookshelf_get_listening_stats',
  'audiobookshelf_search',
  // RomM
  'romm_list_platforms',
  'romm_list_roms',
  'romm_get_rom',
  'romm_search',
  'romm_get_recently_added',
  'romm_list_collections',
  // Immich (search endpoints use POST but are read-only)
  'immich_list_albums',
  'immich_get_album',
  'immich_get_statistics',
  'immich_search',
  'immich_list_people',
  'immich_get_person_assets',
  'immich_get_recent_assets',
  // UniFi
  'unifi_get_health',
  'unifi_list_clients',
  'unifi_list_devices',
  'unifi_get_device',
  'unifi_get_client_stats',
  'unifi_get_sysinfo',
  // Forgejo
  'forgejo_list_repos',
  'forgejo_get_repo',
  'forgejo_list_issues',
  'forgejo_get_issue',
  'forgejo_list_pull_requests',
  'forgejo_get_pull_request',
  'forgejo_list_orgs',
  'forgejo_search_repos',
  // Pi-hole
  'pihole_get_summary',
  'pihole_top_domains',
  'pihole_top_blocked',
  'pihole_top_clients',
  'pihole_query_types',
  'pihole_get_history',
  'pihole_client_history',
  'pihole_blocking_status',
]);

/** Tools explicitly withheld from `read` access. */
export const MCP_FULL_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // State-changing
  'lock_car',
  'unlock_car',
  'start_car',
  'stop_car',
  'resync_car',
  'start_robot',
  'stop_robot',
  'clean_room',
  'call_ha_service',
  'activate_scene',
  'set_thermostat',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'overseerr_request_media',
  'overseerr_approve_request',
  'portainer_container_action',
  // Expose secrets: stack Env, container Config.Env (e.g. database passwords),
  // and endpoint objects (EdgeKey, TLS/credential config, raw snapshots).
  'portainer_list_stacks',
  'portainer_get_container',
  'portainer_list_endpoints',
  // Arbitrary query languages against data stores. render_template can read
  // any HA state attribute (camera access tokens) and bypass read redaction.
  'influxdb_query',
  'grafana_query_datasource',
  'render_template',
  // Paid or outbound network access
  'web_search',
  'fetch_webpage',
  'summarize_url',
  'view_image',
  'generate_image',
]);

/** Resources (by registered name) available to `read` access. */
export const MCP_READ_RESOURCES: ReadonlySet<string> = new Set([
  'car-status',
  'appliances-status',
  'robots-status',
  'scenes-list',
  'rhizome-photos',
]);

/** Resources withheld from `read` access. */
export const MCP_FULL_ONLY_RESOURCES: ReadonlySet<string> = new Set([
  'camera-url',
]);

/**
 * Prompts only render text templates (embedding data that read tools already
 * expose); they never execute tools themselves.
 */
export const MCP_READ_PROMPTS: ReadonlySet<string> = new Set([
  'appliance_report',
  'leaving_home',
  'goodnight',
  'system_health',
  'data_research',
]);

export const MCP_FULL_ONLY_PROMPTS: ReadonlySet<string> = new Set([]);

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(access_token|refresh_token|api_key|apikey|password|secret|token)$/i;
const TOKEN_QUERY_PARAM = /([?&](?:access_)?token=)[^&#"'\s\\]+/gi;
const ACCESS_TOKEN_JSON = /("(?:access_token|refresh_token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

function redactString(value: string): string {
  return value
    .replace(TOKEN_QUERY_PARAM, `$1${REDACTED}`)
    .replace(ACCESS_TOKEN_JSON, `$1"${REDACTED}"`);
}

/**
 * Deep-redacts credentials that Home Assistant (and other services) embed in
 * otherwise read-only data: `access_token` attributes (cameras, media
 * players), and `token=` query parameters in URLs such as `entity_picture`
 * camera proxy links. Applied to every result served with read access.
 */
export function redactSensitive<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) && (typeof item === 'string' || typeof item === 'number')
        ? REDACTED
        : redactSensitive(item),
    ])) as T;
  }
  return value;
}

/** Redacts a text block, preserving JSON formatting when the text is JSON. */
export function redactSensitiveText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactSensitive(JSON.parse(trimmed)), null, 2);
    } catch {
      // not JSON — fall through to string redaction
    }
  }
  return redactString(text);
}

/**
 * Redacts tool, resource, and prompt results: every `text` field (JSON-aware)
 * plus `structuredContent`.
 */
export function redactMcpResult<T>(result: T): T {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') return key === 'text' ? redactSensitiveText(value) : redactString(value);
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, item]) => (
        k === 'structuredContent' ? [k, redactSensitive(item)] : [k, walk(item, k)]
      )));
    }
    return value;
  };
  return walk(result) as T;
}

export function isMcpToolAllowed(access: McpAccess, name: string): boolean {
  return access === 'full' || MCP_READ_TOOLS.has(name);
}

export function isMcpResourceAllowed(access: McpAccess, name: string): boolean {
  return access === 'full' || MCP_READ_RESOURCES.has(name);
}

export function isMcpPromptAllowed(access: McpAccess, name: string): boolean {
  return access === 'full' || MCP_READ_PROMPTS.has(name);
}

/**
 * Access level for an authenticated /mcp user. Only API-key users can be
 * restricted; an API-key user without an explicit `full` scope gets `read`.
 */
export function mcpAccessForUser(user: AuthenticatedUser | undefined): McpAccess {
  if (user?.authMethod !== 'mcp_api_key') return 'full';
  return user.mcpAccess === 'full' ? 'full' : 'read';
}
