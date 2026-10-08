import { pokerogueApi } from "#api/api";
import { loggedInUser } from "#app/account";
import { GameMode, getGameMode } from "#app/game-mode";
import { audioManager } from "#app/global-audio-manager";
import { timedEventManager } from "#app/global-event-manager";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import { Phase } from "#app/phase";
import { bypassLogin } from "#constants/app-constants";
import { getDailyRunStarters, startDailyEventChallenges } from "#data/daily-run";
import { modifierTypes } from "#data/data-lists";
import { Gender } from "#data/gender";
import { BattleType } from "#enums/battle-type";
import { GameDataType } from "#enums/game-data-type";
import { GameModes } from "#enums/game-modes";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import { getBiomeKey } from "#field/arena";
import type { Modifier } from "#modifiers/modifier";
import { getDailyRunStarterModifiers, regenerateModifierPoolThresholds } from "#modifiers/modifier-type";
import { applyCoopBalanceParams } from "#system/coop-balance";
import { leaveCoopRun } from "#system/coop-exit";
import { coopNetwork } from "#system/coop-network";
import { coopSession } from "#system/coop-session";
import { coopSnapshot } from "#system/coop-snapshot";
import { coopTelemetry } from "#system/coop-telemetry";
import {
  type CoopUrlConfig,
  describeRelayAddress,
  getCoopTitleConfigs,
  normalizeRelayAddress,
  parseCoopUrl,
} from "#system/coop-url";
import { getLocalProfileName, listLocalProfiles, setLocalProfileName } from "#system/local-profile";
import { vouchers } from "#system/voucher";
import type { OptionSelectItem, OptionSelectModeConfig } from "#types/ui-types";
import type { CoopLobbyConfig, CoopLobbyUiHandler } from "#ui/coop-lobby-ui-handler";
import type { CoopTextFormConfig } from "#ui/coop-text-form-ui-handler";
import { SaveSlotUiMode } from "#ui/save-slot-select-ui-handler";
import { isLocalServerConnected } from "#utils/common";
import i18next from "i18next";

const NO_SAVE_SLOT = -1;

export class TitlePhase extends Phase {
  public readonly phaseName = "TitlePhase";
  private loaded = false;
  // TODO: Make `end` take a `GameModes` as a parameter rather than storing it on the class itself
  public gameMode: GameModes;

  async start(): Promise<void> {
    super.start();

    globalScene.ui.clearText();
    globalScene.ui.fadeIn(250);

    const now = new Date();
    if (now.getMonth() === 11 || (now.getMonth() === 0 && now.getDate() <= 15)) {
      audioManager.playBgm("winter_title", true);
    } else {
      audioManager.playBgm("title", true);
    }

    // Co-op: the games were sent back to the start of the wave, so load the snapshot instead of showing the menu
    if (coopSession.enabled && coopSnapshot.pendingResume) {
      await this.resumeCoop();
      return;
    }

    const lastSlot = await this.checkLastSaveSlot();
    await this.showOptions(lastSlot);
  }

  /** Co-op: restore the run from the host's snapshot of the wave and carry on from the start of that wave. */
  private async resumeCoop(): Promise<void> {
    const { ui, gameData } = globalScene;
    const session = coopSnapshot.pendingResume!;
    coopSnapshot.pendingResume = null;
    ui.setMode(UiMode.MESSAGE);
    ui.showText("Getting back in sync with your partner...", 0);
    try {
      await gameData.loadSessionFromData(gameData.parseSessionData(session));
    } catch (err) {
      console.error(err);
      leaveCoopRun("Could not get back in sync with your partner. Back to the title screen...");
      return;
    }
    this.loaded = true;
    // Keep what we have, in case the other game has to be sent back again
    coopSnapshot.latest = session;
    coopNetwork.finishResync();
    ui.clearText();
    this.end();
  }

  /**
   * If a user is logged in, check the last save slot they loaded and adjust various variables
   * to account for it.
   * @returns A Promise that resolves with the last loaded session's slot ID.
   * Returns `NO_SAVE_SLOT` if not logged in or no session was found.
   */
  private async checkLastSaveSlot(): Promise<number> {
    if (loggedInUser == null) {
      return NO_SAVE_SLOT;
    }
    try {
      const sessionData = await globalScene.gameData.getSession(loggedInUser.lastSessionSlot);
      if (!sessionData) {
        return NO_SAVE_SLOT;
      }

      globalScene.sessionSlotId = loggedInUser.lastSessionSlot;
      // Set the BG texture to the last save's current biome
      const biomeKey = getBiomeKey(sessionData.arena.biome);
      const bgTexture = `${biomeKey}_bg`;
      await globalScene.loadBiomeAssets(sessionData.arena.biome);
      globalScene.arenaBg.setTexture(bgTexture);
      return loggedInUser.lastSessionSlot;
    } catch (err) {
      console.error(err);
      return NO_SAVE_SLOT;
    }
  }

  private async showOptions(lastSessionSlot: number): Promise<void> {
    const { gameData, ui } = globalScene;
    const options: OptionSelectItem[] = [];
    // Add a "continue" menu if the session slot ID is >-1
    if (lastSessionSlot > NO_SAVE_SLOT) {
      options.push({
        label: i18next.t("continue", { ns: "menu" }),
        handler: () => {
          this.loadSaveSlot(lastSessionSlot);
          return true;
        },
      });
    }
    // Co-op is always offered. A page address that asks for a role (?coop=join&room=CODE&server=...) goes straight
    // there; otherwise the lobby screen lets players host, or pick a lobby from the list
    const page = typeof window === "undefined" ? null : { search: window.location.search, location: window.location };
    const asked = page ? parseCoopUrl(page.search, page.location) : null;
    if (asked) {
      options.push({
        label:
          asked.role === "host"
            ? "Co-op: host a game"
            : asked.room
              ? `Co-op: join room ${asked.room}`
              : "Co-op: join a game",
        handler: () => {
          this.startCoop(asked);
          return true;
        },
      });
    } else if (page) {
      options.push({
        label: "Co-op",
        handler: () => {
          this.openCoopLobby();
          return true;
        },
      });
    }
    if (page) {
      options.push({
        label: "Profile",
        handler: () => {
          this.openProfileMenu(() => this.showOptions(lastSessionSlot));
          return true;
        },
      });
    }
    options.push(
      {
        label: i18next.t("menu:newGame"),
        handler: () => {
          const setModeAndEnd = (gameMode: GameModes) => {
            this.gameMode = gameMode;
            ui.setMode(UiMode.MESSAGE);
            ui.clearText();
            this.end();
          };
          const newGameOptions: OptionSelectItem[] = [];
          newGameOptions.push({
            label: GameMode.getModeName(GameModes.CLASSIC),
            handler: () => {
              setModeAndEnd(GameModes.CLASSIC);
              return true;
            },
          });
          newGameOptions.push({
            label: i18next.t("menu:dailyRun"),
            handler: () => {
              this.initDailyRun();
              return true;
            },
          });
          if (gameData.isUnlocked(Unlockables.ENDLESS_MODE)) {
            newGameOptions.push({
              label: GameMode.getModeName(GameModes.CHALLENGE),
              handler: () => {
                setModeAndEnd(GameModes.CHALLENGE);
                return true;
              },
            });
            newGameOptions.push({
              label: GameMode.getModeName(GameModes.ENDLESS),
              handler: () => {
                setModeAndEnd(GameModes.ENDLESS);
                return true;
              },
            });
            if (gameData.isUnlocked(Unlockables.SPLICED_ENDLESS_MODE)) {
              newGameOptions.push({
                label: GameMode.getModeName(GameModes.SPLICED_ENDLESS),
                handler: () => {
                  setModeAndEnd(GameModes.SPLICED_ENDLESS);
                  return true;
                },
              });
            }
          }
          // Cancel button = back to title
          newGameOptions.push({
            label: i18next.t("menu:cancel"),
            handler: () => {
              globalScene.phaseManager.toTitleScreen();
              super.end();
              return true;
            },
          });
          ui.showText(i18next.t("menu:selectGameMode"), null, () => {
            const config: OptionSelectModeConfig = { options: newGameOptions, yOffset: 48 };
            ui.setOverlayMode(UiMode.OPTION_SELECT, config);
          });
          return true;
        },
      },
      {
        label: i18next.t("menu:loadGame"),
        handler: () => {
          ui.setOverlayMode(UiMode.SAVE_SLOT, SaveSlotUiMode.LOAD, (slotId: number) => {
            if (slotId === NO_SAVE_SLOT) {
              console.warn("Attempted to load save slot of -1 through load game menu!");
              return this.showOptions(slotId);
            }
            this.loadSaveSlot(slotId);
          });
          return true;
        },
      },
      {
        label: i18next.t("menu:runHistory"),
        handler: () => {
          ui.setOverlayMode(UiMode.RUN_HISTORY);
          return true;
        },
        keepOpen: true,
      },
      {
        label: i18next.t("menu:menu"),
        handler: () => {
          ui.setOverlayMode(UiMode.MENU);
          return true;
        },
        keepOpen: true,
      },
    );
    const config: OptionSelectModeConfig = { options, blockCancelButton: true };
    await ui.setMode(UiMode.TITLE, config);
  }

  /** What both co-op ways in (the lobby screen and a direct address) need before connecting. */
  private setupCoopHandlers(): void {
    // Balance settings from the page address (e.g. ?coopBossCut=0&coopLevels=2) and a fresh run log
    applyCoopBalanceParams(window.location.search);
    coopTelemetry.clear();
    // Whenever the partner leaves (or the connection drops), end the run instead of waiting forever
    coopNetwork.onPartnerLeft = () => leaveCoopRun("Your partner left the game. Back to the title screen...");
    // When the two games disagree, the host sends the start of the wave and both go back to it
    coopNetwork.onDesync = (wave, turn) => {
      console.error(`Co-op desync at wave ${wave}, turn ${turn}`);
      if (coopNetwork.role === "host" && !coopNetwork.requestResync()) {
        globalScene.phaseManager.queueMessage(
          `Warning: the two games have gone out of sync (wave ${wave}, turn ${turn}) and could not be fixed. Things may look different on your partner's screen.`,
        );
      }
    };
    coopNetwork.onResync = session => {
      coopSnapshot.pendingResume = session;
      globalScene.reset(true);
    };
    const say = (text: string) => {
      if (globalScene.ui.mode === UiMode.MESSAGE) {
        globalScene.ui.showText(text, 0);
      }
    };
    coopNetwork.onReconnecting = () => say("Lost the connection. Trying to get it back...");
    coopNetwork.onReconnected = () => say("Connected again! Syncing up...");
    coopNetwork.onPartnerAway = () => say("Your partner lost their connection. Waiting for them to come back...");
    coopNetwork.onPartnerBack = () => say("Your partner is back! Syncing up...");
  }

  /** The name this player goes by in lobbies: their profile name. */
  private coopPlayerName(): string {
    return getLocalProfileName(window.location.search, localStorage);
  }

  /** Connect to the relay and the partner, then go on to picking starters. */
  private startCoop(config: CoopUrlConfig): void {
    const { ui } = globalScene;
    ui.setMode(UiMode.MESSAGE);
    ui.clearText();
    ui.showText("Connecting to the relay server...", 0);
    coopNetwork.onStatus = text => ui.showText(text, 0);
    coopNetwork.onHosted = null;
    this.setupCoopHandlers();
    coopNetwork
      .connect({ server: config.server, role: config.role, room: config.room, name: this.coopPlayerName() })
      .then(() => {
        ui.clearText();
        this.gameMode = GameModes.CLASSIC;
        this.end();
      })
      .catch((err: Error) => {
        coopSession.reset();
        ui.showText(
          `${err.message} Back to the title screen...`,
          null,
          () => {
            globalScene.phaseManager.toTitleScreen();
            super.end();
          },
          2500,
        );
      });
  }

  /** The co-op lobby screen: pick a lobby to join, or host one and wait in it. */
  private openCoopLobby(server?: string): void {
    const { ui } = globalScene;
    const page = window.location;
    const relay = server ?? getCoopTitleConfigs(page.search, page)[0].server;
    const lobby = () => ui.getHandler() as CoopLobbyUiHandler;
    const connect = (role: "host" | "join", room?: string) => {
      this.setupCoopHandlers();
      coopNetwork.onStatus = null;
      coopNetwork.onHosted = code => lobby().setHosting(code);
      lobby().setStatus(role === "host" ? "Opening your lobby..." : "Joining...");
      coopNetwork
        .connect({ server: relay, role, room, name: this.coopPlayerName() })
        .then(() => {
          coopNetwork.onHosted = null;
          ui.setMode(UiMode.MESSAGE);
          ui.clearText();
          this.gameMode = GameModes.CLASSIC;
          this.end();
        })
        .catch((err: Error) => {
          coopNetwork.onHosted = null;
          coopSession.reset();
          if (ui.mode === UiMode.COOP_LOBBY) {
            lobby().setHosting(null);
            lobby().setStatus(err.message);
          }
        });
    };
    const config: CoopLobbyConfig = {
      name: this.coopPlayerName(),
      server: describeRelayAddress(relay),
      list: () => coopNetwork.listLobbies(relay),
      onHost: () => connect("host"),
      onJoin: room => connect("join", room),
      onCancelHost: () => {
        coopNetwork.disconnect();
        coopSession.reset();
        this.openCoopLobby(relay);
      },
      onProfile: () => this.openProfileMenu(() => this.openCoopLobby(relay)),
      onServer: () => {
        const form: CoopTextFormConfig = {
          title: "Relay address",
          label: "Address",
          confirm: "Connect",
          initial: describeRelayAddress(relay),
          buttonActions: [
            (typed: string) => {
              ui.revertMode();
              this.openCoopLobby(normalizeRelayAddress(typed, page));
            },
            () => ui.revertMode(),
          ],
        };
        ui.setOverlayMode(UiMode.COOP_TEXT, form);
      },
      onBack: () => {
        coopNetwork.disconnect();
        globalScene.phaseManager.toTitleScreen();
        super.end();
      },
    };
    ui.setMode(UiMode.COOP_LOBBY, config);
  }

  /**
   * The profile screen: who you are playing as, the other profiles saved in this browser, a new profile, and
   * bringing your progress over from the main game.
   * @param back - Called to go back to wherever this was opened from
   */
  private openProfileMenu(back: () => void): void {
    const { ui } = globalScene;
    const current = this.coopPlayerName();
    const switchTo = (name: string) => {
      // The page reloads so the game starts again from that profile's saves
      if (setLocalProfileName(name, localStorage)) {
        window.location.reload();
      }
    };
    const options: OptionSelectItem[] = [{ label: `Playing as: ${current}`, handler: () => false, keepOpen: true }];
    for (const name of listLocalProfiles(localStorage, current).filter(name => name !== current)) {
      options.push({ label: `Switch to ${name}`, handler: () => (switchTo(name), true) });
    }
    options.push({
      label: "New profile",
      handler: () => {
        const form: CoopTextFormConfig = {
          title: "New profile",
          label: "Nickname",
          confirm: "Create",
          buttonActions: [
            (typed: string) => {
              if (setLocalProfileName(typed, localStorage)) {
                window.location.reload();
              } else {
                ui.playError();
              }
            },
            () => {
              ui.revertMode();
              back();
            },
          ],
        };
        ui.setOverlayMode(UiMode.COOP_TEXT, form);
        return true;
      },
    });
    options.push({
      label: "Import from the main game",
      handler: () => {
        this.openImportMenu(back);
        return true;
      },
    });
    options.push({ label: i18next.t("menu:cancel"), handler: () => (back(), true) });
    ui.setMode(UiMode.OPTION_SELECT, { options, yOffset: 48 } satisfies OptionSelectModeConfig);
  }

  /** Bring progress over from the main game's "Export data" files into the profile in use. */
  private openImportMenu(back: () => void): void {
    const { ui, gameData } = globalScene;
    const importing =
      (type: GameDataType, slot = 0) =>
      () => {
        gameData.importData(type, slot);
        return true;
      };
    const options: OptionSelectItem[] = [
      // Where the file comes from, since that is the part nobody can guess
      { label: "Main game > Menu > Manage Data > Export", handler: () => false, keepOpen: true },
      { label: "Pokedex and unlocks (System)", handler: importing(GameDataType.SYSTEM), keepOpen: true },
      { label: "A saved run (into slot 1)", handler: importing(GameDataType.SESSION, 0), keepOpen: true },
      { label: "Run history", handler: importing(GameDataType.RUN_HISTORY), keepOpen: true },
      { label: i18next.t("menu:cancel"), handler: () => (this.openProfileMenu(back), true) },
    ];
    ui.setMode(UiMode.OPTION_SELECT, { options, yOffset: 48 } satisfies OptionSelectModeConfig);
  }

  // TODO: Make callers actually wait for the save slot to load
  private async loadSaveSlot(slotId: number): Promise<void> {
    // TODO: Do we need to `await` this?
    globalScene.ui.setMode(UiMode.MESSAGE);
    globalScene.ui.resetModeChain();
    globalScene.sessionSlotId = slotId;
    try {
      const success = await globalScene.gameData.loadSession(slotId);
      if (success) {
        this.loaded = true;
        globalScene.ui.showText(i18next.t("menu:sessionSuccess"), null, () => this.end());
      } else {
        this.end();
      }
    } catch (err) {
      console.error(err);
      globalScene.ui.showText(i18next.t("menu:failedToLoadSession"), null);
    }
  }

  initDailyRun(): void {
    globalScene.ui.clearText();
    globalScene.ui.setMode(UiMode.SAVE_SLOT, SaveSlotUiMode.SAVE, (slotId: number) => {
      if (slotId === -1) {
        globalScene.phaseManager.toTitleScreen();
        super.end();
        return;
      }
      globalScene.phaseManager.clearPhaseQueue();
      globalScene.sessionSlotId = slotId;

      const generateDaily = (seed: string) => {
        globalScene.gameMode = getGameMode(GameModes.DAILY);

        seed = globalScene.gameMode.trySetCustomDailyConfig(seed);

        // Daily runs don't support all challenges yet (starter select restrictions aren't considered)
        startDailyEventChallenges();

        globalScene.setSeed(seed);
        globalScene.resetSeed();

        globalScene.money = globalScene.gameMode.getStartingMoney();

        const starters = getDailyRunStarters();
        const startingLevel = globalScene.gameMode.getStartingLevel();

        // TODO: Dedupe this
        const party = globalScene.getPlayerParty();
        const loadPokemonAssets: Promise<void>[] = [];
        for (const [index, starter] of starters.entries()) {
          const species = speciesDataRegistry.getSpecies(starter.speciesId);
          const starterFormIndex = starter.formIndex;
          const starterGender =
            species.malePercent === null ? Gender.GENDERLESS : starter.female ? Gender.FEMALE : Gender.MALE;
          const starterPokemon = globalScene.addPlayerPokemon(
            species,
            startingLevel,
            starter.abilityIndex,
            starterFormIndex,
            starterGender,
            starter.shiny,
            starter.variant,
            starter.ivs,
            starter.nature,
          );
          starterPokemon.setVisible(false);
          if (starter.moveset) {
            // avoid validating daily run starter movesets which are pre-populated already
            starterPokemon.tryPopulateMoveset(starter.moveset, true);
          }

          const customStarterConfig = globalScene.gameMode.dailyConfig?.starters?.[index];
          if (customStarterConfig?.ability != null) {
            starterPokemon.customPokemonData.ability = customStarterConfig.ability;
          }
          if (customStarterConfig?.passive != null) {
            starterPokemon.customPokemonData.passive = customStarterConfig.passive;
          }

          party.push(starterPokemon);
          loadPokemonAssets.push(starterPokemon.loadAssets());
        }

        regenerateModifierPoolThresholds(party, ModifierPoolType.DAILY_STARTER);

        const modifiers: Modifier[] = new Array(3)
          .fill(null)
          .map(() => modifierTypes.EXP_SHARE().withIdFromFunc(modifierTypes.EXP_SHARE).newModifier())
          .concat(
            new Array(3)
              .fill(null)
              .map(() => modifierTypes.GOLDEN_EXP_CHARM().withIdFromFunc(modifierTypes.GOLDEN_EXP_CHARM).newModifier()),
          )
          .concat([modifierTypes.MAP().withIdFromFunc(modifierTypes.MAP).newModifier()])
          .concat([modifierTypes.ABILITY_CHARM().withIdFromFunc(modifierTypes.ABILITY_CHARM).newModifier()])
          .concat([modifierTypes.SHINY_CHARM().withIdFromFunc(modifierTypes.SHINY_CHARM).newModifier()])
          .concat(getDailyRunStarterModifiers(party))
          .filter(m => m !== null);

        for (const m of modifiers) {
          globalScene.addModifier(m, true, false, false, true);
        }
        for (const m of timedEventManager.getEventDailyStartingItems()) {
          globalScene.addModifier(
            modifierTypes[m]().withIdFromFunc(modifierTypes[m]).newModifier(),
            true,
            false,
            false,
            true,
          );
        }
        globalScene.updateModifiers(true, true);

        Promise.all(loadPokemonAssets).then(async () => {
          globalScene.time.delayedCall(500, () => audioManager.playBgm());
          globalScene.gameData.gameStats.dailyRunSessionsPlayed++;
          const startingBiome = globalScene.gameMode.getStartingBiome();

          await globalScene.loadBiomeAssets(startingBiome);
          globalScene.newArena(startingBiome);
          globalScene.newBattle();
          globalScene.arena.init();
          globalScene.sessionPlayTime = 0;
          globalScene.lastSavePlayTime = 0;
          this.end();
        });
      };

      // If Online, calls seed fetch from db to generate daily run. If Offline, generates a daily run based on current date.
      if (!bypassLogin || isLocalServerConnected) {
        pokerogueApi.daily
          .getSeed()
          .then(seed => {
            if (seed) {
              generateDaily(seed);
            } else {
              throw new Error("Daily run seed is null!");
            }
          })
          .catch(err => {
            console.error("Failed to load daily run:\n", err);
          });
      } else {
        // Grab first 10 chars of ISO date format (YYYY-MM-DD) and convert to base64
        let seed: string = btoa(new Date().toISOString().slice(0, 10));
        if (activeOverrides.DAILY_RUN_SEED_OVERRIDE != null) {
          seed =
            typeof activeOverrides.DAILY_RUN_SEED_OVERRIDE === "string"
              ? activeOverrides.DAILY_RUN_SEED_OVERRIDE
              : JSON.stringify(activeOverrides.DAILY_RUN_SEED_OVERRIDE);
        }
        generateDaily(seed);
      }
    });
  }

  // TODO: Refactor this
  end(): void {
    if (!this.loaded && !globalScene.gameMode.isDaily) {
      globalScene.gameMode = getGameMode(this.gameMode);
      if (this.gameMode === GameModes.CHALLENGE) {
        globalScene.phaseManager.pushNew("SelectChallengePhase");
      } else {
        globalScene.phaseManager.pushNew("SelectStarterPhase");
      }
      globalScene.newArena(globalScene.gameMode.getStartingBiome());
    } else {
      audioManager.playBgm();
    }

    globalScene.phaseManager.pushNew("EncounterPhase", this.loaded);

    // (a co-op run sends out its own Pokemon in the encounter phase)
    if (this.loaded && !coopSession.enabled) {
      const availablePartyMembers = globalScene.getPokemonAllowedInBattle().length;

      globalScene.phaseManager.pushNew("SummonPhase", 0, true, true);
      if (globalScene.currentBattle.double && availablePartyMembers > 1) {
        globalScene.phaseManager.pushNew("SummonPhase", 1, true, true);
      }

      if (
        globalScene.currentBattle.battleType !== BattleType.TRAINER
        && (globalScene.currentBattle.waveIndex > 1 || !globalScene.gameMode.isDaily)
      ) {
        const minPartySize = globalScene.currentBattle.double ? 2 : 1;
        if (availablePartyMembers > minPartySize) {
          globalScene.phaseManager.pushNew("CheckSwitchPhase", 0, globalScene.currentBattle.double);
          if (globalScene.currentBattle.double) {
            globalScene.phaseManager.pushNew("CheckSwitchPhase", 1, globalScene.currentBattle.double);
          }
        }
      }
    }

    // TODO: Move this to a migrate script instead of running it on save slot load
    for (const achv of Object.keys(globalScene.gameData.achvUnlocks)) {
      if (Object.hasOwn(vouchers, achv) && achv !== "CLASSIC_VICTORY") {
        globalScene.validateVoucher(vouchers[achv]);
      }
    }

    super.end();
  }
}
