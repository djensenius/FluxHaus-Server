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
  // HA REST /api/template renders in HA's sandboxed Jinja environment and has
  // no side effects; dangerous patterns are additionally blocked.
  'render_template',
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
  // Portainer reads
  'portainer_list_endpoints',
  'portainer_list_containers',
  'portainer_list_stacks',
  'portainer_get_container',
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
  // Arbitrary query languages against data stores
  'influxdb_query',
  'grafana_query_datasource',
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
