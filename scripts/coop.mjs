// Starts everything needed to play co-op: the relay server and the game page.
// Usage: pnpm coop          (Ctrl+C stops both)
//        pnpm coop:fast     (serves a built copy: much quicker to load for a friend over a VPN)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(root, "server");
const relayPort = process.env.PORT ?? "8787";
const isWindows = process.platform === "win32";

// A fresh clone has no dependencies yet, and the game's art and text live in submodules
if (!existsSync(join(root, "node_modules"))) {
  console.log("[coop] Installing the game's dependencies first (one time, a few minutes)...");
  const install = spawnSync("pnpm", ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) {
    console.error("[coop] pnpm install failed.");
    process.exit(1);
  }
}
if (!existsSync(join(root, "assets", "images")) || !existsSync(join(root, "locales", "en"))) {
  console.error("[coop] The game's art and text are missing. Run this once, then try again:");
  console.error("[coop]   git submodule update --init --recursive");
  process.exit(1);
}

// The relay has its own small package; install it the first time
if (!existsSync(join(serverDir, "node_modules"))) {
  console.log("[coop] Installing the relay's dependencies (first run only)...");
  const install = spawnSync("npm", ["install"], { cwd: serverDir, stdio: "inherit", shell: isWindows });
  if (install.status !== 0) {
    console.error("[coop] Could not install the relay's dependencies.");
    process.exit(1);
  }
}

// --fast: serve a built copy of the game instead of the dev server. The dev server sends thousands of small files,
// which is painfully slow (or never finishes) for a friend on a VPN; the built game is a handful of bundles.
const fast = process.argv.includes("--fast");
if (fast && !process.argv.includes("--skip-build")) {
  console.log("[coop] Building the game (about a minute; use --skip-build to reuse the last build)...");
  const build = spawnSync("pnpm", ["exec", "vite", "build", "--mode", "coop"], {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
  });
  if (build.status !== 0) {
    console.error("[coop] The build failed.");
    process.exit(1);
  }
}
if (fast && !existsSync(join(root, "dist", "index.html"))) {
  console.error("[coop] There is no build to serve yet: run without --skip-build.");
  process.exit(1);
}

const children = [
  spawn(process.execPath, ["index.mjs"], {
    cwd: serverDir,
    stdio: "inherit",
    env: { ...process.env, PORT: relayPort },
  }),
  // --host lets other computers (a friend over a VPN or LAN) open the page; --strictPort stops Vite from quietly
  // moving to another port (the friend would then be knocking on the wrong one)
  spawn(
    "pnpm",
    fast
      ? ["exec", "vite", "preview", "--mode", "coop", "--host", "--port", "8000", "--strictPort"]
      : ["exec", "vite", "--mode", "development", "--host", "--strictPort"],
    { cwd: root, stdio: "inherit", shell: isWindows },
  ),
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
setTimeout(
  () => {
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
    // Check each address the way a friend would reach it, so a problem shows up here and not as a blank page there
    const pagePort = Number(process.env.VITE_PORT ?? 8000);
    const probe = (host, port) =>
      new Promise(resolve => {
        const socket = connect({ host, port, timeout: 3000 });
        socket.once("connect", () => (socket.destroy(), resolve(true)));
        socket.once("timeout", () => (socket.destroy(), resolve(false)));
        socket.once("error", () => resolve(false));
      });
    const check = async () => {
      for (const address of addresses) {
        const page = await probe(address, pagePort);
        const relay = await probe(address, Number(relayPort));
        console.log(
          `[coop] Self-check ${address}: page(${pagePort}) ${page ? "OK" : "NOT REACHABLE"}, relay(${relayPort}) ${relay ? "OK" : "NOT REACHABLE"}`,
        );
      }
      console.log(
        "[coop] OK here still means 'reachable from this PC'. If your friend sees a blank page, send a screenshot of",
      );
      console.log(
        "[coop] their browser console (F12 > Console) and Network tab (red lines) so the real cause can be found.",
      );
    };
    void check();
  },
  fast ? 6000 : 4000,
);
