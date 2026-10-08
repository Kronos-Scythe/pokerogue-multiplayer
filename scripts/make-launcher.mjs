// Packs the co-op launcher into a Windows program with the game next to it, ready to zip and send:
//   pnpm coop:package               builds the game, then makes release/PokeRogue-Coop (+ a zip)
//   pnpm coop:package --skip-build  reuses the last build in dist/
//   pnpm coop:package --no-zip      leaves out the zip
// The program is Node itself with the launcher inside it (a "single executable application"), so the game's files
// (hundreds of MB) stay in a folder beside it.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const toolsDir = join(releaseDir, ".tools");
const packageDir = join(releaseDir, "PokeRogue-Coop");
const exeName = "PokeRogue Co-op.exe";
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

if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["exec", "vite", "build", "--mode", "coop"]);
}
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("[package] There is no build in dist/ to pack: run without --skip-build.");
  process.exit(1);
}

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });
mkdirSync(toolsDir, { recursive: true });

// Tools used only for packing, kept out of the project's own dependencies
const toolPackages = ["esbuild", "postject"];
const nodeVersion = process.versions.node;
const installArgs = ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", toolsDir];
run(npm, [...installArgs, ...toolPackages]);
if (!isWindows) {
  // a Windows copy of the same Node version (the program embeds the launcher in a copy of Node);
  // --force because npm refuses Windows-only packages on other systems
  run(npm, [...installArgs, "--force", ...toolPackages, `node-win-x64@${nodeVersion}`]);
}
const bin = name => join(toolsDir, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

// 1. One file with the launcher and the relay's dependency in it
const bundle = join(releaseDir, "launcher.cjs");
run(bin("esbuild"), ["launcher/main.mjs", "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`]);

// 2. Turn it into a blob Node can run from inside itself
const blob = join(releaseDir, "launcher.blob");
const seaConfig = join(releaseDir, "sea-config.json");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. Copy Node for Windows and put the blob inside it
const exe = join(packageDir, exeName);
copyFileSync(isWindows ? process.execPath : join(toolsDir, "node_modules", "node-win-x64", "bin", "node.exe"), exe);
run(bin("postject"), [exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);

// 4. The game beside it, and a note
console.log("[package] Copying the game...");
cpSync(join(root, "dist"), join(packageDir, "game"), { recursive: true });
writeFileSync(
  join(packageDir, "READ ME.txt"),
  [
    "PokeRogue co-op",
    "",
    `Double-click "${exeName}". A window shows the addresses; the game opens in your browser.`,
    "",
    "Host:   in the game choose Co-op > Host, and wait in your lobby.",
    "Friend: run the same program, choose Co-op > Server, type the host's address (for a VPN like Radmin,",
    "        the one starting with 26.), then pick the lobby in the list and press Join.",
    "        (A friend can also just open http://<host address>:8000/ in a browser, with nothing installed.)",
    "",
    'Windows may ask to allow the program through the firewall: press "Allow access".',
    "Windows may say the program is from an unknown publisher: More info > Run anyway.",
    'Keep the "game" folder next to the program. Close the window to stop.',
    "",
  ].join("\r\n"),
);

// 5. A zip to send
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
