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
 * Field slot `0` is always seat 0's active Pokemon and field slot `1` is always seat 1's.
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

  /** The seat that controls a given player field slot. */
  public seatOfFieldIndex(fieldIndex: number): CoopSeat {
    return fieldIndex === 0 ? 0 : 1;
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
