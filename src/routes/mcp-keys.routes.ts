import {
  NextFunction, Request, Response, Router,
} from 'express';
import { logEvent } from '../audit';
import {
  createMcpApiKey, isMcpApiKeysEnabled, listMcpApiKeys, revokeMcpApiKey, validateMcpApiKeyInput,
} from '../mcp-api-keys';
import logger from '../logger';

const routesLogger = logger.child({ subsystem: 'mcp-keys-routes' });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Self-service key management is limited to OIDC-authenticated users (with a
 * `sub`). Basic-auth users have no sub; API-key users are rejected here as
 * defense in depth (the auth middleware already denies keys off /mcp).
 */
function requireOidcUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.sub || req.user.role !== 'admin' || req.user.authMethod === 'mcp_api_key') {
    res.status(403).json({ error: 'OIDC authentication required' });
    return;
  }
  next();
}

const router = Router();

router.get('/mcp-keys', requireOidcUser, async (req: Request, res: Response) => {
  try {
    const keys = await listMcpApiKeys(req.user!.sub!, req.user!.issuer);
    res.json({ enabled: isMcpApiKeysEnabled(), keys });
  } catch (err) {
    routesLogger.error({ err }, 'Failed to list MCP API keys');
    res.status(503).json({ error: 'MCP API keys unavailable' });
  }
});

router.post('/mcp-keys', requireOidcUser, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { label?: unknown; scope?: unknown; expiresAt?: unknown };
  const input = validateMcpApiKeyInput(body);
  if ('error' in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  const user = req.user!;
  try {
    const { key, record } = await createMcpApiKey({
      ...input,
      ownerSub: user.sub!,
      ownerIssuer: user.issuer ?? null,
      ownerUsername: user.username,
      createdBySub: user.sub!,
    });
    logEvent({
      user_sub: user.sub,
      username: user.username,
      role: user.role,
      action: 'mcp_api_key_created',
      route: '/mcp-keys',
      method: 'POST',
      ip: req.ip,
      details: {
        keyId: record.id, publicId: record.public_id, scope: record.scope, label: record.label,
      },
    }).catch(() => {});
    // The raw key is returned exactly once and is never retrievable again.
    res.status(201).json({ ...record, key });
  } catch (err) {
    routesLogger.error({ err }, 'Failed to create MCP API key');
    res.status(503).json({ error: 'MCP API keys unavailable' });
  }
});

router.delete('/mcp-keys/:id', requireOidcUser, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_PATTERN.test(id)) {
    res.status(404).json({ error: 'MCP API key not found' });
    return;
  }
  const user = req.user!;
  try {
    const record = await revokeMcpApiKey(id, user.sub!, user.issuer);
    if (!record) {
      res.status(404).json({ error: 'MCP API key not found' });
      return;
    }
    logEvent({
      user_sub: user.sub,
      username: user.username,
      role: user.role,
      action: 'mcp_api_key_revoked',
      route: '/mcp-keys/:id',
      method: 'DELETE',
      ip: req.ip,
      details: { keyId: record.id, publicId: record.public_id },
    }).catch(() => {});
    res.status(204).send();
  } catch (err) {
    routesLogger.error({ err }, 'Failed to revoke MCP API key');
    res.status(503).json({ error: 'MCP API keys unavailable' });
  }
});

export default router;
