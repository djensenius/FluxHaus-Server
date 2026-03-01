import { Client, Issuer } from 'openid-client';
import logger from '../logger';

const oidcLogger = logger.child({ subsystem: 'oidc' });

let oidcClient: Client | null = null;
let oidcIssuer: Issuer<Client> | null = null;

export async function initOidc(): Promise<void> {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;

  if (!issuerUrl || !clientId) {
    oidcLogger.warn('OIDC_ISSUER_URL or OIDC_CLIENT_ID not set — OIDC disabled');
    return;
  }

  try {
    oidcIssuer = await Issuer.discover(issuerUrl);
    oidcClient = new oidcIssuer.Client({
      client_id: clientId,
      client_secret: clientSecret,
    });
    oidcLogger.info({ issuer: issuerUrl }, 'OIDC issuer discovered');
  } catch (err) {
    oidcLogger.warn({ err }, 'Failed to discover OIDC issuer — OIDC disabled');
  }
}

export function getOidcClient(): Client | null {
  return oidcClient;
}

export function getOidcIssuer(): Issuer<Client> | null {
  return oidcIssuer;
}

export async function validateBearerToken(
  token: string,
): Promise<{ sub: string; email?: string; preferred_username?: string } | null> {
  if (!oidcClient || !oidcIssuer) return null;

  try {
    // Use userinfo endpoint to validate the token
    const userinfo = await oidcClient.userinfo(token);
    if (!userinfo.sub) return null;
    return {
      sub: userinfo.sub,
      email: userinfo.email as string | undefined,
      preferred_username: userinfo.preferred_username as string | undefined,
    };
  } catch (err) {
    oidcLogger.debug({ err }, 'Bearer token validation failed');
    return null;
  }
}
