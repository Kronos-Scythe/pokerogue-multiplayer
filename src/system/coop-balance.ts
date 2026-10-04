import { coopSession } from "#system/coop-session";

/**
 * Co-op balance knobs. Every fight is a double battle, so a boss wave sends out two bosses at once
 * (the finale is two Eternatus). The defaults are a first guess, not playtested.
 *
 * To try other values without changing code, add them to the page address, for example
 * `?coopBossCut=0&coopLevels=2` (see {@linkcode applyCoopBalanceParams}). Both players must use the same values.
 */
export const coopBalance = {
  /** How many health bar segments each boss loses in co-op (a boss always keeps at least 2, so it is still a boss) */
  bossSegmentReduction: 1,
  /** How many levels every enemy gains in co-op (can be negative) */
  enemyLevelBonus: 0,
};

/** The number of health bar segments a boss gets, lowered in co-op where two of them are fielded together. */
export function getCoopBossSegments(segments: number): number {
  if (!coopSession.enabled || segments <= 1) {
    return segments;
  }
  return Math.max(2, segments - coopBalance.bossSegmentReduction);
}

/** Enemy levels with the co-op bonus on top (nothing changes outside co-op). */
export function applyCoopLevelBonus(levels: number[] | undefined): number[] | undefined {
  if (!coopSession.enabled || !levels || coopBalance.enemyLevelBonus === 0) {
    return levels;
  }
  return levels.map(level => Math.max(1, level + coopBalance.enemyLevelBonus));
}

/**
 * Read balance settings from a page address: `coopBossCut` (segments each boss loses) and `coopLevels` (levels
 * every enemy gains). Values that are not whole numbers are ignored.
 */
export function applyCoopBalanceParams(search: string): void {
  const params = new URLSearchParams(search);
  const read = (name: string): number | null => {
    const raw = params.get(name);
    return raw !== null && /^-?\d+$/.test(raw.trim()) ? Number(raw) : null;
  };
  const cut = read("coopBossCut");
  if (cut !== null) {
    coopBalance.bossSegmentReduction = Math.max(0, cut);
  }
  const levels = read("coopLevels");
  if (levels !== null) {
    coopBalance.enemyLevelBonus = levels;
  }
}
