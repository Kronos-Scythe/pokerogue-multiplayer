import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { TitlePhase } from "#phases/title-phase";
import { coopSession } from "#system/coop-session";
import { coopSnapshot } from "#system/coop-snapshot";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op snapshots", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    game.override
      .ability(AbilityId.BALL_FETCH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH, MoveId.TACKLE])
      .startingLevel(50)
      .enemyLevel(5);
    coopSession.start({ localSeat: 0, hotseat: true });
    await game.classicMode.startBattle(
      SpeciesId.BULBASAUR,
      SpeciesId.SQUIRTLE,
      SpeciesId.CHARMANDER,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
      SpeciesId.MAGIKARP,
    );
    game.scene.getPlayerParty().forEach((p, i) => {
      p.owner = ([0, 1, 0, 0, 1, 1] as const)[i];
    });
  });

  afterEach(() => {
    coopSession.reset();
    coopSnapshot.clear();
  });

  it("keeps a copy of the run when the wave starts", () => {
    expect(coopSnapshot.latest).toBeTruthy();
    expect(coopSnapshot.wave).toBe(game.scene.currentBattle.waveIndex);
  });

  it("goes back to the start of the wave from the copy, with every Pokemon still on its owner's team", async () => {
    // the snapshot is of the wave start, before the owners were set by this test: take a fresh one
    coopSnapshot.capture();
    const snapshot = coopSnapshot.latest!;
    const wave = game.scene.currentBattle.waveIndex;
    const moneyThen = Math.floor(game.scene.money);
    const speciesThen = game.scene.getPlayerParty().map(p => p.species.speciesId);

    // things go wrong: the game drifts away from the snapshot
    game.scene.money = moneyThen + 12345;
    game.scene.getPlayerParty()[0].hp = 1;
    game.scene.getPlayerParty()[1].owner = 0;

    coopSnapshot.pendingResume = snapshot;
    const title = new TitlePhase();
    game.scene.phaseManager.clearPhaseQueue();
    game.scene.phaseManager.unshiftPhase(title);
    game.endPhase();
    game.scene.modifiers = [];
    await title["resumeCoop"]();
    await game.phaseInterceptor.to("CommandPhase");

    expect(coopSession.enabled).toBe(true);
    expect(game.scene.currentBattle.waveIndex).toBe(wave);
    expect(Math.floor(game.scene.money)).toBe(moneyThen);
    const party = game.scene.getPlayerParty();
    expect(party.map(p => p.species.speciesId)).toEqual(speciesThen);
    expect(party.map(p => p.owner)).toEqual([0, 1, 0, 0, 1, 1]);
    expect(party[0].hp).toBeGreaterThan(1);
    // both seats have a Pokemon on the field again
    expect(game.scene.getPlayerField().filter(p => p.isActive())).toHaveLength(2);
  });
});
