import { parseArgs } from 'util';
import { logEvent } from './audit';
import { closePool, initDatabase, initPool } from './db';
import {
  createMcpApiKey, listMcpApiKeys, McpApiKey, revokeMcpApiKey, validateMcpApiKeyInput,
} from './mcp-api-keys';

export const MCP_KEYS_CLI_USAGE = `Usage: node dist/mcp-keys.js <command> [options]

Commands:
  create --sub <sub> --username <name> --scope <read|full> --label <label>
         [--issuer <issuer-url>] [--expires <ISO-8601>]
      Create a key for an OIDC user. The key is printed once; store it securely.
  list [--sub <sub>]
      List keys (all owners, or one owner). Hashes and secrets are never shown.
  revoke <id|public-id>
      Revoke a key by UUID or public id.
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function formatKey(key: McpApiKey): string {
  const expires = key.expires_at ? new Date(key.expires_at).toISOString() : 'never';
  let status = 'active';
  if (key.revoked_at) status = 'revoked';
  else if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) status = 'expired';
  const lastUsed = key.last_used_at ? new Date(key.last_used_at).toISOString() : 'never';
  return [
    key.id, key.public_id, key.scope, status, key.owner_username, key.owner_sub,
    `expires=${expires}`, `last_used=${lastUsed}`, JSON.stringify(key.label),
  ].join('\t');
}

async function cliAudit(action: string, details: Record<string, unknown>, userSub?: string): Promise<void> {
  await logEvent({
    user_sub: userSub,
    username: 'admin-cli',
    role: 'admin',
    action,
    route: 'cli:mcp-keys',
    method: 'CLI',
    details,
  });
}

/**
 * Runs the admin CLI against the configured database. Returns the exit code.
 * Expects the pool to be initialised by the caller (see mcp-keys-cli-main.ts).
 */
export async function runMcpKeysCommand(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        sub: { type: 'string' },
        username: { type: 'string' },
        issuer: { type: 'string' },
        scope: { type: 'string' },
        label: { type: 'string' },
        expires: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(MCP_KEYS_CLI_USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(MCP_KEYS_CLI_USAGE);
    return values.help ? 0 : 2;
  }

  if (command === 'create') {
    if (!values.sub || !values.username) {
      io.err('create requires --sub and --username');
      return 2;
    }
    const input = validateMcpApiKeyInput({
      label: values.label, scope: values.scope, expiresAt: values.expires,
    });
    if ('error' in input) {
      io.err(input.error);
      return 2;
    }
    const { key, record } = await createMcpApiKey({
      ...input,
      ownerSub: values.sub,
      ownerIssuer: values.issuer ?? null,
      ownerUsername: values.username,
      createdBySub: null,
    });
    await cliAudit('mcp_api_key_created', {
      keyId: record.id, publicId: record.public_id, scope: record.scope, label: record.label,
    }, record.owner_sub);
    io.out(formatKey(record));
    io.out('');
    io.out('MCP API key (shown once — store it now):');
    io.out(key);
    return 0;
  }

  if (command === 'list') {
    const keys = await listMcpApiKeys(values.sub);
    io.out('id\tpublic_id\tscope\tstatus\towner_username\towner_sub\texpires\tlast_used\tlabel');
    keys.forEach((key) => io.out(formatKey(key)));
    return 0;
  }

  if (command === 'revoke') {
    const [identifier] = rest;
    if (!identifier) {
      io.err('revoke requires a key id or public id');
      return 2;
    }
    const record = await revokeMcpApiKey(identifier);
    if (!record) {
      io.err(`No MCP API key found for ${identifier}`);
      return 1;
    }
    await cliAudit('mcp_api_key_revoked', { keyId: record.id, publicId: record.public_id }, record.owner_sub);
    io.out(`Revoked ${formatKey(record)}`);
    return 0;
  }

  io.err(`Unknown command: ${command}`);
  io.err(MCP_KEYS_CLI_USAGE);
  return 2;
}

/** Initialises the database, runs a command, and closes the pool. */
export async function runMcpKeysCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return runMcpKeysCommand(argv, io);
  }
  if (!process.env.POSTGRES_URL) {
    io.err('POSTGRES_URL is not set');
    return 1;
  }
  initPool();
  try {
    await initDatabase();
    return await runMcpKeysCommand(argv, io);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await closePool();
  }
}
