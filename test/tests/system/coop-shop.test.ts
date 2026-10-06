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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

  /** Put two rewards that need no target in front of the player: an Amulet Coin and an Exp. Share */
  const forceRewards = (phase: any) => {
    phase.typeOptions[0] = new ModifierTypeOption(modifierTypes.AMULET_COIN(), 0);
    phase.typeOptions[1] = new ModifierTypeOption(modifierTypes.EXP_SHARE(), 0);
  };

  const pickLocal = (phase: any, cursor: number) => {
    phase.pendingPick = { kind: "reward", cursor };
    phase.pickEpoch = phase.simEpoch;
    phase.applyModifier(phase.typeOptions[cursor].type.newModifier(), -1);
  };

  it("gives each player half the money, hands out both picks on both clients and puts the money back together", async () => {
    await start({ localSeat: 0, hotseat: true });
    game.scene.money = 1001;
    await winWave({ localSeat: 0 });
    let total = 0;
    let shown = -1;
    let budgets: number[] = [];
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      budgets = [...phase.budgets];
      total = budgets[0] + budgets[1];
      shown = game.scene.money;
      forceRewards(phase);
      const before = game.scene.modifiers.length;
      pickLocal(phase, 0);
      // nothing is handed out until the partner has locked in too
      expect(game.scene.modifiers.length).toBe(before);
      coopSession.receiveShop({ kind: "reward", cursor: 1 });
    });
    const before = game.scene.modifiers.length;
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(budgets[0]).toBeGreaterThanOrEqual(budgets[1]);
    expect(budgets[0] - budgets[1]).toBeLessThanOrEqual(1);
    expect(shown).toBe(budgets[0]);
    expect(game.scene.money).toBe(total);
    expect(game.scene.modifiers.length).toBe(before + 2);
    expect(sent.filter(a => a.kind === "reward")).toEqual([{ kind: "reward", cursor: 0, target: undefined, epoch: 0 }]);
  });

  it("gives a reward both players wanted to the priority seat and lets the other pick again", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    // wave 1: seat 1 (the partner here) has priority
    let left = 0;
    let expShare: unknown;
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      forceRewards(phase);
      expShare = phase.typeOptions[1].type;
      pickLocal(phase, 0);
      coopSession.receiveShop({ kind: "reward", cursor: 0 });
    });
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      left = phase.typeOptions.length;
      // the Amulet Coin is gone, so the Exp. Share is first now
      expect(phase.typeOptions[0].type).toBe(expShare);
      pickLocal(phase, 0);
    });
    const before = game.scene.modifiers.length;
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(left).toBe(2);
    // the partner's Amulet Coin and our Exp. Share
    expect(game.scene.modifiers.length).toBe(before + 2);
    expect(sent.filter(a => a.kind === "reward").map(a => (a as any).cursor)).toEqual([0, 0]);
  });

  it("lets the loser of a tie pick again when they lock in after the partner (shop screen still open)", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    // wave 1: seat 1 (the partner here) has priority and has already chosen the first reward
    let reopened = false;
    const modes: UiMode[] = [];
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, async () => {
      const phase = currentShop();
      forceRewards(phase);
      coopSession.receiveShop({ kind: "reward", cursor: 0 });
      await new Promise(resolve => setTimeout(resolve, 0));
      const setMode = game.scene.ui.setMode.bind(game.scene.ui);
      vi.spyOn(game.scene.ui, "setMode").mockImplementation((mode, ...args) => {
        modes.push(mode);
        return setMode(mode, ...args);
      });
      pickLocal(phase, 0);
    });
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      reopened = true;
      pickLocal(currentShop(), 0);
    });
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(reopened).toBe(true);
    // the open shop screen was left before it was shown again (setting the same mode twice does nothing)
    expect(modes.slice(0, 2)).toEqual([UiMode.MESSAGE, UiMode.MODIFIER_SELECT]);
  });

  it("finishes when this player skips and the partner has already picked", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        forceRewards(currentShop());
        coopSession.receiveShop({ kind: "reward", cursor: 0 });
        (game.scene.ui.getHandler() as any).processInput(Button.CANCEL);
      },
      undefined,
      true,
    );
    game.onNextPrompt("SelectModifierPhase", UiMode.CONFIRM, () => {
      (game.scene.ui.getHandler() as any).processInput(Button.ACTION);
    });
    const before = game.scene.modifiers.length;
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(game.scene.modifiers.length).toBe(before + 1);
    expect(sent).toContainEqual({ kind: "skip", epoch: 0 });
  });

  it("only lets a player pick their own Pokemon for items, TMs and fusions", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    let filtered: (string | null)[] = [];
    game.onNextPrompt(
      "SelectModifierPhase",
      UiMode.MODIFIER_SELECT,
      () => {
        const filter = currentShop().ownTeamFilter();
        // slots 0 and 2 are ours (seat 0), slot 1 is the partner's
        filtered = [0, 1, 2].map(i => filter(game.scene.getPlayerParty()[i]));
        forceRewards(currentShop());
        pickLocal(currentShop(), 0);
        coopSession.receiveShop({ kind: "skip" });
      },
      undefined,
    );
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(filtered[0]).toBeNull();
    expect(filtered[1]).toBe("Only your own team!");
    expect(filtered[2]).toBeNull();
  });

  it("lets either player reroll: the roller pays, both clients get the same new rewards", async () => {
    await start({ localSeat: 0, hotseat: true });
    game.scene.money = 100000;
    await winWave({ localSeat: 0 });
    let result: Record<string, any> = {};
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      const before = [...phase.budgets];
      const cost = phase.getRerollCost(false);
      expect(phase.rerollSimultaneous()).toBe(false);
      const afterOwn = [...phase.budgets];
      const ownOptions = phase.typeOptions.map((o: ModifierTypeOption) => o.type.name);
      // the same roll again from scratch (as the partner's client would do it) gives the same rewards
      phase.regenerateOptions(1);
      const again = phase.typeOptions.map((o: ModifierTypeOption) => o.type.name);
      // the partner rolls next: their wallet pays, and the rewards change again
      coopSession.receiveShop({ kind: "reroll", epoch: 2 });
      result = { before, cost, afterOwn, ownOptions, again };
    });
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      result.epochAfter = phase.simEpoch;
      result.budgetsAfter = [...phase.budgets];
      forceRewards(phase);
      pickLocal(phase, 0);
      coopSession.receiveShop({ kind: "skip", epoch: 2 });
    });
    await game.phaseInterceptor.to("TurnInitPhase");

    expect(result.cost).toBeGreaterThan(0);
    expect(result.afterOwn[0]).toBe(result.before[0] - result.cost);
    expect(result.afterOwn[1]).toBe(result.before[1]);
    expect(result.again).toEqual(result.ownOptions);
    expect(result.epochAfter).toBe(2);
    // the partner's reroll was their second step, so it cost double
    expect(result.budgetsAfter[1]).toBe(result.before[1] - result.cost * 2);
    expect(sent.find(a => a.kind === "reroll")).toEqual({ kind: "reroll", epoch: 1 });
  });

  it("ignores a partner's choice made against rewards that have been rerolled since", async () => {
    await start({ localSeat: 0, hotseat: true });
    await winWave({ localSeat: 0 });
    let locks = -1;
    game.onNextPrompt("SelectModifierPhase", UiMode.MODIFIER_SELECT, () => {
      const phase = currentShop();
      coopSession.receiveShop({ kind: "reroll", epoch: 1 });
      // sent before they rerolled, arrives after
      coopSession.receiveShop({ kind: "reward", cursor: 0, epoch: 0 });
      setTimeout(() => {
        locks = phase.locks.size;
        coopSession.receiveShop({ kind: "skip", epoch: 1 });
        forceRewards(phase);
        pickLocal(phase, 0);
      }, 50);
    });
    await game.phaseInterceptor.to("TurnInitPhase");
    expect(locks).toBe(0);
  });
});
