import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { type CoopLearnChoice, coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op move learning", () => {
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
      .moveset([MoveId.SPLASH, MoveId.POUND, MoveId.GROWL, MoveId.TAIL_WHIP])
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
  });

  /** Make the second Pokemon (seat 1's) try to learn Tackle with the partner's client (seat 1) deciding */
  async function teachPartnersPokemon(choice: CoopLearnChoice) {
    coopSession.hotseat = false;
    const partners = game.scene.getPlayerParty()[1];
    expect(partners.getMoveset()).toHaveLength(4);
    coopSession.receiveLearn(choice);
    game.scene.phaseManager.unshiftNew("LearnMovePhase", 1, MoveId.TACKLE);
    game.scene.phaseManager.getCurrentPhase().end();
    await game.phaseInterceptor.to("LearnMovePhase");
    // the answer arrives a moment later
    for (let i = 0; i < 100 && choice.slot >= 0 && partners.moveset[choice.slot].moveId !== MoveId.TACKLE; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return partners;
  }

  it("does what the owner decided: forget the move in the chosen slot", async () => {
    const partners = await teachPartnersPokemon({ slot: 2 });
    expect(partners.moveset[2].moveId).toBe(MoveId.TACKLE);
  });

  it("leaves the moves alone when the owner decided not to learn the move", async () => {
    const partners = await teachPartnersPokemon({ slot: -1 });
    expect(partners.moveset.map(m => m.moveId)).not.toContain(MoveId.TACKLE);
  });

  it("carries the owner's answer over the wire", () => {
    const sent: CoopLearnChoice[] = [];
    coopSession.sendLearn = choice => sent.push(choice);
    coopSession.sendLearn({ slot: 1 });
    expect(sent).toEqual([{ slot: 1 }]);
  });
});
