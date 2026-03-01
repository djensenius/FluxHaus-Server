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

## Prerequisites

*   **Docker**: Recommended for running the server.
*   **Node.js 24+**: If running locally.
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
| `BROOMBOT_ENTITY_ID` | Entity ID for Broombot | `vacuum.broombot` |
| `BROOMBOT_BATTERY_ENTITY_ID` | Battery sensor entity for Broombot | |
| `MOPBOT_ENTITY_ID` | Entity ID for Mopbot | `vacuum.mopbot` |
| `MOPBOT_BATTERY_ENTITY_ID` | Battery sensor entity for Mopbot | |
| `CAR_ENTITY_PREFIX` | HA entity prefix for the car | `kia` |

See `.env-example` for the complete list including Miele, HomeConnect, and Modern Dog integrations.

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
