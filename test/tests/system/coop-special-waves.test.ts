import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { TrainerType } from "#enums/trainer-type";
import * as MysteryEncounters from "#mystery-encounters/mystery-encounter-biomes";
import { coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const coopParty: [SpeciesId, SpeciesId, SpeciesId, SpeciesId, SpeciesId, SpeciesId] = [
  SpeciesId.BULBASAUR,
  SpeciesId.SQUIRTLE,
  SpeciesId.CHARMANDER,
  SpeciesId.PIKACHU,
  SpeciesId.EEVEE,
  SpeciesId.MAGIKARP,
];

describe("Co-op special waves", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    coopSession.start({ localSeat: 0, hotseat: true });
  });

  afterEach(() => {
    coopSession.reset();
  });

  it("makes the classic final boss a double battle", async () => {
    game.override
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .startingWave(200)
      .startingBiome(BiomeId.END);

    await game.classicMode.startBattle(...coopParty);

    const battle = game.scene.currentBattle;
    expect(battle.double).toBe(true);
    expect(game.scene.getPlayerField()).toHaveLength(2);
    console.log(
      "FINALE enemies:",
      game.scene.getEnemyParty().map(p => p.species.name),
      "enemyLevels:",
      battle.enemyLevels,
    );
    expect(game.scene.getEnemyField().length).toBeGreaterThanOrEqual(1);
  });

  it("lets the run be won by defeating both Eternatus through both boss phases", async () => {
    game.override
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset(MoveId.ICE_BEAM)
      .criticalHits(false)
      .startingWave(200)
      .startingBiome(BiomeId.END)
      .startingLevel(10000);

    await game.classicMode.startBattle(...coopParty);
    expect(game.scene.getEnemyField()).toHaveLength(2);

    // Boss phase 1: each seat takes down one Eternatus
    game.move.use(MoveId.ICE_BEAM, 0, BattlerIndex.ENEMY);
    game.move.use(MoveId.ICE_BEAM, 1, BattlerIndex.ENEMY_2);
    await game.toNextTurn();

    // Both should have advanced to their final form rather than the battle ending
    expect(game.scene.getEnemyField(true)).toHaveLength(2);
    expect(game.phaseInterceptor.phaseLog.includes("GameOverPhase")).toBe(false);

    // Boss phase 2
    game.move.use(MoveId.ICE_BEAM, 0, BattlerIndex.ENEMY);
    game.move.use(MoveId.ICE_BEAM, 1, BattlerIndex.ENEMY_2);
    await game.phaseInterceptor.to("PostGameOverPhase", false);

    expect(game.phaseInterceptor.phaseLog.includes("GameOverPhase")).toBe(true);
  });

  describe("mystery encounters", () => {
    beforeEach(() => {
      game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    });

    const encounters = [
      MysteryEncounterType.FIGHT_OR_FLIGHT,
      MysteryEncounterType.MYSTERIOUS_CHALLENGERS,
      MysteryEncounterType.DEPARTMENT_STORE_SALE,
      MysteryEncounterType.DANCING_LESSONS,
    ];

    for (const type of encounters) {
      it(`reaches the option screen for ${MysteryEncounterType[type]} with two player slots`, async () => {
        vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(
          new Map<BiomeId, MysteryEncounterType[]>([[BiomeId.CAVE, [type]]]),
        );

        await game.runToMysteryEncounter(type, coopParty);

        const battle = game.scene.currentBattle;
        console.log(`ME ${MysteryEncounterType[type]}: double=${battle.double} enemies=${battle.enemyParty.length}`);
        expect(battle.double).toBe(true);
        expect(game.scene.getPlayerField()).toHaveLength(2);
      });
    }

    it("keeps the fight a double after choosing to fight in Fight or Flight", async () => {
      vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(
        new Map<BiomeId, MysteryEncounterType[]>([[BiomeId.CAVE, [MysteryEncounterType.FIGHT_OR_FLIGHT]]]),
      );

      await game.runToMysteryEncounter(MysteryEncounterType.FIGHT_OR_FLIGHT, coopParty);
      await runMysteryEncounterToEnd(game, 1, undefined, true);

      // Two player slots face the encounter's single fixed boss
      expect(game).toBeAtPhase("CommandPhase");
      expect(game.scene.currentBattle.double).toBe(true);
      expect(game.scene.getPlayerField()).toHaveLength(2);
      expect(game.scene.getEnemyField()).toHaveLength(1);
    });

    it("makes a trainer encounter a double with two enemies", async () => {
      vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(
        new Map<BiomeId, MysteryEncounterType[]>([[BiomeId.CAVE, [MysteryEncounterType.MYSTERIOUS_CHALLENGERS]]]),
      );

      await game.runToMysteryEncounter(MysteryEncounterType.MYSTERIOUS_CHALLENGERS, coopParty);
      await runMysteryEncounterToEnd(game, 1, undefined, true);

      expect(game).toBeAtPhase("CommandPhase");
      expect(game.scene.currentBattle.trainer).toBeDefined();
      expect(game.scene.currentBattle.double).toBe(true);
      expect(game.scene.getEnemyField()).toHaveLength(2);
    });
  });

  describe("trainer waves", () => {
    beforeEach(() => {
      game.override //
        .enemyAbility(AbilityId.BALL_FETCH)
        .enemyMoveset(MoveId.SPLASH)
        .battleType(BattleType.TRAINER);
    });

    it("makes a trainer with a double variant a double battle with two enemies", async () => {
      game.override.randomTrainer({ trainerType: TrainerType.YOUNGSTER });

      await game.classicMode.startBattle(...coopParty);

      const battle = game.scene.currentBattle;
      console.log(`TRAINER youngster: double=${battle.double} variant=${battle.trainer?.variant}`);
      expect(battle.double).toBe(true);
      expect(game.scene.getEnemyField()).toHaveLength(2);
    });

    it("survives a gym leader that has no double variant", async () => {
      game.override.randomTrainer({ trainerType: TrainerType.BROCK });

      await game.classicMode.startBattle(...coopParty);

      const battle = game.scene.currentBattle;
      console.log(
        `TRAINER brock: double=${battle.double} variant=${battle.trainer?.variant} enemies=${game.scene.getEnemyField().length}`,
      );
      expect(game).toBeAtPhase("CommandPhase");
      expect(game.scene.getEnemyField().length).toBeGreaterThanOrEqual(1);
    });
  });
});
