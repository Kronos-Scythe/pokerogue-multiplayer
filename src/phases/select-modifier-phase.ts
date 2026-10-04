import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import type { ModifierTier } from "#enums/modifier-tier";
import { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import type { Modifier } from "#modifiers/modifier";
import {
  ExtraModifierModifier,
  HealShopCostModifier,
  PokemonHeldItemModifier,
  TempExtraModifierModifier,
} from "#modifiers/modifier";
import type { CustomModifierSettings, ModifierType, ModifierTypeOption } from "#modifiers/modifier-type";
import {
  FusePokemonModifierType,
  getPlayerModifierTypeOptions,
  getPlayerShopModifierTypeOptionsForWave,
  PokemonModifierType,
  PokemonMoveModifierType,
  PokemonPpRestoreModifierType,
  PokemonPpUpModifierType,
  RememberMoveModifierType,
  regenerateModifierPoolThresholds,
  TmModifierType,
} from "#modifiers/modifier-type";
import { BattlePhase } from "#phases/battle-phase";
import { type CoopPickTarget, type CoopSeat, type CoopShopAction, coopSession } from "#system/coop-session";
import type { ConfirmModeConfig } from "#types/ui-types";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import { PartyOption, PartyUiHandler, type PokemonSelectFilter } from "#ui/party-ui-handler";
import { NumberHolder } from "#utils/common";
import i18next from "i18next";

export type ModifierSelectCallback = (rowCursor: number, cursor: number) => boolean;

/**
 * Whose turn it is in a co-op shop. The two seats pick one reward each from the same set of options,
 * and the seat that picks first alternates from wave to wave.
 */
export interface CoopShopTurn {
  /** The seat that is choosing */
  seat: CoopSeat;
  /** Whether this is the second pick of the shop (nothing follows it) */
  final: boolean;
  /** Whether the second pick has been scheduled already */
  followUpQueued: boolean;
}

/** A reward choice a player has locked in during the simultaneous co-op shop (`done` once it has been handed out). */
type CoopLockedPick =
  | { kind: "reward"; cursor: number; target?: CoopPickTarget | undefined }
  | { kind: "skip" }
  | { kind: "done" };

export class SelectModifierPhase extends BattlePhase {
  public readonly phaseName = "SelectModifierPhase";
  private readonly rerollCount: number;
  private readonly modifierTiers?: ModifierTier[] | undefined;
  private readonly customModifierSettings?: CustomModifierSettings | undefined;
  private readonly isCopy: boolean;

  private typeOptions: ModifierTypeOption[];

  /** Co-op: whose turn this is (set when the phase starts, and handed on to rerolls and copies) */
  private coopTurn?: CoopShopTurn | undefined;
  /** Co-op: the reward or purchase the local player is in the middle of choosing */
  private pendingPick?: { kind: "reward"; cursor: number } | { kind: "buy"; rowCursor: number; cursor: number };
  /** Co-op: whether the phase is replaying the other player's step (so nothing is sent back) */
  private replaying = false;
  /** Co-op: whether this phase has finished or is about to */
  private ended = false;
  /** Co-op simultaneous shop: each seat's own wallet while the shop is open (they are added back together afterwards) */
  private budgets: [number, number] = [0, 0];
  /** Co-op simultaneous shop: the reward choices that have been locked in */
  private readonly locks = new Map<CoopSeat, CoopLockedPick>();
  /** Co-op simultaneous shop: where the local player is */
  private simStage: "picking" | "waiting" | "done" = "picking";
  private simCallback?: ModifierSelectCallback;
  /** Co-op simultaneous shop: how many times the rewards have been rerolled (by either player) */
  private simEpoch = 0;
  /** Co-op simultaneous shop: the reroll count the local player's current choice was made against */
  private pickEpoch = 0;
  /** Co-op simultaneous shop: what the partner bought or took, to tell the local player afterwards */
  private partnerLog: string[] = [];

  constructor(
    rerollCount = 0,
    modifierTiers?: ModifierTier[],
    customModifierSettings?: CustomModifierSettings,
    isCopy = false,
    coopTurn?: CoopShopTurn,
  ) {
    super();

    this.rerollCount = rerollCount;
    this.modifierTiers = modifierTiers;
    this.customModifierSettings = customModifierSettings;
    this.isCopy = isCopy;
    this.coopTurn = coopTurn;
  }

  start() {
    super.start();

    if (!this.isPlayer()) {
      return false;
    }

    if (coopSession.enabled) {
      this.coopTurn ??= {
        seat: (globalScene.currentBattle.waveIndex % 2) as CoopSeat,
        final: false,
        followUpQueued: false,
      };
    }

    if (!this.rerollCount && !this.isCopy) {
      this.updateSeed();
    } else if (this.rerollCount) {
      globalScene.reroll = false;
    }

    const party = globalScene.getPlayerParty();
    if (!this.isCopy) {
      regenerateModifierPoolThresholds(party, this.getPoolType(), this.rerollCount);
    }
    const modifierCount = this.getModifierCount();

    this.typeOptions = this.getModifierTypeOptions(modifierCount);

    const modifierSelectCallback = (rowCursor: number, cursor: number) => {
      if (rowCursor < 0 || cursor < 0) {
        globalScene.ui.showText(i18next.t("battle:skipItemQuestion"), null, () => {
          const skipRewardConfirmOptions: ConfirmModeConfig = {
            yesHandler: () => {
              globalScene.ui.revertMode();
              globalScene.ui.setMode(UiMode.MESSAGE);
              if (this.isSimultaneous()) {
                this.lockLocalPick({ kind: "skip" });
                return;
              }
              this.publishShop({ kind: "skip" });
              this.scheduleCoopFollowUp();
              this.endNow();
            },
            noHandler: () => this.resetModifierSelect(modifierSelectCallback),
          };
          globalScene.ui.setOverlayMode(UiMode.CONFIRM, skipRewardConfirmOptions);
        });
        return false;
      }

      switch (rowCursor) {
        // Execute one of the options from the bottom row
        case 0:
          // A reroll changes the rewards for both players (and costs the one who rolls); locking rarities is off
          if (this.isSimultaneous() && cursor === 0) {
            return this.rerollSimultaneous();
          }
          if (this.isSimultaneous() && cursor === 3) {
            globalScene.ui.playError();
            return false;
          }
          switch (cursor) {
            case 0:
              return this.rerollModifiers();
            case 1:
              return this.openModifierTransferScreen(modifierSelectCallback);
            // Check the party, pass a callback to restore the modifier select screen.
            case 2:
              globalScene.ui.setModeWithoutClear(UiMode.PARTY, PartyUiMode.CHECK, -1, () => {
                this.resetModifierSelect(modifierSelectCallback);
              });
              return true;
            case 3:
              return this.toggleRerollLock();
            default:
              return false;
          }
        // Pick an option from the rewards
        case 1:
          return this.selectRewardModifierOption(cursor, modifierSelectCallback);
        // Pick an option from the shop
        default: {
          return this.selectShopModifierOption(rowCursor, cursor, modifierSelectCallback);
        }
      }
    };

    if (this.isSimultaneous()) {
      this.startSimultaneous(modifierSelectCallback);
      return;
    }

    if (this.isRemoteTurn()) {
      this.followRemoteTurn();
      return;
    }

    this.resetModifierSelect(modifierSelectCallback);
  }

  /** Co-op: whether both players shop at the same time (two clients), instead of taking turns (one shared screen). */
  private isSimultaneous(): boolean {
    return coopSession.enabled && !coopSession.hotseat;
  }

  /** Co-op simultaneous shop: the seat whose reward wins when both players want the same one (alternates by wave). */
  private prioritySeat(): CoopSeat {
    return (globalScene.currentBattle.waveIndex % 2) as CoopSeat;
  }

  private partnerSeat(): CoopSeat {
    return coopSession.localSeat === 0 ? 1 : 0;
  }

  /** Open the shop for the local player with their half of the money, and follow what the partner does in theirs. */
  private startSimultaneous(callback: ModifierSelectCallback): void {
    const total = globalScene.money;
    this.budgets = [Math.ceil(total / 2), Math.floor(total / 2)];
    globalScene.money = this.budgets[coopSession.localSeat];
    globalScene.updateMoneyText();
    this.simCallback = callback;
    const next = () => {
      void coopSession.awaitShopAction().then(action => {
        if (this.ended) {
          return;
        }
        this.onPartnerAction(action);
        if (!this.ended) {
          next();
        }
      });
    };
    next();
    this.resetModifierSelect(callback);
  }

  /** Co-op simultaneous shop: something the partner did in their shop. */
  private onPartnerAction(action: CoopShopAction): void {
    const partner = this.partnerSeat();
    switch (action.kind) {
      case "buy": {
        const option = this.getShopOption(action.rowCursor, action.cursor);
        const modifier = this.buildModifier(option.type, action.target);
        const cost = this.getShopCost(option);
        if (modifier && globalScene.addModifier(modifier, false, false, undefined, undefined, cost)) {
          this.partnerLog.push(`Your partner bought ${option.type.name}.`);
          if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
            this.budgets[partner] -= cost;
          }
        }
        break;
      }
      case "reroll":
        this.onPartnerReroll(action.epoch ?? this.simEpoch + 1);
        break;
      case "transfer":
        this.transferItem(action.from, action.item, action.quantity, action.to);
        break;
      case "reward":
        // a choice made against rewards that have been rerolled since is out of date
        if ((action.epoch ?? 0) === this.simEpoch) {
          this.locks.set(partner, { kind: "reward", cursor: action.cursor, target: action.target });
          this.tryResolve();
        }
        break;
      case "skip":
        if ((action.epoch ?? 0) === this.simEpoch) {
          this.locks.set(partner, { kind: "skip" });
          this.tryResolve();
        }
        break;
    }
  }

  /** Co-op simultaneous shop: the local player has made their reward choice. Tell the partner and wait for theirs. */
  private lockLocalPick(
    pick: { kind: "reward"; cursor: number; target?: CoopPickTarget | undefined } | { kind: "skip" },
  ): void {
    if (pick.kind === "reward" && this.pickEpoch !== this.simEpoch) {
      // the rewards were rerolled while the party menu was open
      this.pickAgain("The rewards were rerolled! Pick again.");
      return;
    }
    this.locks.set(coopSession.localSeat, pick);
    this.simStage = "waiting";
    coopSession.sendShop?.(
      pick.kind === "skip"
        ? { kind: "skip", epoch: this.simEpoch }
        : { kind: "reward", cursor: pick.cursor, target: pick.target, epoch: this.simEpoch },
    );
    if (this.locks.has(this.partnerSeat())) {
      this.tryResolve();
      return;
    }
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => {
      if (this.simStage === "waiting" && !this.ended) {
        globalScene.ui.showText("Waiting for your partner...", 0);
      }
    });
  }

  /**
   * Co-op simultaneous shop: once both players have locked in, hand the rewards out in the same order on both clients.
   * If both wanted the same reward, the priority seat gets it and the other player picks again from what is left.
   */
  private tryResolve(): void {
    if (this.ended || this.simStage === "done") {
      return;
    }
    const first = this.prioritySeat();
    const second: CoopSeat = first === 0 ? 1 : 0;
    const a = this.locks.get(first);
    const b = this.locks.get(second);
    if (!a || !b) {
      return;
    }
    if (a.kind === "reward" && b.kind === "reward" && a.cursor === b.cursor) {
      this.handOut(first, a);
      this.typeOptions.splice(a.cursor, 1);
      this.locks.set(first, { kind: "done" });
      this.locks.delete(second);
      if (this.typeOptions.length === 0) {
        this.locks.set(second, { kind: "skip" });
        this.tryResolve();
      } else if (second === coopSession.localSeat) {
        this.simStage = "picking";
        globalScene.ui.showText(
          "Your partner got that one first. Pick another reward!",
          null,
          () => {
            this.resetModifierSelect(this.simCallback!);
          },
          1500,
        );
      }
      return;
    }
    this.handOut(first, a);
    this.handOut(second, b);
    this.finishSimultaneous();
  }

  /** Give a locked-in reward to its player's Pokemon. */
  private handOut(seat: CoopSeat, pick: CoopLockedPick): void {
    if (pick.kind !== "reward") {
      return;
    }
    const type = this.typeOptions[pick.cursor]?.type;
    const modifier = type ? this.buildModifier(type, pick.target) : null;
    if (modifier) {
      globalScene.addModifier(modifier, false, true);
      if (seat !== coopSession.localSeat) {
        this.partnerLog.push(`Your partner took ${type!.name}.`);
      }
    }
  }

  /** Reopen the shop for the local player after their choice fell through, with a message why. */
  private pickAgain(message: string): void {
    this.simStage = "picking";
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => {
      globalScene.ui.showText(
        message,
        null,
        () => {
          if (!this.ended && this.simStage === "picking") {
            this.resetModifierSelect(this.simCallback!);
          }
        },
        1500,
      );
    });
  }

  /** Co-op simultaneous shop: the local player pays to reroll the rewards for both players. */
  private rerollSimultaneous(): boolean {
    const cost = this.getRerollCost(false);
    const waived = activeOverrides.WAIVE_ROLL_FEE_OVERRIDE;
    if (cost < 0 || (globalScene.money < cost && !waived)) {
      globalScene.ui.playError();
      return false;
    }
    const epoch = this.simEpoch + 1;
    coopSession.sendShop?.({ kind: "reroll", epoch });
    this.regenerateOptions(epoch);
    if (!waived) {
      this.budgets[coopSession.localSeat] -= cost;
      globalScene.money = this.budgets[coopSession.localSeat];
      globalScene.updateMoneyText();
      globalScene.animateMoneyChanged(false);
    }
    audioManager.playSound("se/buy");
    this.pickAgain("The rewards were rerolled!");
    return false;
  }

  /** Co-op simultaneous shop: the partner paid to reroll. */
  private onPartnerReroll(epoch: number): void {
    // The partner's wallet pays what a reroll cost at the point they rolled
    const cost = this.getRerollCost(false, epoch - 1);
    if (cost > 0 && !activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      this.budgets[this.partnerSeat()] -= cost;
    }
    if (epoch <= this.simEpoch) {
      // both players rolled at once: the rewards were already rerolled here
      return;
    }
    this.regenerateOptions(epoch);
    // anything chosen against the old rewards is out of date
    if (this.simStage === "waiting" && this.locks.get(coopSession.localSeat)?.kind !== "done") {
      this.locks.delete(coopSession.localSeat);
      this.pickAgain("Your partner rerolled the rewards! Pick again.");
    }
  }

  /** Roll a new set of rewards the same way on both clients, whatever else has happened in the shop so far. */
  private regenerateOptions(epoch: number): void {
    this.simEpoch = epoch;
    for (const [seat, lock] of [...this.locks]) {
      if (lock.kind !== "done") {
        this.locks.delete(seat);
      }
    }
    const party = globalScene.getPlayerParty();
    globalScene.executeWithSeedOffset(
      () => {
        regenerateModifierPoolThresholds(party, this.getPoolType(), epoch);
        this.typeOptions = getPlayerModifierTypeOptions(this.getModifierCount(true), party);
      },
      globalScene.currentBattle.waveIndex + epoch * 1000,
    );
  }

  private finishSimultaneous(): void {
    this.simStage = "done";
    coopSession.cancelShopWait();
    globalScene.money = this.budgets[0] + this.budgets[1];
    globalScene.updateMoneyText();
    globalScene.ui.clearText();
    globalScene.ui.setMode(UiMode.MESSAGE);
    for (const line of this.partnerLog) {
      globalScene.phaseManager.queueMessage(line, undefined, true);
    }
    this.endNow();
  }

  /** Co-op simultaneous shop: the local player buys something from the shop with their own money. */
  private purchaseSimultaneous(modifier: Modifier, cost: number, target?: CoopPickTarget): void {
    const pick = this.pendingPick;
    const result = globalScene.addModifier(modifier, false, false, undefined, undefined, cost);
    if (!result || pick?.kind !== "buy") {
      globalScene.ui.playError();
      return;
    }
    if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      this.budgets[coopSession.localSeat] -= cost;
      globalScene.money = this.budgets[coopSession.localSeat];
      globalScene.updateMoneyText();
      globalScene.animateMoneyChanged(false);
    }
    audioManager.playSound("se/buy");
    coopSession.sendShop?.({ kind: "buy", rowCursor: pick.rowCursor, cursor: pick.cursor, target });
    (globalScene.ui.getHandler() as ModifierSelectUiHandler).updateCostText();
  }

  /** In the simultaneous shop, only a player's own Pokemon can be picked. */
  private ownTeamFilter(base?: PokemonSelectFilter): PokemonSelectFilter | undefined {
    if (!this.isSimultaneous()) {
      return base;
    }
    return pokemon => {
      if (pokemon.owner !== coopSession.localSeat) {
        return "Only your own team!";
      }
      return base ? base(pokemon) : null;
    };
  }

  /** Build the modifier a reward or purchase gives, for the Pokemon chosen in `target` if it needs one. */
  private buildModifier(modifierType: ModifierType, target?: CoopPickTarget): Modifier | null {
    if (!(modifierType instanceof PokemonModifierType)) {
      return modifierType.newModifier();
    }
    const party = globalScene.getPlayerParty();
    if (target === undefined) {
      return null;
    }
    if (modifierType instanceof FusePokemonModifierType) {
      return modifierType.newModifier(party[target.slot], party[target.splice ?? -1]);
    }
    if (modifierType instanceof PokemonMoveModifierType) {
      return modifierType.newModifier(party[target.slot], (target.option ?? 0) - PartyOption.MOVE_1);
    }
    if (modifierType instanceof RememberMoveModifierType) {
      return modifierType.newModifier(party[target.slot], target.option ?? 0);
    }
    return modifierType.newModifier(party[target.slot]);
  }

  /** Co-op: whether the player whose turn it is sits at the other client. */
  private isRemoteTurn(): boolean {
    return coopSession.enabled && this.coopTurn != null && !coopSession.controls(this.coopTurn.seat);
  }

  /** Co-op: send a step of the local player's turn to the other client. */
  private publishShop(action: CoopShopAction): void {
    if (coopSession.enabled && !coopSession.hotseat && !this.replaying) {
      coopSession.sendShop?.(action);
    }
  }

  /** Co-op: show that the other player is choosing and replay each of their steps until their turn is over. */
  private followRemoteTurn(): void {
    globalScene.ui.setMode(UiMode.MESSAGE);
    globalScene.ui.showText("Your partner is choosing rewards...", 0);
    const next = () => {
      void coopSession.awaitShopAction().then(action => {
        this.replay(action);
        if (!this.ended) {
          next();
        }
      });
    };
    next();
  }

  /** Co-op: carry out a step the other player took. */
  private replay(action: CoopShopAction): void {
    this.replaying = true;
    try {
      switch (action.kind) {
        case "reward": {
          const type = this.typeOptions[action.cursor]?.type;
          if (type) {
            this.pendingPick = { kind: "reward", cursor: action.cursor };
            this.applyPick(type, -1, action.target);
          }
          break;
        }
        case "buy": {
          const option = this.getShopOption(action.rowCursor, action.cursor);
          this.pendingPick = { kind: "buy", rowCursor: action.rowCursor, cursor: action.cursor };
          this.applyPick(option.type, this.getShopCost(option), action.target);
          break;
        }
        case "reroll":
          this.rerollModifiers();
          break;
        case "lock":
          globalScene.lockModifierTiers = !globalScene.lockModifierTiers;
          break;
        case "transfer":
          this.transferItem(action.from, action.item, action.quantity, action.to);
          break;
        case "skip":
          this.scheduleCoopFollowUp();
          this.endNow();
          break;
      }
    } finally {
      this.replaying = false;
    }
  }

  /** Apply a reward or purchase the other player chose, on the Pokemon they chose it for. */
  private applyPick(modifierType: ModifierType, cost: number, target?: CoopPickTarget): void {
    if (!(modifierType instanceof PokemonModifierType)) {
      this.applyModifier(modifierType.newModifier()!, cost);
      return;
    }
    const modifier = this.buildModifier(modifierType, target);
    if (modifier) {
      this.applyModifier(modifier, cost, true, target);
    }
  }

  /** Co-op: after the first player's pick, let the other player pick from what is left. */
  private scheduleCoopFollowUp(): void {
    const turn = this.coopTurn;
    if (!coopSession.enabled || !turn || turn.final || turn.followUpQueued) {
      return;
    }
    turn.followUpQueued = true;
    const picked = this.pendingPick?.kind === "reward" ? this.pendingPick.cursor : -1;
    const remaining = this.typeOptions.filter((_, i) => i !== picked);
    if (remaining.length === 0) {
      return;
    }
    globalScene.phaseManager.unshiftNew(
      "SelectModifierPhase",
      0,
      undefined,
      // The second pick cannot reroll: it is a pick from what the first player left
      { guaranteedModifierTypeOptions: remaining, rerollMultiplier: -1, allowLuckUpgrades: false },
      true,
      { seat: turn.seat === 0 ? 1 : 0, final: true, followUpQueued: true },
    );
  }

  /** End the phase (and remember that it has ended). */
  private endNow(): void {
    this.ended = true;
    super.end();
  }

  // Pick a modifier from among the rewards and apply it
  private selectRewardModifierOption(cursor: number, modifierSelectCallback: ModifierSelectCallback): boolean {
    if (this.typeOptions.length === 0) {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.MESSAGE);
      this.endNow();
      return true;
    }
    const modifierType = this.typeOptions[cursor].type;
    this.pendingPick = { kind: "reward", cursor };
    this.pickEpoch = this.simEpoch;
    return this.applyChosenModifier(modifierType, -1, modifierSelectCallback);
  }

  // Pick a modifier from the shop and apply it
  private selectShopModifierOption(
    rowCursor: number,
    cursor: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): boolean {
    const shopOption = this.getShopOption(rowCursor, cursor);
    const modifierType = shopOption.type;
    const cost = this.getShopCost(shopOption);

    if (globalScene.money < cost && !activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      globalScene.ui.playError();
      return false;
    }

    this.pendingPick = { kind: "buy", rowCursor, cursor };
    return this.applyChosenModifier(modifierType, cost, modifierSelectCallback);
  }

  private getShopOption(rowCursor: number, cursor: number): ModifierTypeOption {
    const shopOptions = getPlayerShopModifierTypeOptionsForWave(
      globalScene.currentBattle.waveIndex,
      globalScene.getWaveMoneyAmount(1),
    );
    return shopOptions[
      rowCursor > 2 || shopOptions.length <= SHOP_OPTIONS_ROW_LIMIT ? cursor : cursor + SHOP_OPTIONS_ROW_LIMIT
    ];
  }

  /** The price of a shop option, with Black Sludge applied to healing items */
  private getShopCost(shopOption: ModifierTypeOption): number {
    const healingItemCost = new NumberHolder(shopOption.cost);
    globalScene.applyModifier(HealShopCostModifier, true, healingItemCost);
    return healingItemCost.value;
  }

  // Apply a chosen modifier: do an effect or open the party menu
  private applyChosenModifier(
    modifierType: ModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): boolean {
    if (modifierType instanceof PokemonModifierType) {
      if (modifierType instanceof FusePokemonModifierType) {
        this.openFusionMenu(modifierType, cost, modifierSelectCallback);
      } else {
        this.openModifierMenu(modifierType, cost, modifierSelectCallback);
      }
    } else {
      this.applyModifier(modifierType.newModifier()!, cost);
    }
    return cost === -1;
  }

  // Reroll rewards
  private rerollModifiers() {
    const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
    if (rerollCost < 0 || globalScene.money < rerollCost) {
      globalScene.ui.playError();
      return false;
    }
    this.publishShop({ kind: "reroll" });
    globalScene.reroll = true;
    globalScene.phaseManager.unshiftNew(
      "SelectModifierPhase",
      this.rerollCount + 1,
      this.typeOptions.map(o => o.type?.tier).filter(t => t !== undefined) as ModifierTier[],
      undefined,
      false,
      this.coopTurn,
    );
    this.ended = true;
    globalScene.ui.clearText();
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
    if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      globalScene.money -= rerollCost;
      globalScene.updateMoneyText();
      globalScene.animateMoneyChanged(false);
    }
    audioManager.playSound("se/buy");
    return true;
  }

  // Transfer modifiers among party pokemon
  private openModifierTransferScreen(modifierSelectCallback: ModifierSelectCallback) {
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      PartyUiMode.MODIFIER_TRANSFER,
      -1,
      (fromSlotIndex: number, itemIndex: number, itemQuantity: number, toSlotIndex: number) => {
        if (
          toSlotIndex !== undefined
          && fromSlotIndex < 6
          && toSlotIndex < 6
          && fromSlotIndex !== toSlotIndex
          && itemIndex > -1
          && (!this.isSimultaneous()
            || (globalScene.getPlayerParty()[fromSlotIndex].owner === coopSession.localSeat
              && globalScene.getPlayerParty()[toSlotIndex].owner === coopSession.localSeat))
        ) {
          this.publishShop({
            kind: "transfer",
            from: fromSlotIndex,
            item: itemIndex,
            quantity: itemQuantity,
            to: toSlotIndex,
          });
          this.transferItem(fromSlotIndex, itemIndex, itemQuantity, toSlotIndex);
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      PartyUiHandler.FilterItemMaxStacks,
    );
    return true;
  }

  /** Move held items from one party member to another */
  private transferItem(fromSlotIndex: number, itemIndex: number, itemQuantity: number, toSlotIndex: number): void {
    const party = globalScene.getPlayerParty();
    const itemModifiers = globalScene.findModifiers(
      m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === party[fromSlotIndex].id,
    ) as PokemonHeldItemModifier[];
    const itemModifier = itemModifiers[itemIndex];
    globalScene.tryTransferHeldItemModifier(
      itemModifier,
      party[toSlotIndex],
      true,
      itemQuantity,
      undefined,
      undefined,
      false,
    );
  }

  // Toggle reroll lock
  private toggleRerollLock() {
    const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
    if (rerollCost < 0) {
      // Reroll lock button is also disabled when reroll is disabled
      globalScene.ui.playError();
      return false;
    }
    this.publishShop({ kind: "lock" });
    globalScene.lockModifierTiers = !globalScene.lockModifierTiers;
    const uiHandler = globalScene.ui.getHandler() as ModifierSelectUiHandler;
    uiHandler.setRerollCost(this.getRerollCost(globalScene.lockModifierTiers));
    uiHandler.updateLockRaritiesText();
    uiHandler.updateRerollCostText();
    return false;
  }

  /**
   * Apply the effects of the chosen modifier
   * @param modifier - The modifier to apply
   * @param cost - The cost of the modifier if it was purchased, or -1 if selected as the modifier reward
   * @param playSound - Whether the 'obtain modifier' sound should be played when adding the modifier.
   */
  private applyModifier(modifier: Modifier, cost = -1, playSound = false, target?: CoopPickTarget): void {
    if (this.isSimultaneous()) {
      if (cost === -1) {
        this.lockLocalPick({
          kind: "reward",
          cursor: this.pendingPick?.kind === "reward" ? this.pendingPick.cursor : -1,
          target,
        });
      } else {
        this.purchaseSimultaneous(modifier, cost, target);
      }
      return;
    }
    if (this.pendingPick) {
      this.publishShop({ ...this.pendingPick, target });
    }
    const ends = cost === -1 || modifier.type instanceof RememberMoveModifierType;
    if (ends) {
      this.scheduleCoopFollowUp();
    }
    const result = globalScene.addModifier(modifier, false, playSound, undefined, undefined, cost);
    // Queue a copy of this phase when applying a TM or Memory Mushroom.
    // If the player selects either of these, then escapes out of consuming them,
    // they are returned to a shop in the same state.
    if (modifier.type instanceof RememberMoveModifierType || modifier.type instanceof TmModifierType) {
      globalScene.phaseManager.unshiftPhase(this.copy());
    }

    if (cost !== -1 && !(modifier.type instanceof RememberMoveModifierType)) {
      if (result) {
        if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
          globalScene.money -= cost;
          globalScene.updateMoneyText();
          globalScene.animateMoneyChanged(false);
        }
        audioManager.playSound("se/buy");
        if (!this.replaying) {
          (globalScene.ui.getHandler() as ModifierSelectUiHandler).updateCostText();
        }
      } else {
        globalScene.ui.playError();
      }
    } else {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.MESSAGE);
      this.endNow();
    }
  }

  // Opens the party menu specifically for fusions
  private openFusionMenu(
    modifierType: PokemonModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): void {
    const party = globalScene.getPlayerParty();
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      PartyUiMode.SPLICE,
      -1,
      (fromSlotIndex: number, spliceSlotIndex: number) => {
        if (
          spliceSlotIndex !== undefined
          && fromSlotIndex < 6
          && spliceSlotIndex < 6
          && fromSlotIndex !== spliceSlotIndex
        ) {
          globalScene.ui.setMode(UiMode.MODIFIER_SELECT, this.isPlayer()).then(() => {
            const modifier = modifierType.newModifier(party[fromSlotIndex], party[spliceSlotIndex])!; //TODO: is the bang correct?
            this.applyModifier(modifier, cost, true, { slot: fromSlotIndex, splice: spliceSlotIndex });
          });
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      this.ownTeamFilter(modifierType.selectFilter),
    );
  }

  // Opens the party menu to apply one of various modifiers
  private openModifierMenu(
    modifierType: PokemonModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): void {
    const party = globalScene.getPlayerParty();
    const pokemonModifierType = modifierType as PokemonModifierType;
    const isMoveModifier = modifierType instanceof PokemonMoveModifierType;
    const isTmModifier = modifierType instanceof TmModifierType;
    const isRememberMoveModifier = modifierType instanceof RememberMoveModifierType;
    const isPpRestoreModifier =
      modifierType instanceof PokemonPpRestoreModifierType || modifierType instanceof PokemonPpUpModifierType;
    const partyUiMode = isMoveModifier
      ? PartyUiMode.MOVE_MODIFIER
      : isTmModifier
        ? PartyUiMode.TM_MODIFIER
        : isRememberMoveModifier
          ? PartyUiMode.REMEMBER_MOVE_MODIFIER
          : PartyUiMode.MODIFIER;
    const tmMoveId = isTmModifier ? (modifierType as TmModifierType).moveId : undefined;
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      partyUiMode,
      -1,
      (slotIndex: number, option: PartyOption) => {
        if (slotIndex < 6) {
          globalScene.ui.setMode(UiMode.MODIFIER_SELECT, this.isPlayer()).then(() => {
            const modifier = isMoveModifier
              ? modifierType.newModifier(party[slotIndex], option - PartyOption.MOVE_1)
              : isRememberMoveModifier
                ? modifierType.newModifier(party[slotIndex], option as number)
                : modifierType.newModifier(party[slotIndex]);
            this.applyModifier(modifier!, cost, true, {
              slot: slotIndex,
              option: isMoveModifier || isRememberMoveModifier ? (option as number) : undefined,
            }); // TODO: is the bang correct?
          });
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      this.ownTeamFilter(pokemonModifierType.selectFilter),
      modifierType instanceof PokemonMoveModifierType
        ? (modifierType as PokemonMoveModifierType).moveSelectFilter
        : undefined,
      tmMoveId,
      isPpRestoreModifier,
    );
  }

  // Function that determines how many reward slots are available
  private getModifierCount(ignoreCustom = false): number {
    const modifierCountHolder = new NumberHolder(3);
    globalScene.applyModifiers(ExtraModifierModifier, true, modifierCountHolder);
    globalScene.applyModifiers(TempExtraModifierModifier, true, modifierCountHolder);

    // If custom modifiers are specified, overrides default item count
    if (this.customModifierSettings && !ignoreCustom) {
      const newItemCount =
        (this.customModifierSettings.guaranteedModifierTiers?.length ?? 0)
        + (this.customModifierSettings.guaranteedModifierTypeOptions?.length ?? 0)
        + (this.customModifierSettings.guaranteedModifierTypeFuncs?.length ?? 0);
      if (this.customModifierSettings.fillRemaining) {
        const originalCount = modifierCountHolder.value;
        modifierCountHolder.value = originalCount > newItemCount ? originalCount : newItemCount;
      } else {
        modifierCountHolder.value = newItemCount;
      }
    }

    return modifierCountHolder.value;
  }

  // Function that resets the reward selection screen,
  // e.g. after pressing cancel in the party ui or while learning a move
  private resetModifierSelect(modifierSelectCallback: ModifierSelectCallback) {
    globalScene.ui.setMode(
      UiMode.MODIFIER_SELECT,
      this.isPlayer(),
      this.typeOptions,
      modifierSelectCallback,
      this.getRerollCost(globalScene.lockModifierTiers),
    );
  }

  updateSeed(): void {
    globalScene.resetSeed();
  }

  isPlayer(): boolean {
    return true;
  }

  getRerollCost(lockRarities: boolean, epoch = this.simEpoch): number {
    let baseValue = 0;
    if (activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      return baseValue;
    }
    if (lockRarities) {
      const tierValues = [50, 125, 300, 750, 2000];
      for (const opt of this.typeOptions) {
        baseValue += tierValues[opt.type.tier ?? 0];
      }
    } else {
      baseValue = 250;
    }

    let multiplier = 1;
    if (this.customModifierSettings?.rerollMultiplier != null) {
      if (this.customModifierSettings.rerollMultiplier < 0) {
        // Completely overrides reroll cost to -1 and early exits
        return -1;
      }

      // Otherwise, continue with custom multiplier
      multiplier = this.customModifierSettings.rerollMultiplier;
    }

    const baseMultiplier = Math.min(
      Math.ceil(globalScene.currentBattle.waveIndex / 10) * baseValue * 2 ** (this.rerollCount + epoch) * multiplier,
      Number.MAX_SAFE_INTEGER,
    );

    // Apply Black Sludge to reroll cost
    const modifiedRerollCost = new NumberHolder(baseMultiplier);
    globalScene.applyModifier(HealShopCostModifier, true, modifiedRerollCost);
    return modifiedRerollCost.value;
  }

  getPoolType(): ModifierPoolType {
    return ModifierPoolType.PLAYER;
  }

  getModifierTypeOptions(modifierCount: number): ModifierTypeOption[] {
    return getPlayerModifierTypeOptions(
      modifierCount,
      globalScene.getPlayerParty(),
      globalScene.lockModifierTiers ? this.modifierTiers : undefined,
      this.customModifierSettings,
    );
  }

  copy(): SelectModifierPhase {
    return globalScene.phaseManager.create(
      "SelectModifierPhase",
      this.rerollCount,
      this.modifierTiers,
      {
        guaranteedModifierTypeOptions: this.typeOptions,
        rerollMultiplier: this.customModifierSettings?.rerollMultiplier,
        allowLuckUpgrades: false,
      },
      true,
      this.coopTurn,
    );
  }

  addModifier(modifier: Modifier): boolean {
    return globalScene.addModifier(modifier, false, true);
  }
}
