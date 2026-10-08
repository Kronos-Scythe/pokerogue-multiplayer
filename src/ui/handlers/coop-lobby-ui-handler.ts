import { globalScene } from "#app/global-scene";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { CoopLobby } from "#system/coop-network";
import { addTextObject } from "#ui/text";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";

/** What the lobby screen needs from whoever opens it. */
export interface CoopLobbyConfig {
  /** The name this player is known by */
  name: string;
  /** The relay being browsed, as the player would say it (`26.1.2.3:8787`) */
  server: string;
  /** Ask the relay which lobbies are open */
  list: () => Promise<CoopLobby[]>;
  /** Open a lobby of your own and wait in it */
  onHost: () => void;
  /** Join somebody's lobby */
  onJoin: (room: string) => void;
  /** Leave the lobby you opened (back to the list) */
  onCancelHost: () => void;
  /** Open the profile screen */
  onProfile: () => void;
  /** Ask for a different relay address */
  onServer: () => void;
  /** Back to the title screen */
  onBack: () => void;
}

type Focus = "list" | "actions";

const ROW_HEIGHT = 13;
const VISIBLE_ROWS = 7;
const REFRESH_MS = 3000;

/** The pieces a screen is made of, so tests can look at what is on offer without drawing anything. */
export interface CoopLobbyView {
  hosting: boolean;
  actions: string[];
  rows: { host: string; players: string }[];
}

/**
 * The co-op lobby screen: the open lobbies on the relay on the left, who is sitting where in the selected one on
 * the right, and the things you can do at the bottom (host your own, join, change profile, go back).
 * Hosting shows your own lobby with an open seat until a partner joins.
 */
export class CoopLobbyUiHandler extends UiHandler {
  private container: Phaser.GameObjects.Container;
  private dynamic: Phaser.GameObjects.GameObject[] = [];
  private config: CoopLobbyConfig | null = null;
  private lobbies: CoopLobby[] = [];
  private status = "";
  private scroll = 0;
  private focus: Focus = "list";
  private actionCursor = 0;
  /** The room code of the lobby this player opened, while they wait in it */
  private hostingRoom: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  setup(): void {
    const ui = this.getUi();
    const { width, height } = globalScene.scaledCanvas;
    this.container = globalScene.add.container(0, -height).setVisible(false);
    ui.add(this.container);

    const bg = globalScene.add.rectangle(0, 0, width, height, 0x2a2f4f).setOrigin(0, 0);
    this.container.add(bg);
    this.container.add(addWindow(0, 0, width, 20).setOrigin(0, 0));
    this.container.add(addWindow(0, 22, 172, 118).setOrigin(0, 0));
    this.container.add(addWindow(174, 22, width - 174, 118).setOrigin(0, 0));
    this.container.add(addTextObject(8, 5, "Lobbies", TextStyle.WINDOW).setOrigin(0, 0));
  }

  show(args: any[]): boolean {
    const config = args[0] as CoopLobbyConfig | undefined;
    if (!config) {
      return false;
    }
    super.show(args);
    this.config = config;
    this.lobbies = [];
    this.status = "";
    this.scroll = 0;
    this.cursor = 0;
    this.focus = "list";
    this.actionCursor = 0;
    this.hostingRoom = null;
    this.container.setVisible(true);
    this.render();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    return true;
  }

  clear(): void {
    super.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clearDynamic();
    this.container.setVisible(false);
    this.config = null;
  }

  /** Ask the relay again which lobbies are open. */
  private async refresh(): Promise<void> {
    if (!this.config || this.refreshing || this.hostingRoom) {
      return;
    }
    this.refreshing = true;
    const config = this.config;
    try {
      const lobbies = await config.list();
      if (this.config === config && !this.hostingRoom) {
        const selected = this.lobbies[this.cursor]?.room;
        this.lobbies = lobbies;
        // keep the same lobby selected when the list shifts around
        const kept = lobbies.findIndex(lobby => lobby.room === selected);
        this.cursor = kept >= 0 ? kept : Math.min(this.cursor, Math.max(0, lobbies.length - 1));
        this.status = "";
      }
    } catch (error) {
      if (this.config === config) {
        this.lobbies = [];
        this.status = (error as Error).message;
      }
    } finally {
      this.refreshing = false;
    }
    if (this.config === config && this.active) {
      this.render();
    }
  }

  /** The lobby this player opened is open (a code is known): show it and wait for the partner. */
  public setHosting(room: string | null): void {
    this.hostingRoom = room;
    this.focus = "actions";
    this.actionCursor = 0;
    this.status = "";
    if (this.active) {
      this.render();
    }
  }

  /** Show a problem or progress note in the corner (e.g. "That room is full."). */
  public setStatus(text: string): void {
    this.status = text;
    if (this.active) {
      this.render();
    }
  }

  /** What the screen currently offers, for tests. */
  public getView(): CoopLobbyView {
    return {
      hosting: this.hostingRoom !== null,
      actions: this.getActions().map(action => action.label),
      rows: this.getRows(),
    };
  }

  private getRows(): { host: string; players: string }[] {
    if (this.hostingRoom && this.config) {
      return [{ host: this.config.name, players: "1/2" }];
    }
    return this.lobbies.map(lobby => ({ host: lobby.host, players: `${lobby.players}/${lobby.max}` }));
  }

  private getActions(): { label: string; run: () => void }[] {
    const config = this.config;
    if (!config) {
      return [];
    }
    if (this.hostingRoom) {
      return [{ label: "Cancel lobby", run: () => config.onCancelHost() }];
    }
    return [
      { label: "Host", run: () => config.onHost() },
      { label: "Join", run: () => this.joinSelected() },
      { label: "Server", run: () => config.onServer() },
      { label: "Profile", run: () => config.onProfile() },
      { label: "Back", run: () => config.onBack() },
    ];
  }

  private joinSelected(): boolean {
    const lobby = this.lobbies[this.cursor];
    if (!lobby || lobby.players >= lobby.max) {
      this.getUi().playError();
      this.setStatus(lobby ? "That lobby is full." : "No lobby selected.");
      return false;
    }
    this.config?.onJoin(lobby.room);
    return true;
  }

  private clearDynamic(): void {
    for (const object of this.dynamic) {
      object.destroy();
    }
    this.dynamic = [];
  }

  private add<T extends Phaser.GameObjects.GameObject>(object: T): T {
    this.container.add(object);
    this.dynamic.push(object);
    return object;
  }

  private render(): void {
    if (!this.config) {
      return;
    }
    this.clearDynamic();
    const { width } = globalScene.scaledCanvas;
    const rows = this.getRows();

    // The corner of the header: a problem, else where we are
    const corner =
      this.status || (this.hostingRoom ? `Lobby ${this.hostingRoom}` : `${this.config.name} @ ${this.config.server}`);
    this.add(addTextObject(width - 8, 5, corner, TextStyle.WINDOW).setOrigin(1, 0));

    // Left panel: the lobbies
    this.add(addTextObject(8, 26, "Host", TextStyle.SETTINGS_LABEL).setOrigin(0, 0));
    this.add(addTextObject(164, 26, "Players", TextStyle.SETTINGS_LABEL).setOrigin(1, 0));
    if (this.cursor < this.scroll) {
      this.scroll = this.cursor;
    } else if (this.cursor >= this.scroll + VISIBLE_ROWS) {
      this.scroll = this.cursor - VISIBLE_ROWS + 1;
    }
    if (rows.length === 0) {
      this.add(addTextObject(8, 44, "No lobbies yet.", TextStyle.SETTINGS_LOCKED).setOrigin(0, 0));
      this.add(addTextObject(8, 57, "Host one and tell your friend!", TextStyle.SETTINGS_LOCKED).setOrigin(0, 0));
    }
    rows.slice(this.scroll, this.scroll + VISIBLE_ROWS).forEach((row, i) => {
      const y = 40 + i * ROW_HEIGHT;
      const selected = this.scroll + i === this.cursor;
      if (selected && (this.focus === "list" || this.hostingRoom)) {
        this.add(globalScene.add.rectangle(6, y - 1, 160, ROW_HEIGHT, 0x7fe9ff, 0.28).setOrigin(0, 0));
      }
      const style = selected ? TextStyle.SETTINGS_SELECTED : TextStyle.WINDOW;
      this.add(addTextObject(10, y + 1, row.host, style).setOrigin(0, 0));
      this.add(addTextObject(164, y + 1, row.players, style).setOrigin(1, 0));
    });
    if (rows.length > VISIBLE_ROWS) {
      this.add(addTextObject(164, 128, `${this.cursor + 1}/${rows.length}`, TextStyle.SETTINGS_LOCKED).setOrigin(1, 0));
    }

    // Right panel: who is sitting where in the selected lobby
    const seatsOf = this.getSeats();
    if (seatsOf) {
      this.add(addTextObject(182, 26, seatsOf.host, TextStyle.WINDOW).setOrigin(0, 0));
      this.add(addTextObject(182, 40, "2P co-op", TextStyle.SETTINGS_LABEL).setOrigin(0, 0));
      seatsOf.seats.forEach((seat, i) => {
        const y = 58 + i * 15;
        this.add(addTextObject(182, y, `P${i + 1}`, TextStyle.SETTINGS_LABEL).setOrigin(0, 0));
        this.add(
          addTextObject(202, y, seat.name, seat.open ? TextStyle.SETTINGS_LOCKED : TextStyle.WINDOW).setOrigin(0, 0),
        );
        if (seat.tag) {
          this.add(addTextObject(width - 8, y, seat.tag, TextStyle.SETTINGS_LABEL).setOrigin(1, 0));
        }
      });
      this.add(addTextObject(182, 112, seatsOf.note, TextStyle.SETTINGS_LABEL).setOrigin(0, 0));
    }

    // Bottom: what you can do
    const actions = this.getActions();
    const slot = (width + 1) / actions.length;
    actions.forEach((action, i) => {
      const x = Math.round(i * slot);
      const w = Math.round(slot) - 4;
      this.add(addWindow(x, 142, w, 22).setOrigin(0, 0));
      const selected = this.focus === "actions" && i === this.actionCursor;
      if (selected) {
        this.add(globalScene.add.rectangle(x + 1, 143, w - 2, 20, 0x7fe9ff, 0.28).setOrigin(0, 0));
      }
      this.add(
        addTextObject(
          x + w / 2,
          148,
          action.label,
          selected ? TextStyle.SETTINGS_SELECTED : TextStyle.WINDOW,
        ).setOrigin(0.5, 0),
      );
    });
    this.add(
      addTextObject(
        width / 2,
        168,
        this.hostingRoom
          ? `Your friend can now pick your lobby in their list (room ${this.hostingRoom}).`
          : "Up/Down: lobbies   Left/Right: buttons   Confirm: join/select   Back: leave",
        TextStyle.SETTINGS_LABEL,
      ).setOrigin(0.5, 0),
    );
  }

  private getSeats(): { host: string; seats: { name: string; open: boolean; tag?: string }[]; note: string } | null {
    if (this.hostingRoom && this.config) {
      return {
        host: this.config.name,
        seats: [
          { name: this.config.name, open: false, tag: "[Host]" },
          { name: "Open", open: true },
        ],
        note: "Waiting...",
      };
    }
    const lobby = this.lobbies[this.cursor];
    if (!lobby) {
      return null;
    }
    return {
      host: lobby.host,
      seats: [
        { name: lobby.host, open: false, tag: "[Host]" },
        lobby.players >= lobby.max ? { name: "Taken", open: false } : { name: "Open", open: true },
      ],
      note: lobby.players >= lobby.max ? "Full" : "Waiting",
    };
  }

  processInput(button: Button): boolean {
    if (!this.config) {
      return false;
    }
    const actions = this.getActions();
    let changed = false;
    switch (button) {
      case Button.UP:
        if (this.focus === "actions" && !this.hostingRoom) {
          this.focus = "list";
          changed = true;
        } else if (this.focus === "list" && this.cursor > 0) {
          this.cursor--;
          changed = true;
        }
        break;
      case Button.DOWN:
        if (this.focus === "list" && this.cursor < this.getRows().length - 1) {
          this.cursor++;
          changed = true;
        } else if (this.focus === "list") {
          this.focus = "actions";
          changed = true;
        }
        break;
      case Button.LEFT:
        if (this.focus === "actions" && this.actionCursor > 0) {
          this.actionCursor--;
          changed = true;
        }
        break;
      case Button.RIGHT:
        if (this.focus === "actions" && this.actionCursor < actions.length - 1) {
          this.actionCursor++;
          changed = true;
        }
        break;
      case Button.ACTION:
        if (this.focus === "list") {
          // Enter on a lobby joins it
          this.joinSelected();
        } else {
          actions[this.actionCursor]?.run();
        }
        return true;
      case Button.CANCEL:
        if (this.hostingRoom) {
          this.config.onCancelHost();
        } else {
          this.config.onBack();
        }
        return true;
      default:
        break;
    }
    if (changed) {
      this.getUi().playSelect();
      this.render();
    }
    return changed;
  }
}
