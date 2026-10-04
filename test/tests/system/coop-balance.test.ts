import { applyCoopBalanceParams, applyCoopLevelBonus, coopBalance, getCoopBossSegments } from "#system/coop-balance";
import { coopSession } from "#system/coop-session";
import { afterEach, describe, expect, it } from "vitest";

describe("Co-op balance", () => {
  afterEach(() => {
    coopSession.reset();
    coopBalance.bossSegmentReduction = 1;
    coopBalance.enemyLevelBonus = 0;
  });

  it("leaves boss health bars and levels alone outside co-op", () => {
    expect(getCoopBossSegments(4)).toBe(4);
    expect(getCoopBossSegments(0)).toBe(0);
    coopBalance.enemyLevelBonus = 5;
    expect(applyCoopLevelBonus([10, 12])).toEqual([10, 12]);
  });

  it("takes a segment off each boss in co-op, but never below 2 and never turns a non-boss into one", () => {
    coopSession.start({ localSeat: 0 });
    expect(getCoopBossSegments(4)).toBe(3);
    expect(getCoopBossSegments(2)).toBe(2);
    expect(getCoopBossSegments(0)).toBe(0);
  });

  it("adds levels to enemies in co-op, never going below level 1", () => {
    coopSession.start({ localSeat: 0 });
    coopBalance.enemyLevelBonus = 3;
    expect(applyCoopLevelBonus([10, 12])).toEqual([13, 15]);
    coopBalance.enemyLevelBonus = -20;
    expect(applyCoopLevelBonus([10])).toEqual([1]);
  });

  it("reads the knobs from the page address and ignores nonsense", () => {
    applyCoopBalanceParams("?coop=host&coopBossCut=0&coopLevels=-2");
    expect(coopBalance).toEqual({ bossSegmentReduction: 0, enemyLevelBonus: -2 });
    applyCoopBalanceParams("?coopBossCut=lots&coopLevels=1.5");
    expect(coopBalance).toEqual({ bossSegmentReduction: 0, enemyLevelBonus: -2 });
  });
});
