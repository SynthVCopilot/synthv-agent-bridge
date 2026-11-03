#!/usr/bin/env node

// One-command update for a git checkout: fast-forward the current branch,
// reinstall dependencies, rebuild, and reinstall the SynthV scripts where they
// were last installed. It never stashes, resets, or rewrites local work.

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(
    "Usage: npm run update -- [--target <SynthV scripts directory>] [--without-sidebar] [--no-reload] [--force] [--dry-run]\n" +
      "Without --target, the scripts are reinstalled where npm run install:synthv last put them.",
  );
}

const argumentsList = process.argv.slice(2);
function flagValue(name) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return undefined;
  const value = argumentsList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    usage();
    process.exit(2);
  }
  return value;
}

const dryRun = argumentsList.includes("--dry-run");
const force = argumentsList.includes("--force");
const noReload = argumentsList.includes("--no-reload");
const withoutSidebarFlag = argumentsList.includes("--without-sidebar");
const repositoryRoot = path.resolve(
  flagValue("--repository") ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function git(args) {
  return spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function gitOutput(args) {
  const result = git(args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, label) {
  console.log(`> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0;
}

// Prefer the npm that launched this script; fall back to npm on PATH.
function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && npmCli.endsWith(".js")) {
    return run(process.execPath, [npmCli, ...args], `npm ${args.join(" ")}`);
  }
  console.log(`> npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

async function readPackageVersion() {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  return manifest.version;
}

// The installer records where it put the scripts and which files it copied.
async function readLastInstall() {
  const ipcDirectory = path.resolve(
    process.env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || os.tmpdir(),
  );
  try {
    const manifest = JSON.parse(
      await readFile(
        path.join(ipcDirectory, "synthv-agent-bridge.install.json"),
        "utf8",
      ),
    );
    if (typeof manifest.scriptFile !== "string") return null;
    return {
      target: path.dirname(path.dirname(manifest.scriptFile)),
      sidebar: Object.hasOwn(
        manifest.installedFiles ?? {},
        "SynthVAgentSidebar.lua",
      ),
    };
  } catch {
    return null;
  }
}

if (gitOutput(["rev-parse", "--is-inside-work-tree"]) !== "true") {
  fail(`${repositoryRoot} is not a git checkout; update it by cloning the repository again.`);
}
const changes = gitOutput(["status", "--porcelain", "--untracked-files=no"]);
if (changes === null || changes.length > 0) {
  fail("The checkout has uncommitted changes. Commit or stash them, then run npm run update again. Nothing was changed.");
}
const upstream = gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
if (upstream === null) {
  fail("The current branch has no upstream branch to update from. Check out the main branch, then run npm run update again.");
}

const beforeCommit = gitOutput(["rev-parse", "HEAD"]);
const beforeVersion = await readPackageVersion();
const explicitTarget =
  flagValue("--target") ?? (process.env.SYNTHV_SCRIPTS_DIR?.trim() || undefined);
const lastInstall = explicitTarget === undefined ? await readLastInstall() : null;
const installTarget = explicitTarget ?? lastInstall?.target;
const withoutSidebar =
  withoutSidebarFlag || (lastInstall !== null && !lastInstall.sidebar);

if (dryRun) {
  console.log(`Would fast-forward ${upstream} into ${repositoryRoot} (now ${beforeVersion}, ${beforeCommit.slice(0, 7)}).`);
  console.log("Would run npm ci and npm run build.");
  console.log(
    installTarget === undefined
      ? "Would skip reinstalling the SynthV scripts: no install location is known."
      : `Would reinstall the SynthV scripts into ${installTarget}${withoutSidebar ? " without the side panel" : ""}.`,
  );
  process.exit(0);
}

if (!run("git", ["-C", repositoryRoot, "pull", "--ff-only"], `git pull --ff-only (${upstream})`)) {
  fail("git pull --ff-only failed: the branch has diverged or the network is unavailable. Nothing was rebuilt.");
}
const afterCommit = gitOutput(["rev-parse", "HEAD"]);
const afterVersion = await readPackageVersion();
if (afterCommit === beforeCommit && !force) {
  console.log(`Already up to date (${afterVersion}, ${afterCommit.slice(0, 7)}). Pass --force to rebuild and reinstall anyway.`);
  process.exit(0);
}

if (!runNpm(["ci", "--no-audit", "--no-fund"])) {
  fail("npm ci failed. The checkout was updated; fix the error, then run npm run update -- --force.");
}
if (!runNpm(["run", "build"])) {
  fail("npm run build failed. The checkout was updated; fix the error, then run npm run update -- --force.");
}

let reinstalled = false;
if (installTarget === undefined) {
  console.log(
    "Skipped reinstalling the SynthV scripts because no install location is known. Run npm run install:synthv -- --target <SynthV scripts directory>.",
  );
} else {
  const installerArguments = [
    path.join(repositoryRoot, "scripts", "install-synthv-bridge.mjs"),
    "--target",
    installTarget,
    ...(withoutSidebar ? ["--without-sidebar"] : []),
    ...(noReload ? ["--no-reload"] : []),
  ];
  if (!run(process.execPath, installerArguments, `install SynthV scripts into ${installTarget}`)) {
    fail("Reinstalling the SynthV scripts failed. The build is current; rerun npm run install:synthv -- --target <SynthV scripts directory>.");
  }
  reinstalled = true;
}

console.log(
  `Updated ${beforeVersion} (${beforeCommit.slice(0, 7)}) to ${afterVersion} (${afterCommit.slice(0, 7)}).`,
);
console.log(
  reinstalled
    ? "Follow any SynthV Rescan instruction above, then reconnect your MCP host so it loads the new build. Run npm run doctor to confirm."
    : "Reconnect your MCP host so it loads the new build, then run npm run doctor to confirm.",
);
