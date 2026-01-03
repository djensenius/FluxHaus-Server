# FluxHaus Server

A Node.js server that acts as the central nervous system for the FluxHaus smart home. It integrates various smart devices and services into a unified API.

## Features

*   **Robot Vacuums**: Control Roomba/Braava robots via direct connection (dorita980) or Home Assistant.
*   **Car Integration**: Monitor and control Kia/Hyundai vehicles (Bluelinky).
*   **Appliances**: Monitor Miele (Washer/Dryer) and Bosch Home Connect (Dishwasher) appliances.
*   **Data Aggregation**: Fetches and caches data from external services (Modern Dog, GitHub).
*   **API**: Exposes a unified JSON API for the FluxHaus frontend.

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

The server is configured via environment variables in the `.env` file.

### Robot Control
You can choose between two connection methods for your robots:

*   **Direct (`ROBOT_CONNECTION_TYPE=direct`)**: Connects directly to the robot's IP using `dorita980`. Requires `blid` and `password`.
*   **Home Assistant (`ROBOT_CONNECTION_TYPE=homeassistant`)**: Connects to a Home Assistant instance. Requires a Long-Lived Access Token.

**To get a Home Assistant Token:**
1.  Log in to your Home Assistant.
2.  Click on your **Profile** (bottom left corner).
3.  Scroll down to **Long-Lived Access Tokens**.
4.  Click **Create Token**.
5.  Copy the token to `HOMEASSISTANT_TOKEN` in your `.env`.

## Development

*   **Run tests**: `npm test`
*   **Lint code**: `npm run lint`
*   **Build**: `npm run build`

## License

MIT
