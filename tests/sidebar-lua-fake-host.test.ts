import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function runSidebarFakeHost(
  context: { skip(message?: string): void },
  extraEnvironment: NodeJS.ProcessEnv = {},
): string | undefined {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "synthv-v3-sidebar-fake-host-"),
  );
  try {
    for (const executable of [
      process.env.SYNTHV_AGENT_LUA54,
      "lua54",
      "lua5.4",
      "lua",
    ]) {
      if (executable === undefined || executable.length === 0) {
        continue;
      }
      const result = spawnSync(
        executable,
        [path.resolve("scripts", "mock-synthv-sidebar-smoke.lua")],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...extraEnvironment,
            SYNTHV_AGENT_BRIDGE_DIR: directory,
            SIDEBAR_SCRIPT: path.resolve(
              "synthv",
              "SynthVAgentSidebar.lua",
            ),
          },
        },
      );
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, output);
      return output;
    }
    context.skip("Lua 5.4 interpreter not found");
    return undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Sidebar Fake Host exercises the native panel lifecycle", (context) => {
  const output = runSidebarFakeHost(context);
  if (output !== undefined) {
    assert.match(output, /Mock SynthV sidebar smoke test passed/u);
  }
});

test("Sidebar retries a Bridge badge update after a transient widget failure", (context) => {
  const output = runSidebarFakeHost(context, {
    SIDEBAR_TEST_FAIL_BRIDGE_STATUS_ONCE: "1",
  });
  if (output !== undefined) {
    assert.match(output, /CASE:sidebar-bridge-status-retried/u);
  }
});
