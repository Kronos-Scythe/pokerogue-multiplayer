// The game server and the relay, as a function so both the command line and the desktop app can start them.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, extname, join, normalize, sep } from "node:path";
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

/** The IPv4 addresses of this computer that other computers could use (VPN, LAN). */
export function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter(net => net && net.family === "IPv4" && !net.internal)
    .map(net => net.address);
}

/**
 * Serve the built game and run the lobby relay.
 * @param {{ gameDir: string, gamePort?: number, relayPort?: number }} options
 * @returns {Promise<{ gamePort: number, relayPort: number, relayError: string | null, close: () => Promise<void> }>}
 *   Rejects when the game page's port is taken. A taken relay port is not fatal (only the host needs the relay),
 *   it is reported in `relayError`.
 */
export function startServers({ gameDir, gamePort = 8000, relayPort = 8787 }) {
  if (!existsSync(join(gameDir, "index.html"))) {
    return Promise.reject(new Error(`Could not find the game in "${gameDir}".`));
  }
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

  return new Promise((resolve, reject) => {
    server.once("error", error => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `Port ${gamePort} is already in use. Is PokeRogue Co-op already open?`
            : `The game server could not start: ${error.message}`,
        ),
      );
    });
    server.listen(gamePort, "0.0.0.0", () => {
      let relay = null;
      let relayError = null;
      const done = () =>
        resolve({
          gamePort,
          relayPort,
          relayError,
          close: () =>
            Promise.all([
              new Promise(res => server.close(() => res())),
              relay ? relay.close() : Promise.resolve(),
            ]).then(() => undefined),
        });
      try {
        relay = createRelay({ port: relayPort, host: "0.0.0.0" });
        relay.wss.once("error", error => {
          relayError =
            error.code === "EADDRINUSE"
              ? `Port ${relayPort} is in use, so other players cannot join you through this program.`
              : `The relay could not start: ${error.message}`;
          relay = null;
          done();
        });
        relay.wss.once("listening", done);
      } catch (error) {
        relayError = `The relay could not start: ${error.message}`;
        done();
      }
    });
  });
}
