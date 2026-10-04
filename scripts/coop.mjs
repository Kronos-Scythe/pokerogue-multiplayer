// Starts everything needed to play co-op: the relay server and the game page.
// Usage: pnpm coop   (Ctrl+C stops both)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const relayPort = process.env.PORT ?? "8787";
const isWindows = process.platform === "win32";

// The relay has its own small package; install it the first time
if (!existsSync(join(serverDir, "node_modules"))) {
  console.log("[coop] Installing the relay's dependencies (first run only)...");
  const install = spawnSync("npm", ["install"], { cwd: serverDir, stdio: "inherit", shell: isWindows });
  if (install.status !== 0) {
    console.error("[coop] Could not install the relay's dependencies.");
    process.exit(1);
  }
}

const children = [
  spawn(process.execPath, ["index.mjs"], {
    cwd: serverDir,
    stdio: "inherit",
    env: { ...process.env, PORT: relayPort },
  }),
  // --host lets other computers (a friend over a VPN or LAN) open the page; --strictPort stops Vite from quietly
  // moving to another port (the friend would then be knocking on the wrong one)
  spawn("pnpm", ["exec", "vite", "--mode", "development", "--host", "--strictPort"], {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
  }),
];

const stopAll = () => {
  for (const child of children) {
    child.kill();
  }
};
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
for (const child of children) {
  child.on("exit", code => {
    if (code) {
      console.error(`[coop] A process stopped (exit code ${code}); stopping the other one too.`);
    }
    stopAll();
    process.exit(code ?? 0);
  });
}

// Tell the players which addresses to use
setTimeout(() => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter(net => net && net.family === "IPv4" && !net.internal)
    .map(net => net.address);
  console.log("\n[coop] ================ Co-op is running ================");
  console.log(
    "[coop] You:      open the game page (Vite prints its Local address above, usually http://localhost:8000)",
  );
  console.log("[coop]           and pick 'Co-op: host a game'.");
  for (const address of addresses) {
    console.log(`[coop] Friend:   http://${address}:<the same port>/   then 'Co-op: join a game'`);
  }
  console.log("[coop] Use the address that matches your VPN (for example Radmin/Hamachi/Tailscale).");
  console.log("[coop] The relay is on port " + relayPort + "; allow it and the game port through the firewall.");
  if (isWindows) {
    console.log(
      "[coop] If your friend's page loads forever, Windows Firewall is blocking it. In PowerShell as Administrator:",
    );
    console.log(
      `[coop]   New-NetFirewallRule -DisplayName "PokeRogue co-op" -Direction Inbound -Protocol TCP -LocalPort 8000,${relayPort} -Action Allow -Profile Any`,
    );
  }
  console.log("[coop] =======================================================\n");
}, 4000);
