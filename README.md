# FluxHaus Server

A Node.js server that acts as the central nervous system for the FluxHaus smart home. It integrates various smart devices and services into a unified API.

## Features

*   **Robot Vacuums**: Control Roomba/Braava robots via Home Assistant.
*   **Car Integration**: Monitor and control Kia/Hyundai vehicles (Bluelinky).
*   **Appliances**: Monitor Miele (Washer/Dryer) and Bosch Home Connect (Dishwasher) appliances.
*   **Data Aggregation**: Fetches and caches data from external services (Modern Dog, GitHub).
*   **API**: Exposes a unified JSON API for the FluxHaus frontend.
*   **OIDC Authentication**: Secure admin access via Authentik (or any OIDC provider) with basic auth fallback for demo/rhizome users.
*   **Audit Logging**: Every API request is logged to PostgreSQL for compliance and debugging.
*   **Health Check**: Unauthenticated `/health` endpoint for monitoring.
*   **Time-series Metrics**: Device data pushed to InfluxDB.
*   **Structured Logging**: All logs use pino for JSON-structured output.

## Prerequisites

*   **Docker**: Recommended for running the server.
*   **Node.js 24+**: If running locally.
*   **Home Assistant**: (Optional) If using Home Assistant for robot control.
*   **PostgreSQL 17**: For persistence and audit logging.
*   **InfluxDB 2**: For time-series metrics (optional).
*   **Authentik** (or any OIDC provider): For admin authentication (optional, falls back to basic auth).

## Getting Started

### Option 1: Docker Compose (Recommended)

You don't need to clone the code. Just create a directory with `docker-compose.yml` and `.env`.

1.  **Create `docker-compose.yml`** using the provided example in this repository.

2.  **Configure Environment**:
    Download the example configuration and save it as `.env`:
    ```bash
    curl -o .env https://raw.githubusercontent.com/djensenius/FluxHaus-Server/main/.env-example
    ```
    Edit `.env` and fill in your credentials.

3.  **Run**:
    ```bash
    docker compose up -d
    ```

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

### OIDC (Admin access via Authentik)

Admin access uses OpenID Connect. Configure your Authentik (or other OIDC provider) application and set:

```
OIDC_ISSUER_URL=https://auth.example.com/application/o/fluxhaus/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

Clients send a `Bearer <token>` in the `Authorization` header. If OIDC is not configured, admin access falls back to basic auth using `BASIC_AUTH_PASSWORD`.

### Basic Auth Fallback (Demo / Rhizome users)

Demo and rhizome users authenticate via HTTP Basic auth:
- `demo` / `DEMO_PASSWORD`
- `rhizome` / `RHIZOME_PASSWORD`

## PostgreSQL Setup

The server uses PostgreSQL for audit logging and OAuth token persistence.

```
POSTGRES_URL=postgresql://fluxhaus:password@localhost:5432/fluxhaus
```

Tables are created automatically on startup. When using Docker Compose, the `postgres` service is provisioned automatically.

## InfluxDB Setup

Optional time-series metrics for device state:

```
INFLUXDB_URL=http://localhost:8086
INFLUXDB_TOKEN=your-token
INFLUXDB_ORG=fluxhaus
INFLUXDB_BUCKET=fluxhaus
```

If not configured, InfluxDB integration is silently disabled.

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

Every API request is logged to the `audit_logs` PostgreSQL table. Admins can query the audit log:

```bash
GET /audit?limit=50&offset=0&username=admin&since=2024-01-01T00:00:00Z
```

## Configuration

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Server port | `8888` |
| `OIDC_ISSUER_URL` | OIDC issuer URL | |
| `OIDC_CLIENT_ID` | OIDC client ID | |
| `OIDC_CLIENT_SECRET` | OIDC client secret | |
| `BASIC_AUTH_PASSWORD` | Legacy admin password (basic auth fallback) | |
| `RHIZOME_PASSWORD` | Rhizome user password | |
| `DEMO_PASSWORD` | Demo user password | |
| `POSTGRES_URL` | PostgreSQL connection string | |
| `INFLUXDB_URL` | InfluxDB URL | |
| `INFLUXDB_TOKEN` | InfluxDB token | |
| `INFLUXDB_ORG` | InfluxDB organisation | `fluxhaus` |
| `INFLUXDB_BUCKET` | InfluxDB bucket | `fluxhaus` |
| `CORS_ORIGINS` | Comma-separated allowed origins | `http://localhost:8080,https://haus.fluxhaus.io` |
| `LOG_LEVEL` | Pino log level | `info` |
| `HOMEASSISTANT_URL` | Home Assistant URL | `http://homeassistant.local:8123` |
| `HOMEASSISTANT_TOKEN` | Home Assistant Long-Lived Access Token | |
| `BROOMBOT_ENTITY_ID` | Entity ID for Broombot | `vacuum.broombot` |
| `MOPBOT_ENTITY_ID` | Entity ID for Mopbot | `vacuum.mopbot` |
| `CAR_ENTITY_PREFIX` | HA entity prefix for the car | `kia` |

## Breaking Changes

### v2.0 — Auth migration

- **HTTP Basic Auth for admin is deprecated.** Admin access now uses OIDC Bearer tokens. Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`. Basic auth with `BASIC_AUTH_PASSWORD` still works as a fallback during transition.
- **Token storage migrated to PostgreSQL.** Miele and HomeConnect OAuth tokens are now stored in the `oauth_tokens` table. Existing `cache/miele-token.json` and `cache/homeconnect-token.json` files are automatically migrated on first access.
- **Docker Compose**: The `network_mode: "host"` has been replaced with explicit port mapping. PostgreSQL and InfluxDB services are now included.

## Development

*   **Run tests**: `npm test`
*   **Lint code**: `npm run lint`
*   **Build**: `npm run build`

## License

MIT
