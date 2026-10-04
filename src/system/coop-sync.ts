import { globalScene } from "#app/global-scene";
import Phaser from "phaser";

/** A short, stable hash of some text (FNV-1a). */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Summarize the battle in a hash: both clients simulate the whole game, so if they ever disagree
 * on this at the same point, something went out of sync.
 */
export function computeCoopStateHash(): { state: string; rng: string } {
  const { currentBattle } = globalScene;
  const describe = (p: {
    species: { speciesId: number };
    hp: number;
    level: number;
    status?: { effect: number } | null;
    owner?: number;
  }) => `${p.species.speciesId}/${p.level}/${p.hp}/${p.status?.effect ?? 0}/${p.owner ?? "e"}`;
  const state = [
    currentBattle.waveIndex,
    currentBattle.turn,
    globalScene.money,
    globalScene.getPlayerParty().map(describe).join(","),
    globalScene.getEnemyParty().map(describe).join(","),
  ].join("|");
  return { state: hashText(state), rng: hashText(String(Phaser.Math.RND.state())) };
}
