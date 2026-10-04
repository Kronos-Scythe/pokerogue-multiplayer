import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import { SpeciesId } from "#enums/species-id";
import { type CoopCommandMessage, coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Co-op running and catching", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let sent: CoopCommandMessage[];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    game.override
      .ability(AbilityId.BALL_FETCH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH, MoveId.TACKLE])
      .startingLevel(50)
      .enemyLevel(5)
      .criticalHits(false);
    sent = [];
    coopSession.start({ localSeat: 0 });
    coopSession.send = message => sent.push(message);
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
    vi.restoreAllMocks();
  });

  const remote = (command: Command, extra: Partial<CoopCommandMessage> = {}): CoopCommandMessage => ({
    wave: game.scene.currentBattle.waveIndex,
    turn: game.scene.currentBattle.turn,
    seat: 1,
    command,
    cursor: -1,
    ...extra,
  });

  // Poké Balls can only be thrown when one enemy is left, as in a normal double battle
  const onlyOneEnemyLeft = () => {
    game.scene.getEnemyField()[1].hp = 0;
  };

  const phasesQueued = (spy: ReturnType<typeof vi.spyOn>, name: string) =>
    spy.mock.calls.filter(call => call[0] === name);

  async function localCommand(command: Command.RUN | Command.BALL, cursor = 0) {
    const phase = game.scene.phaseManager.getCurrentPhase() as any;
    expect(phase.handleCommand(command, cursor)).toBe(true);
  }

  it("flees only when both players chose Run", async () => {
    const spy = vi.spyOn(game.scene.phaseManager, "unshiftNew");
    await localCommand(Command.RUN);
    expect(sent.at(-1)?.command).toBe(Command.RUN);
    coopSession.receive(remote(Command.RUN));
    await game.phaseInterceptor.to("TurnStartPhase");

    expect(phasesQueued(spy, "AttemptRunPhase")).toHaveLength(1);
  });

  it("stays and fights when only one player chose Run", async () => {
    const spy = vi.spyOn(game.scene.phaseManager, "unshiftNew");
    await localCommand(Command.RUN);
    coopSession.receive(remote(Command.FIGHT, { cursor: 0, move: MoveId.SPLASH, targets: [BattlerIndex.PLAYER_2] }));
    await game.phaseInterceptor.to("TurnStartPhase");

    expect(phasesQueued(spy, "AttemptRunPhase")).toHaveLength(0);
  });

  it("lets one player throw a ball without using up the partner's turn", async () => {
    game.scene.pokeballCounts[0] = 5;
    onlyOneEnemyLeft();
    const spy = vi.spyOn(game.scene.phaseManager, "unshiftNew");
    await localCommand(Command.BALL, 0);
    expect(sent.at(-1)?.command).toBe(Command.BALL);
    coopSession.receive(remote(Command.FIGHT, { cursor: 0, move: MoveId.SPLASH, targets: [BattlerIndex.PLAYER_2] }));
    await game.phaseInterceptor.to("TurnStartPhase", false);

    const commands = game.scene.currentBattle.turnCommands;
    expect(commands[0]?.command).toBe(Command.BALL);
    expect(commands[1]?.command).toBe(Command.FIGHT);
    expect(commands[1]?.skip).toBeFalsy();
    await game.phaseInterceptor.to("TurnStartPhase");
    expect(phasesQueued(spy, "AttemptCapturePhase")[0]?.[3]).toBe(0);
  });

  it("puts a Pokemon the partner caught on their team, in the slot they chose to release", async () => {
    game.scene.pokeballCounts[4] = 5;
    onlyOneEnemyLeft();
    // the local seat splashes, the partner throws a Master Ball at the first enemy
    const phase = game.scene.phaseManager.getCurrentPhase() as any;
    phase.handleCommand(Command.FIGHT, 0, MoveUseMode.NORMAL);
    const caught = game.scene.getEnemyField()[0].species.speciesId;
    coopSession.receive(remote(Command.BALL, { cursor: 4, targets: [BattlerIndex.ENEMY] }));
    // the partner decided to release their Eevee (slot 4)
    coopSession.receiveChoice({ slot: 4 });
    await game.phaseInterceptor.to("TurnEndPhase", false);

    const party = game.scene.getPlayerParty();
    expect(party).toHaveLength(6);
    expect(party[4].species.speciesId).toBe(caught);
    expect(party[4].owner).toBe(1);
    expect(party.filter(p => p.species.speciesId === SpeciesId.EEVEE)).toHaveLength(0);
  });
});
