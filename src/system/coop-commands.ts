import { globalScene } from "#app/global-scene";
import type { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { PlayerPokemon } from "#field/pokemon";
import { type CoopCommandMessage, coopSession } from "#system/coop-session";

/**
 * Send the command the local seat just finished choosing for `fieldIndex` to the other client.
 * Does nothing outside co-op, in hotseat mode, or for a Pokemon the local client does not control.
 */
export function publishLocalCommand(fieldIndex: number): void {
  const pokemon = globalScene.getPlayerField()[fieldIndex] as PlayerPokemon | undefined;
  if (!coopSession.enabled || coopSession.hotseat || !coopSession.send || !pokemon) {
    return;
  }
  if (!coopSession.controls(pokemon.owner)) {
    return;
  }
  const { currentBattle } = globalScene;
  const turnCommand = currentBattle.turnCommands[fieldIndex];
  if (!turnCommand) {
    return;
  }
  coopSession.send({
    wave: currentBattle.waveIndex,
    turn: currentBattle.turn,
    seat: pokemon.owner,
    command: turnCommand.command,
    cursor: turnCommand.cursor ?? -1,
    move: turnCommand.move?.move,
    targets: turnCommand.targets ?? turnCommand.move?.targets,
    tera: currentBattle.preTurnCommands[fieldIndex]?.command === Command.TERA,
    baton: turnCommand.command === Command.POKEMON ? !!turnCommand.args?.[0] : undefined,
  });
}

/**
 * Turn a command received from the other client into the turn command for `fieldIndex`.
 * Only fight and switch commands can be sent; balls and running are not available in co-op yet.
 */
export function applyRemoteCommand(fieldIndex: number, message: CoopCommandMessage): void {
  const { currentBattle } = globalScene;
  if (message.command === Command.POKEMON) {
    currentBattle.turnCommands[fieldIndex] = {
      command: Command.POKEMON,
      cursor: message.cursor,
      args: [!!message.baton],
    };
    return;
  }
  const useMode = MoveUseMode.NORMAL;
  const targets = (message.targets ?? []) as BattlerIndex[];
  currentBattle.preTurnCommands[fieldIndex] = {
    command: message.tera ? Command.TERA : Command.FIGHT,
    targets: [fieldIndex],
    skip: !message.tera,
  };
  currentBattle.turnCommands[fieldIndex] = {
    command: Command.FIGHT,
    cursor: message.cursor,
    move: { move: (message.move ?? 0) as MoveId, targets, useMode },
    targets,
    args: [useMode, undefined],
  };
}
