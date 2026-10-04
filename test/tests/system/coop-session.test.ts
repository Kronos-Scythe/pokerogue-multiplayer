import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { coopSession } from "#system/coop-session";
import { PokemonData } from "#system/pokemon-data";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op session", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override //
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .ability(AbilityId.BALL_FETCH);
  });

  afterEach(() => {
    coopSession.reset();
  });

  describe("seat control", () => {
    it("controls every seat outside co-op", () => {
      expect(coopSession.controls(0)).toBe(true);
      expect(coopSession.controls(1)).toBe(true);
    });

    it("controls only the local seat in a networked run", () => {
      coopSession.start({ localSeat: 1 });
      expect(coopSession.controls(0)).toBe(false);
      expect(coopSession.controls(1)).toBe(true);
    });

    it("controls both seats in hotseat mode", () => {
      coopSession.start({ localSeat: 0, hotseat: true });
      expect(coopSession.controls(0)).toBe(true);
      expect(coopSession.controls(1)).toBe(true);
    });

    it("maps field slot 0 to seat 0 and field slot 1 to seat 1", () => {
      expect(coopSession.seatOfFieldIndex(0)).toBe(0);
      expect(coopSession.seatOfFieldIndex(1)).toBe(1);
    });

    it("returns to single-player behavior after reset", () => {
      coopSession.start({ localSeat: 1 });
      coopSession.reset();
      expect(coopSession.enabled).toBe(false);
      expect(coopSession.controls(0)).toBe(true);
    });
  });

  describe("battle setup", () => {
    it("makes the first wave a double battle", async () => {
      coopSession.start({ localSeat: 0, hotseat: true });
      await game.classicMode.startBattle(
        SpeciesId.BULBASAUR,
        SpeciesId.SQUIRTLE,
        SpeciesId.CHARMANDER,
        SpeciesId.PIKACHU,
        SpeciesId.EEVEE,
        SpeciesId.MAGIKARP,
      );

      expect(game.scene.currentBattle.double).toBe(true);
      expect(game.scene.getPlayerField()).toHaveLength(2);
    });
  });

  describe("pokemon ownership", () => {
    beforeEach(async () => {
      await game.classicMode.startBattle(
        SpeciesId.BULBASAUR,
        SpeciesId.SQUIRTLE,
        SpeciesId.CHARMANDER,
        SpeciesId.PIKACHU,
        SpeciesId.EEVEE,
        SpeciesId.MAGIKARP,
      );
      // Party order mirrors co-op layout: [seat0 active, seat1 active, then each seat's bench]
      const owners = [0, 1, 0, 0, 1, 1] as const;
      game.scene.getPlayerParty().forEach((p, i) => {
        p.owner = owners[i];
      });
    });

    it("defaults to seat 0", () => {
      expect(new PokemonData(game.scene.getPlayerParty()[0]).owner).toBe(0);
    });

    it("survives a PokemonData round trip", () => {
      const seatOnePokemon = game.scene.getPlayerParty()[1];
      const data = new PokemonData(seatOnePokemon);
      expect(data.owner).toBe(1);

      const restored = data.toPokemon();
      expect("owner" in restored && restored.owner).toBe(1);
    });

    it("survives a JSON round trip", () => {
      const data = new PokemonData(game.scene.getPlayerParty()[4]);
      const fromJson = new PokemonData(JSON.parse(JSON.stringify(data)));
      expect(fromJson.owner).toBe(1);
    });

    it("treats a missing owner (old save data) as seat 0", () => {
      const data = JSON.parse(JSON.stringify(new PokemonData(game.scene.getPlayerParty()[0])));
      delete data.owner;
      expect(new PokemonData(data).owner).toBe(0);
    });

    it("filters allowed pokemon by owner", () => {
      const species = (seat?: 0 | 1) => game.scene.getPokemonAllowedInBattle(seat).map(p => p.species.speciesId);

      expect(species()).toHaveLength(6);
      expect(species(0)).toEqual([SpeciesId.BULBASAUR, SpeciesId.CHARMANDER, SpeciesId.PIKACHU]);
      expect(species(1)).toEqual([SpeciesId.SQUIRTLE, SpeciesId.EEVEE, SpeciesId.MAGIKARP]);
    });
  });
});
