import { Status } from "#data/status-effect";
import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import { SwitchSummonPhase } from "#phases/switch-summon-phase";
import { coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import type { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Party layout used throughout: [seat 0 lead, seat 1 lead, seat 0 bench, seat 0 bench, seat 1 bench, seat 1 bench].
 */
const OWNERS = [0, 1, 0, 0, 1, 1] as const;
const BULBASAUR = 0;
const SQUIRTLE = 1;
const CHARMANDER = 2;
const PIKACHU = 3;
const EEVEE = 4;
const MAGIKARP = 5;

describe("Co-op switching and wipes", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    game.override
      .ability(AbilityId.BALL_FETCH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset(MoveId.SPLASH)
      .startingLevel(5)
      .enemyLevel(100)
      .criticalHits(false);

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
      p.owner = OWNERS[i];
    });
  });

  afterEach(() => {
    coopSession.reset();
  });

  const party = () => game.scene.getPlayerParty();
  const speciesAt = (index: number) => party()[index].species.speciesId;

  /** Make a party member fainted without going through a battle. */
  function faint(pokemon: PlayerPokemon) {
    pokemon.hp = 0;
    pokemon.status = new Status(StatusEffect.FAINT);
  }

  /** Have the enemies spend a turn knocking out the player's slot 0 (and doing nothing else). */
  async function enemyKnocksOutSlotZero() {
    game.move.use(MoveId.SPLASH, 0);
    game.move.use(MoveId.SPLASH, 1);
    await game.move.forceEnemyMove(MoveId.TACKLE, BattlerIndex.PLAYER);
    await game.move.forceEnemyMove(MoveId.SPLASH);
  }

  /** Knock out every enemy at once (the harness helper waits on a command prompt between the two kills) */
  function koEnemies() {
    for (const enemy of game.scene.getEnemyField()) {
      enemy.hp = 0;
      game.scene.phaseManager.pushNew("FaintPhase", enemy.getBattlerIndex(), true);
    }
  }

  describe("a faint in a team that still has Pokemon", () => {
    it("lets that team refill the slot from its own bench", async () => {
      await enemyKnocksOutSlotZero();
      game.doSelectPartyPokemon(CHARMANDER);
      await game.toNextTurn();

      expect(speciesAt(0)).toBe(SpeciesId.CHARMANDER);
      expect(party()[0].owner).toBe(0);
      // the partner's slot is untouched
      expect(speciesAt(1)).toBe(SpeciesId.SQUIRTLE);
      expect(game.scene.getPlayerField(true)).toHaveLength(2);
    });

    it("does not offer the partner's Pokemon as something to send out", async () => {
      let optionsForPartnersPokemon: unknown[] = [];
      let optionsForOwnPokemon: unknown[] = [];
      await enemyKnocksOutSlotZero();
      game.onNextPrompt("SwitchPhase", UiMode.PARTY, () => {
        const handler = game.scene.ui.getHandler() as PartyUiHandler;
        // Partner's bench Pokemon: the menu may show it but must not allow sending it out
        handler.setCursor(EEVEE);
        handler.processInput(Button.ACTION);
        optionsForPartnersPokemon = [...(handler as any).options];
        handler.processInput(Button.CANCEL);
        // Own bench Pokemon: sending out is offered
        handler.setCursor(CHARMANDER);
        handler.processInput(Button.ACTION);
        optionsForOwnPokemon = [...(handler as any).options];
        handler.processInput(Button.ACTION);
      });
      await game.toNextTurn();

      expect(optionsForOwnPokemon.length).toBeGreaterThan(optionsForPartnersPokemon.length);
      expect(speciesAt(0)).toBe(SpeciesId.CHARMANDER);
    });
  });

  describe("a wiped team", () => {
    beforeEach(() => {
      // seat 0's bench is already down; its lead is about to go as well
      faint(party()[CHARMANDER]);
      faint(party()[PIKACHU]);
    });

    it("spectates instead of ending the run, while the partner keeps fighting", async () => {
      await enemyKnocksOutSlotZero();
      await game.phaseInterceptor.to("TurnEndPhase");

      expect(game.phaseInterceptor.phaseLog.includes("GameOverPhase")).toBe(false);
      expect(game.phaseInterceptor.phaseLog.includes("SwitchPhase")).toBe(false);
      // seat 1's Pokemon is the only one still active
      const active = game.scene.getPlayerField(true);
      expect(active).toHaveLength(1);
      expect(active[0].owner).toBe(1);

      // and the next turn only asks the surviving seat for a command
      await game.toNextTurn();
      expect(game.scene.getPlayerField(true)).toHaveLength(1);
    });

    it("gets its slot back after a revive, and the slot stays empty until then", async () => {
      await enemyKnocksOutSlotZero();
      await game.toNextTurn();

      // next wave: seat 0 is still wiped, so only seat 1 takes the field
      game.move.use(MoveId.SPLASH, 1);
      koEnemies();
      await game.toNextWave();
      expect(game.scene.getPlayerField(true)).toHaveLength(1);
      expect(game.scene.getPlayerField(true)[0].owner).toBe(1);
      expect(party()[0].owner).toBe(0);
      expect(party()[0].isFainted()).toBe(true);

      // the shop revives one of seat 0's Pokemon
      const revived = party()[PIKACHU];
      revived.hp = revived.getMaxHp();
      revived.status = null;

      game.move.use(MoveId.SPLASH, 1);
      koEnemies();
      await game.toNextWave();

      const active = game.scene.getPlayerField(true);
      expect(active).toHaveLength(2);
      expect(active.map(p => p.owner).sort()).toEqual([0, 1]);
      expect(party()[0].species.speciesId).toBe(SpeciesId.PIKACHU);
    });
  });

  it("ends the run once both teams are wiped", async () => {
    for (const index of [CHARMANDER, PIKACHU, EEVEE, MAGIKARP]) {
      faint(party()[index]);
    }

    game.move.use(MoveId.SPLASH, 0);
    game.move.use(MoveId.SPLASH, 1);
    await game.move.forceEnemyMove(MoveId.TACKLE, BattlerIndex.PLAYER);
    await game.move.forceEnemyMove(MoveId.TACKLE, BattlerIndex.PLAYER_2);
    await game.phaseInterceptor.to("GameOverPhase", false);

    expect(game.scene.getPokemonAllowedInBattle()).toHaveLength(0);
  });

  describe("forced switches", () => {
    it("redirect a partner's Pokemon to the slot owner's own bench", () => {
      // ask to bring the partner's bench Pokemon into seat 0's slot
      const phase = new SwitchSummonPhase(SwitchType.SWITCH, 0, EEVEE, true);
      expect((phase as any).slotIndex).toBe(CHARMANDER);
    });

    it("cancel when the slot owner has nobody left to bring in", () => {
      faint(party()[CHARMANDER]);
      faint(party()[PIKACHU]);

      const phase = new SwitchSummonPhase(SwitchType.SWITCH, 0, EEVEE, true);
      expect((phase as any).coopCancelled).toBe(true);
    });

    it("leave a switch within the same team alone", () => {
      const phase = new SwitchSummonPhase(SwitchType.SWITCH, 1, MAGIKARP, true);
      expect((phase as any).slotIndex).toBe(MAGIKARP);
      expect((phase as any).coopCancelled).toBe(false);
    });
  });

  describe("normalizing the party", () => {
    it("puts each team's first healthy Pokemon in the first two slots and keeps the rest in order", () => {
      // scramble: partner first, seat 0's old lead fainted
      const [bulbasaur, squirtle, charmander, pikachu, eevee, magikarp] = party();
      faint(bulbasaur);
      party().splice(0, 6, squirtle, bulbasaur, magikarp, charmander, eevee, pikachu);

      game.scene.normalizeCoopParty();

      expect(party().map(p => p.species.speciesId)).toEqual([
        SpeciesId.CHARMANDER, // seat 0's first healthy Pokemon
        SpeciesId.SQUIRTLE, // seat 1's first healthy Pokemon
        SpeciesId.BULBASAUR, // the rest keep their relative order
        SpeciesId.MAGIKARP,
        SpeciesId.EEVEE,
        SpeciesId.PIKACHU,
      ]);
    });

    it("keeps a wiped team's fainted Pokemon in its slot so that the team spectates", () => {
      for (const index of [BULBASAUR, CHARMANDER, PIKACHU]) {
        faint(party()[index]);
      }
      const partner = party()[SQUIRTLE];
      party().splice(
        0,
        6,
        partner,
        party()[BULBASAUR],
        party()[CHARMANDER],
        party()[PIKACHU],
        party()[EEVEE],
        party()[MAGIKARP],
      );

      game.scene.normalizeCoopParty();

      expect(party()[0].owner).toBe(0);
      expect(party()[0].isFainted()).toBe(true);
      expect(party()[1]).toBe(partner);
    });

    it("does nothing outside co-op", () => {
      coopSession.reset();
      const before = party().map(p => p.id);
      party().reverse();
      game.scene.normalizeCoopParty();
      expect(party().map(p => p.id)).toEqual(before.reverse());
    });
  });
});
