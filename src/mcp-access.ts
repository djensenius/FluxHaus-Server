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
// Key names whose values are credentials: *_token, *_secret, *_password,
// passphrase, authkey, api(_)key, private(_)key, credential(s), and UniFi's
// x_*key fields (x_authkey, x_vwirekey, x_iapp_key, ...). SENSITIVE_CAMEL_KEY
// (case-sensitive) covers camelCase names: accessToken, clientSecret, ...
const SENSITIVE_KEY = /(^|_)(token|secret|password|passphrase|authkey|api_?key|private_?key|credentials?)$|^x_.*key$/i;
const SENSITIVE_CAMEL_KEY = /[a-z0-9](Token|Secret|Password|Passphrase|AuthKey|ApiKey|PrivateKey|Credentials?)$/;
// Credential URL parameters, incl. S3/Azure-style signed URLs and Zoom `pwd`.
// Separators include `;`, HTML entities with or without `;` (`&amp;`, `&#38;`,
// `&#x26;`), JS escapes (`\u0026`, `\u003f`), and single/double URL encoding
// (`%26`, `%3F`, `%2526`, `%253F`); `=` may be `%3D`, `%253D` or `\u003d`.
// Escaped links in HTML/JS bodies or nested URL parameters cannot slip through.
// No nested quantifiers, so matching stays linear.
const QUERY_SEPARATOR = [
  '[?&;]', '&amp;?', '&#0*38;?(?![0-9])', '&#x0*26;?(?![0-9a-f])',
  '\\\\u0026', '\\\\u003f', '%26', '%3F', '%2526', '%253F',
].join('|');
const QUERY_EQUALS = ['=', '%3D', '%253D', '\\\\u003d'].join('|');
const SENSITIVE_QUERY_PARAM = new RegExp(`((?:${QUERY_SEPARATOR})(?:${[
  'token', 'access_token', 'apikey', 'api_key', 'key', 'auth', 'authSig', 'password', 'secret', 'x-plex-token',
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'signature', 'sig', 'pwd',
].join('|')})(?:${QUERY_EQUALS}))[^&#;"'<>\\s\\\\]+`, 'gi');
// user:pass@, :pass@ (password-only, e.g. redis://:secret@host) and user:@.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/?#@\s"'\\:]*:[^/?#@\s"'\\]*@/gi;
// Calendar subscription feeds are capability URLs (the secret is often in the
// path): any webcal(s):// link and any http(s) link to an .ics file.
// iCloud shared calendars are also published as https://pNN-caldav.icloud.com/published/...
const CALENDAR_FEED_URL = new RegExp([
  /\bwebcals?:\/\/[^\s"'<>\\]+/.source,
  /\bhttps?:\/\/[^\s"'<>\\/]*icloud\.com\/published\/[^\s"'<>\\]*/.source,
  /\bhttps?:\/\/[^\s"'<>\\]+?\.ics\b[^\s"'<>\\]*/.source,
].join('|'), 'gi');
// Token-looking usernames with no password (https://ghp_xxx@github.com):
// known token prefixes, or 20+ token characters. Short names (git@, user@) stay.
const URL_TOKEN_USER = new RegExp(
  `(\\b[a-z][a-z0-9+.-]*:\\/\\/)(?:(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|fhmcp_|sbk_)`
  + `[^/?#@\\s"'\\\\:]*|[A-Za-z0-9_-]{20,})@`,
  'gi',
);
const SENSITIVE_JSON_STRING = /("([^"\\]+)"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || SENSITIVE_CAMEL_KEY.test(key);
}

const JSON_CONTAINER_START = /"([^"\\]+)"\s*:\s*[{[]/g;

// Index just past the JSON object/array opening at `start`, honouring nested
// containers and strings; -1 when it is not closed in `text`.
function closingIndex(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth += 1;
    } else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Redacts object/array values under sensitive keys inside free text (e.g.
// JSON embedded in prompt prose). Unbalanced values are redacted to the end
// of the line (or text), erring towards over-redaction.
function redactEmbeddedContainers(text: string): string {
  let result = '';
  let last = 0;
  JSON_CONTAINER_START.lastIndex = 0;
  let match = JSON_CONTAINER_START.exec(text);
  while (match) {
    const valueStart = match.index + match[0].length - 1;
    if (isSensitiveKey(match[1]) && valueStart >= last) {
      let end = closingIndex(text, valueStart);
      if (end < 0) {
        const newline = text.indexOf('\n', valueStart);
        end = newline < 0 ? text.length : newline;
      }
      result += `${text.slice(last, valueStart)}"${REDACTED}"`;
      last = end;
      JSON_CONTAINER_START.lastIndex = end;
    }
    match = JSON_CONTAINER_START.exec(text);
  }
  return result + text.slice(last);
}

function redactString(value: string): string {
  return redactEmbeddedContainers(value)
    .replace(SENSITIVE_QUERY_PARAM, `$1${REDACTED}`)
    .replace(CALENDAR_FEED_URL, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_TOKEN_USER, `$1${REDACTED}@`)
    .replace(SENSITIVE_JSON_STRING, (match, prefix: string, key: string) => (
      isSensitiveKey(key) ? `${prefix}"${REDACTED}"` : match
    ));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Non-plain objects: Dates are kept as-is (they serialise to ISO strings);
// anything else with toJSON is traversed as its JSON form; other instances
// are traversed by their own enumerable properties, as JSON.stringify would.
// toJSON is called at most once per value: a non-plain result is flattened to
// its own properties rather than re-entering toJSON, so it cannot recurse.
function jsonForm(value: object): unknown {
  const { toJSON } = value as { toJSON?: unknown };
  const json = typeof toJSON === 'function' ? toJSON.call(value) : value;
  if (json instanceof Date || Array.isArray(json) || isPlainObject(json)) return json;
  return json && typeof json === 'object' ? { ...json } : json;
}

/**
 * Deep-redacts credentials that Home Assistant and other services embed in
 * otherwise read-only data: values under sensitive keys (the whole value,
 * including objects/arrays), credential URL parameters such as camera proxy
 * `token=`, and `user:pass@` URL userinfo. Applied to every read-access result.
 */
export function redactSensitive<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as T;
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && !isPlainObject(value)) return redactSensitive(jsonForm(value)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) && item !== null && item !== undefined ? REDACTED : redactSensitive(item),
    ])) as T;
  }
  return value;
}

/** Removes the named keys at any depth (used to trim noisy/secret-prone fields). */
export function omitKeysDeep<T>(value: T, keys: ReadonlySet<string>): T {
  if (Array.isArray(value)) return value.map((item) => omitKeysDeep(item, keys)) as T;
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && !isPlainObject(value)) return omitKeysDeep(jsonForm(value), keys) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !keys.has(key))
      .map(([key, item]) => [key, omitKeysDeep(item, keys)])) as T;
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
    if (value instanceof Date) return value;
    if (value && typeof value === 'object' && !isPlainObject(value)) return walk(jsonForm(value), key);
    if (isPlainObject(value)) {
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
