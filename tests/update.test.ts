import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const gitAvailable = spawnSync("git", ["--version"]).status === 0;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c", "user.name=Update Test",
      "-c", "user.email=update-test@example.invalid",
      "-c", "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writePackage(directory: string, version: string): Promise<void> {
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: "update-fixture",
      version,
      private: true,
      scripts: { build: "node build.mjs" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "package-lock.json"),
    `${JSON.stringify({
      name: "update-fixture",
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "update-fixture", version } },
    }, null, 2)}\n`,
  );
}

// A remote with one released commit, a clone of it, and a newer pushed commit.
async function createFixture(): Promise<{
  readonly root: string;
  readonly seed: string;
  readonly clone: string;
  readonly ipc: string;
  readonly scripts: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthv-update-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  const ipc = path.join(root, "ipc");
  const scripts = path.join(root, "SynthV scripts");
  git(root, "init", "--bare", "-b", "main", origin);
  await mkdir(path.join(seed, "scripts"), { recursive: true });
  git(seed, "init", "-b", "main");
  await writePackage(seed, "1.0.0");
  await writeFile(
    path.join(seed, ".gitignore"),
    "node_modules/\nbuilt.txt\ninstalled.json\n",
  );
  await writeFile(
    path.join(seed, "build.mjs"),
    "import { readFileSync, writeFileSync } from 'node:fs';\n" +
      "writeFileSync('built.txt', JSON.parse(readFileSync('package.json', 'utf8')).version);\n",
  );
  await writeFile(
    path.join(seed, "scripts", "install-synthv-bridge.mjs"),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync('installed.json', JSON.stringify(process.argv.slice(2)));\n",
  );
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Release 1.0.0");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "main");
  git(root, "clone", origin, clone);
  await writePackage(seed, "1.0.1");
  git(seed, "commit", "-am", "Release 1.0.1");
  git(seed, "push", "origin", "main");
  await mkdir(ipc, { recursive: true });
  await writeFile(
    path.join(ipc, "synthv-agent-bridge.install.json"),
    JSON.stringify({
      schemaVersion: 2,
      scriptFile: path.join(scripts, "SynthV Agent Bridge", "SynthVAgentBridge.lua"),
      installedFiles: { "SynthVAgentBridge.lua": "a", "StopSynthVAgentBridge.lua": "b" },
    }),
  );
  return { root, seed, clone, ipc, scripts };
}

function runUpdate(clone: string, ipc: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [path.resolve("scripts", "update.mjs"), "--repository", clone, ...extra],
    {
      encoding: "utf8",
      env: { ...process.env, SYNTHV_AGENT_BRIDGE_DIR: ipc, SYNTHV_SCRIPTS_DIR: "" },
    },
  );
}

test("update fast-forwards, rebuilds and reinstalls where the scripts were last installed", { skip: !gitAvailable }, async () => {
  const fixture = await createFixture();
  try {
    const result = runUpdate(fixture.clone, fixture.ipc);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(git(fixture.clone, "rev-parse", "HEAD"), git(fixture.seed, "rev-parse", "HEAD"));
    assert.equal(await readFile(path.join(fixture.clone, "built.txt"), "utf8"), "1.0.1");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(fixture.clone, "installed.json"), "utf8")),
      ["--target", fixture.scripts, "--without-sidebar"],
    );
    assert.match(result.stdout, /Updated 1\.0\.0 \([0-9a-f]{7}\) to 1\.0\.1/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("update refuses a checkout with uncommitted changes and leaves it untouched", { skip: !gitAvailable }, async () => {
  const fixture = await createFixture();
  try {
    const before = git(fixture.clone, "rev-parse", "HEAD");
    await writeFile(path.join(fixture.clone, "build.mjs"), "// local edit\n");
    const result = runUpdate(fixture.clone, fixture.ipc);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uncommitted changes/u);
    assert.equal(git(fixture.clone, "rev-parse", "HEAD"), before);
    assert.equal(await readFile(path.join(fixture.clone, "build.mjs"), "utf8"), "// local edit\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("update stops without rebuilding when the checkout is already current", { skip: !gitAvailable }, async () => {
  const fixture = await createFixture();
  try {
    git(fixture.clone, "pull", "--ff-only");
    const result = runUpdate(fixture.clone, fixture.ipc);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Already up to date \(1\.0\.1/u);
    assert.equal(existsSync(path.join(fixture.clone, "built.txt")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("update dry run reports the plan without changing the checkout", { skip: !gitAvailable }, async () => {
  const fixture = await createFixture();
  try {
    const before = git(fixture.clone, "rev-parse", "HEAD");
    const result = runUpdate(fixture.clone, fixture.ipc, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would reinstall the SynthV scripts into .* without the side panel/u);
    assert.equal(git(fixture.clone, "rev-parse", "HEAD"), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
