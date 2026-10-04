import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { coopSession } from "#system/coop-session";
import { coopTelemetry } from "#system/coop-telemetry";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op run log", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    // other test files that ran in the same worker may have left waves behind
    coopTelemetry.clear();
  });

  afterEach(() => {
    coopSession.reset();
    coopTelemetry.clear();
  });

  it("records how a wave went when it ends", async () => {
    game = new GameManager(phaserGame);
    game.override
      .ability(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset(MoveId.SPLASH)
      .startingLevel(50)
      .enemyLevel(5);
    coopSession.start({ localSeat: 0, hotseat: true });
    await game.classicMode.startBattle(
      SpeciesId.BULBASAUR,
      SpeciesId.SQUIRTLE,
      SpeciesId.CHARMANDER,
      SpeciesId.PIKACHU,
    );
    coopTelemetry.endWave("won");

    expect(coopTelemetry.waves).toHaveLength(1);
    expect(coopTelemetry.waves[0]).toMatchObject({
      wave: 1,
      boss: false,
      faints: 0,
      alive: 4,
      hpPercent: 100,
      result: "won",
    });
    expect(coopTelemetry.toCsv().split("\n")).toHaveLength(2);
  });
});
