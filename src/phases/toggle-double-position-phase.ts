import { globalScene } from "#app/global-scene";
import { FieldPosition } from "#enums/field-position";
import { BattlePhase } from "#phases/battle-phase";
import { coopSession } from "#system/coop-session";

export class ToggleDoublePositionPhase extends BattlePhase {
  public readonly phaseName = "ToggleDoublePositionPhase";
  private double: boolean;

  constructor(double: boolean) {
    super();

    this.double = double;
  }

  start() {
    super.start();

    // Co-op: slots belong to teams, and this phase can swap party slots, so leave every Pokemon where it is
    if (coopSession.enabled) {
      this.end();
      return;
    }

    const playerPokemon = globalScene.getPlayerField().find(p => p.isActive(true));
    if (playerPokemon) {
      playerPokemon
        .setFieldPosition(
          this.double && globalScene.getPokemonAllowedInBattle().length > 1 ? FieldPosition.LEFT : FieldPosition.CENTER,
          500,
        )
        .then(() => {
          if (playerPokemon.getFieldIndex() === 1) {
            const party = globalScene.getPlayerParty();
            party[1] = party[0];
            party[0] = playerPokemon;
          }
          this.end();
        });
    } else {
      this.end();
    }
  }
}
