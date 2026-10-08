// Runs the game server and the lobby relay from a terminal, without the desktop app:
//   node launcher/main.mjs --game dist [--port 8000] [--relay-port 8787] [--no-open]
// (The desktop app in desktop/ does the same inside its own window.)
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { localAddresses, startServers } from "./server.mjs";

const argValue = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const gamePort = Number(argValue("port") ?? process.env.PORT ?? 8000);
const relayPort = Number(argValue("relay-port") ?? process.env.RELAY_PORT ?? 8787);
const gameDir = resolve(argValue("game") ?? join(dirname(process.execPath), "game"));

try {
  const running = await startServers({ gameDir, gamePort, relayPort });
  console.log("\n=========== PokeRogue co-op ===========");
  console.log(`The game is running. Open:  http://localhost:${running.gamePort}/`);
  console.log("Your addresses (for a VPN like Radmin, the one starting with 26.):");
  for (const address of localAddresses()) {
    console.log(`  ${address}`);
  }
  console.log(`Ports: ${running.gamePort} (game page) and ${running.relayPort} (lobbies).`);
  if (running.relayError) {
    console.log(`Note: ${running.relayError}`);
  }
  console.log("=======================================\n");
  if (!process.argv.includes("--no-open")) {
    const url = `http://localhost:${running.gamePort}/`;
    const command =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(command[0], command[1], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  }
} catch (error) {
  console.error(`\n[coop] ${error.message}\n`);
  process.exitCode = 1;
}
