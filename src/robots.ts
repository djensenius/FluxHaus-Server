import dorita980, { RobotState, Roomba } from 'dorita980';

/**
 * How long to wait to connect to Roomba.
 */
const CONNECT_TIMEOUT_MILLIS = 60_000;

/**
 * How long after HomeKit has asked for the plugin's status should we continue
 * frequently monitoring and reporting Roomba's status?
 */
const USER_INTERESTED_MILLIS = 60_000;

/**
 * How long after Roomba has been active should we continue frequently monitoring and reporting Roomba's status?
 */
const AFTER_ACTIVE_MILLIS = 120_000;

/**
 * How long will we wait for the Roomba to send status before giving up?
 */
const STATUS_TIMEOUT_MILLIS = 60_000;

/**
 * Coalesce multiple refreshState requests into one when they're less than this many millis apart.
 */
const REFRESH_STATE_COALESCE_MILLIS = 10_000;

const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];

/**
 * Holds a connection to Roomba and tracks the number of uses to enable connections to be closed
 * when no longer in use.
 */
interface RoombaHolder {
    readonly roomba: Roomba
    /**
     * How many requests are currently using the current Roomba instance.
     */
    useCount: number
}

export interface AccessoryConfig {
    name: string
    model: string
    serialnum: string
    blid: string
    robotpwd: string
    ipaddress: string
    cleanBehaviour: 'everywhere' | 'rooms';
    stopBehaviour: 'home' | 'pause';
    idleWatchInterval: number
}

interface Status {
    timestamp: number
    running?: boolean
    docking?: boolean
    charging?: boolean
    /**
     * Paused during a clean cycle.
     */
    paused?: boolean
    batteryLevel?: number
    binFull?: boolean
}

const EMPTY_STATUS: Status = {
  timestamp: 0,
};

function shouldTryDifferentCipher(error: Error) {
  /* Explicit TLS errors definitely suggest a different cipher should be used */
  if (error.message.indexOf('TLS') !== -1) {
    return true;
  }
  if (error.message.toLowerCase().indexOf('identifier rejected') !== -1) {
    return true;
  }
  return false;
}

export default class RoombaAccessory {
  private name: string;

  private model: string;

  private serialnum: string;

  private blid: string;

  private robotpwd: string;

  private ipaddress: string;

  private cleanBehaviour: 'everywhere' | 'rooms';

  private stopBehaviour: 'home' | 'pause';

  private idlePollIntervalMillis: number;

  /**
   * The last known state from Roomba, if any.
   */
  cachedStatus = EMPTY_STATUS;

  private lastUpdatedStatus = EMPTY_STATUS;

  private lastRefreshState = 0;

  /**
   * The current promise that returns a Roomba instance (_only_ used in the connect() method).
   */
  private _currentRoombaPromise?: Promise<RoombaHolder>;

  /**
   * Whether the plugin is actively polling Roomba's state and updating HomeKit
   */
  private currentPollTimeout?: NodeJS.Timeout;

  /**
   * When we think a user / HomeKit was last interested in Roomba's state.
   */
  private userLastInterestedTimestamp?: number;

  /**
   * When we last saw the Roomba active.
   */
  private roombaLastActiveTimestamp?: number;

  /**
   * The duration of the last poll interval used.
   */
  private lastPollInterval?: number;

  /**
   * An index into `ROBOT_CIPHERS` indicating the current cipher configuration used to communicate with Roomba.
   */
  private currentCipherIndex = 0;

  public constructor(config: AccessoryConfig) {
    this.name = config.name;
    this.model = config.model;
    this.serialnum = config.serialnum;
    this.blid = config.blid;
    this.robotpwd = config.robotpwd;
    this.ipaddress = config.ipaddress;
    this.cleanBehaviour = config.cleanBehaviour !== undefined ? config.cleanBehaviour : 'everywhere';
    this.stopBehaviour = config.stopBehaviour !== undefined ? config.stopBehaviour : 'home';
    this.idlePollIntervalMillis = (config.idleWatchInterval * 60_000) || 900_000;

    this.startPolling();
  }

  public identify() {
    this.connect(async (error, roomba) => {
      if (error || !roomba) {
        return;
      }
      try {
        await roomba.find();
      } catch (ierror) {
        console.warn('Roomba failed to locate: %s', (ierror as Error).message);
      }
    });
  }

  /**
   * Refresh our knowledge of Roomba's state by connecting to Roomba and getting its status.
   * @param callback a function to call when the state refresh has completed.
   */
  private refreshState(callback: (success: boolean) => void): void {
    this.connect(async (error, roomba) => {
      if (error || !roomba) {
        callback(false);
        return undefined;
      }

      /* Wait until we've received a state with all of the information we desire */
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
          callback(false);
        }, STATUS_TIMEOUT_MILLIS);

        const updateState = (state: RobotState) => {
          if (RoombaAccessory.receivedRobotStateIsComplete(state)) {
            clearTimeout(timeout);

            /* NB: the actual state is received and updated in the listener in connect() */
            roomba.off('state', updateState);
            resolve();
            callback(true);
          }
        };
        roomba.on('state', updateState);
      });
    });
  }

  static receivedRobotStateIsComplete(state: RobotState) {
    return (state.batPct !== undefined && state.bin !== undefined && state.cleanMissionStatus !== undefined);
  }

  private receiveRobotState(state: RobotState) {
    const parsed = RoombaAccessory.parseState(state);
    this.mergeCachedStatus(parsed);

    return true;
  }

  /**
     * Returns a Promise that, when resolved, provides access to a connected Roomba instance.
     * In order to reuse connected Roomba instances, this function returns the same Promise across
     * multiple calls, until that Roomba instance is disconnected.
     * <p>
     * If the Promise fails it means there was a failure connecting to the Roomba instance.
     * @returns a RoombaHolder containing a connected Roomba instance
     */
  private async connectedRoomba(attempts = 0): Promise<RoombaHolder> {
    return new Promise<RoombaHolder>((resolve, reject) => {
      let connected = false;
      let failed = false;

      const roomba = new dorita980.Local(this.blid, this.robotpwd, this.ipaddress, 2, {
        ciphers: ROBOT_CIPHERS[this.currentCipherIndex],
      });

      const timeout = setTimeout(() => {
        failed = true;

        roomba.end();
        reject(new Error('Connect timed out'));
      }, CONNECT_TIMEOUT_MILLIS);

      roomba.on('state', (state) => {
        this.receiveRobotState(state);
      });

      const onError = (error: Error) => {
        roomba.off('error', onError);
        roomba.end();
        clearTimeout(timeout);

        if (!connected) {
          failed = true;

          /* Check for recoverable errors */
          if (error instanceof Error && shouldTryDifferentCipher(error) && attempts < ROBOT_CIPHERS.length) {
            /* Perhaps a cipher error, so we retry using the next cipher */
            this.currentCipherIndex = (this.currentCipherIndex + 1) % ROBOT_CIPHERS.length;
            this.connectedRoomba(attempts + 1).then(resolve).catch(reject);
          } else {
            reject(error);
          }
        }
      };
      roomba.on('error', onError);

      const onConnect = () => {
        roomba.off('connect', onConnect);
        clearTimeout(timeout);

        if (failed) {
          return;
        }

        connected = true;

        resolve({
          roomba,
          useCount: 0,
        });
      };
      roomba.on('connect', onConnect);
    });
  }

  private connect(callback: (error: Error | null, roomba?: Roomba) => Promise<void>): void {
    /* Use the current Promise, if possible, so we share the connected Roomba instance, whether
    it is already connected, or when it becomes connected.
    */
    const promise = this._currentRoombaPromise || this.connectedRoomba();
    this._currentRoombaPromise = promise;

    promise.then((holder) => {
      const pHolder = holder;
      pHolder.useCount += 1;
      callback(null, holder.roomba).finally(() => {
        pHolder.useCount -= 1;

        if (pHolder.useCount <= 0) {
          this._currentRoombaPromise = undefined;
          pHolder.roomba.end();
        }
      });
    }).catch((error) => {
      /* Failed to connect to Roomba */
      this._currentRoombaPromise = undefined;
      callback(error);
    });
  }

  /**
     * Merge in changes to the cached status, and update our characteristics so the plugin
     * preemptively reports state back to Homebridge.
     */
  private mergeCachedStatus(status: Partial<Status>) {
    this.setCachedStatus({
      ...this.cachedStatus,
      timestamp: Date.now(),
      ...status,
    });

    if (this.isActive()) {
      this.roombaLastActiveTimestamp = Date.now();
    }
  }

  /**
     * Update the cached status and update our characteristics so the plugin preemptively
     * reports state back to Homebridge.
     */
  private setCachedStatus(status: Status) {
    this.cachedStatus = status;
  }

  static parseState(state: RobotState) {
    const status: Status = {
      timestamp: Date.now(),
    };

    if (state.batPct !== undefined) {
      status.batteryLevel = state.batPct;
    }
    if (state.bin !== undefined) {
      status.binFull = state.bin.full;
    }

    if (state.cleanMissionStatus !== undefined) {
      /* See https://www.openhab.org/addons/bindings/irobot/ for a list of phases */
      switch (state.cleanMissionStatus.phase) {
      case 'run':
        status.running = true;
        status.charging = false;
        status.docking = false;

        break;
      case 'charge':
      case 'recharge':
        status.running = false;
        status.charging = true;
        status.docking = false;

        break;
      case 'hmUsrDock':
      case 'hmMidMsn':
      case 'hmPostMsn':
        status.running = false;
        status.charging = false;
        status.docking = true;

        break;
      case 'stop':
      case 'stuck':
      case 'evac':
        status.running = false;
        status.charging = false;
        status.docking = false;

        break;
      default:
        status.running = false;
        status.charging = false;
        status.docking = false;

        break;
      }
      status.paused = !status.running && state.cleanMissionStatus.cycle === 'clean';
    }

    return status;
  }

  /**
     * Trigger a refresh of Roomba's status for a user.
     */
  private refreshStatusForUser() {
    this.userLastInterestedTimestamp = Date.now();
    this.startPolling(true);
  }

  /**
     * Start polling Roomba's status and reporting updates to HomeKit.
     * We start polling whenever an event occurs, so we update HomeKit promptly
     * when the status changes.
     */
  private startPolling(adhoc?: boolean) {
    const checkStatus = (checkAdhoc: boolean) => {
      const now = Date.now();
      if (!checkAdhoc || now - this.lastRefreshState > REFRESH_STATE_COALESCE_MILLIS) {
        this.lastRefreshState = now;

        /* Cancel any existing timeout */
        if (this.currentPollTimeout) {
          clearTimeout(this.currentPollTimeout);
          this.currentPollTimeout = undefined;
        }

        this.refreshState(() => {
          const interval = this.currentPollInterval();
          this.lastPollInterval = interval;

          if (this.currentPollTimeout) {
            clearTimeout(this.currentPollTimeout);
            this.currentPollTimeout = undefined;
          }
          this.currentPollTimeout = setTimeout(() => checkStatus(false), interval);
        });
      }
    };

    checkStatus(adhoc || false);
  }

  private currentPollInterval = () => {
    /* Check if the user is still interested */
    const timeSinceUserLastInterested = Date.now() - (this.userLastInterestedTimestamp || 0);
    if (timeSinceUserLastInterested < USER_INTERESTED_MILLIS) {
      /* HomeKit is actively querying Roomba's status so a user may be interested */
      return 5_000;
    }

    const timeSinceLastActive = Date.now() - (this.roombaLastActiveTimestamp || 0);
    if (this.isActive() || timeSinceLastActive < AFTER_ACTIVE_MILLIS) {
      /* Roomba is actively doing things */
      return 10_000;
    }

    /* Roomba is idle */
    return this.idlePollIntervalMillis;
  };

  isActive(): boolean {
    return this.cachedStatus.running || this.cachedStatus.docking || false;
  }

  static runningStatus = (status: Status) => (status.running === undefined
    ? undefined
    : status.running);

  static chargingStatus = (status: Status) => (status.charging === undefined
    ? undefined : status.charging);

  static dockingStatus = (status: Status) => {
    if (status.docking === undefined) {
      return undefined;
    }
    return status.docking;
  };

  static dockedStatus = (status: Status) => {
    if (status.charging === undefined) {
      return undefined;
    }
    return status.charging ? 'CONTACT_DETECTED' : 'CONTACT_NOT_DETECTED';
  };

  static batteryLevelStatus = (status: Status) => (status.batteryLevel === undefined
    ? undefined
    : status.batteryLevel);

  static binStatus = (status: Status) => {
    if (status.binFull === undefined) {
      return undefined;
    }
    return status.binFull ? 'CHANGE_FILTER' : 'FILTER_OK';
  };

  static batteryStatus = (status: Status) => {
    if (status.batteryLevel === undefined) {
      return undefined;
    }
    return status.batteryLevel <= 20 ? 'Low' : 'Normal';
  };

  /**
   * Method to turn on the Roomba, starting its cleaning cycle.
   */
  async turnOn() {
    this.connect(async (error, roomba) => {
      if (error || !roomba) {
        console.error('Failed to connect to Roomba to turn it on.');
        return;
      }
      try {
        await roomba.start();
        console.log('Roomba has been turned on.');
      } catch (err) {
        console.error('Failed to start Roomba:', err);
      }
    });
  }

  /**
   * Method to turn off the Roomba, stopping its cleaning cycle.
   */
  async turnOff() {
    this.connect(async (error, roomba) => {
      if (error || !roomba) {
        console.error('Failed to connect to Roomba to turn it off.');
        return;
      }
      try {
        await roomba.stop();
        console.log('Roomba has been turned off.');
      } catch (err) {
        console.error('Failed to stop Roomba:', err);
      }
    });
  }
}
