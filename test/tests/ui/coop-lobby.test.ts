import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import type { CoopLobby } from "#system/coop-network";
import { GameManager } from "#test/framework/game-manager";
import type { CoopLobbyConfig, CoopLobbyUiHandler } from "#ui/coop-lobby-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Co-op lobby screen", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let calls: string[];
  let lobbies: CoopLobby[];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    calls = [];
    lobbies = [
      { room: "AAAA", host: "Ana", players: 1, max: 2 },
      { room: "BBBB", host: "Bo", players: 2, max: 2 },
    ];
  });

  afterEach(() => {
    // leaving the screen stops its refresh timer
    void game.scene.ui.setMode(UiMode.MESSAGE);
  });

  const handler = () => game.scene.ui.getHandler() as CoopLobbyUiHandler;
  const press = (button: Button) => handler().processInput(button);
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  async function open(list: () => Promise<CoopLobby[]> = async () => lobbies) {
    const config: CoopLobbyConfig = {
      name: "Me",
      server: "10.0.0.5:8787",
      list,
      onHost: () => calls.push("host"),
      onJoin: room => calls.push(`join ${room}`),
      onCancelHost: () => calls.push("cancel-host"),
      onProfile: () => calls.push("profile"),
      onServer: () => calls.push("server"),
      onBack: () => calls.push("back"),
    };
    await game.scene.ui.setMode(UiMode.COOP_LOBBY, config);
    await flush();
  }

  it("lists the open lobbies with their player counts and offers the actions", async () => {
    await open();
    expect(handler().getView()).toEqual({
      hosting: false,
      rows: [
        { host: "Ana", players: "1/2" },
        { host: "Bo", players: "2/2" },
      ],
      actions: ["Host", "Join", "Server", "Profile", "Back"],
    });
  });

  it("joins the selected lobby, but not a full one", async () => {
    await open();
    press(Button.ACTION);
    expect(calls).toEqual(["join AAAA"]);
    press(Button.DOWN);
    press(Button.ACTION);
    expect(calls).toEqual(["join AAAA"]);
  });

  it("moves between the list and the buttons, and runs the button under the cursor", async () => {
    await open();
    press(Button.DOWN);
    press(Button.DOWN);
    // past the last lobby: on the buttons now
    press(Button.RIGHT);
    press(Button.RIGHT);
    press(Button.ACTION);
    expect(calls).toEqual(["server"]);
    // back up on the list, the full lobby is still selected: joining it does nothing
    press(Button.UP);
    press(Button.ACTION);
    expect(calls).toEqual(["server"]);
  });

  it("goes back on cancel", async () => {
    await open();
    press(Button.CANCEL);
    expect(calls).toEqual(["back"]);
  });

  it("shows your own lobby with an open seat while hosting, and cancels it on back", async () => {
    await open();
    handler().setHosting("ZZZZ");
    expect(handler().getView()).toEqual({
      hosting: true,
      rows: [{ host: "Me", players: "1/2" }],
      actions: ["Cancel lobby"],
    });
    press(Button.CANCEL);
    expect(calls).toEqual(["cancel-host"]);
  });

  it("copes with a relay that cannot be reached", async () => {
    const list = vi.fn().mockRejectedValue(new Error("Could not reach the relay server."));
    await open(list);
    expect(handler().getView().rows).toEqual([]);
  });
});
