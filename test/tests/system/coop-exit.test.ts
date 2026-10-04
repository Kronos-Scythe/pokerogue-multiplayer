import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { leaveCoopRun } from "#system/coop-exit";
import { coopNetwork } from "#system/coop-network";
import { coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Leaving a co-op run", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    game.override.ability(AbilityId.BALL_FETCH).enemyAbility(AbilityId.BALL_FETCH).moveset(MoveId.SPLASH);
    coopSession.start({ localSeat: 0, hotseat: true });
    await game.classicMode.startBattle(
      SpeciesId.BULBASAUR,
      SpeciesId.SQUIRTLE,
      SpeciesId.CHARMANDER,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
      SpeciesId.MAGIKARP,
    );
  });

  afterEach(() => {
    coopSession.reset();
  });

  it("forgets the co-op session, drops the connection and queues the title screen", () => {
    let disconnected = false;
    const original = coopNetwork.disconnect.bind(coopNetwork);
    coopNetwork.disconnect = () => {
      disconnected = true;
      original();
    };

    leaveCoopRun();
    coopNetwork.disconnect = original;

    expect(disconnected).toBe(true);
    expect(coopSession.enabled).toBe(false);
    // back to the start of the title flow (the login step comes first)
    expect(game.scene.phaseManager.getCurrentPhase().phaseName).toBe("LoginPhase");
  });

  it("can be called twice (the partner leaving while quitting yourself) without trouble", () => {
    leaveCoopRun();
    expect(() => leaveCoopRun()).not.toThrow();
    expect(coopSession.enabled).toBe(false);
  });
});
