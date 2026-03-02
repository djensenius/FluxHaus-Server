import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { createServices } from './services';
import createMcpServer from './mcp-server';
import { initOidc, isOidcEnabled, validateBearerToken } from './middleware/oidc.middleware';

async function main() {
  // Require a valid OIDC bearer token before serving any MCP requests.
  // Obtain a token by logging in via the FluxHaus web interface and copy the
  // access token, then set it as MCP_AUTH_TOKEN in the MCP client config.
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    console.error(
      'FluxHaus MCP: MCP_AUTH_TOKEN is required. '
      + 'Log in via OIDC at the FluxHaus web interface, obtain a bearer token, '
      + 'and set it as the MCP_AUTH_TOKEN environment variable.',
    );
    process.exit(1);
  }

  await initOidc();
  if (!isOidcEnabled()) {
    console.error(
      'FluxHaus MCP: OIDC is not configured on this server. '
      + 'Ensure OIDC_ISSUER_URL and OIDC_CLIENT_ID are set.',
    );
    process.exit(1);
  }

  const claims = await validateBearerToken(token);
  if (!claims) {
    console.error(
      'FluxHaus MCP: OIDC token validation failed. '
      + 'Ensure MCP_AUTH_TOKEN is a valid, non-expired OIDC bearer token.',
    );
    process.exit(1);
  }

  console.error(
    `FluxHaus MCP: Authenticated as ${claims.preferred_username || claims.email || claims.sub}`,
  );

  const services = await createServices();
  const server = createMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('FluxHaus MCP server error:', err);
  process.exit(1);
});
