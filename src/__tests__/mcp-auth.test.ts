import { SignJWT } from 'jose';
import { getMcpSigningKey, verifyMcpToken } from '../mcp-auth';

describe('MCP auth token verification', () => {
  const resource = 'https://haus.example.com/mcp';

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret';
  });

  async function token(claims: Record<string, unknown>, issuer = 'https://haus.example.com', audience = resource) {
    return new SignJWT({ sub: 'user-1', type: 'mcp', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(getMcpSigningKey());
  }

  it('accepts MCP tokens with matching issuer and audience', async () => {
    const jwt = await token({ email: 'user@example.com' });
    await expect(verifyMcpToken(jwt, resource)).resolves.toEqual({
      sub: 'user-1',
      email: 'user@example.com',
      preferred_username: undefined,
    });
  });

  it('rejects tokens with the wrong audience', async () => {
    const jwt = await token({}, 'https://haus.example.com', 'https://haus.example.com/other');
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });

  it('rejects tokens with the wrong issuer', async () => {
    const jwt = await token({}, 'https://evil.example.com', resource);
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });

  it('rejects tokens without MCP type', async () => {
    const jwt = await token({ type: 'session' });
    await expect(verifyMcpToken(jwt, resource)).resolves.toBeNull();
  });
});
