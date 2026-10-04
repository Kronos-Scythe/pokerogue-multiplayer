import { getCoopBossSegments } from "#system/coop-balance";
import { coopSession } from "#system/coop-session";
import { afterEach, describe, expect, it } from "vitest";

describe("Co-op balance", () => {
  afterEach(() => {
    coopSession.reset();
  });

  it("leaves boss health bars alone outside co-op", () => {
    expect(getCoopBossSegments(4)).toBe(4);
    expect(getCoopBossSegments(0)).toBe(0);
  });

  it("takes a segment off each boss in co-op, but never below 2 and never turns a non-boss into one", () => {
    coopSession.start({ localSeat: 0 });
    expect(getCoopBossSegments(4)).toBe(3);
    expect(getCoopBossSegments(2)).toBe(2);
    expect(getCoopBossSegments(0)).toBe(0);
  });
});
