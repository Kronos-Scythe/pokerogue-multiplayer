import { modifierTypes } from "#data/data-lists";
import { AbilityId } from "#enums/ability-id";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { ModifierTypeOption, PokemonModifierType } from "#modifiers/modifier-type";
import { type CoopShopAction, coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op shop", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let sent: CoopShopAction[];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    game.override
      .ability(AbilityId.BALL_FETCH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset(MoveId.SPLASH)
      .startingLevel(50)
      .enemyLevel(5)
      .criticalHits(false);
    sent = [];
  });

  afterEach(() => {
    coopSession.reset();
  });

  async function start(options: { localSeat: 0 | 1; hotseat: boolean }) {
    coopSession.start(options);
    coopSession.sendShop = action => sent.push(action);
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
  }

  const currentShop = () => game.scene.phaseManager.getCurrentPhase() as any;

  /**
   * Win the wave with both seats on this client, then hand the partner's seat over to the other client
   * (so the shop sees a remote player).
   */
  async function winWave(remote?: { localSeat: 0 | 1 }) {
    for (const enemy of game.scene.getEnemyField()) {
      enemy.hp = 0;
      game.scene.phaseManager.pushNew("FaintPhase", enemy.getBattlerIndex(), true);
    }
    game.move.use(MoveId.SPLASH, 0);
    game.move.use(MoveId.SPLASH, 1);
    await game.phaseInterceptor.to("BattleEndPhase", false);
    if (remote) {
      coopSession.hotseat = false;
      coopSession.localSeat = remote.localSeat;
    }
  }

  const skipPrompt = () => {
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        (game.scene.ui.getHandler() as any).processInput(Button.CANCEL);
      },
      undefined,
      true,
    );
    game.onNextPrompt("SelectModifierPhase", UiMode.CONFIRM, () => {
      (game.scene.ui.getHandler() as any).processInput(Button.ACTION);
    });
  };

  it("gives each seat one pick from the same options, and the second pick cannot reroll", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave();
    const seen: { options: number; reroll: number }[] = [];
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      seen.push({ options: phase.typeOptions.length, reroll: phase.getRerollCost(false) });
      // take a reward that needs no target (an Amulet Coin if the roll has none)
      let index = phase.typeOptions.findIndex((o: ModifierTypeOption) => !(o.type instanceof PokemonModifierType));
      if (index === -1) {
        index = 0;
        phase.typeOptions[0] = new ModifierTypeOption(modifierTypes.AMULET_COIN(), 0);
      }
      phase.pendingPick = { kind: "reward", cursor: index };
      phase.applyModifier(phase.typeOptions[index].type.newModifier(), -1);
    });
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        const phase = currentShop();
        seen.push({ options: phase.typeOptions.length, reroll: phase.getRerollCost(false) });
        (game.scene.ui.getHandler() as any).processInput(Button.CANCEL);
      },
      undefined,
      true,
    );
    game.onNextPrompt("SelectModifierPhase", UiMode.CONFIRM, () => {
      (game.scene.ui.getHandler() as any).processInput(Button.ACTION);
    });
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(seen).toHaveLength(2);
    expect(seen[1].options).toBe(seen[0].options - 1);
    expect(seen[0].reroll).toBeGreaterThanOrEqual(0);
    expect(seen[1].reroll).toBeLessThan(0);
  });

  it("lets the partner go first on odd waves, replays their step, then gives this seat the turn", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    // wave 1 is odd, so seat 1 (remote here) picks first; they skip
    const waiting = game.phaseInterceptor.to("SelectModifierPhase", false);
    await waiting;
    let ours = 0;
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        ours = currentShop().typeOptions.length;
        (game.scene.ui.getHandler() as any).processInput(Button.CANCEL);
      },
      undefined,
      true,
    );
    game.onNextPrompt("SelectModifierPhase", UiMode.CONFIRM, () => {
      (game.scene.ui.getHandler() as any).processInput(Button.ACTION);
    });
    const done = game.phaseInterceptor.to("TurnInitPhase");
    coopSession.receiveShop({ kind: "skip" });
    await done;

    // the partner skipped, so our turn still has every option
    expect(ours).toBe(3);
    expect(sent.some(a => a.kind === "skip")).toBe(true);
  });

  it("applies the partner's reward pick here and leaves one fewer option for this seat", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    let ours = 0;
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        ours = currentShop().typeOptions.length;
        (game.scene.ui.getHandler() as any).processInput(Button.CANCEL);
      },
      undefined,
      true,
    );
    game.onNextPrompt("SelectModifierPhase", UiMode.CONFIRM, () => {
      (game.scene.ui.getHandler() as any).processInput(Button.ACTION);
    });
    const done = game.phaseInterceptor.to("TurnInitPhase");
    // the first shop belongs to the partner; wait for it to open, make sure it holds an untargeted reward, take it
    for (let i = 0; i < 100 && !currentShop().typeOptions; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const phase = currentShop();
    phase.typeOptions[0] = new ModifierTypeOption(modifierTypes.AMULET_COIN(), 0);
    const before = game.scene.modifiers.length;
    coopSession.receiveShop({ kind: "reward", cursor: 0 });
    await done;

    expect(game.scene.modifiers.length).toBe(before + 1);
    expect(ours).toBe(2);
  });

  it("sends the local seat's skip to the partner", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 1 });
    // seat 1 (local now) picks first on wave 1, then seat 0 (remote) picks
    skipPrompt();
    const done = game.phaseInterceptor.to("TurnInitPhase");
    // let our own skip go out, then the partner takes their turn
    for (let i = 0; i < 100 && sent.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(sent.filter(a => a.kind === "skip")).toHaveLength(1);
    coopSession.receiveShop({ kind: "skip" });
    await done;
  });
});
