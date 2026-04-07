import express, { Express } from 'express';

const port = Number(process.env.M365_LOGIN_PORT || 8787);
const tenantId = (process.env.M365_TENANT_ID || '').trim();
const clientId = (process.env.M365_CLIENT_ID || '').trim();
const clientSecret = (process.env.M365_CLIENT_SECRET || '').trim();
const redirectUri = (process.env.M365_REDIRECT_URI || `http://localhost:${port}/auth/m365/callback`).trim();
const scopes = (process.env.M365_SCOPES || 'offline_access User.Read Calendars.Read Calendars.ReadWrite').trim();

function buildAuthorizationUrl(): string {
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes);
  return url.toString();
}

async function exchangeCode(code: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        scope: scopes,
      }).toString(),
    },
  );

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<Record<string, unknown>>;
}

async function createServer(): Promise<Express> {
  const app: Express = express();

  app.get('/auth/m365/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      res.status(400).send('Missing code');
      return;
    }

    try {
      const token = await exchangeCode(code);
      const refreshToken = token.refresh_token;
      // eslint-disable-next-line no-console
      console.log('\nMicrosoft 365 OAuth complete.\n');
      // eslint-disable-next-line no-console
      console.log(`M365_REFRESH_TOKEN=${refreshToken}`);
      // eslint-disable-next-line no-console
      console.log(`M365_REDIRECT_URI=${redirectUri}`);
      res.send('Microsoft 365 login complete. Check your terminal for the refresh token.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).send(message);
    }
  });

  return app;
}

if (!tenantId || !clientId || !clientSecret) {
  throw new Error('Set M365_TENANT_ID, M365_CLIENT_ID, and M365_CLIENT_SECRET before running login-m365');
}

createServer().then((app) => {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Open this URL in your browser:\n\n${buildAuthorizationUrl()}\n`);
    // eslint-disable-next-line no-console
    console.log(`Waiting for callback on ${redirectUri}`);
  });
});
