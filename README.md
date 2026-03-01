# FluxHaus Server

A Node.js server that acts as the central nervous system for the FluxHaus smart home. It integrates various smart devices and services into a unified API.

## Features

*   **Robot Vacuums**: Control Roomba/Braava robots via Home Assistant.
*   **Car Integration**: Monitor and control Kia/Hyundai vehicles (Bluelinky).
*   **Appliances**: Monitor Miele (Washer/Dryer) and Bosch Home Connect (Dishwasher) appliances.
*   **Data Aggregation**: Fetches and caches data from external services (Modern Dog, GitHub).
*   **API**: Exposes a unified JSON API for the FluxHaus frontend.
*   **AI Command Endpoint**: Natural-language `POST /command` endpoint powered by Anthropic, OpenAI, GitHub Copilot, or Z.ai.
*   **MCP Server**: Model Context Protocol server for AI assistants (Claude Desktop, etc.) to control your home.

## Prerequisites

*   **Docker**: Recommended for running the server.
*   **Node.js 24+**: If running locally.
*   **Home Assistant**: (Optional) If using Home Assistant for robot control.

## Getting Started

### Option 1: Docker Compose (Recommended)

You don't need to clone the code. Just create a directory with `docker-compose.yml` and `.env`.

1.  **Create `docker-compose.yml`**:
    ```yaml
    services:
      fluxhaus-server:
        image: ghcr.io/djensenius/fluxhaus-server:latest
        network_mode: "host"
        volumes:
          - ./cache:/app/cache
          - .env:/app/.env
        restart: unless-stopped
    ```

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

## Configuration

The server is configured via environment variables in the `.env` file. Copy `.env-example` to `.env` and fill in your values.

### Robot Control
The server connects to a Home Assistant instance to control your robots. Requires a Long-Lived Access Token.

**To get a Home Assistant Token:**
1.  Log in to your Home Assistant.
2.  Click on your **Profile** (bottom left corner).
3.  Scroll down to **Long-Lived Access Tokens**.
4.  Click **Create Token**.
5.  Copy the token to `HOMEASSISTANT_TOKEN` in your `.env`.

### Environment Variables

#### Server

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP port | `8888` |
| `BASIC_AUTH_PASSWORD` | Password for the `admin` user | |
| `RHIZOME_PASSWORD` | Password for the `rhizome` user | |
| `DEMO_PASSWORD` | Password for the `demo` user | |

#### Home Assistant / Robots

| Variable | Description | Default |
| :--- | :--- | :--- |
| `ROBOT_CONNECTION_TYPE` | `direct` or `homeassistant` | `direct` |
| `HOMEASSISTANT_URL` | URL of your Home Assistant instance | `http://homeassistant.local:8123` |
| `HOMEASSISTANT_TOKEN` | Long-Lived Access Token | |
| `BROOMBOT_ENTITY_ID` | Entity ID for Broombot | `vacuum.broombot` |
| `BROOMBOT_BATTERY_ENTITY_ID` | Entity ID for Broombot battery | `sensor.broombot_battery` |
| `MOPBOT_ENTITY_ID` | Entity ID for Mopbot | `vacuum.mopbot` |
| `MOPBOT_BATTERY_ENTITY_ID` | Entity ID for Mopbot battery | `sensor.mopbot_battery` |

#### Car (Kia/Hyundai via Home Assistant)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `CAR_ENTITY_PREFIX` | Name of your vehicle in Home Assistant | `kia` |

#### Appliances

| Variable | Description |
| :--- | :--- |
| `mieleClientId` | Miele API client ID |
| `mieleSecretId` | Miele API client secret |
| `mieleAppliances` | Comma-separated list of Miele appliance IDs |
| `boschClientId` | Bosch Home Connect client ID |
| `boschSecretId` | Bosch Home Connect client secret |
| `boschAppliance` | Bosch appliance ID |

#### AI Command Endpoint

| Variable | Description | Default |
| :--- | :--- | :--- |
| `AI_PROVIDER` | AI provider: `anthropic`, `copilot`, `github-copilot`, `zai`, `z.ai`, or `openai` | `anthropic` |
| `AI_MODEL` | Model name override (see defaults below) | *(provider default)* |
| `ANTHROPIC_API_KEY` | API key from [console.anthropic.com](https://console.anthropic.com) or your Claude.ai Pro plan | |
| `GITHUB_TOKEN` | GitHub token with the `copilot` scope (Copilot provider) | |
| `ZAI_API_KEY` | Z.ai API key | |
| `ZAI_BASE_URL` | Z.ai base URL | `https://api.z.ai/api/v1` |
| `OPENAI_API_KEY` | OpenAI API key | |

**Default models per provider:**

| Provider | Default model |
| :--- | :--- |
| `anthropic` | `claude-3-5-sonnet-20241022` |
| `copilot` / `github-copilot` | `gpt-4o` |
| `zai` / `z.ai` | `glm-4-flash` |
| `openai` | `gpt-4o` |

## AI Command Endpoint

Send a plain-English command to control your home. The server runs a full tool-calling loop and returns a natural-language response.

```
POST /command
Authorization: Basic admin:<password>
Content-Type: application/json

{ "command": "Lock the car and start the broombot" }
```

Response:
```json
{ "response": "Done! Your car is locked and the broombot is cleaning." }
```

This endpoint is admin-only. Configure the provider and credentials via the AI env vars above.

## MCP Server

FluxHaus ships a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI assistants like Claude Desktop can control your home directly.

### Running the MCP server

```bash
node dist/mcp.js
```

Or via `npx`:
```bash
npx ts-node src/mcp.ts
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

The MCP server exposes the same tools as the `/command` endpoint (lock/unlock/start/stop car, control robots, activate Home Assistant scenes).

## Development

*   **Run tests**: `npm test`
*   **Lint code**: `npm run lint`
*   **Build**: `npm run build`

## License

MIT
