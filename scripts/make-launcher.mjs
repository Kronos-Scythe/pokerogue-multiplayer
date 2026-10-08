// Packs PokeRogue co-op into a Windows desktop program with the game next to it, ready to zip and send:
//   pnpm coop:package               builds the game, then makes release/PokeRogue-Coop (+ a zip)
//   pnpm coop:package --skip-build  reuses the last build in dist/
//   pnpm coop:package --no-zip      leaves out the zip
// The program is an Electron window (desktop/main.mjs) that serves the game and runs the lobby relay inside itself.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const toolsDir = join(releaseDir, ".tools");
const packageDir = join(releaseDir, "PokeRogue-Coop");
const appName = "PokeRogue Co-op";
const exeName = `${appName}.exe`;
const electronVersion = "39.8.10";
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  console.log(`[package] ${command} ${args.join(" ")}`);
  // through the shell on Windows, so paths with spaces ("PokeRogue Co-op.exe") need quotes
  const quote = text => (isWindows && /\s/.test(text) ? `"${text}"` : text);
  const result = spawnSync(quote(command), args.map(quote), {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[package] Failed: ${command} ${args.join(" ")}`);
    process.exit(1);
  }
}

// A fresh clone has no dependencies yet, and the game's art and text live in submodules
if (!existsSync(join(root, "node_modules"))) {
  console.log("[package] Installing the game's dependencies first (one time, a few minutes)...");
  const install = spawnSync("pnpm", ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) {
    console.error("[package] pnpm install failed.");
    process.exit(1);
  }
}
if (!existsSync(join(root, "assets", "images")) || !existsSync(join(root, "locales", "en"))) {
  console.error("[package] The game's art and text are missing. Run this once, then try again:");
  console.error("[package]   git submodule update --init --recursive");
  process.exit(1);
}

if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["exec", "vite", "build", "--mode", "coop"]);
}
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("[package] There is no build in dist/ to pack: run without --skip-build.");
  process.exit(1);
}

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(toolsDir, { recursive: true });

// Tools used only for packing, kept out of the project's own dependencies
run(npm, ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", toolsDir, "esbuild", "@electron/packager"]);
const bin = name => join(toolsDir, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// 1. The program's own code (the window, the game server and the relay) in one file
const appDir = join(releaseDir, "app");
mkdirSync(appDir, { recursive: true });
run(bin("esbuild"), [
  "desktop/main.mjs",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--external:electron",
  `--outfile=${join(appDir, "main.cjs")}`,
]);
writeFileSync(
  join(appDir, "package.json"),
  JSON.stringify({ name: "pokerogue-coop", productName: appName, version: "1.0.0", main: "main.cjs" }, null, 2),
);

// 2. Electron for Windows with that code inside it
const buildDir = join(releaseDir, "build");
run(bin("electron-packager"), [
  appDir,
  appName,
  "--platform=win32",
  "--arch=x64",
  `--out=${buildDir}`,
  `--electron-version=${electronVersion}`,
  "--overwrite",
]);
const built = readdirSync(buildDir).find(name => name.startsWith(appName));
if (!built) {
  console.error("[package] The packager made nothing.");
  process.exit(1);
}
renameSync(join(buildDir, built), packageDir);

// 3. The game beside it (inside the program's resources folder), and a note
console.log("[package] Copying the game...");
cpSync(join(root, "dist"), join(packageDir, "resources", "game"), { recursive: true });
writeFileSync(
  join(packageDir, "READ ME.txt"),
  [
    "PokeRogue co-op",
    "",
    `Double-click "${exeName}". The game opens in its own window.`,
    "",
    "Host:   in the game choose Co-op > Host, and wait in your lobby.",
    "        Game menu > Addresses for my friend... shows what to send them.",
    "Friend: run the same program, choose Co-op > Server, type the host's address (for a VPN like Radmin,",
    "        the one starting with 26.), then pick the lobby in the list and press Join.",
    "",
    'Windows may ask to allow the program through the firewall: press "Allow access" (the host needs this).',
    "Windows may say the program is from an unknown publisher: More info > Run anyway.",
    "Press F11 for fullscreen. Close the window to quit.",
    "",
  ].join("\r\n"),
);

// 4. A zip to send
if (process.argv.includes("--no-zip")) {
  console.log(`[package] Done: ${packageDir}`);
} else {
  const zip = join(releaseDir, "PokeRogue-Coop.zip");
  rmSync(zip, { force: true });
  if (isWindows) {
    run("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${packageDir}' -DestinationPath '${zip}'`]);
  } else {
    run("zip", ["-r", "-q", "-1", zip, "PokeRogue-Coop"], { cwd: releaseDir });
  }
  console.log(`[package] Done: ${zip}`);
}
