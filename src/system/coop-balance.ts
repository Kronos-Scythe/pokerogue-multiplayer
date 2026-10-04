import { coopSession } from "#system/coop-session";

/**
 * Co-op balance knobs. Every fight is a double battle, so a boss wave sends out two bosses at once
 * (the finale is two Eternatus). These values are a first guess, not playtested: change them here.
 */

/** How many health bar segments each boss loses in co-op (a boss always keeps at least 2, so it is still a boss). */
export const COOP_BOSS_SEGMENT_REDUCTION = 1;

/** The number of health bar segments a boss gets, lowered in co-op where two of them are fielded together. */
export function getCoopBossSegments(segments: number): number {
  if (!coopSession.enabled || segments <= 1) {
    return segments;
  }
  return Math.max(2, segments - COOP_BOSS_SEGMENT_REDUCTION);
}
