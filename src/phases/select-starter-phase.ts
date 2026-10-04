import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import { Phase } from "#app/phase";
import { SpeciesFormChangeMoveLearnedTrigger } from "#data/form-change-triggers";
import { Gender } from "#data/gender";
import { ChallengeType } from "#enums/challenge-type";
import { UiMode } from "#enums/ui-mode";
import { overrideHeldItems, overrideModifiers } from "#modifiers/modifier";
import { type CoopStarter, coopNetwork } from "#system/coop-network";
import { type CoopSeat, coopSession } from "#system/coop-session";
import type { Starter } from "#types/save-data";
import { SaveSlotUiMode } from "#ui/save-slot-select-ui-handler";
import { applyChallenges } from "#utils/challenge-utils";

export class SelectStarterPhase extends Phase {
  public readonly phaseName = "SelectStarterPhase";
  start() {
    super.start();

    audioManager.playBgm("menu");

    globalScene.ui.setMode(UiMode.STARTER_SELECT, (starters: Starter[]) => {
      globalScene.ui.clearText();
      if (coopSession.enabled && coopNetwork.connected) {
        this.startCoopRun(starters);
        return;
      }
      globalScene.ui.setMode(UiMode.SAVE_SLOT, SaveSlotUiMode.SAVE, (slotId: number) => {
        // If clicking cancel, back out to title screen
        if (slotId === -1) {
          globalScene.phaseManager.toTitleScreen();
          this.end();
          return;
        }
        globalScene.sessionSlotId = slotId;
        this.initBattle(starters);
      });
    });
  }

  /**
   * Co-op: swap teams with the partner, then start the run with both teams and a shared seed.
   * Co-op runs are never saved, so the save slot screen is skipped.
   */
  private startCoopRun(starters: Starter[]): void {
    const mine: CoopStarter[] = starters.map(starter => ({
      ...starter,
      luck: globalScene.gameData.getDexAttrLuck(globalScene.gameData.dexData[starter.speciesId].caughtAttr),
    }));
    globalScene.ui.setMode(UiMode.MESSAGE);
    globalScene.ui.showText("Waiting for your partner to pick their team...", 0);
    coopNetwork.exchangeStarters(mine).then(setup => {
      globalScene.ui.clearText();
      // Both games roll the same dice from here on
      globalScene.setSeed(setup.seed);
      globalScene.resetSeed();
      this.initBattle(setup.starters, {
        owners: setup.owners,
        lucks: setup.starters.map(s => s.luck),
      });
    });
  }

  /**
   * Initialize starters before starting the first battle
   * @param starters - Array of {@linkcode Starter}s with which to start the battle
   * @param coop - In co-op, who owns each starter and how lucky it is (luck comes from its owner's save)
   */
  initBattle(starters: Starter[], coop?: { owners: CoopSeat[]; lucks: number[] }) {
    const party = globalScene.getPlayerParty();
    const loadPokemonAssets: Promise<void>[] = [];
    starters.forEach((starter: Starter, i: number) => {
      if (!i && activeOverrides.STARTER_SPECIES_OVERRIDE) {
        starter.speciesId = activeOverrides.STARTER_SPECIES_OVERRIDE;
      }
      const species = speciesDataRegistry.getSpecies(starter.speciesId);
      let starterFormIndex = starter.formIndex;
      if (
        starter.speciesId in activeOverrides.STARTER_FORM_OVERRIDES
        && activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId] != null
        && species.forms[activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId]!]
      ) {
        starterFormIndex = activeOverrides.STARTER_FORM_OVERRIDES[starter.speciesId]!;
      }

      let starterGender =
        species.malePercent === null ? Gender.GENDERLESS : starter.female ? Gender.FEMALE : Gender.MALE;
      if (activeOverrides.GENDER_OVERRIDE !== null) {
        starterGender = activeOverrides.GENDER_OVERRIDE;
      }
      const starterPokemon = globalScene.addPlayerPokemon(
        species,
        globalScene.gameMode.getStartingLevel(),
        starter.abilityIndex,
        starterFormIndex,
        starterGender,
        starter.shiny,
        starter.variant,
        starter.ivs,
        starter.nature,
      );
      if (starter.moveset) {
        starterPokemon.tryPopulateMoveset(starter.moveset);
      }
      if (starter.passive) {
        starterPokemon.passive = true;
      }
      starterPokemon.luck =
        coop?.lucks[i]
        ?? globalScene.gameData.getDexAttrLuck(globalScene.gameData.dexData[species.speciesId].caughtAttr);
      if (coop) {
        starterPokemon.owner = coop.owners[i];
      }
      if (starter.pokerus) {
        starterPokemon.pokerus = true;
      }

      if (starter.nickname) {
        starterPokemon.nickname = starter.nickname;
      }

      if (starter.teraType == null) {
        starterPokemon.teraType = starterPokemon.species.type1;
      } else {
        starterPokemon.teraType = starter.teraType;
      }

      if (globalScene.gameMode.isSplicedOnly || activeOverrides.STARTER_FUSION_OVERRIDE) {
        starterPokemon.generateFusionSpecies(true);
      }
      starterPokemon.setVisible(false);
      const chalApplied = applyChallenges(ChallengeType.STARTER_MODIFY, starterPokemon);
      party.push(starterPokemon);
      if (chalApplied) {
        // If any challenges modified the starter, it should update
        loadPokemonAssets.push(starterPokemon.updateInfo());
      }
      loadPokemonAssets.push(starterPokemon.loadAssets());
    });
    overrideModifiers();
    overrideHeldItems(party[0]);
    Promise.all(loadPokemonAssets).then(() => {
      audioManager.playBgm(undefined, true);
      if (globalScene.gameMode.isClassic) {
        globalScene.gameData.gameStats.classicSessionsPlayed++;
      } else {
        globalScene.gameData.gameStats.endlessSessionsPlayed++;
      }
      globalScene.newBattle();
      globalScene.arena.init();
      globalScene.sessionPlayTime = 0;
      globalScene.lastSavePlayTime = 0;
      // Ensures Keldeo (or any future Pokemon that have this type of form change) starts in the correct form
      globalScene.getPlayerParty().forEach(p => {
        globalScene.triggerPokemonFormChange(p, SpeciesFormChangeMoveLearnedTrigger);
      });
      this.end();
    });
  }
}
