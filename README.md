# FluxHaus Server

A Node.js server that acts as the central nervous system for the FluxHaus smart home. It integrates various smart devices and services into a unified API.

## Features

*   **Robot Vacuums**: Control Roomba/Braava robots via Home Assistant.
*   **Car Integration**: Monitor and control Kia/Hyundai vehicles via Home Assistant.
*   **Appliances**: Monitor Miele (Washer/Dryer) and Bosch Home Connect (Dishwasher) appliances.
*   **Data Aggregation**: Fetches and caches data from external services (Modern Dog, GitHub).
*   **API**: Exposes a unified JSON API for the FluxHaus iOS app and web frontend.
*   **OIDC Authentication**: Browser login via Authentik (or any OIDC provider) with authorization code flow + PKCE. Bearer token support for API clients. Basic auth fallback for demo/rhizome guest users.
*   **Audit Logging**: Auth events (logins, failures, logouts) and every API request logged to PostgreSQL.
*   **Time-series Metrics**: Auth events and request volume pushed to InfluxDB for dashboarding. Device data also tracked.
*   **Health Check**: Unauthenticated `/health` endpoint for monitoring.
*   **Structured Logging**: JSON-structured output via pino.
*   **Session Management**: PostgreSQL-backed sessions via `connect-pg-simple`. Sessions persist across server restarts.
*   **Graceful Shutdown**: Clean teardown of database connections, InfluxDB writes, and HTTP server on SIGTERM/SIGINT.
*   **AI Command Endpoint**: Natural-language `POST /command` endpoint powered by Anthropic, OpenAI, GitHub Copilot, or Z.ai.
*   **MCP Server**: Model Context Protocol server so AI assistants (Claude Desktop, etc.) can control your home directly.
*   **Unified Calendars**: Aggregate calendars from Home Assistant, iCloud, Microsoft 365, and subscribed ICS feeds, with default calendar support for event creation.

## Prerequisites

*   **Docker**: Recommended for running the server.
*   **Node.js 26.12.1 or newer within Node 26** (`>=26.12.1 <27`).
    `.node-version`, `mise.toml`, Docker and CI track the latest Node 26 release;
    `package.json` and `.npmrc` reject runtimes below the Node2Shell security floor.
    Run `mise install` and `mise exec -- node --version` when developing locally;
    use `mise upgrade node` to refresh an already installed Node 26.
    Node 26 is currently the Current release line and is scheduled to become LTS.
    [Node2Shell (CVE-2026-111497)](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
    is fixed in 26.12.1. Updating npm dependencies alone does not patch the runtime;
    rebuild with a fresh base image and redeploy. CI uses `pull: true` for Docker builds.
    The Docker build logs its actual Node version and enforces the engine range.
    After deployment, verify the running container with `docker exec <container> node --version`.
*   **Home Assistant**: For robot and car control.
*   **PostgreSQL 18**: For audit logging, session storage, and OAuth token persistence.
*   **InfluxDB 2**: For time-series metrics (optional — disabled if not configured).
*   **Authentik** (or any OIDC provider): For admin authentication (optional — falls back to basic auth).

## Getting Started

### Option 1: Docker Compose (Recommended)

You don't need to clone the code. Just create a directory with `docker-compose.yml` and `.env`.

1.  **Create `docker-compose.yml`**:

    ```yaml
    ---
    services:
      postgres:
        image: postgres:18-alpine
        container_name: fluxhaus-postgres
        network_mode: "host"
        environment:
          - POSTGRES_DB=fluxhaus
          - POSTGRES_USER=fluxhaus
          - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-fluxhaus}
        volumes:
          - postgres_data:/var/lib/postgresql
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U fluxhaus"]
          interval: 10s
          timeout: 5s
          retries: 5
        restart: unless-stopped

      fluxhaus-server:
        image: ghcr.io/djensenius/fluxhaus-server:latest
        container_name: fluxhaus
        network_mode: "host"
        depends_on:
          postgres:
            condition: service_healthy
        environment:
          - TZ=America/Toronto
        volumes:
          - ./cache:/app/cache
          - ./.env:/app/.env
        healthcheck:
          test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8888/health || exit 1"]
          interval: 30s
          timeout: 10s
          retries: 3
        restart: unless-stopped

    volumes:
      postgres_data:
    ```

2.  **Configure Environment**:
    Download the example configuration and save it as `.env`:
    ```bash
    curl -o .env https://raw.githubusercontent.com/djensenius/FluxHaus-Server/main/.env-example
    ```
    Edit `.env` and fill in your credentials. At minimum, set `POSTGRES_URL` to match the docker-compose postgres service (e.g., `postgresql://fluxhaus:fluxhaus@localhost:5432/fluxhaus`).

3.  **Run**:
    ```bash
    docker compose up -d
    ```

    PostgreSQL initializes automatically on first startup. The server creates its tables (`audit_logs`, `oauth_tokens`, `session`) on boot.

### Option 2: Running Locally

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/djensenius/FluxHaus-Server.git
    cd FluxHaus-Server
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Configure Environment**:
    Copy `.env-example` to `.env` and fill in your values.
    ```bash
    cp .env-example .env
    ```

4.  **Build and Run**:
    ```bash
    npm run build
    npm start
    ```

## Authentication

The server uses a layered auth system. Requests are checked in this order:

1. **Session cookie** — set after browser OIDC login
2. **Bearer token** — OIDC JWT validated via JWKS (for API clients like the iOS app)
3. **Basic auth** — for demo/rhizome guest users and legacy admin fallback
4. **Browser redirect** — unauthenticated browser requests redirect to `/auth/login`
5. **401 Unauthorized** — API requests without valid credentials

### OIDC (Admin access via Authentik)

Browser visitors are automatically redirected to your OIDC provider for login. The flow uses authorization code grant with PKCE.

**Authentik setup:**
- **Client type**: Confidential
- **Grant type**: Authorization Code
- **Redirect URI**: `https://your-server/auth/callback`
- **Scopes**: `openid`, `email`, `profile`

**Environment variables:**
```
OIDC_ISSUER_URL=https://auth.fluxhaus.io/application/o/fluxhaus/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_REDIRECT_URI=https://api.fluxhaus.io/auth/callback
SESSION_SECRET=generate-with-openssl-rand-base64-32
```

Any user authorized in Authentik for this application gets `admin` role. User management is handled entirely in Authentik.

**Auth routes:**
- `GET /auth/login` — initiates OIDC flow, redirects to provider
- `GET /auth/callback` — exchanges authorization code for tokens, sets session
- `GET /auth/logout` — destroys session, redirects to provider's end-session endpoint

### API Clients (Bearer Tokens)

API clients (e.g., the FluxHaus iOS app) authenticate with a Bearer token in the `Authorization` header. Tokens are validated locally via JWKS (no network call per request).

```
Authorization: Bearer <access_token>
```

### Guest Access (Basic Auth)

Demo and rhizome users authenticate via HTTP Basic auth:
- `demo` / `DEMO_PASSWORD` — read-only access to device status
- `rhizome` / `RHIZOME_PASSWORD` — access to camera and schedule data

### Legacy Admin (Basic Auth)

During transition, admin access via basic auth still works with `BASIC_AUTH_PASSWORD`. Remove this once OIDC is confirmed working.

## PostgreSQL

The server uses PostgreSQL for:
- **Audit logs** (`audit_logs` table) — every request and auth event
- **Session storage** (`session` table) — browser login sessions
- **OAuth tokens** (`oauth_tokens` table) — Miele and HomeConnect tokens
- **User preferences** (`user_preferences` table) — includes memory preferences (`memoryEnabled`, `personalMemoryEnabled`) and default calendar selection
- **User memories** (`user_memories` table) — durable facts the assistant remembers about each user, grouped by `category` (`project`, `possession`, `wishlist`, `preference`, `fact`); content is encrypted at rest. The assistant captures these proactively as you chat and can fully manage them through chat tools — list, add, update, delete, or clear (`list_memories`, `save_memory`, `update_memory`, `delete_memory`, `delete_all_memories`). The REST API exposes a subset: `GET /memories` (list) and `DELETE /memories/:id` / `DELETE /memories` (delete one or clear all).

```
POSTGRES_URL=postgresql://fluxhaus:password@localhost:5432/fluxhaus
```

All tables are created automatically on startup. When using Docker Compose, the database and user are provisioned automatically.

## InfluxDB

Optional time-series metrics. The server writes two measurements:

- **`auth`** — login successes, failures, and logouts (tags: `result`, `method`, `reason`)
- **`request`** — every authenticated API request (tags: `route`, `method`, `role`)

```
INFLUXDB_URL=http://localhost:8086
INFLUXDB_TOKEN=your-token
INFLUXDB_ORG=fluxhaus
INFLUXDB_BUCKET=fluxhaus
```

If not configured, InfluxDB integration is silently disabled. Connect to an existing InfluxDB instance — no need to run one in docker-compose.

## Metrics dashboard

The app renders a Grafana-style dashboard from a server-defined catalog. Clients
only reference metric ids — raw Flux/PromQL never leaves the server. Definitions
live in `src/metrics.ts` (`METRIC_CATALOG`) and are exposed via:

- `GET /metrics/catalog` — list of `{ id, title, unit, group }`
- `GET /metrics/series?metric=<id>&range=<1h|6h|24h|7d|30d>` — time-series data

Catalog groups:

- **Environment** — indoor + outdoor temperature/humidity (Environment Canada),
  indoor air quality (Blue Pure PM2.5), and outdoor air quality (AQHI). Outdoor
  readings are relabelled **"Outside"** via each metric's `seriesRename` map so the
  app can colour them consistently across charts. The temperature chart
  automatically includes every indoor sensor discovered by
  [Indoor climate](#indoor-climate) that Home Assistant logs to InfluxDB under
  the `climate` or `°C` measurement, on top of its static entity list
  (Fahrenheit installs log under `°F` and aren't charted).
- **Energy** — live power draw (W) and cumulative energy (kWh) for the computer
  station, media centre, and server hardware.
- **Outdoor** — the full weather-tab detail set: outdoor temperature/humidity,
  dew point, humidex, UV index, AQHI, and U.S./Chinese AQI (IQAir).
- **Car**, **System**, **Network**, **Power** (UPS), **UniFi** — host and vehicle
  telemetry from InfluxDB/Prometheus.

Outdoor/environment series read Home Assistant data already flowing into InfluxDB
(measurements keyed by unit, e.g. `climate`, `°C`, `μg/m³`, `UV index`, and
`state` for index-style sensors) — no extra collector or env vars required.

## Indoor climate

The server auto-discovers the entities of one Home Assistant integration
(`INDOOR_CLIMATE_INTEGRATION`, default `ecobee`) and polls them every minute
(re-discovering every 10 minutes, so new sensors appear without a restart):

- every `sensor.*` with `device_class: temperature` becomes a room, named after
  its HA device (e.g. an Ecobee SmartSensor called "Bedroom"), with its HA
  `area` (entity area, else device area; `null` if unassigned) and `unit`
  (`unit_of_measurement`, `null` if unknown);
- an `occupancy` `binary_sensor` on the same device supplies `occupied`;
- the first `climate.*` entity (by entity id) is reported as the thermostat
  (mode, action, set points, preset, current temperature/humidity — from the
  thermostat device's own sensors if the climate entity omits them, dropping a
  temperature whose unit is unknown — area, plus
  the control capabilities `hvacModes`, `presetModes`, `fanMode`, `fanModes`,
  `minTemp`, `maxTemp` and `targetTempStep` — lists are `[]` and values `null`
  when HA doesn't report them — and `temperatureUnit`, Home Assistant's unit
  for every thermostat temperature, read from `/api/config`);
  temperature sensors on the device of *any* discovered `climate.*` entity are
  flagged `isThermostat` and listed first.

The snapshot is returned as `indoorClimate`
(`{ timestamp, thermostat, sensors, unit }`, where `unit` is the first known
sensor unit, else Home Assistant's unit) in `GET /` for admin and demo users, and in the MCP
`get_home_summary` tool.

```
INDOOR_CLIMATE_INTEGRATION=ecobee
```

The value is passed to HA's `integration_entities()`, which matches a
config-entry title first (e.g. `Ecobee Upstairs`; up to 100 characters, no
control characters) and then an integration domain. Choose it carefully:
e.g. `homekit_controller` pulls in every HomeKit temperature sensor.

Discovery uses Home Assistant's `/api/template` endpoint, so `HOMEASSISTANT_TOKEN`
must be allowed to render templates — the same requirement as the MCP
`render_template` tool. If discovery fails, the last discovered entities are kept.
Each Home Assistant request made by this poller times out (and is aborted) after
15 seconds, so a hung request can't stall polling.

### Thermostat controls

Admin-only (`403` otherwise; cookie sessions need the CSRF token) routes that
control the reported thermostat:

| Route | Body | Home Assistant service |
|-------|------|------------------------|
| `POST /thermostat/temperature` | `{ temperature }` or `{ targetTempLow, targetTempHigh }` | `climate.set_temperature` |
| `POST /thermostat/mode` | `{ mode }` (one of `hvacModes`) | `climate.set_hvac_mode` |
| `POST /thermostat/preset` | `{ preset }` (one of `presetModes`) | `climate.set_preset_mode` |
| `POST /thermostat/fan` | `{ mode }` (one of `fanModes`) | `climate.set_fan_mode` |
| `POST /thermostat/resume` | `{ resumeAll? }` (default `false`) | `ecobee.resume_program` |

Temperatures accept numbers or numeric strings and must be within
`minTemp`..`maxTemp` when known. Use `temperature` outside `heat_cool` mode and
`targetTempLow` < `targetTempHigh` in `heat_cool` mode. If the thermostat
doesn't report `hvacModes`, `mode` must be one of `off`, `heat`, `cool`,
`heat_cool`, `auto`, `dry` or `fan_only`. Resume is only available when the
thermostat's own integration (its config entry domain) is `ecobee`. On Home
Assistant older than 2024.7, which can't report it, Resume requires
`INDOOR_CLIMATE_INTEGRATION=ecobee`.

Controls run one at a time (app and MCP alike). Each first waits for any
in-flight poll and reads the thermostat fresh, so validation uses its current
mode and limits. After the service call it re-reads only the thermostat (up to
4 times, 1.5 seconds apart) until it reports the change. Success returns `200`
with the `indoorClimate` snapshot plus `confirmed`, which is `false` if the
thermostat still hadn't reported the change (the snapshot may then show the
previous values). A set point counts as reported when it is within Ecobee's
rounding of the request, but never when it is still the previous value. Resume
is confirmed only when the preset moves off the hold (to a different preset
that isn't `temp`); resuming with no hold, or when the schedule matches the
held comfort setting, changes nothing visible and so returns `confirmed: false`.
If a poll that finished during the confirmation read the thermostat more
recently, its result is kept.

A change that may still take effect (unconfirmed, timed out, or with an
unknown outcome) holds back the next control of a different kind until the
thermostat reports it, for up to 60 seconds from when that outcome was known, so a late mode change can't
invalidate a set point chosen for the new mode. That control re-reads the
thermostat and, if the change still hasn't shown up, returns `409`
`The previous thermostat change has not taken effect yet; try again shortly`.
A control of the same kind runs immediately and replaces the pending one once
Home Assistant accepts it; if it is invalid or refused, the pending change
keeps holding. An unconfirmed resume doesn't hold anything back.

Invalid requests return `400`, and a missing or unavailable thermostat returns
`409`, each with a plain-text reason. If the thermostat can't be read first,
the route returns `503` `Could not read the thermostat state; no change was
sent`. If the change was sent but every read afterwards fails, it returns `502`
`Thermostat change was sent but its new state could not be read`. Control calls
time out after 30 seconds because Ecobee cloud calls can be slow; a timeout
returns `504` with a reason saying the change may still be applied, so check
the thermostat before retrying. A dropped connection, unreadable response or
5xx (e.g. a proxy error) may also have applied the change, so it returns `502`
`Could not tell whether the thermostat received the change; it may still be
applied, so check its state before retrying`. Home Assistant refusing the call
(a 4xx) changed nothing and returns `502` `Thermostat control failed`.

The MCP `set_thermostat` tool takes `temperature`, `target_temp_low`,
`target_temp_high`, `hvac_mode`, `preset_mode`, `fan_mode` and
`resume_program` (at least one is required). `resume_program` cancels all
holds (`resume_all: true`) and returns to the schedule. It applies them in the
order resume → HVAC mode → preset → fan → temperature as one operation, so no
other control can run between them, and returns the resulting snapshot with
`confirmed` (true only if every step was reported) and `unconfirmedSteps`. A
step the thermostat reports later (e.g. while the next step waits for it)
counts as reported. Every step acts on the same thermostat: if discovery
selects a different one partway, the remaining steps stop with `409`. A
failing step stops the sequence (including a `409` because an earlier step
hasn't taken effect yet), but earlier steps stay applied. The error lists them
and includes a fresh status of the thermostat they changed, or its last known
one (labelled as such) if it can't be read.

The web server and its HTTP MCP endpoint (`/mcp`) share one controller, so
the guarantees above hold between them. Raw `climate.*` and `ecobee.*` calls
through the `call_ha_service` tool (MCP and AI commands) also take their turn
with the controls, so one can't land between the steps of `set_thermostat`.
Like the controls, they time out (and are aborted) after 30 seconds with a
`504` saying the change may still be applied. One that may target the reported
thermostat (it names it, `all`, or no entity, or targets an area, device, floor
or label) also follows the hold-back rule above: it waits for (or is refused
with `409` by) a pending change of another kind, and a mode, preset, fan or set
point change it makes holds back other kinds of control until the thermostat
reports it. Ecobee services wait the same way, but what they change isn't held
back, as it can't be read from the thermostat's state.
The local stdio MCP server
(`node dist/mcp.js`) runs in its own process with its own controller and isn't
coordinated with a running web server.

### Sensor placement insights

`GET /climate/placement-insights?days=14&home=<ids>&sleep=<ids>&away=<ids>&thermostatHome=true|false&thermostatSleep=true|false&thermostatAway=true|false&followMe=true|false`
(admin and demo users) looks for the sensor that skews the Ecobee comfort
reading. It approximates the effect using a simple mean of the sensors in the
active comfort setting (modeling Follow Me as using only occupied sensors, or
all when none is occupied). A cold sensor may contribute to longer heating,
and a warm sensor may contribute to it stopping sooner (mirrored for cooling);
the analysis does not prove what caused a run. Ecobee documents that its
displayed temperature may be humidity-adjusted; whether or how this applies to
the HomeKit reading is unverified. The simple mean is an analysis approximation,
not a claim that HomeKit reports an unadjusted arithmetic mean. The analysis
puts the Sleep → Home wake-up first, then cooling and other heat-ups.

- `days` is an integer from 3 to 30, default 14.
- `home`, `sleep`, `away` (optional) are comma-separated `sensors[].id` values for
  room sensors in that comfort setting, excluding `isThermostat` sensors;
  an empty value means no room sensors are selected. `thermostatHome`,
  `thermostatSleep`, and `thermostatAway` (optional, exactly `true` or `false`)
  separately describe whether the thermostat's **physical built-in sensor**
  participates in each setting. Omission means unknown, not excluded.
  `followMe` (optional) is `true` or `false`; omitted, it is unknown, not off.
  Check these choices in the Ecobee app: HomeKit doesn't expose separate
  built-in temperature or comfort-setting membership. Choices are applied
  throughout the analyzed history (including last-season cooling), so they
  may not reflect a setting changed during that time. Without room lists, room
  participation is unknown and advice is conditional ("If it's in your Home
  comfort setting…") unless a safe estimate is possible (see below).
- Malformed values return `400`. A thermostat-associated temperature id in a
  room list is rejected because it cannot safely be classified as a remote
  room; use the `thermostat*` parameters for the physical built-in sensor.
  Unknown room ids return `400` once any eligible room sensors are discovered.
  If discovery yields no
  eligible rooms, their id validation is deferred and the response can be a
  degraded `200`; malformed values and discovered thermostat-associated ids
  are still rejected.
- `coverage.thermostatParticipationSupported: true` confirms that the server
  understands the three thermostat parameters, including in degraded responses.
  An older server may omit it and silently ignore them. `participationConfigured`
  continues to indicate whether any room list was supplied. A thermostat-associated
  temperature entity's `participation` is `null` for each setting; it doesn't
  describe the separately configured built-in sensor.
- `coverage.unitAssumptions` is present even without recommendations and has four
  boolean fields: `reportedTemperature` and `setpoints` cover history fetched
  for the requested window; `coolingReportedTemperature` and `coolingSetpoints`
  cover the cooling window. A field is `true` when at least one retained
  reported-temperature bucket or parsed set point, respectively, used HA's
  last-known climate unit as a historical assumption. Set-point history can
  include the prior snapshot. These are window-level indicators, not proof
  that any particular sensor metric used the assumed data. `false` also means
  no retained data (including unavailable or unchecked cooling), not proof
  that history or units were complete. When cooling shares the requested
  history, the corresponding flags match. Older servers omit this object;
  treat an absent object as unknown, not as all `false`.
- If a room list is empty and its thermostat sensor is explicitly excluded, the
  choices don't establish a sensor-free setting:
  [Ecobee uses its thermostat sensor when the last sensor is removed](https://www.ecobee.com/home/developer/api/documentation/v1/objects/Climate.shtml).
  A `participation-empty-<setting>` recommendation asks you to check the
  setting; actual room and thermostat participation stays unknown rather than
  categorically excluding rooms or inventing a sensor-free setting.
- Results are computed on request and cached per `days` and participation
  (including each thermostat tri-state) for 15 minutes (at most 32 at once:
  expired results are evicted first, then the least recently used); results
  with missing data (a failed read, no eligible room sensors, no thermostat,
  no usable current-window thermostat reference history, missing room
  temperature data or no thermostat history) are cached for 1 minute so they
  are retried soon. A separate thermostat temperature entity is not required,
  and the age of the last change-driven reference value alone does not shorten
  the cache; stale values still cannot be used in comparisons. Where evidence
  is missing, values are `null` or events are marked inferred rather than guessed.

All history comes from the InfluxDB bucket Home Assistant writes to (the
configured `INFLUXDB_BUCKET`), since the Home Assistant recorder keeps only
about 10 days:

- **Room temperatures** come from InfluxDB: the indoor sensors discovered above,
  matched on Home Assistant's `domain` (`sensor`) and `entity_id` (object id)
  tags, from the `climate`, `°C` and `°F` measurements, averaged per 15 minutes
  and stamped with the start of each 15-minute window (the earliest time any
  reading in it could have been taken). The unit comes from the measurement
  (`°C`/`°F`); for an overridden measurement such as `climate`, only the unit
  Home Assistant recorded with each reading counts — the `unit_of_measurement`
  tag if it is configured as one, else the `unit_of_measurement_str` field —
  never the sensor's current unit. Readings in different units are averaged
  separately; a sensor's 15-minute window with an unknown unit, or split
  across more than one series (different units or measurements, whose
  per-series reading counts aren't queried, so their means can't be weighted),
  is dropped and counted in `coverage.unknownUnitWindows` (windows, not
  individual readings).
  Outdoor-looking sensors (`outdoor`, `outside`, `patio`, `exterior`,
  `environment_canada`) are skipped.
- **Reported climate temperature** is the selected climate entity's
  `current_temperature` attribute in InfluxDB, queried separately from
  `sensor` entities and averaged in complete 15-minute source windows. It is
  the thermostat-reported reference, not a separately measured physical
  thermostat sensor or evidence of its participation. The climate attribute's
  recorded unit is used where available; for untagged readings the analysis
  assumes Home Assistant's last known climate temperature unit applied
  throughout that history. HA's unit may have changed without being recorded,
  so this assumption can be wrong and is disclosed through coverage and, when
  present, recommendations. An unknown or conflicting explicit unit is not
  replaced by the assumption; evidence of a historical unit change in either
  climate history or reported-temperature rows also prevents assuming units
  for untagged readings.
  Windows split across series or with unknown units are dropped. The existing
  `coverage.unknownUnitWindows` counts room/sensor windows, not this separate
  reference. Known climate outages, unavailable attribute values and invalid
  unit windows cannot be crossed by the combined source intervals of a
  reference and the rooms it is compared with. After any such interruption,
  the first wholly subsequent, gap-free numeric source bucket is only a
  recovery anchor, not a comparison: the aggregate cannot establish when
  within it the numeric value returned. A bucket overlapping an outage or
  invalid window cannot be that anchor; later complete buckets can be used.
- **Alignment:** readings are placed on a 15-minute grid. A 15-minute average
  is used only once its window has ended, and for at most 30 minutes after the
  window started, so stale readings are never compared. A sensor joins an
  event's house average only if it is fresh for at least 75% of the event, and
  the average is only taken where every joined sensor is fresh, so membership
  doesn't change within an event. Home-specific heating advice selects its
  cohort using only eligible Home windows; wake advice selects it separately
  for each setting over its active heating windows. Sleep coverage therefore
  cannot make sparse Home readings count as a well-covered Home cohort, or
  vice versa. Only 15-minute averages whose whole source window lies inside
  the event count, so readings from just before it (e.g. while the thermostat
  was still off) never do. Scoped comparisons also require each source window
  to be wholly inside the setting being assessed.
- **Thermostat history** is the climate entity's InfluxDB fields (`domain`
  `climate`): `state` (mode), `hvac_action_str`, `preset_mode_str`, and set points
  (`temperature` in single-target modes, `target_temp_low` for heating and
  `target_temp_high` for cooling in range modes; `_str` variants too) in its
  `temperatureUnit`, converted to °C and dropped if the
  unit is unknown or the result is outside 5–35 °C. Set-point conversion assumes
  HA's last known climate unit applied historically, independently of whether
  the reported temperature has an explicit unit. If recorded climate-unit
  evidence is unknown or conflicts with that assumption, set points in that
  fetched window are discarded rather than guessed. Plausible values and
  absent conflict evidence cannot prove the unit never changed.
  Mode, action and preset carry forward between changes, except that a heating
  or cooling action incompatible with the reported mode is unknown, not idle;
  a compatible action reported at the same time as the mode is retained. Set
  points come from each change and are cleared on a mode change until reported again. A
  single `temperature` in `heat_cool`/`auto` is not identified as a heating
  target without `target_temp_low`. The last value
  before the window (within 30 days) gives the state at its start.
  Only `off`, `heating`, `cooling`, `drying`, `fan` and `idle` are treated as
  known actions. An `unavailable`/`unknown` or unsupported action is unknown
  (not a heating start, stop, satisfaction or zero-runtime evidence).
  `unavailable`/`unknown` states are gaps: they clear the carried
  action, preset and set points (a recovery row without them leaves them unknown),
  no transition is read across one,
  and history with nothing but gaps counts as unavailable
  (`hvacHistoryAvailable: false`, retried after 1 minute).
  Whole-window heating runtime and "rare heating" claims require a known action
  at the window start and throughout, without gaps or unknown actions. Otherwise
  runtime is unknown, not zero; known idle samples can still support a qualified
  passive-warmth observation.
- **Comfort setting** is the Ecobee select `<thermostat>_current_mode` (e.g.
  `select.home_current_mode`: `home`, `sleep`, `away`;
  `coverage.comfortScheduleAvailable`). It takes precedence; wherever it has no
  known value (a thermostat without it, before its first value, or while the
  select is unavailable), the climate entity's preset (`away`, `home`, `sleep`,
  …) is used instead, so wake-ups and returns from Away still work. A
  `none`/`unknown`/`unavailable` preset (or a gap) is unknown, not the previous
  preset.
- **Occupancy** comes from each discovered `occupancy` binary sensor (`value`
  0/1, change-driven, so each value holds until the next), matched to a
  temperature entity by their shared Home Assistant device ID, not their names.
  Independently of the temperature entity, analysis assumes that a uniquely
  matched occupancy entity on the primary climate device reflects its physical
  built-in sensor. Missing, multiple or unclassifiable binary-sensor matches are
  unknown; sensors without
  temperature (e.g. a door) are ignored. Used for Follow Me (`coverage.occupancyAvailable`).
  Current device associations are applied to the history; an entity reassigned
  during the window may not have had the same device then. HomeKit's occupancy
  timing and physical semantics have not been verified and can differ from
  Ecobee's API; no fixed motion-detection time is assumed. An
  `unavailable`/`unknown` state (a `state` field) makes occupancy unknown until
  the next value: it isn't carried across an outage, the Follow Me average
  isn't guessed while a required participant's occupancy is unknown (including
  a room or built-in sensor with no occupancy stream when others have one), and
  `occupiedShare` is `null` unless occupancy was known for at least 75% of the
  time. Reconstructed readings and contribution estimates require the relevant
  occupancy to be known and stable across the actual source-temperature
  intervals; a later grid-time change is not applied retroactively. For
  heating or cooling contributions those intervals must also lie within the
  relevant active run and comfort setting.
- **Thermostat-associated temperatures:** an `isThermostat` entity is not
  automatically the thermostat-reported comfort reading. A shared device, a
  name, a sole temperature entity, or even a matching current snapshot does not
  establish the meaning of its historical series. Discovery therefore does not
  identify those entities as the reference; the separately queried climate
  attribute can be used whenever fresh regardless of built-in participation.
  No synthetic sensor is added to the response. Unidentified thermostat-associated
  sensors retain their names, are never judged as rooms, and don't claim to be the
  selected reading. The legacy name "Thermostat (Ecobee average)" remains
  reserved for a separately identified reported-temperature sensor.
  Temperature sensors that cannot safely be distinguished from thermostat
  readings are omitted from placement
  analysis. An unreadable or classless indoor-looking discovered sensor can
  also be an unclassified temperature candidate. These prevent membership
  fitting and cause a degraded response; the indoor snapshot is unchanged.
  Without a positively identified reading, approximation needs the active
  setting and its complete configured room list, with every required room
  discovered and its temperature fresh. The built-in sensor must be explicitly
  excluded, or be unoccupied in the Follow
  Me model with at least one configured room occupied. Where Follow
  Me might change the mean, the required occupancies must also be known.
  If the built-in sensor might count, its independent temperature is unavailable,
  so an incomplete room-only mean isn't presented as the comfort reading.
  Follow Me off doesn't require occupancy; when the built-in sensor is
  explicitly excluded, a single configured room supplies the approximation even
  without occupancy history. Missing required members or evidence makes the
  reference unknown rather than partial. The thermostat is never judged as an
  outlier, and rooms are compared with each other without it. With a positively
  identified reported series, which rooms each setting may use can be estimated
  under the simple mean approximation only where the physical thermostat sensor
  is explicitly excluded: every plausible subset is scored over the same
  samples with temperatures from all discovered
  rooms and the reported reading, a stable setting, and stable known occupancy
  when Follow Me might apply. An absent room or too few complete comparable
  samples leaves membership unknown; intermittent rooms can still be fitted
  when at least 24 complete samples remain. With Follow Me omitted, mixed
  occupancy samples aren't comparable and are skipped. Rooms in every subset
  within 0.1 °C of the best fit
  (itself within 0.2 °C) count as in. The estimate shapes the wording ("The
  thermostat's readings suggest it's in your Home comfort setting") when
  participation isn't configured (estimated separately from the cooling data
  for cooling tips), and when it contradicts the configured
  participation a `participation-mismatch-<setting>` recommendation suggests
  checking the setting, subject to the model approximation.
  Membership isn't estimated when the reference is unidentified or Follow Me
  is on or omitted and there's no occupancy history.
  - A *morning warm-up* is a reported heating start (`hvac_action` changing
    from a reported non-heating action to heating, in a mode that can heat)
    between 04:00 and 10:00 server time, once per day. Set point or preset
    changes alone, and anything in `cool`/`off` mode, don't count. Server time
    is `TZ`, else the system time zone, else UTC.
  - A *wake-up* is a Sleep → Home change (`coverage.wakeEvents`). Heating in the
    immediately preceding Sleep interval within 3 hours of Home (Smart Recovery
    preheats, even if they finished before Home), else the first heating within
    2 hours after Home, is the wake-up heat-up and replaces the morning warm-up
    in that same interval. Earlier Sleep intervals separated by Away or an
    unknown setting, and heating across an unknown action or history gap, are
    not combined. Its room offsets are measured from the start of that heating
    through the first 2 hours of Home, stopping at an unknown action or gap,
    each reading against the comfort setting in force then.
    Source windows and every room in a comparison must have a compatible,
    unchanged heat-capable mode and `heating` or `idle` action; cooling,
    gaps and windows spanning HVAC state changes don't count.
    When the relevant Sleep/Home lead/tail search interval is inside the
    requested window, its actions are known throughout, and run boundaries
    are observed, its warm-up time is the sum of those heating runs (not the
    span from the first start to the last stop). Otherwise its duration is unknown, not zero;
    aggregate wake-minute claims require all included wakes to be measurable.
    Its modeled effect on the comfort reading is
    measured per comfort setting over the time those runs heated in it.
  - A *return from Away* is only an explicit comfort setting change from `away` to
    home, in a mode that can heat, with heating reported within 30
    minutes while the preset stays home/comfort (a switch back to Away, or any
    other preset, first cancels it). Without comfort setting history, `coverage.returnHistoryAvailable`
    is `false` and no returns are reported.
  - On days without an observed morning warm-up (e.g. the recorder keeps fewer
    days than requested, or there's no thermostat history at all), a morning
    warm-up is *inferred* when room sensors warm by 0.5 °C on average within an
    hour: each room's rise is from its own first to last reading in the window
    (so sparse or staggered rooms count; at least two rooms with two
    readings each are needed; thermostat-associated sensors aren't rooms),
    using only readings taken from the candidate
    start until the first off/cool state or gap (so the rise happens while
    heating is possible), unless the recorded thermostat mode couldn't heat then (off, cool)
    or it reported a `cooling` action (e.g. in `heat_cool`/`auto`). It
    never starts while such a state or a gap is in force (the last
    recorded state at or before its start, including a gap in the first
    returned row); it can start later, once a heat-capable state is. A
    reported `idle` action doesn't rule heating out: some integrations (e.g. an
    ecobee through `homekit_controller`) report idle for hours after a morning
    set point increase while the rooms warm. The earliest
    recorded (non-gap) state Home Assistant returned is reported, with its
    timestamp as returned, as `coverage.hvacEarliestStateAt`. A prior snapshot
    or first in-window state is respected from its recorded timestamp onward,
    not retroactively; before the first observation heating remains unobserved.
    `inferredMorningEvents` counts inferred events, and
    every recommendation's text says how many of a sensor's heat-ups were inferred.
- **Heating stopped:** the thermostat is *satisfied* only when it goes from
  heating to reported `idle` in a mode that can heat (an unknown
  action after heating ends the heat-up unsatisfied), with the
  mode, set point and preset unchanged since the event. Switching to
  `off`/`cool`, or any set point, preset or mode change during the heat-up
  (even while heating continues), is an *interruption*: it ends the heat-up,
  and no overshoot is measured for it.
- **Offsets:** each sensor's offset from the house average is measured from the
  event until heating is satisfied or interrupted (at most 2 hours, and not
  past a gap in thermostat history). An inferred event's window also ends at
  the first recorded `off`/`cool` state or gap, so readings taken once heating
  was impossible or unknown don't count. A sensor is `cold`/`warm` when it is at least 1.0 °C below/above
  the average in 60% of its events, `insufficient` with fewer than 3 events or
  12 samples, and `representative` otherwise. `averageOffset`, `morningOffset`
  and `returnOffset` use this room-only house average, not the thermostat's
  effective comfort average. Before the first thermostat observation or with
  no history, temperature-only inference remains available.
- **`overshoot`** is how far a room's highest 15-minute average was above the set
  point after the thermostat was satisfied, for up to 2 hours,
  ending early when the action is no longer reported idle, at the next set
  point, preset or mode change, at a gap in history, or at the next event.
  Only averages wholly inside that window count, and they must cover at least 75% of at least two
  15-minute windows. It's `0` when the room stayed at or below the set point and
  `null` when that can't be established: inferred events, unknown set points,
  heating that was interrupted or wasn't reported to stop within 4 hours, or
  too few readings. It is the peak above the set point, not the rise after
  heating stopped: a room already above the set point when heating stopped
  counts even if it didn't warm further.
- **Cooling** uses the most recent cooling (`hvac_action_str` `cooling`) in the
  past 365 days whose climate mode was `cool`, `heat_cool` or `auto`: up to
  `days` days of data ending 2 hours after it, or the requested window when it
  falls inside it, so cooling tips also show in winter
  (`coverage.coolingFrom`/`coolingTo`, `coolingEvents`; `null`/`0` when no
  cooling was found in the available history or the lookup could not be made).
  The lookup also reads 30 days of prior climate modes to establish the mode at
  the boundary. An action incompatible with its known mode is ignored; when a
  newer action's mode is missing, unavailable or conflicting, the window is
  unknown and no no-cooling claim is made. A later positively compatible action
  can establish the window. A successful empty lookup does not prove complete
  coverage for the year; a failed lookup makes no no-cooling claim. Cooling runs
  merge across reported `idle` spells under 30 minutes (heating runs: 20 minutes), never across a
  gap, an unknown action or any other action. Cooling event offsets and daily
  room comparisons use complete source buckets within actual active cooling,
  not the merged idle spells; every room in a comparison must belong to the
  same active run. Repeated parts of one run in the same comfort setting are
  combined before choosing its room cohort and checking the per-event sample
  minimum; they contribute a sample-weighted offset to one occurrence, not
  multiple runs. Other settings, idle spells and gaps aren't interpolated.
- **Passive warmth:** when the reported or approximated comfort reading sits at
  least 1.0 °C over the heating set point for at least half of 96 or more
  observed idle samples (excluding the 2 hours after a reported heating run),
  or under the cool set point with cooling idle in `cool` mode, a
  `passive-warmth-heating` / `passive-cooling` recommendation gives the sampled
  share and signed mean distance, whose direction can differ from the threshold
  share. It notes that sensor placement may still matter and offers other
  possible explanations; idle evidence doesn't prove the cause.
  The reported idle action, applicable mode and set point must hold throughout
  the temperature source intervals; gaps, changes and buckets overlapping a
  recent run aren't treated as observed idle.
  Heating runtime is included only with complete action coverage. When reported
  heating ran less than 10% of the completely observed window, heating tips are
  `low`.
- **Per-sensor drill-down:** `verdict` (`cold_outlier`, `warm_outlier`,
  `representative`, `insufficient`; `null` for the comfort average) with a
  one-sentence `verdictSummary`. A sensor is an outlier when it is consistently
  off the other rooms (cold/warm heat-ups as above, or at least 0.5 °C off on
  60% of at least 3 sampled calendar dates) and also stands out from the median
  room, so one outlier pulling the house average doesn't make every other room
  look skewed. A representative verdict uses the heating or cooling scope
  actually assessed; events from different settings cannot by themselves make
  a separately judged setting sufficient. A scope without enough evidence is
  not described as representative, and a no-changes summary discloses other
  settings or periods with insufficient evidence and observed heating scopes
  that weren't assessed.
  `periodOffsets` (`sleep`, `wake`, `home`, `heatingRuns`, `cooling`) are mean
  offsets from the thermostat-reported comfort reading, or from the complete
  room-only approximation where safe (otherwise `null`). `wakeOffset` and
  `coolingOffset` repeat the corresponding wake
  and cooling values. `wakeOvershoot` is how far
  the room peaked over an applicable Home heating set point in the 2 hours after
  waking (against the target in force within the first 15 minutes, excluding
  overlapping buckets before that target, and ending early at a set point,
  mode or preset change, an incompatible or unknown action, or a gap),
  averaged across measurable wakes whether or not they heated;
  `coolingUndershoot` is the greatest dip below the cool set
  point in whole source buckets of actual active cooling, with a stable target.
  Merged idle spells and buckets spanning target changes cannot contribute.
  Heating offsets and daily comparisons skip source windows with incompatible
  or unknown recorded modes/actions, gaps, or HVAC state changes; the combined
  room and reference source intervals must also be compatible. Before the
  first recorded state, and without thermostat history, temperature-only
  inference remains available. When any comfort setting
  is known, heating verdicts, `consistency` heating dates and heating tips use
  only Home source windows, including for every room in a house reference, so a
  carried Sleep reading isn't blamed on Home. Without any known setting,
  comparisons are not attributed to Home and advice remains setting-neutral.
  `consistency` counts local calendar dates with sufficient samples
  (`days`, `coldDays`, `warmDays`, `coolingDays`, `coolingColdDays`,
  `coolingWarmDays`), not full days or continuous coverage; partial dates at
  the ends of the window can count. `participation` and `occupiedShare` (`wake`,
  `home`) follow the request and occupancy; `recommendationIds` lists the tips
  about it.
- **Recommendations** (`high`, `medium`, `low`; sorted by severity, wake-up and
  passive warmth first) name the sensor, the affected rooms
  (`affectedSensorIds`) and observed temperature differences, give possible
  `likelyCauses`, and say what to do (`action`). These are hypotheses and
  actionable checks, not proof that placement caused the heating or cooling:
  - `wake-<sensor>` (`move`): a sensor at least 0.5 °C below the comfort average
    in 60% of measurable heated wake-ups while other rooms end up at least
    0.5 °C over the Home set point on those same cold wake-ups with sufficient
    room readings. The quoted cold offset and modeled Follow Me share use those
    cold wake-ups; the consistency denominator also includes comparable warmer
    wake-ups. Idle wakes, warmer wakes and heated wakes without that sensor's
    qualifying reference offsets do not contribute to the tip's overshoot. It
    targets the setting the temperature evidence came from: Home
    when measured there, else the setting the preheat ran in (e.g. Sleep,
    "while heating in Sleep before Home"). A sensor configured or estimated
    outside that setting isn't treated as a participant. It can mention a Sleep
    setback of 2 °C or more, a warm-up of an hour or more, and Smart Recovery.
    Setback advice requires applicable heating targets from Home and the
    immediately preceding continuous Sleep interval, without intervening
    incompatible states or gaps. The Sleep target must have been reported
    during that interval before the warm-up; a carried older target or a
    synthesized setting transition isn't a new observation. If only the
    warm-up duration is known it can suggest reviewing recovery timing instead.
    Changing the setback or reviewing recovery timing does not promise a
    reduction in total heating runtime.

    The Follow Me model assumes occupied participants count, or all participants
    count when none is occupied. An occupied included thermostat can therefore
    leave an unoccupied room out in the model; unknown built-in membership or
    occupancy leaves the result conditional unless other evidence settles it.
    A room's own occupancy can make it count in the model, while another known
    occupied participant can model it as left out. These are not verified
    real-world inclusion rules or weights. Tips report modeled shares as
    approximate percentages of comparable samples, not exact participation
    time, and state that actual Follow Me timing and weighting may differ. At
    least 75% of candidate samples need sufficient evidence; if a modeled share
    is zero but some samples are unknown, the share is unknown. A zero modeled
    share does not suppress guidance or prove a sensor irrelevant: the tip is
    conditional and `low`. Unknown shares likewise get conditional `low` tips.

    When `followMe` is omitted, the model only counts a room where it would
    count either way; the effective reference is unknown where Follow Me would
    change it. With no occupancy history, omitted or `true` `followMe` usually
    leaves contribution unknown and prevents reconstructing a multi-sensor
    reference. The exception is a single configured room with the physical
    thermostat explicitly excluded, which supplies the approximation without
    occupancy. The fresh thermostat-reported climate series is usable
    regardless of built-in membership. `followMe=false` tells the
    model to use every member. The same qualifications apply to other heat-ups
    and to cooling using its own history.
  - `move-<sensor>` / `remove-<sensor>` (`move`, `exclude_from_comfort` for a
    warm Kitchen known to participate) for other heat-ups;
    `cooling-<sensor>` (always `move`) for cooling. Heating tips are about Home
    when that setting is known. When no setting is known, useful room
    comparisons may still yield `low`, conditional move advice with
    `comfortSetting: null`; they do not infer Home membership or suggest
    changing a specific setting. Heating-tip overshoot and severity use only
    the biased heat-ups supporting that sensor's assessment, in Home when
    scoped there; a sampled-date-only assessment has no matched heat-up
    overshoot. The public `overshoot` field continues to summarize all measured
    heat-ups.
    Cooling runs are split where the comfort setting changes, and cooling is
    judged separately in each setting from that setting's parts only (parts in
    an unknown setting form their own conditional, setting-neutral group),
    so evidence and advice are never blended across settings; the text
    names the setting ("while cooling ran in Sleep") when cooling ran in more
    than one. A room with the same kind of tip in two settings gets the
    setting appended (`cooling-<sensor>-sleep`, or `-unknown` for the
    unknown-setting group). Without a heating verdict,
    `verdict` uses the first skewed setting by cooling time; `coolingOffset`, `coolingUndershoot` and the
    cooling `consistency` counts cover all cooling; the rooms a tip says the AC
    overcooled come from that setting's cooling only, with the greatest dip
    counted once per original run even when that setting has multiple parts.
  - `add-<sensor>` / `add-cooling-<sensor>` (`include_in_comfort`) for a room known
    not to participate that is consistently off, or a room that overshoots by
    1.0 °C or more when no other heating tip applies.
  - `passive-warmth-heating`, `passive-cooling`, `participation-mismatch-<setting>`
    and `no-changes` (`none`). `no-changes` summarizes what the data covered (it
    only claims no overshoot when it was measured for every room, and names
    sensors without enough data and inferred heat-ups). When a room was measured
    as an outlier or overshooting but no tip applies (e.g. it's already in the
    setting), it's titled "No changes suggested"
    and names those rooms instead of saying there was no bias.
  `mode` (`heating`/`cooling`), `period` and `comfortSetting` say when it
  applies. `action` stays within the existing values (`move`,
  `exclude_from_comfort`, `include_in_comfort`, `none`); exclude/include refer
  to the comfort setting named by `comfortSetting`.

```json
{
  "generatedAt": "ISO", "windowDays": 14, "unit": "°C",
  "coverage": {"start": "ISO", "end": "ISO", "hvacHistoryAvailable": true,
    "hvacEarliestStateAt": "ISO", "returnHistoryAvailable": true,
    "morningEvents": 9, "inferredMorningEvents": 2, "returnEvents": 0,
    "unknownUnitWindows": 0,
    "unitAssumptions": {"reportedTemperature": true, "setpoints": true,
      "coolingReportedTemperature": false, "coolingSetpoints": true},
    "participationConfigured": true, "thermostatParticipationSupported": true, "followMe": false,
    "occupancyAvailable": true, "comfortScheduleAvailable": true, "wakeEvents": 14,
    "coolingFrom": "ISO", "coolingTo": "ISO", "coolingEvents": 21},
  "sensors": [{"id": "bedroom_temperature", "name": "Bedroom", "isThermostat": false,
    "averageOffset": -1.5, "morningOffset": -1.5, "returnOffset": null,
    "overshoot": 0, "sampleCount": 120, "classification": "cold",
    "wakeOffset": -1.5, "coolingOffset": 0.1,
    "participation": {"home": true, "sleep": true, "away": null},
    "occupiedShare": {"wake": null, "home": null},
    "verdict": "cold_outlier",
    "verdictSummary": "Bedroom reads 1.5 °C below the house average during morning warm-ups, …",
    "periodOffsets": {"sleep": -1.5, "wake": -1.5, "home": -1.5, "heatingRuns": -1.5, "cooling": 0.1},
    "wakeOvershoot": 0, "coolingUndershoot": 0,
    "consistency": {"days": 14, "coldDays": 13, "warmDays": 0, "coolingDays": 5,
      "coolingColdDays": 0, "coolingWarmDays": 0},
    "recommendationIds": ["wake-bedroom"]}],
  "recommendations": [{"id": "wake-bedroom", "severity": "medium", "sensorId": "bedroom_temperature",
    "action": "move", "title": "Bedroom may be holding the morning warm-up on",
    "detail": "In 13 of 14 wake-ups (Sleep → Home), Bedroom read 1.5 °C below the reported or approximated comfort reading. Because it's in your Home comfort setting, a low reading could contribute to a longer warm-up. Living, Kitchen and Office peaked 0.5, 0.5 and 0.5 °C over the Home set point on average in the 2 hours after waking. Move it to an interior wall at about chest height, away from windows, doors and vents, or remove it from Home. …",
    "mode": "heating", "period": "wake", "comfortSetting": "home",
    "affectedSensorIds": ["living_temperature", "kitchen_temperature", "office_temperature"],
    "likelyCauses": ["near a window or exterior wall"]}]
}
```

Everything after `classification` in `sensors[]`, after `title`/`detail` in
`recommendations[]`, and after `unknownUnitWindows` in `coverage` is optional
for older clients; clients should ignore unknown enum values. Offsets and
`overshoot` are `null` without data; `sensorId` is `null` for `none`
recommendations. InfluxDB failures return an empty or partial analysis rather
than an error; `503` means InfluxDB isn't configured.

## Car analytics

The authenticated car analytics endpoint calculates historical usage on the
server so clients and AI providers do not need raw InfluxDB access:

```
GET /analytics/car?range=30d&comparison=previous&topic=overview
```

Supported preset ranges are `7d`, `30d`, `90d`, `1y`, and `all`. Explicit
ISO-8601 `start` and `end` query parameters select a custom period. `all` means
all data retained by the configured InfluxDB bucket; the server uses adaptive
five-minute, fifteen-minute, hourly, or daily aggregation based on period length.
Charging state is queried separately at five-minute resolution so averaging
cannot erase session transitions.

The response includes:

- charging session count, frequency, duration, and battery gained;
- distance calculated from validated odometer deltas;
- measured `kWh/100 km` efficiency when cumulative energy telemetry exists;
- an explicitly labeled `%/100 km` battery-use estimate otherwise;
- outdoor-temperature bands and weather-impact comparisons;
- previous-period changes, coverage, sample counts, and warnings;
- the requested and effective retained-data periods and timezone.

Measured efficiency is optional. Configure a monotonic Home Assistant energy
sensor and its unit:

```
CAR_ENERGY_ENTITY_ID=sensor.kia_energy_total
CAR_ENERGY_UNIT=kWh
```

`CAR_ENERGY_UNIT` accepts `Wh` or `kWh`; stored InfluxDB values are normalized
to `energy_total_kwh`. If the sensor is absent or has insufficient coverage,
the API never presents a battery-based estimate as measured energy efficiency.
The outdoor series defaults to
`patio_environment_canada_temperature` and can be changed with
`CAR_ANALYTICS_OUTDOOR_TEMPERATURE_ENTITY_ID`.

Ask FluxHaus exposes the same deterministic calculation through the
`get_car_analytics` tool. Historical car questions should use this tool rather
than the generic `influxdb_query` tool.

## Calendar setup

Calendars are available in both the MCP server and the AI command endpoint. The server keeps the existing Home Assistant calendar access and adds optional providers for iCloud, Microsoft 365, and subscribed ICS feeds.

You can configure calendar sources in two ways:

1. **Per-user stored sources** via the authenticated `/calendar-sources` API
2. **Environment-based fallback sources** via `.env`

If you want a browser UI instead of raw API calls, open **`/calendar-settings`** after signing in. It lets each user:

- add iCloud, Microsoft 365, or ICS sources
- review saved sources
- delete sources
- choose the default calendar for new events

### Default calendar

The server supports a per-user `defaultCalendarId` preference. Calendar creation tools use it when no `calendar_id` is provided.

- `GET /preferences` returns the current `defaultCalendarId`
- `PATCH /preferences` accepts `defaultCalendarId` as a string or `null`

Use `list_calendars` first, then copy the returned `id` into `defaultCalendarId`.

### Managing stored calendar sources

Authenticated users can manage their own providers with:

- `GET /calendar-sources`
- `POST /calendar-sources`
- `PATCH /calendar-sources/:id`
- `DELETE /calendar-sources/:id`

Secrets are stored encrypted in PostgreSQL and are not returned in plaintext from these routes.
ICS source URLs must use a public `http` or `https` endpoint; localhost and private-network
addresses are rejected.

### iCloud

Use an Apple app-specific password.

```env
ICLOUD_CALDAV_URL=https://caldav.icloud.com
ICLOUD_APPLE_ID=you@example.com
ICLOUD_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
```

### Microsoft 365

Create an Azure app registration with:

- redirect URI: `http://localhost:8787/auth/m365/callback`
- delegated scopes: `offline_access`, `User.Read`, `Calendars.Read`, `Calendars.ReadWrite`

Then bootstrap the refresh token:

```bash
npm run login-m365
```

Add the printed refresh token to `.env`:

```env
M365_TENANT_ID=...
M365_CLIENT_ID=...
M365_CLIENT_SECRET=...
M365_REFRESH_TOKEN=...
M365_USER_ID=me
```

### Subscribed calendars

For a single ICS feed:

```env
SUBSCRIBED_CALENDAR_NAME=Subscribed Calendar
SUBSCRIBED_CALENDAR_URL=https://example.com/calendar.ics
```

For multiple ICS feeds:

```env
SUBSCRIBED_CALENDARS_JSON=[{"id":"school","name":"School Calendar","url":"https://example.com/calendar.ics"}]
```

Subscribed calendars are always read-only.

These `.env` calendar settings remain useful as server-wide fallback sources, but the preferred setup for personal providers is the per-user `/calendar-sources` API.

### Calendar tools

The MCP server and AI command endpoint expose:

- `list_calendars`
- `get_calendar_events`
- `list_events`
- `get_today_agenda`
- `create_calendar_event`
- `update_calendar_event`
- `delete_calendar_event`

## Health Check

The `/health` endpoint is unauthenticated and returns the status of all services:

```bash
curl http://localhost:8888/health
```

```json
{
  "status": "healthy",
  "version": "1.2.15",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "services": {
    "postgres": "up",
    "influxdb": "up",
    "oidc": "up"
  }
}
```

Status values: `healthy` (all up), `degraded` (non-critical service down), `unhealthy` (postgres down → HTTP 503).

## Audit Logging

Auth events and every authenticated API request are logged to the `audit_logs` PostgreSQL table:

| Event | Action |
| :--- | :--- |
| OIDC browser login | `oidc_login` |
| OIDC login failure | `oidc_login_failed` |
| Logout | `logout` |
| Rejected auth | `auth_failed` |
| API request | `GET`, `POST`, etc. |

Admins can query the audit log via the API:

```bash
GET /audit?limit=50&offset=0&username=admin&since=2024-01-01T00:00:00Z
```

## Configuration

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Server port | `8888` |
| **OIDC** | | |
| `OIDC_ISSUER_URL` | OIDC issuer discovery URL | |
| `OIDC_CLIENT_ID` | OIDC client ID | |
| `OIDC_CLIENT_SECRET` | OIDC client secret | |
| `OIDC_REDIRECT_URI` | OAuth callback URL | `http://localhost:8888/auth/callback` |
| `SESSION_SECRET` | Secret for signing session cookies | `fluxhaus-dev-secret` |
| **Auth** | | |
| `BASIC_AUTH_PASSWORD` | Legacy admin password (basic auth fallback) | |
| `RHIZOME_PASSWORD` | Rhizome guest user password | |
| `DEMO_PASSWORD` | Demo guest user password | |
| **Database** | | |
| `POSTGRES_URL` | PostgreSQL connection string | |
| `INFLUXDB_URL` | InfluxDB URL | |
| `INFLUXDB_TOKEN` | InfluxDB API token | |
| `INFLUXDB_ORG` | InfluxDB organisation (name or ID) | `fluxhaus` |
| `INFLUXDB_BUCKET` | InfluxDB bucket | `fluxhaus` |
| **Server** | | |
| `CORS_ORIGINS` | Comma-separated allowed origins | `http://localhost:8080,https://haus.fluxhaus.io` |
| `LOG_LEVEL` | Pino log level | `info` |
| **Home Assistant** | | |
| `HOMEASSISTANT_URL` | Home Assistant URL | `http://homeassistant.local:8123` |
| `HOMEASSISTANT_TOKEN` | Home Assistant Long-Lived Access Token | |
| `CLEANBOT_ENTITY_ID` | Entity ID for Cleanbot | `vacuum.v70_ultra_complete` |
| `CLEANBOT_BATTERY_ENTITY_ID` | Battery sensor entity for Cleanbot | `sensor.v70_ultra_complete_battery_level` |
| `CAR_ENTITY_PREFIX` | HA entity prefix for the car | `kia` |
| `INDOOR_CLIMATE_INTEGRATION` | HA integration whose temperature/occupancy sensors and thermostat are discovered | `ecobee` |
| **AI** | | |
| `AI_PROVIDER` | AI provider: `anthropic`, `copilot`, `github-copilot`, `zai`, `z.ai`, or `openai` | `anthropic` |
| `AI_MODEL` | Model name override | *(provider default)* |
| `ANTHROPIC_API_KEY` | Anthropic API key | |
| `GITHUB_TOKEN` | GitHub token with `copilot` scope (Copilot provider) | |
| `ZAI_API_KEY` | Z.ai API key | |
| `ZAI_BASE_URL` | Z.ai base URL | `https://api.z.ai/api/v1` |
| `OPENAI_API_KEY` | OpenAI API key | |
| **Personal memory (Hindsight)** | | |
| `HINDSIGHT_URL` | Base URL of the private Hindsight service | |
| `HINDSIGHT_APP_KEY` | Server-side app key for Hindsight (never logged or returned) | |
| `HINDSIGHT_ALLOWED_ISSUERS` | Comma-separated OIDC issuer URLs whose users may use personal memory | |
| `HINDSIGHT_BANK` | Hindsight memory bank name | `shared` |
| `HINDSIGHT_TIMEOUT_MS` | Per-request timeout to Hindsight | `4000` |

See `.env-example` for the complete list including Miele, HomeConnect, and Modern Dog integrations.

## AI Command Endpoint

Send a plain-English command to control your home. The server runs a full tool-calling loop and returns a natural-language confirmation. This endpoint is admin-only.

```
POST /command
Authorization: Bearer <token>
Content-Type: application/json

{ "command": "Lock the car and start cleanbot" }
```

Response:
```json
{ "response": "Done! Your car is locked and cleanbot is cleaning." }
```

Configure the provider with `AI_PROVIDER` (default: `anthropic`) and the matching API key. Default models per provider:

| Provider | Default model |
| :--- | :--- |
| `anthropic` | `claude-3-5-sonnet-20241022` |
| `copilot` / `github-copilot` | `gpt-4o` |
| `zai` / `z.ai` | `glm-4-flash` |
| `openai` | `gpt-4o` |

## Personal memory (Hindsight)

Separately from FluxHaus's own encrypted memories (`user_memories`, managed by `save_memory`/`list_memories`), the assistant can use a **personal memory** that each user shares with their other assistants. It is backed by the owner's private Hindsight service. Nothing is imported from or mirrored into FluxHaus's own memories.

**Notice shown to users:** The assistant may save durable facts about you (preferences, household routines, projects) to your private personal memory, which is shared with your other assistants. Saved memories are processed by OpenAI for fact extraction and stored on the owner's home server. You can turn this off at any time with the `personalMemoryEnabled` preference; turning it off stops new saves and recall but does not delete anything already saved.

**Who gets it:** every signed-in OIDC user, isolated by their OIDC subject. It is **on by default** (`personalMemoryEnabled: true`) and only offered when all of these hold, checked server-side on every request:

- `HINDSIGHT_URL`, `HINDSIGHT_APP_KEY`, and `HINDSIGHT_ALLOWED_ISSUERS` are all set (otherwise the feature is fully disabled);
- `SESSION_SECRET` is set to a strong, non-default value (session cookies and MCP tokens that carry the issuer are signed with it, so personal memory stays disabled when it is unset or left at the `fluxhaus-dev-secret` default);
- the user has an OIDC subject and the issuer that validated their login is in `HINDSIGHT_ALLOWED_ISSUERS` (Basic-auth users never qualify; browser sessions created before this feature need to sign in again; MCP tokens qualify only if they were issued from a validated OIDC login; bearer tokens that can only be validated through the primary issuer's userinfo endpoint qualify only if they are JWTs whose `iss` is the primary issuer — opaque tokens do not);
- the user's `personalMemoryEnabled` preference is on (`PATCH /preferences { "personalMemoryEnabled": false }` turns it off).

Otherwise the `recall_personal_memory` and `save_personal_memory` tools are not offered to the model and are refused if called. Background work (scheduled routines, webhooks, conversation titles) never uses personal memory.

**What gets saved:** short (≤1000 characters), standalone, durable facts useful across assistants. The assistant is instructed never to save credentials, secrets, tokens, or codes; raw transcripts or conversation dumps; other people's sensitive data; precise security details such as door codes or alarm schedules; or transient chit-chat, and obvious credentials are rejected server-side. Recalled memories are capped (10 items / 4000 characters) and passed to the model as fenced, untrusted data.

**Privacy and failure handling:** requests authenticate with the server-side app key and send the user's validated subject in `X-Hindsight-Subject`; redirects are refused and each request has a short timeout. Memory content, queries, and the app key are never logged — only operation names and status codes. If Hindsight is unavailable the assistant says so and chat and home controls keep working.

Client toggles for `personalMemoryEnabled` live in the FluxHaus client apps (separate repositories) and are not part of this server.

## MCP Server

FluxHaus ships a [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants like Claude Desktop can control your home directly.

### Running the local stdio MCP server

```bash
node dist/mcp.js
```

### Claude Desktop configuration

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fluxhaus": {
      "command": "node",
      "args": ["/path/to/FluxHaus-Server/dist/mcp.js"],
      "env": {
        "HOMEASSISTANT_URL": "http://homeassistant.local:8123",
        "HOMEASSISTANT_TOKEN": "<your-token>",
        "CAR_ENTITY_PREFIX": "kia"
      }
    }
  }
}
```

### Remote MCP over HTTP

The main web server also exposes a Streamable HTTP MCP endpoint at:

```text
https://<your-fluxhaus-host>/mcp
```

Remote MCP defaults to `MCP_AUTH_MODE=proxy`, using Bearer tokens issued by the built-in MCP OAuth proxy routes. Configure OIDC (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`) and a strong `SESSION_SECRET`. Existing clients keep this behavior unless an operator explicitly switches modes. The OAuth protected-resource metadata is available at both:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

#### Opt-in direct Authentik OIDC

This protects FluxHaus's **own** `/mcp` endpoint; it is not an external MCP client integration. Create a **dedicated public FluxHaus MCP Authentik application and OAuth2/OIDC provider** with slug `fluxhaus-mcp-oidc`, separate from browser/mobile and SynthBook providers. Leave the existing confidential `fluxhaus-mcp` application/provider unchanged: it serves the legacy proxy callback.

```dotenv
MCP_AUTH_MODE=oidc
MCP_ISSUER_URL=https://auth.fluxhaus.io/application/o/fluxhaus-mcp-oidc/
MCP_RESOURCE_URL=https://api.fluxhaus.io/mcp
```

Both URLs must be absolute HTTPS with no credentials, query or fragment (explicit loopback HTTP is allowed for local tests/development). The resource path must be exactly `/mcp`; the issuer must match discovery and JWT `iss` exactly, including its trailing slash. Metadata and verification use these operator settings, never request Host or forwarded headers. Missing/invalid settings or unsupported modes fail closed with 503.

- Pre-register a **public client ID** in Authentik and configure it in the MCP client; anonymous dynamic client registration is not assumed. Require authorization-code flow with **PKCE S256** and register Claude's exact redirect URI: `https://claude.ai/api/mcp/auth_callback`.
- Configure asymmetric JWT **access tokens**, with the FluxHaus-only canonical audience `https://api.fluxhaus.io/mcp` (your `MCP_RESOURCE_URL`) and a space-delimited `fluxhaus:mcp` scope. Request `fluxhaus:mcp offline_access` (**no `openid`**) and enable the provider's refresh-token policy. ID tokens are not MCP credentials; opaque tokens, proxy JWTs and SynthBook read tokens are not accepted.
- **Enable “Include claims in id_token” (`include_claims_in_id_token`) on the dedicated Authentik provider:** this also gates property mappings in access JWTs, including the required audience mapping. The audience mapping also affects ID token claims, so do not request `openid` or use ID tokens for MCP authentication.
- If your Authentik version lacks RFC 8707 resource indicators, use a provider audience/scope mapping that emits the canonical MCP URL in `aud`, rather than its client ID. Verify actual access-token claims before switching; **never weaken the audience verifier**.
- **`fluxhaus:mcp` grants the existing full FluxHaus admin toolset: private home, calendar and infrastructure access, including mutations. It is not read-only.** Limit application access and scope grants to accounts already authorized for FluxHaus; do not share the SynthBook issuer or grant SynthBook read-token holders this scope.
- Direct mode advertises only the dedicated issuer, disables local `/register`, `/authorize`, `/token`, `/oauth/mcp-callback` and local authorization-server metadata, and has no proxy/browser/Basic/userinfo fallback. Dedicated MCP JWTs are also denied on general REST/admin routes before legacy bearer validation. Do **not** add the MCP issuer to `OIDC_ADDITIONAL_ISSUERS`.
- Personal memory may require explicit inclusion of this exact issuer in `HINDSIGHT_ALLOWED_ISSUERS` and a matching subject mapping to the user's existing FluxHaus account. Preserve stable `sub` attribution across providers; do not automatically grant memory policies. Existing session-secret and memory eligibility requirements still apply.

To retain or restore existing proxy clients, explicitly set `MCP_AUTH_MODE=proxy` and retain the existing OIDC/session configuration. **Keep both `MCP_ISSUER_URL` and `MCP_RESOURCE_URL` configured while the dedicated tokens/provider remain usable, even in proxy mode:** the REST deny guard uses those identifiers to prevent dedicated MCP tokens from becoming general REST/admin credentials. Do not remove both identifiers during rollback. Coordinate client/provider setup before the deployment switch; tokens are not interchangeable across modes.

Security notes:

- MCP access tokens are audience-bound to the `/mcp` resource and are not accepted as general REST admin tokens.
- Browser-origin calls to `/mcp` are restricted by `MCP_ALLOWED_ORIGINS` (falls back to `CORS_ORIGINS`). Non-browser MCP clients usually omit `Origin` and authenticate with Bearer tokens. Defaults/examples include Claude and GitHub Copilot surfaces (`https://claude.ai`, `https://github.com`, `https://github.dev`, `https://vscode.dev`).
- In proxy mode, MCP OAuth dynamic client registration only accepts redirect URI origins listed in `MCP_ALLOWED_REDIRECT_ORIGINS`. Loopback redirects (`localhost`, `127.0.0.1`, `[::1]`, any port) are always accepted for local clients such as Copilot CLI; GitHub/Copilot web origins are included in the defaults/examples.
- Web/image fetching tools reject localhost, `.local`, loopback, link-local, and private-network URLs to reduce SSRF risk from model-controlled URL fetches.

#### Scoped MCP API keys (`read` / `full`)

For MCP clients that cannot run an OAuth flow (or where a narrower grant is wanted), `/mcp` also accepts per-client API keys. They are **off by default**; enable them with `MCP_API_KEYS_ENABLED=true`. Keys look like `fhmcp_<publicId>_<secret>` and are sent as `Authorization: Bearer fhmcp_...`.

- **Storage:** only a SHA-256 hash is stored (`mcp_api_keys` table, created automatically). The raw key is shown once at creation. Each key has an owner (OIDC `sub`, issuer and username copied from the creator), a label, a scope, an optional expiry, `last_used_at`, and can be revoked.
- **Scopes:** `full` exposes every tool, resource and prompt. `read` exposes only an explicit allowlist (`MCP_READ_TOOLS` in `src/mcp-access.ts`); everything else is hidden from `tools/list`/`resources/list` and refused if called. `read` **excludes** all state-changing tools (car, robot, Home Assistant services/scenes, thermostat, calendar writes, Overseerr requests/approvals, Portainer container actions), tools whose output can contain secrets (`portainer_list_stacks` and `portainer_get_container` return stack/container environment variables such as database passwords; `portainer_list_endpoints` returns endpoint credentials/config), the arbitrary query tools `influxdb_query`, `grafana_query_datasource` and `render_template` (which can read any Home Assistant attribute, including camera tokens), the paid/outbound tools `web_search`, `fetch_webpage`, `summarize_url`, `view_image` and `generate_image`, and the `camera-url` resource. Prompts remain available. Tools added later are denied to `read` until they are classified.
- **Read redaction:** with `read` access every tool, resource and prompt result is scrubbed of embedded credentials, so a read key cannot obtain camera access or device secrets. The whole value (including objects/arrays) under credential-like keys — names ending in `token`, `secret`, `password`, `passphrase`, `authkey`, `api_key`/`apikey`, `private_key`/`privatekey` or `credential(s)` (snake_case or camelCase, e.g. `accessToken`, `clientSecret`), and UniFi `x_*key` fields such as `x_authkey`/`x_vwirekey` — becomes `[REDACTED]`, as do the URL parameters `token`, `access_token`, `apikey`, `api_key`, `key`, `auth`, `authSig`, `password`, `secret`, `X-Plex-Token`, signed-URL parameters (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `Signature`, `sig`) and Zoom `pwd` — including encoded forms such as `&amp;token=`, `&#38;`/`&#x26;` (with or without `;`), `\u0026`/`\u003f`, `%26token%3D`, double-encoded `%2526token%253D` and `;` separators — (e.g. Home Assistant camera `entity_picture` proxy links), URL credentials (`user:pass@`, password-only `:pass@`, `user:@`, and token-like usernames such as `ghp_…@`/`glpat-…@` or any 20+ character token; short names like `git@` stay), and calendar feed links (any `webcal://`/`webcals://` URL, iCloud `…icloud.com/published/…` link, or `http(s)` link to an `.ics` file). `list_calendars` omits the description of ICS subscription calendars (it holds the feed URL); ids and names stay. `portainer_list_containers` also omits container `Command` and `Labels`, and `prometheus_get_targets` omits `discoveredLabels`. Prompts redact their source data before embedding it in prose.
- **Input validation:** tool arguments that are interpolated into upstream URLs or Flux (IDs, entity IDs, timestamps, MAC addresses, repository names, state filters, InfluxDB bucket names) must match a strict format, so path traversal, query-parameter or Flux injection cannot reach endpoints outside a tool's purpose.
- **Isolation:** keys only work on `/mcp`. Any `Authorization` header containing `fhmcp_` (any case or whitespace, any scheme) on another route is rejected with 401 before any JWT or IdP userinfo validation, so keys are never sent to the identity provider — this holds even when `MCP_API_KEYS_ENABLED` is off. On `/mcp`, such headers never fall through to MCP JWT validation; malformed, invalid, revoked, expired or disabled keys (or an unavailable database) get 401. Logs record only the key's public id, and request audit records include the key id and scope.
- **Lifetime:** keys are independent of the identity provider — a key keeps working after its owner is deactivated or loses access in the IdP until it is revoked or expires. Always set an expiry (`expiresAt` / `--expires`) and revoke keys when access is removed; there is no enforced maximum lifetime.
- **Kill switch:** set `MCP_API_KEYS_ENABLED=false` (or unset it) and restart to reject every key immediately; existing keys stay stored and work again when re-enabled.

Self-service management (OIDC-signed-in users only — not Basic auth, MCP tokens or API keys; each user sees and revokes only their own keys, matched by OIDC `sub` and issuer (trailing slashes ignored; a login without an issuer matches only keys without one); create/revoke are audit-logged):

```bash
GET    /mcp-keys                       # { enabled, keys: [...] } — never returns hashes or secrets
POST   /mcp-keys   {"label":"Copilot CLI","scope":"read","expiresAt":"2027-01-01T00:00:00Z"}
                                       # 201 with the record plus "key" (shown once); expiresAt optional
DELETE /mcp-keys/<id>                  # revoke
```

Admin CLI (bundled as `dist/mcp-keys.js`; reads `POSTGRES_URL` from the environment or `/app/.env`). `--issuer` (for `create` and `list --sub`) defaults to `OIDC_ISSUER_URL`; it must match the owner's login issuer for the key to appear in their self-service list, so users who sign in through another trusted issuer (e.g. a separate MCP OIDC issuer) need an explicit `--issuer`. In the production container:

```bash
docker exec -it fluxhaus node dist/mcp-keys.js --help
docker exec -it fluxhaus node dist/mcp-keys.js create --sub <oidc-sub> --username <name> \
  [--issuer <issuer-url>] --scope read --label "Copilot CLI" [--expires 2027-01-01T00:00:00Z]
docker exec -it fluxhaus node dist/mcp-keys.js list [--sub <oidc-sub> [--issuer <issuer-url>]]
docker exec -it fluxhaus node dist/mcp-keys.js revoke <id-or-public-id>
```

Client setup examples:

```bash
# GitHub Copilot CLI
copilot mcp add --transport http --header "Authorization: Bearer fhmcp_..." fluxhaus https://api.fluxhaus.io/mcp
```

```jsonc
// VS Code .vscode/mcp.json — prompts for the key instead of storing it in the file
{
  "inputs": [{ "type": "promptString", "id": "fluxhaus-mcp-key", "description": "FluxHaus MCP API key", "password": true }],
  "servers": {
    "fluxhaus": {
      "type": "http",
      "url": "https://api.fluxhaus.io/mcp",
      "headers": { "Authorization": "Bearer ${input:fluxhaus-mcp-key}" }
    }
  }
}
```

Copilot Studio: add an MCP tool with server URL `https://api.fluxhaus.io/mcp` and authentication type **API key**, sent as a **header** named `Authorization`; enter the value as `Bearer fhmcp_...` (including the `Bearer ` prefix).

Prefer `read` keys for assistants that only need status; issue `full` keys sparingly, give each client its own key, set an expiry, and revoke keys you no longer use.

The MCP server exposes FluxHaus home, car, calendar, media, infrastructure, web, and image tools. Several high-value read tools return `structuredContent` in addition to text for modern MCP clients, and sensitive/state-changing tools are annotated with MCP tool hints.

## Breaking Changes

### v2.0 — OIDC + PostgreSQL migration

- **Admin auth is now OIDC-based.** Browser visitors are redirected to Authentik for login. API clients use Bearer tokens. Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI`. Basic auth with `BASIC_AUTH_PASSWORD` still works as a fallback during transition.
- **New required service: PostgreSQL 18.** Used for audit logs, session storage, and OAuth token persistence. Set `POSTGRES_URL`. Tables are auto-created.
- **New env vars:** `OIDC_REDIRECT_URI`, `SESSION_SECRET`, `INFLUXDB_*`.
- **Token storage migrated to PostgreSQL.** Miele and HomeConnect OAuth tokens are now stored in the `oauth_tokens` table. Existing `cache/miele-token.json` and `cache/homeconnect-token.json` files are automatically migrated on first access.
- **Docker Compose updated.** PostgreSQL service added. InfluxDB is no longer in compose (connect to an existing instance). All services use `network_mode: "host"`.

## Development

*   **Run tests**: `npm test`
*   **Lint code**: `npm run lint`
*   **Build**: `npm run build`

## License

MIT
