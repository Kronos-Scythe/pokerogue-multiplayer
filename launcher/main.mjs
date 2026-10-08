// The co-op launcher: serves the built game and runs the relay in one program, so hosting is "run this".
// As a plain script:  node launcher/main.mjs --game dist
// As the packaged exe: it looks for a `game` folder next to itself (see scripts/make-launcher.mjs).
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { createRelay } from "../server/relay.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".xml", ".txt", ".webmanifest"]);

const argValue = name => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const gamePort = Number(argValue("port") ?? process.env.PORT ?? 8000);
const relayPort = Number(argValue("relay-port") ?? process.env.RELAY_PORT ?? 8787);
const gameDir = resolve(argValue("game") ?? join(dirname(process.execPath), "game"));
const openBrowser = !process.argv.includes("--no-open");

/** Show a problem and keep the window open long enough to read it (double-clicked programs close at once). */
function fatal(message) {
  console.error(`\n[coop] ${message}\n`);
  console.error("[coop] This window closes in 30 seconds.");
  setTimeout(() => process.exit(1), 30_000);
}

if (existsSync(join(gameDir, "index.html"))) {
  start();
} else {
  fatal(`Could not find the game in "${gameDir}". Keep the "game" folder next to this program.`);
}

function start() {
  const gzipCache = new Map();

  const server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const target = normalize(join(gameDir, pathname === "/" ? "index.html" : pathname));
    // never leave the game folder
    if (target !== gameDir && !target.startsWith(gameDir + sep)) {
      res.writeHead(403).end();
      return;
    }
    let stats;
    try {
      stats = statSync(target);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (!stats.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    const ext = extname(target).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // the game files do not change while this runs
      "Cache-Control": basename(target) === "index.html" ? "no-cache" : "public, max-age=86400",
    };
    const wantsGzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"]));
    if (wantsGzip && stats.size < 32 * 1024 * 1024) {
      let body = gzipCache.get(target);
      if (!body) {
        body = gzipSync(readFileSync(target));
        gzipCache.set(target, body);
      }
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stats.size });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  });

  server.on("error", error => {
    fatal(
      error.code === "EADDRINUSE"
        ? `Port ${gamePort} is already in use. Is the launcher already running? Close it, or run with --port <number>.`
        : `The game server could not start: ${error.message}`,
    );
  });

  const relay = createRelay({ port: relayPort, host: "0.0.0.0" });
  relay.wss.on("error", error => {
    fatal(
      error.code === "EADDRINUSE"
        ? `Port ${relayPort} is already in use. Is the launcher already running? Close it, or run with --relay-port <number>.`
        : `The relay could not start: ${error.message}`,
    );
  });

  server.listen(gamePort, "0.0.0.0", () => {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter(net => net && net.family === "IPv4" && !net.internal)
      .map(net => net.address);
    console.log("\n=========== PokeRogue co-op ===========");
    console.log(`The game is running. Open:  http://localhost:${gamePort}/`);
    console.log("\nPlaying together:");
    console.log(`  1. In the game choose "Co-op", then "Host", and wait in your lobby.`);
    console.log("  2. Your friend does ONE of these:");
    console.log(`     - runs this same program, chooses "Co-op" > "Server" and types one of your addresses below`);
    console.log(`     - or just opens  http://<one of your addresses>:${gamePort}/  in a browser (nothing to install)`);
    console.log("\nYour addresses (for a VPN like Radmin, use the one that starts with 26. or the VPN's):");
    for (const address of addresses) {
      console.log(`  ${address}${address.startsWith("26.") ? "   <- Radmin VPN" : ""}`);
    }
    console.log(
      `\nPorts used: ${gamePort} (game page) and ${relayPort} (lobbies). If Windows asks, press "Allow access".`,
    );
    console.log("Close this window to stop.");
    console.log("=======================================\n");
    if (openBrowser) {
      launchBrowser(`http://localhost:${gamePort}/`);
    }
  });
}

function launchBrowser(url) {
  try {
    const command =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(command[0], command[1], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // the player can open the address themselves
  }
}
