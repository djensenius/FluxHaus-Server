import { ServerSentEvent, fetchEventData } from 'fetch-sse';
import fs from 'fs';
import 'dotenv/config';
import { clearError, writeError } from './errors';
import { EventData, StatusesWrapper } from './homeconnect-types';

export default class HomeConnect {
  public dishwasher: DishWasher;

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
    this.dishwasher = {
      status: 'Finished',
      operationState: 'Inactive',
      doorState: 'Closed',
    };
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

  public async getStatus(): Promise<void> {
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
    const url = `${this.serverURL}/api/homeappliances/${process.env.boschAppliance}/status`;
    const headers = {
      Authorization: `Bearer ${this.HOMECONNECT_TOKEN}`,
      Accept: 'application/vnd.bsh.sdk.v1+json',
      'Accept-Language': 'en-US',
    };

    const response = await fetch(url, { headers });
    let body;
    try {
      body = await response.json() as StatusesWrapper;
    } catch {
      return;
    }

    body.data.status.forEach((item) => {
      if (item.key === 'BSH.Common.Status.OperationState') {
        this.dishwasher.operationState = (item.value as string)
          .replace('BSH.Common.EnumType.OperationState.', '') as OperationState;
      } else if (item.key === 'BSH.Common.Status.DoorState') {
        this.dishwasher.doorState = item.value === 'BSH.Common.EnumType.DoorState.Open' ? 'Open' : 'Closed';
      }
    });
  }

  public parseMessage(msg: ServerSentEvent | null): void {
    if (msg === null) {
      return;
    }

    const { event, data } = msg;
    let parsedData;
    try {
      parsedData = JSON.parse(data);
    } catch {
      return;
    }
    const { items } = parsedData;

    switch (event) {
    case 'EVENT':
      items.forEach((item: EventData) => {
        if (item.key === 'BSH.Common.Event.ProgramFinished') {
          this.dishwasher.status = 'Finished';
        } else if (item.key === 'BSH.Common.Event.ProgramAborted') {
          this.dishwasher.status = 'Aborted';
        }
      });
      break;
    case 'STATUS':
      items.forEach((item: EventData) => {
        if (item.key === 'BSH.Common.Status.OperationState') {
          this.dishwasher.operationState = (item.value as string)
            .replace('BSH.Common.EnumType.OperationState.', '') as OperationState;
        } else if (item.key === 'BSH.Common.Status.DoorState') {
          this.dishwasher.doorState = item.value === 'BSH.Common.EnumType.DoorState.Open' ? 'Open' : 'Closed';
        }
      });
      break;
    case 'NOTIFY':
      items.forEach((item: EventData) => {
        switch (item.key) {
        case 'BSH.Common.Status.ProgramProgress':
          this.dishwasher.programProgress = item.value as number;
          break;
        case 'BSH.Common.Status.SelectedProgram':
          this.dishwasher.selectedProgram = item.value as string;
          break;
        case 'BSH.Common.Status.ActiveProgram':
          this.dishwasher.activeProgram = (item.value as string)
            .replace('Dishcare.Dishwasher.Program.', '') as DishWasherProgram;
          break;
        case 'BSH.Common.Status.RemainingProgramTime':
          this.dishwasher.remainingTime = item.value as number;
          this.dishwasher.remainingTimeUnit = item.unit as 'seconds' | 'minutes' | 'hours';
          break;
        case 'BSH.Common.Status.StartInRelative':
          this.dishwasher.startInRelative = item.value as number;
          this.dishwasher.startInRelativeUnit = item.unit as 'seconds' | 'minutes' | 'hours';
          break;
        default:
          break;
        }
      });
      break;
    default:
      break;
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

    await this.getStatus();

    let tokenInfo = JSON.parse(fs.readFileSync('cache/homeconnect-token.json', 'utf8'));
    const dateIssued = new Date(tokenInfo.timestamp);
    const expiresIn = tokenInfo.expires_in;
    const expireDate = new Date(dateIssued.valueOf() + (expiresIn * 1000));
    const parseMessage = this.parseMessage.bind(this);

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
        parseMessage(msg);
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

type DishWasherProgram =
  'PreRinse' | 'Auto1' | 'Auto2' | 'Auto3' | 'Eco50' | 'Quick45' | 'Intensiv70' | 'Normal65' | 'Glas40' |
  'GlassCare' | 'NightWash' | 'Quick65' | 'Normal45' | 'Intensiv45' | 'AutoHalfLoad' | 'IntensivPower' |
  'MagicDaily' | 'Super60' | 'Kurz60' | 'ExpressSparkle65' | 'MachineCare' | 'SteamFresh' | 'MaximumCleaning' |
  'MixedLoad';

type OperationState =
  'Inactive' | 'Ready' | 'DelayedStart' | 'Run' | 'Pause' | 'ActionRequired' | 'Finished' | 'Error' | 'Aborting';

interface DishWasher {
  status: 'Running' | 'Paused' | 'Finished' | 'Aborted';
  program?: string;
  remainingTime?: number;
  remainingTimeUnit?: 'seconds' | 'minutes' | 'hours';
  remainingTimeEstimate?: boolean;
  programProgress?: number;
  operationState: OperationState;
  doorState: 'Open' | 'Closed';
  selectedProgram?: string;
  activeProgram?: DishWasherProgram;
  startInRelative?: number;
  startInRelativeUnit?: 'seconds' | 'minutes' | 'hours';
}

