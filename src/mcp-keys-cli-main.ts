// Admin CLI entry point, bundled by webpack to dist/mcp-keys.js.
// Usage (inside the production container): node dist/mcp-keys.js --help
import 'dotenv/config';

// Keep routine info logs (pool/table init) out of CLI output unless requested.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

// Loaded after LOG_LEVEL is set so the shared pino logger picks it up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runMcpKeysCli } = require('./mcp-keys-cli') as typeof import('./mcp-keys-cli');

runMcpKeysCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then((code) => {
  process.exitCode = code;
});
