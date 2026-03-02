import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServices } from './services';
import createMcpServer from './mcp-server';

async function main() {
  const services = await createServices();
  const server = createMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('FluxHaus MCP server error:', err);
  process.exit(1);
});
