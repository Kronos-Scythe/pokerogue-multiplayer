/**
 * A seat in a co-op run. Seat `0` owns the first field slot, seat `1` owns the second.
 * Each seat brings its own team of {@linkcode COOP_TEAM_SIZE} Pokemon.
 */
export type CoopSeat = 0 | 1;

/** How many Pokemon each seat brings to a co-op run. */
export const COOP_TEAM_SIZE = 3;

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
