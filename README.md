# FluxHaus Server

A Node.js server that acts as the central nervous system for the FluxHaus smart home. It integrates various smart devices and services into a unified API.

## Features

*   **Robot Vacuums**: Control Roomba/Braava robots via Home Assistant.
*   **Car Integration**: Monitor and control Kia/Hyundai vehicles (Bluelinky).
*   **Appliances**: Monitor Miele (Washer/Dryer) and Bosch Home Connect (Dishwasher) appliances.
*   **Data Aggregation**: Fetches and caches data from external services (Modern Dog, GitHub).
*   **API**: Exposes a unified JSON API for the FluxHaus frontend.
*   **OIDC Authentication**: Admin access secured via Authentik (OIDC); guest roles use basic auth.
*   **PostgreSQL**: Persistent storage for audit logs and OAuth tokens.
*   **InfluxDB**: Time-series metrics storage.
*   **Structured Logging**: JSON-structured logs via pino with configurable log level.
*   **Audit Log**: Every authenticated request is recorded and queryable via `GET /audit`.
*   **Health Check**: `GET /health` endpoint for liveness/readiness probing.

## Breaking Changes

> **⚠️ If you are upgrading from a previous version, read this section first.**

*   **`BASIC_AUTH_PASSWORD` is removed.** Admin authentication now uses OIDC (Authentik). You must configure an OIDC provider before upgrading.
*   **PostgreSQL is now required.** A `POSTGRES_URL` must be provided. Tables are created automatically on first start.
*   **Miele and HomeConnect OAuth tokens** previously stored as files are automatically migrated to the database on first start.

See the [Migration Guide](#migration-guide) for step-by-step instructions.

## Prerequisites

*   **Docker**: Recommended for running the server.
*   **Node.js 24+**: If running locally.
*   **Home Assistant**: (Optional) If using Home Assistant for robot control.
*   **PostgreSQL 14+**: Required for audit logs and token storage.
*   **InfluxDB 2.x**: Required for time-series metrics.
*   **Authentik** (or another OIDC provider): Required for admin authentication.

## Getting Started

### Option 1: Docker Compose (Recommended)

You don't need to clone the code. Just create a directory with `docker-compose.yml` and `.env`.

1.  **Create `docker-compose.yml`**:
    ```yaml
    services:
      fluxhaus-server:
        image: ghcr.io/djensenius/fluxhaus-server:latest
        network_mode: "host"
        environment:
          - TZ=America/Toronto
        volumes:
          - ./cache:/app/cache
          - .env:/app/.env
        restart: unless-stopped
        depends_on:
          postgres:
            condition: service_healthy
          influxdb:
            condition: service_healthy
        healthcheck:
          test: ["CMD", "wget", "-qO-", "http://localhost:8888/health"]
          interval: 30s
          timeout: 10s
          retries: 3

      postgres:
        image: postgres:16
        environment:
          POSTGRES_USER: fluxhaus
          # ⚠️ Change this password before deploying to production
          POSTGRES_PASSWORD: password
          POSTGRES_DB: fluxhaus
        volumes:
          - postgres_data:/var/lib/postgresql/data
        restart: unless-stopped
        healthcheck:
          test: ["CMD-SHELL", "pg_isready -U fluxhaus"]
          interval: 10s
          timeout: 5s
          retries: 5

      influxdb:
        image: influxdb:2
        environment:
          DOCKER_INFLUXDB_INIT_MODE: setup
          DOCKER_INFLUXDB_INIT_USERNAME: admin
          # ⚠️ Change this password before deploying to production
          DOCKER_INFLUXDB_INIT_PASSWORD: adminpassword
          DOCKER_INFLUXDB_INIT_ORG: fluxhaus
          DOCKER_INFLUXDB_INIT_BUCKET: fluxhaus
          # ⚠️ Change this token before deploying to production
          DOCKER_INFLUXDB_INIT_ADMIN_TOKEN: change-me-influxdb-token
        volumes:
          - influxdb_data:/var/lib/influxdb2
        restart: unless-stopped
        healthcheck:
          test: ["CMD", "influx", "ping"]
          interval: 10s
          timeout: 5s
          retries: 5

    volumes:
      postgres_data:
      influxdb_data:
    ```

2.  **Configure Environment**:
    Download the example configuration and save it as `.env`:
    ```bash
    curl -o .env https://raw.githubusercontent.com/djensenius/FluxHaus-Server/main/.env-example
    ```
    Edit `.env` and fill in your credentials (see [Configuration](#configuration) below).

3.  **Run**:
    ```bash
    docker compose up -d
    ```

#### Volume Management and Backups

*   **PostgreSQL data** is stored in the `postgres_data` named volume. To back it up:
    ```bash
    docker exec <postgres-container> pg_dump -U fluxhaus fluxhaus > backup.sql
    ```
*   **InfluxDB data** is stored in the `influxdb_data` named volume. Use the InfluxDB CLI or UI for backups.
*   **Cache files** are stored in `./cache` on the host. Back up this directory to preserve cached API responses.

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

## Configuration

The server is configured via environment variables in the `.env` file.

### OIDC / Authentik Setup

FluxHaus uses [Authentik](https://goauthentik.io/) as its OIDC provider for admin authentication.

**Create an Authentik Application:**

1.  In Authentik, go to **Applications → Providers → Create** and choose **OAuth2/OpenID Provider**.
2.  Set the following:
    *   **Name**: `FluxHaus`
    *   **Client type**: `Confidential`
    *   **Redirect URIs**: `https://haus.fluxhaus.io/callback` (adjust to your domain)
    *   **Scopes**: `openid`, `profile`, `email`
    *   **Subject mode**: `Based on the hashed User ID` or `Based on the User's username`
3.  Copy the **Client ID** and **Client Secret**.
4.  Create an **Application** linked to this provider.
5.  Set the **Issuer URL** — it looks like `https://auth.example.com/application/o/fluxhaus/`.

**Required environment variables:**

| Variable | Description | Example |
| :--- | :--- | :--- |
| `OIDC_ISSUER_URL` | Authentik issuer URL for the application | `https://auth.example.com/application/o/fluxhaus/` |
| `OIDC_CLIENT_ID` | OAuth2 Client ID from Authentik | |
| `OIDC_CLIENT_SECRET` | OAuth2 Client Secret from Authentik | |

For more details, see the [Authentik documentation](https://docs.goauthentik.io/docs/applications).

### Authentication Model

FluxHaus uses a **hybrid authentication** model:

| Role | Auth Method | Access |
| :--- | :--- | :--- |
| `admin` | OIDC (Authentik) | Full access: robots, car, appliances, camera, all sensor data |
| `rhizome` | HTTP Basic Auth (`RHIZOME_PASSWORD`) | Rhizome schedule, photos, camera URL |
| `demo` | HTTP Basic Auth (`DEMO_PASSWORD`) | Robot status, car status, appliances (read-only, no secrets) |

Admin credentials are no longer a password — they are issued as a JWT by Authentik after the user authenticates via OIDC. The `rhizome` and `demo` roles continue to use HTTP Basic Auth passwords set in `.env`.

### PostgreSQL Setup

PostgreSQL stores audit logs and OAuth tokens (Miele, HomeConnect).

**Standalone setup:**

```bash
createuser -P fluxhaus          # enter a password when prompted
createdb -O fluxhaus fluxhaus
```

**Connection string format:**

```
POSTGRES_URL=postgresql://<user>:<password>@<host>:<port>/<database>
```

Tables are created automatically on first start — no manual schema migration is required.

**Tables created:**

| Table | Description |
| :--- | :--- |
| `audit_logs` | Record of every authenticated API request |
| `oauth_tokens` | Persisted OAuth tokens for Miele and HomeConnect |

### InfluxDB Setup

InfluxDB 2.x stores time-series metrics.

**Create an InfluxDB organization and bucket:**

1.  Start InfluxDB and open the UI at `http://localhost:8086`.
2.  Complete the initial setup wizard:
    *   **Username / Password**: choose admin credentials
    *   **Organization**: `fluxhaus`
    *   **Bucket**: `fluxhaus`
3.  Go to **Data → API Tokens → Generate API Token** and create an **All Access token** (or a scoped token with read/write on the `fluxhaus` bucket).
4.  Copy the token.

**Required environment variables:**

| Variable | Description | Default |
| :--- | :--- | :--- |
| `INFLUXDB_URL` | URL of the InfluxDB instance | `http://localhost:8086` |
| `INFLUXDB_TOKEN` | API token with read/write access | |
| `INFLUXDB_ORG` | Organization name | `fluxhaus` |
| `INFLUXDB_BUCKET` | Bucket name | `fluxhaus` |

### Robot Control

The server connects to a Home Assistant instance to control your robots. Requires a Long-Lived Access Token.

**To get a Home Assistant Token:**
1.  Log in to your Home Assistant.
2.  Click on your **Profile** (bottom left corner).
3.  Scroll down to **Long-Lived Access Tokens**.
4.  Click **Create Token**.
5.  Copy the token to `HOMEASSISTANT_TOKEN` in your `.env`.

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Port the server listens on | `8888` |
| `POSTGRES_URL` | PostgreSQL connection string | |
| `OIDC_ISSUER_URL` | OIDC issuer URL (Authentik) | |
| `OIDC_CLIENT_ID` | OIDC client ID | |
| `OIDC_CLIENT_SECRET` | OIDC client secret | |
| `INFLUXDB_URL` | InfluxDB URL | `http://localhost:8086` |
| `INFLUXDB_TOKEN` | InfluxDB API token | |
| `INFLUXDB_ORG` | InfluxDB organization | `fluxhaus` |
| `INFLUXDB_BUCKET` | InfluxDB bucket | `fluxhaus` |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins | `http://localhost:8080,https://haus.fluxhaus.io` |
| `LOG_LEVEL` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`) | `info` |
| `RHIZOME_PASSWORD` | Basic auth password for `rhizome` role | |
| `DEMO_PASSWORD` | Basic auth password for `demo` role | |
| `HOMEASSISTANT_URL` | URL of your Home Assistant instance | `http://homeassistant.local:8123` |
| `HOMEASSISTANT_TOKEN` | Long-Lived Access Token | |
| `BROOMBOT_ENTITY_ID` | Entity ID for Broombot | `vacuum.broombot` |
| `BROOMBOT_BATTERY_ENTITY_ID` | Entity ID for Broombot battery | `sensor.broombot_battery` |
| `MOPBOT_ENTITY_ID` | Entity ID for Mopbot | `vacuum.mopbot` |
| `MOPBOT_BATTERY_ENTITY_ID` | Entity ID for Mopbot battery | `sensor.mopbot_battery` |
| `CAR_ENTITY_PREFIX` | Home Assistant entity prefix for the car | `kia` |
| `CAMERA_URL` | URL of the camera snapshot | |
| `mieleClientId` | Miele client ID | |
| `mieleSecretId` | Miele client secret | |
| `mieleAppliances` | Comma-separated Miele appliance IDs | |
| `boschClientId` | Bosch / Home Connect client ID | |
| `boschSecretId` | Bosch / Home Connect client secret | |
| `boschAppliance` | Bosch appliance ID | |
| `favouriteHomeKit` | Comma-separated HomeKit favourite IDs | |
| `MODERN_DOG_URL` | Modern Dog API URL | |
| `MODERN_DOG_TOKEN` | Modern Dog API token | |
| `MODERN_DOG_COOKIE` | Modern Dog session cookie | |

## API Endpoints

### Health Check

```
GET /health
```

Returns a JSON object with the server version and the status of all dependencies:

```json
{
  "status": "ok",
  "version": "1.2.3",
  "postgres": "ok",
  "influxdb": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

This endpoint is unauthenticated and is used by Docker healthchecks and load balancers.

### Audit Log

```
GET /audit
```

Returns paginated audit log entries. Requires admin authentication.

**Query parameters:**

| Parameter | Description | Example |
| :--- | :--- | :--- |
| `limit` | Number of results (default: 100) | `?limit=50` |
| `offset` | Pagination offset (default: 0) | `?offset=100` |
| `username` | Filter by username | `?username=admin` |
| `action` | Filter by action/path | `?action=/startCar` |
| `since` | ISO 8601 timestamp — only entries after this time | `?since=2025-01-01T00:00:00Z` |

Every authenticated request is automatically recorded with the username, action, IP address, HTTP status, and timestamp.

## Structured Logging

FluxHaus uses [pino](https://getpino.io/) for structured JSON logging. Set `LOG_LEVEL` in `.env` to control verbosity:

```
LOG_LEVEL=debug   # trace | debug | info | warn | error
```

In production, pipe the output through `pino-pretty` for human-readable logs:

```bash
npm start | npx pino-pretty
```

## Migration Guide

### Migrating from Basic-Auth-Only Setup to OIDC

1.  **Set up Authentik** (or another OIDC provider) — see [OIDC / Authentik Setup](#oidc--authentik-setup).
2.  **Provision PostgreSQL** — see [PostgreSQL Setup](#postgresql-setup).
3.  **Provision InfluxDB** — see [InfluxDB Setup](#influxdb-setup).
4.  **Update `.env`**:
    *   Remove `BASIC_AUTH_PASSWORD`.
    *   Add `POSTGRES_URL`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `INFLUXDB_*`, `CORS_ORIGINS`, `LOG_LEVEL`.
    *   Keep `RHIZOME_PASSWORD` and `DEMO_PASSWORD` unchanged.
5.  **Update `docker-compose.yml`** — add the `postgres` and `influxdb` services (see [Docker Compose](#option-1-docker-compose-recommended)).
6.  **Restart the server**:
    ```bash
    docker compose down && docker compose up -d
    ```
7.  **Token migration**: Miele and HomeConnect OAuth tokens previously stored as files in `cache/` are automatically migrated to the `oauth_tokens` PostgreSQL table on first start. No manual action is required.

## Development

*   **Run tests**: `npm test`
*   **Lint code**: `npm run lint`
*   **Build**: `npm run build`

## License

MIT
