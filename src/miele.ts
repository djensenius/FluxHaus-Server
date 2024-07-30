import 'dotenv/config';
import { fetchEventData } from 'fetch-sse';
import fs from 'fs';

export default class Miele {
  private clientId: string;

  private clientSecret: string;

  private redirectUri: string;

  private MIELE_TOKEN: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = 'https://fluxhaus.io/auth/miele/callback';
    this.MIELE_TOKEN = '';
  }

  public async authorize(): Promise<void> {
    const url = 'https://api.mcs3.miele.com/thirdparty/login';
    const params = `client_id=${this.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code`;
    console.warn(`Visit ${url}?${params} to authorize your Miele account`);
  }

  public async getToken(code: string): Promise<void> {
    const url = 'https://api.mcs3.miele.com/thirdparty/token';
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const formBody = [];
    formBody.push(`client_id=${encodeURIComponent(this.clientId)}`);
    formBody.push(`client_secret=${encodeURIComponent(this.clientSecret)}`);
    formBody.push(`code=${encodeURIComponent(code)}`);
    formBody.push(`grant_type=${encodeURIComponent('authorization_code')}`);
    formBody.push(`vg=${encodeURIComponent('en-CA')}`);
    formBody.push(`redirect_uri=${encodeURIComponent(this.redirectUri)}`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formBody.join('&'),
    });

    const body = await response.json();
    if (body.access_token) {
      this.MIELE_TOKEN = body.access_token;
      fs.writeFileSync(
        'cache/miele-token.json',
        JSON.stringify({ timestamp: new Date(), ...body }, null, 2),
      );
    }
  }

  public async refreshToken(): Promise<void> {
    if (!fs.existsSync('cache/miele-token.json')) {
      console.warn('You need to authorize your Miele account first');
      return;
    }

    const tokenInfo = JSON.parse(fs.readFileSync('cache/miele-token.json', 'utf8'));
    const url = 'https://api.mcs3.miele.com/thirdparty/token';

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const formBody = [];
    formBody.push(`client_id=${encodeURIComponent(this.clientId)}`);
    formBody.push(`client_secret=${encodeURIComponent(this.clientSecret)}`);
    formBody.push(`grant_type=${encodeURIComponent('refresh_token')}`);
    formBody.push(`refresh_token=${encodeURIComponent(tokenInfo.refresh_token)}`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formBody.join('&'),
    });

    const body = await response.json();
    if (body.access_token) {
      this.MIELE_TOKEN = body.access_token;
      fs.writeFileSync(
        'cache/miele-token.json',
        JSON.stringify({ timestamp: new Date(), ...body }, null, 2),
      );
    }
  }

  public async listenEvents(): Promise<void> {
    if (!fs.existsSync('cache/miele-token.json')) {
      console.warn('You need to authorize your Miele account first');
      return;
    }
    let tokenInfo = JSON.parse(fs.readFileSync('cache/miele-token.json', 'utf8'));
    const dateIssued = new Date(tokenInfo.timestamp);
    const expiresIn = tokenInfo.expires_in;
    const expireDate = new Date(dateIssued.valueOf() + (expiresIn * 1000));

    if (expireDate <= new Date()) {
      console.warn('Token has expired, please re-authorize your account');
      await this.refreshToken();
      tokenInfo = JSON.parse(fs.readFileSync('cache/miele-token.json', 'utf8'));
    }

    this.MIELE_TOKEN = tokenInfo.access_token;
    const url = 'https://api.mcs3.miele.com/v1/devices/all/events';
    const headers = {
      'Accept-Language': 'en-CA',
      Authorization: `Bearer ${this.MIELE_TOKEN}`,
    };

    await fetchEventData(url, {
      headers,
      onMessage(msg) {
        const event = (msg?.event || '').trim();
        if (event === 'devices') {
          fs.writeFileSync(
            'cache/miele.json',
            JSON.stringify(JSON.parse(msg!.data), null, 2),
          );
        }
      },
      onClose() {
        console.warn('Connection closed');
      },
      onError(err: Error) {
        console.error(err);
      },
    });
  }
}

