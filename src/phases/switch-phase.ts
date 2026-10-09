import { globalScene } from "#app/global-scene";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { BattlePhase } from "#phases/battle-phase";
import { coopSession, sameSeat } from "#system/coop-session";
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";

/**
 * Opens the party selector UI and transitions into a {@linkcode SwitchSummonPhase}
 * for the player (if a switch would be valid for the current battle state).
 */
export class SwitchPhase extends BattlePhase {
  public readonly phaseName = "SwitchPhase";
  protected readonly fieldIndex: number;
  private readonly switchType: SwitchType;
  private readonly isModal: boolean;
  private readonly doReturn: boolean;

  /**
   * Creates a new SwitchPhase
   * @param switchType {@linkcode SwitchType} The type of switch logic this phase implements
   * @param fieldIndex Field index to switch out
   * @param isModal Indicates if the switch should be forced (true) or is
   * optional (false).
   * @param doReturn Indicates if the party member on the field should be
   * recalled to ball or has already left the field. Passed to {@linkcode SwitchSummonPhase},
   * and is (ostensibly) only set to `false` from `FaintPhase`.
   */
  constructor(switchType: SwitchType, fieldIndex: number, isModal: boolean, doReturn: boolean) {
    super();

    this.switchType = switchType;
    this.fieldIndex = fieldIndex;
    this.isModal = isModal;
    this.doReturn = doReturn;
  }

  start() {
    super.start();

    /** The Pokemon currently holding (or just vacated) the slot being refilled */
    const slotPokemon = globalScene.getPlayerParty()[this.fieldIndex];
    /** In co-op, only the team that owns the slot may refill it */
    const owner = coopSession.enabled ? slotPokemon?.owner : undefined;

    // Skip modal switch if impossible (no remaining party members that aren't already in battle)
    if (this.isModal && globalScene.getPokemonAllowedInBattle(owner).every(p => p.isOnField())) {
      return super.end();
    }

    /**
     * Skip if the fainted party member has been revived already. doReturn is
     * only passed as `false` from FaintPhase (as opposed to other usages such
     * as ForceSwitchOutAttr or CheckSwitchPhase), so we only want to check this
     * if the mon should have already been returned but is still alive and well
     * on the field. see also; battle.test.ts
     */
    // TODO: If a Phasing move kills its own user, when does said user appear on field?
    // Is it after the user faints
    if (this.isModal && !this.doReturn && !globalScene.getPlayerParty()[this.fieldIndex].isFainted()) {
      return super.end();
    }

    // Check if there is any space still in field
    if (this.isModal && globalScene.getPlayerField(true).length > globalScene.currentBattle.getBattlerCount()) {
      return super.end();
    }

    // Override field index to 0 in case of double battle where 2/3 remaining legal party members fainted at once
    // (co-op slots belong to teams, so the slot is never overridden there)
    const fieldIndex =
      coopSession.enabled
      || globalScene.currentBattle.getBattlerCount() === 1
      || globalScene.getPokemonAllowedInBattle().length > 1
        ? this.fieldIndex
        : 0;

    /** Bring the chosen party member in (only from the team that owns the slot) */
    const applySwitch = (slotIndex: number, option?: PartyOption) => {
      const incoming = globalScene.getPlayerParty()[slotIndex];
      const ownTeam =
        !coopSession.enabled || (incoming != null && slotPokemon != null && sameSeat(incoming, slotPokemon));
      if (slotIndex >= globalScene.currentBattle.getBattlerCount() && slotIndex < 6 && ownTeam) {
        const switchType = option === PartyOption.PASS_BATON ? SwitchType.BATON_PASS : this.switchType;
        globalScene.phaseManager.unshiftNew("SwitchSummonPhase", switchType, fieldIndex, slotIndex, this.doReturn);
      }
    };

    // Co-op: only the player who owns the fainted Pokemon picks the replacement; the other screen waits for the answer
    if (
      coopSession.enabled
      && !coopSession.hotseat
      && slotPokemon != null
      && !coopSession.controls(slotPokemon.owner)
    ) {
      globalScene.ui.showText("Your partner is choosing their next Pokémon...", 0);
      coopSession.awaitChoice().then(({ slot }) => {
        applySwitch(slot);
        globalScene.ui.clearText();
        globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
      });
      return;
    }

    globalScene.ui.setMode(
      UiMode.PARTY,
      this.isModal ? PartyUiMode.FAINT_SWITCH : PartyUiMode.POST_BATTLE_SWITCH,
      fieldIndex,
      (slotIndex: number, option: PartyOption) => {
        if (coopSession.enabled && !coopSession.hotseat) {
          coopSession.sendChoice?.({ slot: slotIndex });
        }
        applySwitch(slotIndex, option);
        globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
      },
      PartyUiHandler.FilterNonFainted,
    );
  }
}
