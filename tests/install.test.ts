import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("core-only installation omits the optional sidebar without deleting one", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, "scripts");
  const ipcDirectory = path.join(fixture, "ipc");
  const installer = fileURLToPath(
    new URL("../../scripts/install-synthv-bridge.mjs", import.meta.url),
  );
  const runInstaller = () =>
    spawnSync(
      process.execPath,
      [
        installer,
        "--target",
        target,
        "--no-reload",
        "--without-sidebar",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory,
        },
      },
    );

  const first = runInstaller();
  assert.equal(first.status, 0, first.stderr);
  const installedDirectory = path.join(target, "SynthV Agent Bridge");
  await access(path.join(installedDirectory, "SynthVAgentBridge.lua"));
  await access(path.join(installedDirectory, "StopSynthVAgentBridge.lua"));
  await assert.rejects(
    access(path.join(installedDirectory, "SynthVAgentSidebar.lua")),
    { code: "ENOENT" },
  );
  assert.match(first.stdout, /Skipped the optional side-panel script/u);
  assert.match(first.stdout, /The Bridge runtime changed/u);
  assert.match(first.stdout, /Scripts → Rescan/u);

  const sidebarPath = path.join(
    installedDirectory,
    "SynthVAgentSidebar.lua",
  );
  await writeFile(sidebarPath, "existing optional sidebar\n", "utf8");
  const second = runInstaller();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await readFile(sidebarPath, "utf8"),
    "existing optional sidebar\n",
  );
  assert.doesNotMatch(second.stdout, /The Bridge runtime changed/u);
});
