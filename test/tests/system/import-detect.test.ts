import { GameDataType } from "#enums/game-data-type";
import { GameData } from "#system/game-data";
import { describe, expect, it } from "vitest";

describe("Import file detection", () => {
  const detect = (data: unknown): GameDataType =>
    (GameData.prototype as any).detectDataType.call({}, JSON.stringify(data));

  it("recognises a saved run, system data and run history", () => {
    expect(detect({ party: [], enemyParty: [], timestamp: 1 })).toBe(GameDataType.SESSION);
    expect(detect({ dexData: {}, timestamp: 1 })).toBe(GameDataType.SYSTEM);
    expect(detect({ 1: { isVictory: true, isFavorite: false, entry: {} } })).toBe(GameDataType.RUN_HISTORY);
  });

  it("falls back to system data for unreadable text", () => {
    expect((GameData.prototype as any).detectDataType.call({}, "not json")).toBe(GameDataType.SYSTEM);
  });
});
