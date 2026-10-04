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
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";
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

    if (this.isRemoteTurn()) {
      this.followRemoteTurn();
      return;
    }

    this.resetModifierSelect(modifierSelectCallback);
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
    const party = globalScene.getPlayerParty();
    if (target === undefined) {
      return;
    }
    let modifier: Modifier | null;
    if (modifierType instanceof FusePokemonModifierType) {
      modifier = modifierType.newModifier(party[target.slot], party[target.splice ?? -1]);
    } else if (modifierType instanceof PokemonMoveModifierType) {
      modifier = modifierType.newModifier(party[target.slot], (target.option ?? 0) - PartyOption.MOVE_1);
    } else if (modifierType instanceof RememberMoveModifierType) {
      modifier = modifierType.newModifier(party[target.slot], target.option ?? 0);
    } else {
      modifier = modifierType.newModifier(party[target.slot]);
    }
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
      modifierType.selectFilter,
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
      pokemonModifierType.selectFilter,
      modifierType instanceof PokemonMoveModifierType
        ? (modifierType as PokemonMoveModifierType).moveSelectFilter
        : undefined,
      tmMoveId,
      isPpRestoreModifier,
    );
  }

  // Function that determines how many reward slots are available
  private getModifierCount(): number {
    const modifierCountHolder = new NumberHolder(3);
    globalScene.applyModifiers(ExtraModifierModifier, true, modifierCountHolder);
    globalScene.applyModifiers(TempExtraModifierModifier, true, modifierCountHolder);

    // If custom modifiers are specified, overrides default item count
    if (this.customModifierSettings) {
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

  getRerollCost(lockRarities: boolean): number {
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
      Math.ceil(globalScene.currentBattle.waveIndex / 10) * baseValue * 2 ** this.rerollCount * multiplier,
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
