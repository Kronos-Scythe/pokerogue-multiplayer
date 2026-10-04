import { globalScene } from "#app/global-scene";
import { UiMode } from "#enums/ui-mode";
import { coopNetwork } from "#system/coop-network";
import { coopSession } from "#system/coop-session";

let leaving = false;

/**
 * Leave the co-op run and go back to the title screen: drop the connection, forget the co-op session and
 * (when there is something to say, like "your partner left") show a message first.
 * Safe to call more than once; calls while already leaving do nothing.
 */
export function leaveCoopRun(message?: string): void {
  if (leaving) {
    return;
  }
  leaving = true;
  coopNetwork.disconnect();
  coopSession.reset();

  const toTitle = () => {
    leaving = false;
    globalScene.reset(true);
  };
  if (!message) {
    toTitle();
    return;
  }
  const { ui } = globalScene;
  void ui.setMode(UiMode.MESSAGE).then(() => ui.showText(message, null, toTitle, 2500));
}
