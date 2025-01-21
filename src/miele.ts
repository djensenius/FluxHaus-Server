import fs from 'fs';
import apn from '@parse/node-apn';
import 'dotenv/config';
import { fetchEventData } from 'fetch-sse';
import { clearError, writeError } from './errors';
import { MieleDevice } from './types/types';
import { MieleRoot } from './types/miele';

export default class Miele {
  public washer: MieleDevice;

  public dryer: MieleDevice;

  private clientId: string;

  private clientSecret: string;

  private redirectUri: string;

  private MIELE_TOKEN: string;

  private apnProvider: apn.Provider;

  constructor(clientId: string, clientSecret: string, apnProvider: apn.Provider) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apnProvider = apnProvider;
    this.redirectUri = 'https://fluxhaus.io/auth/miele/callback';
    this.MIELE_TOKEN = '';
    this.washer = {
      name: 'Washer',
      inUse: false,
    };

    this.dryer = {
      name: 'Dryer',
      inUse: false,
    };
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
      writeError('Miele', 'Miele needs authorized');
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

  public newParseMessage(parsedData: MieleRoot): void {
    Object.values(parsedData).filter((dev) => dev.state).forEach((device) => {
      const myDevice: MieleDevice = {
        name: device.ident.type.value_localized,
        timeRunning: device.state.elapsedTime.length > 0
          ? (device.state.elapsedTime[0] * 60) + device.state.elapsedTime[1] : 0,
        timeRemaining: (device.state.remainingTime[0] * 60) + device.state.remainingTime[1],
        step: device.state.programPhase.value_localized,
        programName: device.state.ProgramID.value_localized,
        status: device.state.status.value_localized,
        inUse: device.state.status.value_localized !== 'Off' && device.state.status.value_localized !== 'Not Connected',
      };

      // Send push notification
      const notification = new apn.Notification();
      notification.topic = 'org.davidjensenius.FluxHaus';
      notification.alert = `${myDevice.name} is now ${myDevice.status}`;
      notification.payload = { device: myDevice };

      this.apnProvider.send(notification, 'user-device-token').then((_result) => {
        // console.log(result);
      });

      if (device.ident.type.value_localized === 'Washing machine') {
        this.washer = myDevice;
      } else if (device.ident.type.value_localized === 'Tumble dryer') {
        this.dryer = myDevice;
      }
    });
  }

  public parseMessage(parsedData: MieleRoot): void {
    Object.values(parsedData).filter((dev) => dev.state).forEach((device) => {
      const myDevice: MieleDevice = {
        name: device.ident.type.value_localized,
        timeRunning: device.state.elapsedTime.length > 0
          ? (device.state.elapsedTime[0] * 60) + device.state.elapsedTime[1] : 0,
        timeRemaining: (device.state.remainingTime[0] * 60) + device.state.remainingTime[1],
        step: device.state.programPhase.value_localized,
        programName: device.state.ProgramID.value_localized,
        status: device.state.status.value_localized,
        inUse:
          device.state.status.value_localized !== 'Off' && device.state.status.value_localized !== 'Not Connected',
      };

      if (device.ident.type.value_localized === 'Washing machine') {
        this.washer = myDevice;
      } else if (device.ident.type.value_localized === 'Tumble dryer') {
        this.dryer = myDevice;
      }
    });
  }

  public async getActivePrograms(): Promise<void> {
    if (!fs.existsSync('cache/miele-token.json')) {
      console.warn('You need to authorize your Miele account first');
      writeError('Miele', 'Miele needs authorized');
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
    const url = 'https://api.mcs3.miele.com/v1/devices';
    const headers = {
      'Accept-Language': 'en-CA',
      Authorization: `Bearer ${this.MIELE_TOKEN}`,
    };

    const response = await fetch(url, { method: 'GET', headers });
    const body = await response.json();
    this.newParseMessage(body);
    fs.writeFileSync(
      'cache/miele.json',
      JSON.stringify(body, null, 2),
    );
  }

  public async listenEvents(): Promise<void> {
    if (!fs.existsSync('cache/miele-token.json')) {
      console.warn('You need to authorize your Miele account first');
      writeError('Miele', 'Miele needs authorized');
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
    const parseMessage = this.newParseMessage.bind(this);
    const url = 'https://api.mcs3.miele.com/v1/devices/all/events';
    const headers = {
      'Accept-Language': 'en-CA',
      Authorization: `Bearer ${this.MIELE_TOKEN}`,
    };

    await fetchEventData(url, {
      headers,
      onMessage(msg) {
        const event = (msg?.event || '').trim();
        if (msg?.data.trim() === 'ping') {
          return;
        }
        let body;
        try {
          body = JSON.parse(msg!.data);
          parseMessage(body);
          if (event === 'devices') {
            clearError('Miele');
            fs.writeFileSync(
              'cache/miele.json',
              JSON.stringify(JSON.parse(msg!.data), null, 2),
            );
          }
        } catch {
          console.warn(`Could not parse Miele body ${msg!.data}`);
        }
      },
      onOpen() {
        clearError('Miele');
        console.warn('Connected to Miele');
      },
      onClose() {
        writeError('Miele', 'Connection closed');
        console.warn('Miele: Connection closed');
      },
      onError(err: Error) {
        writeError('Miele', 'Connection error');
        console.error('Miele: Connection error');
        console.error(err);
      },
    });
  }
}
