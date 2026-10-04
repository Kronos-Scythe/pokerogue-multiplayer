/**
 * A seat in a co-op run. Seat `0` owns the first field slot, seat `1` owns the second.
 * Each seat brings its own team of {@linkcode COOP_TEAM_SIZE} Pokemon.
 */
export type CoopSeat = 0 | 1;

/** How many Pokemon each seat brings to a co-op run. */
export const COOP_TEAM_SIZE = 3;

/**
 * One seat's command for one turn, as sent to the other client.
 * Plain numbers and booleans only so it can go over the wire as JSON.
 */
export interface CoopCommandMessage {
  /** Wave index the command is for */
  wave: number;
  /** Battle turn the command is for */
  turn: number;
  /** The seat that issued the command */
  seat: CoopSeat;
  /** A {@linkcode Command} value */
  command: number;
  /** Move slot (fight), party slot (switch) or ball type */
  cursor: number;
  /** The move chosen, for fight commands (a `MoveId`) */
  move?: number | undefined;
  /** The final targets (`BattlerIndex` values), for fight commands */
  targets?: number[] | undefined;
  /** Whether the move is used with Terastallization */
  tera?: boolean | undefined;
  /** Whether a switch is a Baton Pass */
  baton?: boolean | undefined;
}

const commandKey = (wave: number, turn: number, seat: CoopSeat) => `${wave}:${turn}:${seat}`;

/**
 * Tracks whether the current run is a co-op run, and which seat the local client sits in.
 *
 * Co-op keeps the engine's single 6-slot party and tags each `PlayerPokemon` with the seat that owns it.
 * A field slot belongs to whichever seat owns the Pokemon sitting in it, and may only be refilled from that seat's own
 * team. Slot *indices* are deliberately not tied to seats, because the engine sometimes shuffles party order.
 */
class CoopSession {
  /** Whether the current run is a co-op run. */
  public enabled = false;

  /** The seat controlled by this client. Meaningless unless {@linkcode enabled}. */
  public localSeat: CoopSeat = 0;

  /**
   * Whether both seats are controlled from this client (no remote peer).
   * Used for local testing and for exercising co-op logic without a network.
   */
  public hotseat = false;

  /** Called with each command this client issues; set by the network layer. */
  public send: ((message: CoopCommandMessage) => void) | null = null;

  /** Commands that arrived before anyone asked for them */
  private readonly inbox = new Map<string, CoopCommandMessage>();
  /** Callers waiting for a command that has not arrived yet */
  private readonly waiting = new Map<string, (message: CoopCommandMessage) => void>();

  /** Hand a command from the other client to whoever is waiting for it (or keep it until they ask). */
  public receive(message: CoopCommandMessage): void {
    const key = commandKey(message.wave, message.turn, message.seat);
    const waiter = this.waiting.get(key);
    if (waiter) {
      this.waiting.delete(key);
      waiter(message);
    } else {
      this.inbox.set(key, message);
    }
  }

  /** Resolves with the given seat's command for the given turn, as soon as it is available. */
  public awaitCommand(wave: number, turn: number, seat: CoopSeat): Promise<CoopCommandMessage> {
    const key = commandKey(wave, turn, seat);
    const early = this.inbox.get(key);
    if (early) {
      this.inbox.delete(key);
      return Promise.resolve(early);
    }
    return new Promise(resolve => this.waiting.set(key, resolve));
  }

  /** Start a co-op run. */
  public start({ localSeat, hotseat = false }: { localSeat: CoopSeat; hotseat?: boolean }): void {
    this.enabled = true;
    this.localSeat = localSeat;
    this.hotseat = hotseat;
  }

  /** Return to normal single-player behavior. */
  public reset(): void {
    this.enabled = false;
    this.localSeat = 0;
    this.hotseat = false;
    this.send = null;
    this.inbox.clear();
    this.waiting.clear();
  }

  /**
   * Whether this client supplies commands for the given seat.
   * Always `true` outside co-op, and for both seats in hotseat mode.
   */
  public controls(seat: CoopSeat): boolean {
    return !this.enabled || this.hotseat || this.localSeat === seat;
  }
}

/** The co-op session for this client. */
export const coopSession = new CoopSession();

/** Read the co-op seat off anything that may carry one. Things without an owner (enemies) count as seat 0. */
function seatOf(pokemon: object): CoopSeat {
  return (pokemon as { owner?: CoopSeat }).owner === 1 ? 1 : 0;
}

/**
 * Whether two Pokemon belong to the same co-op seat.
 * Always `true` outside co-op, so call sites can use it without checking {@linkcode coopSession} first.
 */
export function sameSeat(a: object, b: object): boolean {
  return !coopSession.enabled || seatOf(a) === seatOf(b);
}
