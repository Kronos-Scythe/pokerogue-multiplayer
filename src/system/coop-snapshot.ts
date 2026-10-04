import { globalScene } from "#app/global-scene";

/**
 * A copy of the run as it was when the current wave began, kept by both clients.
 *
 * When the two games drift apart, or a player's connection dropped and some messages were lost, the host's copy is sent to the
 * guest and both games go back to the start of the wave from it (the same way "continue" restores a saved run).
 * Co-op runs are never written to the save slots, so this lives in memory only.
 */
class CoopSnapshots {
  /** The run at the start of the current wave, as JSON */
  public latest: string | null = null;
  /** The wave of {@linkcode latest} */
  public wave = 0;
  /** A snapshot waiting to be loaded by the title phase, which is where the game is restored from */
  public pendingResume: string | null = null;

  /** Keep a copy of the run as it is now. */
  public capture(): void {
    this.latest = JSON.stringify(globalScene.gameData.getSessionSaveData(), (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    this.wave = globalScene.currentBattle.waveIndex;
  }

  public clear(): void {
    this.latest = null;
    this.wave = 0;
    this.pendingResume = null;
  }
}

export const coopSnapshot = new CoopSnapshots();
