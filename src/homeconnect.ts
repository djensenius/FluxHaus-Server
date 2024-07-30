import { fetchEventData } from 'fetch-sse';
import fs from 'fs';
import 'dotenv/config';
import { clearError, writeError } from './errors';

export default class HomeConnect {
  private clientId: string;

  private clientSecret: string;

  private deviceCode: string;

  private HOMECONNECT_TOKEN: string;

  private serverURL = 'https://api.home-connect.com';

  // private serverURL = 'https://simulator.home-connect.com';

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.deviceCode = '';
    this.HOMECONNECT_TOKEN = '';
  }

  public async authorize(): Promise<void> {
    const url = `${this.serverURL}/security/oauth/device_authorization`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const formBody = [];
    formBody.push(`client_id=${encodeURIComponent(this.clientId)}`);
    formBody.push(`scope=${encodeURIComponent('IdentifyAppliance Monitor Control Settings')}`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formBody.join('&'),
    });

    const body = await response.json();
    console.warn(`Login to ${body.verification_uri_complete} and enter ${body.user_code} if asked`);
    this.deviceCode = body.device_code;
  }

  public async getToken(): Promise<void> {
    const url = `${this.serverURL}/security/oauth/token`;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    const interval = setInterval(async () => {
      const formBody = [];
      formBody.push(`client_id=${encodeURIComponent(this.clientId)}`);
      formBody.push(`client_secret=${encodeURIComponent(this.clientSecret)}`);
      formBody.push(`device_code=${encodeURIComponent(this.deviceCode)}`);
      formBody.push(`grant_type=${encodeURIComponent('device_code')}`);
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formBody.join('&'),
      });

      const body = await response.json();
      if (body.access_token) {
        fs.writeFileSync(
          'cache/homeconnect-token.json',
          JSON.stringify({ timestamp: new Date(), ...body }, null, 2),
        );
        clearInterval(interval);
      }
    }, 1000 * 10);
  }

  public async refreshToken(): Promise<void> {
    if (!fs.existsSync('cache/homeconnect-token.json')) {
      console.warn('You need to authorize your HomeConnect account first');
      writeError('HomeConnect', 'HomeConnect needs authorized');
      return;
    }

    const tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    const url = `${this.serverURL}/security/oauth/token`;

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
    if (body.error) {
      console.warn('You need to authorize your HomeConnect account first');
      writeError('HomeConnect', 'HomeConnect needs authorized');
      return;
    }

    if (body.access_token) {
      this.HOMECONNECT_TOKEN = body.id_token;
      fs.writeFileSync(
        'cache/homeconnect-token.json',
        JSON.stringify({ timestamp: new Date(), ...body }, null, 2),
      );
    }
  }

  public async getActiveProgram(): Promise<void> {
    if (!fs.existsSync('cache/homeconnect-token.json')) {
      console.warn('You need to authorize your HomeConnect account first');
      writeError('HomeConnect', 'HomeConnect needs authorized');
      return;
    }
    let tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    const dateIssued = new Date(tokenInfo.timestamp);
    const expiresIn = tokenInfo.expires_in;
    const expireDate = new Date(dateIssued.valueOf() + (expiresIn * 1000));

    if (expireDate <= new Date()) {
      await this.refreshToken();
      tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    }

    this.HOMECONNECT_TOKEN = tokenInfo.id_token;
    const url = `${this.serverURL}/api/homeappliances/${process.env.boschAppliance}/programs/active`;
    const headers = {
      Authorization: `Bearer ${this.HOMECONNECT_TOKEN}`,
      Accept: 'application/vnd.bsh.sdk.v1+json',
      'Accept-Language': 'en-US',
    };

    const response = await fetch(url, { headers });
    const body = await response.json();
    fs.writeFileSync(
      'cache/homeconnect.json',
      JSON.stringify(body, null, 2),
    );
  }

  public async listenEvents(): Promise<void> {
    if (!fs.existsSync('cache/homeconnect-token.json')) {
      console.warn('You need to authorize your HomeConnect account first');
      writeError('HomeConnect', 'HomeConnect needs authorized');
      return;
    }
    let tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    const dateIssued = new Date(tokenInfo.timestamp);
    const expiresIn = tokenInfo.expires_in;
    const expireDate = new Date(dateIssued.valueOf() + (expiresIn * 1000));

    if (expireDate <= new Date()) {
      await this.refreshToken();
      tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    }

    this.HOMECONNECT_TOKEN = tokenInfo.id_token;
    const url = `${this.serverURL}/api/homeappliances/events`;
    const headers = {
      Authorization: `Bearer ${this.HOMECONNECT_TOKEN}`,
      Accept: 'text/event-stream',
      'Accept-Language': 'en-US',
    };

    await fetchEventData(url, {
      headers,
      onMessage(msg) {
        console.warn(msg);
        clearError('HomeConnect');
      },
      onOpen() {
        clearError('HomeConnect');
      },
      onClose() {
        console.warn('Connection closed');
        const message = 'Connection closed';
        writeError('HomeConnect', message);
      },
      onError(err: Error) {
        console.error(err);
        const message = 'Connection error';
        writeError('HomeConnect', message);
      },
    });
  }
}

