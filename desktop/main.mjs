// PokeRogue co-op as a desktop program: a window with the game in it, and the lobby relay running behind it.
// Bundled by scripts/make-launcher.mjs; the game's files sit in a `game` folder next to the program.
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { localAddresses, startServers } from "../launcher/server.mjs";

const GAME_PORT = 8000;
const RELAY_PORT = 8787;

// Let the game use the graphics card even when the browser blocklist would not (laptops with odd drivers)
app.commandLine.appendSwitch("ignore-gpu-blocklist");

const gameDir = app.isPackaged ? join(process.resourcesPath, "game") : resolve(process.env.COOP_GAME_DIR ?? "dist");

/** @type {Awaited<ReturnType<typeof startServers>> | null} */
let servers = null;
/** @type {BrowserWindow | null} */
let win = null;

function showAddresses() {
  const addresses = localAddresses();
  const lines = [
    "To play together, you host a lobby in the game (Co-op > Host).",
    "Your friend opens this same program, picks Co-op > Server, and types one of these addresses:",
    "",
    ...addresses.map(address => `    ${address}${address.startsWith("26.") ? "    (Radmin VPN)" : ""}`),
    "",
    `Ports used: ${RELAY_PORT} (lobbies) and ${GAME_PORT} (game page, for friends who use a browser instead).`,
  ];
  if (servers?.relayError) {
    lines.push("", `Note: ${servers.relayError}`);
  }
  void dialog.showMessageBox(win ?? undefined, {
    type: "info",
    title: "Addresses for your friend",
    message: "Addresses for your friend",
    detail: lines.join("\n"),
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Game",
      submenu: [
        { label: "Addresses for my friend...", click: showAddresses },
        { type: "separator" },
        { label: "Fullscreen", accelerator: "F11", click: () => win?.setFullScreen(!win.isFullScreen()) },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
        { label: "Developer tools", accelerator: "F12", click: () => win?.webContents.toggleDevTools() },
        { type: "separator" },
        { label: "Quit", accelerator: "Alt+F4", role: "quit" },
      ],
    },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: "#000000",
    title: "PokeRogue Co-op",
    autoHideMenuBar: true,
    webPreferences: {
      // keep syncing with the partner when this window is not in front
      backgroundThrottling: false,
    },
  });
  win.setMenu(buildMenu());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://localhost:${GAME_PORT}/`);
  win.on("closed", () => {
    win = null;
  });
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      servers = await startServers({ gameDir, gamePort: GAME_PORT, relayPort: RELAY_PORT });
    } catch (error) {
      dialog.showErrorBox("PokeRogue Co-op", error.message);
      app.quit();
      return;
    }
    createWindow();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    void servers?.close();
  });
} else {
  app.quit();
}
