import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { type CoopCommandMessage, coopSession } from "#system/coop-session";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Co-op command input", () => {
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
    // this client is seat 0; seat 1 lives on the other client
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
  });

  const remoteFight = (cursor: number, move: MoveId, targets: BattlerIndex[]): CoopCommandMessage => ({
    wave: game.scene.currentBattle.waveIndex,
    turn: game.scene.currentBattle.turn,
    seat: 1,
    command: Command.FIGHT,
    cursor,
    move,
    targets,
  });

  it("sends the local seat's command and applies the partner's when it arrives", async () => {
    game.move.use(MoveId.TACKLE, 0, BattlerIndex.ENEMY);
    await game.phaseInterceptor.to("CommandPhase", false);
    // the partner's command only arrives now
    coopSession.receive(remoteFight(1, MoveId.TACKLE, [BattlerIndex.ENEMY_2]));
    await game.phaseInterceptor.to("TurnStartPhase", false);

    const commands = game.scene.currentBattle.turnCommands;
    expect(commands[0]?.move?.move).toBe(MoveId.TACKLE);
    expect(commands[1]?.move?.move).toBe(MoveId.TACKLE);
    expect(commands[1]?.targets).toEqual([BattlerIndex.ENEMY_2]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      seat: 0,
      command: Command.FIGHT,
      move: MoveId.TACKLE,
      targets: [BattlerIndex.ENEMY],
    });
  });

  it("waits for the partner and does not open a menu for their Pokemon", async () => {
    game.move.use(MoveId.SPLASH, 0);
    let reachedTurnStart = false;
    const run = game.phaseInterceptor.to("TurnStartPhase", false).then(() => {
      reachedTurnStart = true;
    });
    await new Promise(resolve => setTimeout(resolve, 200));

    // seat 0 has chosen, seat 1 has not: the turn must not start
    expect(reachedTurnStart).toBe(false);
    expect(game.scene.currentBattle.turnCommands[0]).toBeTruthy();
    expect(game.scene.currentBattle.turnCommands[1]).toBeFalsy();

    coopSession.receive(remoteFight(0, MoveId.SPLASH, [BattlerIndex.PLAYER_2]));
    await run;
    expect(game.scene.currentBattle.turnCommands[1]?.move?.move).toBe(MoveId.SPLASH);
  });

  it("takes a partner command that arrived before it was needed", async () => {
    coopSession.receive(remoteFight(0, MoveId.SPLASH, [BattlerIndex.PLAYER_2]));
    game.move.use(MoveId.SPLASH, 0);
    await game.phaseInterceptor.to("TurnStartPhase", false);
    expect(game.scene.currentBattle.turnCommands[1]?.move?.move).toBe(MoveId.SPLASH);
  });

  it("does not send anything in hotseat mode", async () => {
    coopSession.hotseat = true;
    game.move.use(MoveId.SPLASH, 0);
    game.move.use(MoveId.SPLASH, 1);
    await game.toNextTurn();
    expect(sent).toHaveLength(0);
  });
});

describe("Co-op command order", () => {
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
    coopSession.start({ localSeat: 1 });
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
  });

  it("asks the local seat first even when its Pokemon is in the second slot", async () => {
    // Turn 1 was queued before the seats were assigned, so play it out: slot 0 (seat 0) is the partner's
    coopSession.receive({
      wave: game.scene.currentBattle.waveIndex,
      turn: game.scene.currentBattle.turn,
      seat: 0,
      command: Command.FIGHT,
      cursor: 0,
      move: MoveId.SPLASH,
      targets: [BattlerIndex.PLAYER],
    });
    game.move.use(MoveId.SPLASH, 1);
    await game.toNextTurn();
    sent.length = 0;

    // Turn 2: this client is seat 1, and seat 0 (slot 0) has not chosen yet
    game.move.use(MoveId.TACKLE, 1, BattlerIndex.ENEMY);
    let reachedTurnStart = false;
    const run = game.phaseInterceptor.to("TurnStartPhase", false).then(() => {
      reachedTurnStart = true;
    });
    for (let i = 0; i < 100 && sent.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // our choice went out while the partner's slot is still empty
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ seat: 1, move: MoveId.TACKLE });
    expect(reachedTurnStart).toBe(false);
    expect(game.scene.currentBattle.turnCommands[0]).toBeFalsy();

    coopSession.receive({
      wave: game.scene.currentBattle.waveIndex,
      turn: game.scene.currentBattle.turn,
      seat: 0,
      command: Command.FIGHT,
      cursor: 0,
      move: MoveId.SPLASH,
      targets: [BattlerIndex.PLAYER],
    });
    await run;
    expect(game.scene.currentBattle.turnCommands[0]?.move?.move).toBe(MoveId.SPLASH);
  });
});
