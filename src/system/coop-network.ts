import {
  type CoopChoice,
  type CoopCommandMessage,
  type CoopSeat,
  type CoopShopAction,
  coopSession,
} from "#system/coop-session";
import { coopSnapshot } from "#system/coop-snapshot";
import type { Starter } from "#types/save-data";
import { randomString } from "#utils/common";

/** A starter as sent to the other player: the starter itself plus the luck its owner's save gives it. */
export type CoopStarter = Starter & { luck: number };

/** Everything the two clients say to each other, on top of the relay's own messages. */
type Wire =
  | { type: "starters"; starters: CoopStarter[]; seed?: string }
  | { type: "command"; message: CoopCommandMessage }
  | { type: "shop"; action: CoopShopAction }
  | { type: "choice"; choice: CoopChoice }
  | { type: "sync"; wave: number; turn: number; state: string; rng: string }
  /** The host's snapshot of the wave: both games go back to the start of the wave from it */
  | { type: "resync"; session: string }
  /** The sender has loaded the snapshot; everything it sent before this was from before the rewind */
  | { type: "resync-ready" };

type RelayMessage =
  | { type: "hosted"; room: string; token?: string }
  | { type: "joined"; room: string; token?: string }
  | { type: "rejoined"; room: string }
  | { type: "peer-joined" }
  | { type: "peer-away" }
  | { type: "peer-back" }
  | { type: "peer-left" }
  | { type: "error"; message: string };

/** The parts of a browser `WebSocket` that the connection uses (so tests can supply a stand-in). */
export interface CoopSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** `WebSocket.OPEN` */
const SOCKET_OPEN = 1;

/** How many times the host may send the game back to the start of the same wave */
const MAX_RESYNCS_PER_WAVE = 3;

/** The team the two players put together at the start of a run. */
export interface CoopRunSetup {
  /** Seed for the whole run. The host picks it so both games roll the same dice. */
  seed: string;
  /** Host's Pokemon first, then the guest's */
  starters: CoopStarter[];
  /** The seat that owns each entry of {@linkcode starters} */
  owners: CoopSeat[];
}

/**
 * The connection to the other player, through the relay server.
 *
 * The host is seat 0 and the guest is seat 1. Once connected, commands and shop steps that
 * {@linkcode coopSession} produces are sent across, and the other player's arrive in {@linkcode coopSession}.
 */
class CoopNetwork {
  /** Makes the socket for a relay address. Replaceable so tests need no real network. */
  public socketFactory: (url: string) => CoopSocket = url => new WebSocket(url) as unknown as CoopSocket;

  /** Called with a short progress or problem text for the player to read */
  public onStatus: ((text: string) => void) | null = null;
  /** Called when the other player disconnects, or the connection drops, during a run */
  public onPartnerLeft: (() => void) | null = null;
  /** Called when the two games disagree about the state of the run */
  public onDesync: ((wave: number, turn: number, what: string) => void) | null = null;
  /** Called with the host's snapshot when both games have to go back to the start of the wave */
  public onResync: ((session: string) => void) | null = null;
  /** Called when the other player's connection dropped during a run (they have a while to come back) */
  public onPartnerAway: (() => void) | null = null;
  /** Called when the other player is back after a dropped connection */
  public onPartnerBack: (() => void) | null = null;
  /** Called when this client lost its own connection (and is trying to get it back), and when it did */
  public onReconnecting: (() => void) | null = null;
  public onReconnected: (() => void) | null = null;

  /** How long to wait between attempts to get the connection back, and how long to keep trying */
  public reconnectDelayMs = 2000;
  public reconnectGiveUpMs = 5 * 60_000;

  public role: "host" | "join" | null = null;
  public room: string | null = null;

  private socket: CoopSocket | null = null;
  private ready = false;
  private server = "";
  /** What the relay gave this player to take their place in the room again */
  private token: string | null = null;
  /** Whether the run has started (from then on a dropped connection can be picked up again) */
  private runStarted = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** After a rewind: everything from the other game is stale until it says it has loaded the snapshot */
  private resyncing = false;
  private readonly resyncsPerWave = new Map<number, number>();
  private readonly early: Wire[] = [];
  private waiting: { type: Wire["type"]; resolve: (wire: Wire) => void }[] = [];
  private readonly ownStates = new Map<string, { state: string; rng: string }>();
  private readonly partnerStates = new Map<string, { state: string; rng: string }>();

  public get connected(): boolean {
    return this.ready;
  }

  /**
   * Connect to the relay, open or join a room, and wait until both players are there.
   * Starts the co-op session when it succeeds.
   * @returns The room code
   */
  public connect(options: { server: string; role: "host" | "join"; room?: string | undefined }): Promise<string> {
    this.disconnect();
    this.role = options.role;
    this.server = options.server;
    return new Promise<string>((resolve, reject) => {
      const socket = this.socketFactory(options.server);
      this.socket = socket;
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          this.disconnect();
          reject(new Error(message));
        }
      };
      const succeed = (room: string) => {
        if (!settled) {
          settled = true;
          this.room = room;
          this.ready = true;
          coopSession.start({ localSeat: options.role === "host" ? 0 : 1 });
          coopSession.send = message => this.sendWire({ type: "command", message });
          coopSession.sendShop = action => this.sendWire({ type: "shop", action });
          coopSession.sendChoice = choice => this.sendWire({ type: "choice", choice });
          resolve(room);
        }
      };

      socket.onopen = () => {
        if (options.role === "host") {
          this.sendRaw({ type: "host", room: options.room });
        } else {
          this.sendRaw({ type: "join", room: options.room });
        }
      };
      socket.onerror = () => fail("Could not reach the relay server.");
      socket.onclose = () => {
        if (settled && this.ready) {
          this.ready = false;
          if (this.runStarted && this.token) {
            this.startReconnect();
          } else {
            this.onPartnerLeft?.();
          }
        } else {
          fail("The connection to the relay server closed.");
        }
      };
      socket.onmessage = event => {
        let message: RelayMessage | Wire;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        this.handle(message, succeed, fail, options.role);
      };
    });
  }

  private pendingRoom: string | null = null;

  private handle(
    message: RelayMessage | Wire,
    succeed: (room: string) => void,
    fail: (message: string) => void,
    role: "host" | "join",
  ): void {
    switch (message.type) {
      case "hosted":
        this.pendingRoom = message.room;
        this.token = message.token ?? null;
        this.onStatus?.(`Room ${message.room} is open. Waiting for your partner...`);
        return;
      case "peer-joined":
        succeed(this.pendingRoom ?? "");
        return;
      case "joined":
        this.token = message.token ?? null;
        if (role === "join") {
          succeed(message.room);
        }
        return;
      case "peer-away":
        this.onPartnerAway?.();
        return;
      case "peer-back":
        this.onPartnerBack?.();
        // After any gap, messages may have been lost: the host sends both games back to the start of the wave
        this.requestResync();
        return;
      case "rejoined":
        this.ready = true;
        this.reconnecting = false;
        this.onReconnected?.();
        this.requestResync();
        return;
      case "peer-left":
        this.ready = false;
        this.stopReconnecting();
        this.onPartnerLeft?.();
        return;
      case "error":
        fail(message.message);
        return;
      case "resync":
        this.beginResync();
        this.onResync?.(message.session);
        return;
      case "resync-ready":
        this.resyncing = false;
        return;
      case "command":
        if (!this.resyncing) {
          coopSession.receive(message.message);
        }
        return;
      case "shop":
        if (!this.resyncing) {
          coopSession.receiveShop(message.action);
        }
        return;
      case "choice":
        if (!this.resyncing) {
          coopSession.receiveChoice(message.choice);
        }
        return;
      case "sync":
        if (this.resyncing) {
          return;
        }
        this.partnerStates.set(`${message.wave}:${message.turn}`, { state: message.state, rng: message.rng });
        this.compare(message.wave, message.turn);
        return;
      case "starters": {
        const waiter = this.waiting.findIndex(w => w.type === message.type);
        if (waiter === -1) {
          this.early.push(message);
        } else {
          const [found] = this.waiting.splice(waiter, 1);
          found.resolve(message);
        }
      }
    }
  }

  private sendRaw(message: object): void {
    if (this.socket && this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private sendWire(wire: Wire): void {
    this.sendRaw(wire);
  }

  private expect(type: Wire["type"]): Promise<Wire> {
    const index = this.early.findIndex(w => w.type === type);
    if (index !== -1) {
      return Promise.resolve(this.early.splice(index, 1)[0]);
    }
    return new Promise(resolve => this.waiting.push({ type, resolve }));
  }

  /**
   * Swap starters with the other player. The host also picks the run's seed.
   * @param mine - The starters this player picked
   */
  public async exchangeStarters(mine: CoopStarter[]): Promise<CoopRunSetup> {
    const isHost = this.role === "host";
    const seed = isHost ? randomString(24) : undefined;
    this.sendWire({ type: "starters", starters: mine, ...(seed === undefined ? {} : { seed }) });
    const theirs = (await this.expect("starters")) as Extract<Wire, { type: "starters" }>;
    const hostStarters = isHost ? mine : theirs.starters;
    const guestStarters = isHost ? theirs.starters : mine;
    return {
      seed: seed ?? theirs.seed ?? "",
      starters: [...hostStarters, ...guestStarters],
      owners: [...hostStarters.map((): CoopSeat => 0), ...guestStarters.map((): CoopSeat => 1)],
    };
  }

  /**
   * Tell the other game what this one looks like at the start of a turn, and check it against what it says.
   * @param wave - The wave index
   * @param turn - The turn within the wave
   * @param state - A hash of the visible battle state
   * @param rng - The state of the random number generator
   */
  public reportState(wave: number, turn: number, state: string, rng: string): void {
    const key = `${wave}:${turn}`;
    this.ownStates.set(key, { state, rng });
    this.sendWire({ type: "sync", wave, turn, state, rng });
    this.compare(wave, turn);
  }

  private compare(wave: number, turn: number): void {
    const key = `${wave}:${turn}`;
    const own = this.ownStates.get(key);
    const theirs = this.partnerStates.get(key);
    if (!own || !theirs) {
      return;
    }
    this.ownStates.delete(key);
    this.partnerStates.delete(key);
    if (own.state !== theirs.state) {
      this.onDesync?.(wave, turn, "battle state");
    } else if (own.rng !== theirs.rng) {
      this.onDesync?.(wave, turn, "random numbers");
    }
  }

  /**
   * The run has started, so a dropped connection is no longer the end of it: the relay keeps this player's place for a
   * while and the connection tries to come back on its own.
   */
  public markRunStarted(): void {
    if (!this.runStarted) {
      this.runStarted = true;
      this.sendRaw({ type: "resumable" });
    }
  }

  /**
   * Host only: send the snapshot of the current wave to the guest and go back to it here too.
   * Does nothing when there is no snapshot yet, or when the same wave was rewound too many times already
   * (so a problem that keeps coming back cannot trap the players in a loop).
   * @returns Whether a rewind was started
   */
  public requestResync(): boolean {
    const session = coopSnapshot.latest;
    if (this.role !== "host" || !session || this.resyncing || !this.ready) {
      return false;
    }
    const times = (this.resyncsPerWave.get(coopSnapshot.wave) ?? 0) + 1;
    if (times > MAX_RESYNCS_PER_WAVE) {
      return false;
    }
    this.resyncsPerWave.set(coopSnapshot.wave, times);
    this.sendWire({ type: "resync", session });
    this.beginResync();
    this.onResync?.(session);
    return true;
  }

  private beginResync(): void {
    this.resyncing = true;
    this.ownStates.clear();
    this.partnerStates.clear();
    coopSession.clearPending();
  }

  /** This game has gone back to the snapshot: tell the other game that what it receives from now on is current. */
  public finishResync(): void {
    this.sendWire({ type: "resync-ready" });
  }

  /** Try to get a dropped connection back, until it works or too much time has passed. */
  private startReconnect(): void {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.onReconnecting?.();
    const started = Date.now();
    const attempt = () => {
      this.reconnectTimer = null;
      if (!this.reconnecting) {
        return;
      }
      if (Date.now() - started > this.reconnectGiveUpMs) {
        this.reconnecting = false;
        this.onPartnerLeft?.();
        return;
      }
      const retry = () => {
        if (this.reconnecting && !this.reconnectTimer) {
          this.reconnectTimer = setTimeout(attempt, this.reconnectDelayMs);
        }
      };
      let socket: CoopSocket;
      try {
        socket = this.socketFactory(this.server);
      } catch {
        retry();
        return;
      }
      this.socket = socket;
      socket.onopen = () => this.sendRaw({ type: "rejoin", room: this.room, token: this.token });
      socket.onerror = () => retry();
      socket.onclose = () => {
        if (this.reconnecting) {
          retry();
        } else if (this.ready) {
          // the new connection dropped too, after it had been established
          this.ready = false;
          this.startReconnect();
        }
      };
      socket.onmessage = event => {
        let message: RelayMessage | Wire;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === "error") {
          // The relay no longer knows this player (the room expired): there is nothing to come back to
          this.reconnecting = false;
          this.onPartnerLeft?.();
          return;
        }
        this.handle(
          message,
          () => {},
          () => {},
          this.role ?? "join",
        );
      };
    };
    attempt();
  }

  private stopReconnecting(): void {
    this.reconnecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Leave the room and drop the connection. */
  public disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.stopReconnecting();
    if (socket && this.ready) {
      // say goodbye properly, so the other player is told at once instead of waiting for us to come back
      try {
        socket.send(JSON.stringify({ type: "leave" }));
      } catch {
        // already gone
      }
    }
    this.ready = false;
    this.token = null;
    this.runStarted = false;
    this.resyncing = false;
    this.resyncsPerWave.clear();
    coopSnapshot.clear();
    this.room = null;
    this.role = null;
    this.pendingRoom = null;
    this.early.length = 0;
    this.waiting = [];
    this.ownStates.clear();
    this.partnerStates.clear();
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}

/** The connection of this client. */
export const coopNetwork = new CoopNetwork();
