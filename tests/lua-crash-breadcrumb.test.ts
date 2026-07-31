import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const probes = [
  {
    mode: "clone_group_reference.addGroupReference",
    exitCode: 86,
    checkpoint: "mutate.addGroupReference.before",
  },
  {
    mode: "clone_group_reference.verifySourceAutomation",
    exitCode: 87,
    checkpoint:
      "freshRead.sourceSnapshot.automation.loudness.getAllPoints.before",
  },
  {
    mode: "clone_group_reference.verifyReferenceFingerprint",
    exitCode: 88,
    checkpoint: "verify.referenceFingerprint.before",
  },
  {
    mode: "clone_group_reference.verifyVocalModeAutomation",
    exitCode: 89,
    checkpoint:
      "freshRead.sourceSnapshot.automation.vocalMode.getAllPoints.before",
    forbiddenText: "SensitiveStyleName",
  },
] as const;

for (const probe of probes) {
  test(`Lua crash probe preserves the last checkpoint for ${probe.mode}`, (context) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "synthv-v3-lua-crash-probe-"),
    );
    try {
      let executed = false;
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
          [path.resolve("scripts", "mock-synthv-smoke.lua")],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              SYNTHV_AGENT_BRIDGE_DIR: directory,
              SYNTHV_AGENT_CRASH_PROBE: probe.mode,
              BRIDGE_SCRIPT: path.resolve(
                "synthv",
                "SynthVAgentBridge.lua",
              ),
            },
          },
        );
        if (
          (result.error as NodeJS.ErrnoException | undefined)?.code ===
          "ENOENT"
        ) {
          continue;
        }
        executed = true;
        assert.equal(
          result.status,
          probe.exitCode,
          `${result.stdout}${result.stderr}`,
        );
        const breadcrumbPath = path.join(
          directory,
          "synthv-agent-bridge.crash-breadcrumb.json",
        );
        assert.equal(
          existsSync(breadcrumbPath),
          true,
          `the executor exited during ${probe.mode} without a crash breadcrumb`,
        );
        const breadcrumb = JSON.parse(
          readFileSync(breadcrumbPath, "utf8"),
        ) as Record<string, unknown>;
        assert.deepEqual(Object.keys(breadcrumb).sort(), [
          "action",
          "checkpoint",
          "executorBuildId",
          "schemaVersion",
          "sessionToken",
          "traceId",
          "updatedAtEpochMs",
        ]);
        assert.equal(breadcrumb.schemaVersion, 1);
        assert.equal(breadcrumb.action, "clone_group_reference");
        assert.equal(breadcrumb.checkpoint, probe.checkpoint);
        assert.match(String(breadcrumb.traceId), /^trace-\d{12}$/u);
        if ("forbiddenText" in probe) {
          assert.doesNotMatch(
            JSON.stringify(breadcrumb),
            new RegExp(probe.forbiddenText, "u"),
          );
        }
        break;
      }
      if (!executed) {
        context.skip("Lua 5.4 interpreter not found");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("clone verification does not reread GroupContent through a post-mutation proxy", (context) => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "synthv-v3-lua-stale-proxy-"),
  );
  try {
    let executed = false;
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
        [path.resolve("scripts", "mock-synthv-smoke.lua")],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            SYNTHV_AGENT_BRIDGE_DIR: directory,
            SYNTHV_AGENT_STALE_PROXY_GUARD:
              "clone_group_reference",
            SYNTHV_AGENT_STALE_TRACK_PROXY_GUARD:
              "clone_group_reference",
            SYNTHV_AGENT_NIL_INSERTION_INDEX_GUARD:
              "clone_group_reference",
            BRIDGE_SCRIPT: path.resolve(
              "synthv",
              "SynthVAgentBridge.lua",
            ),
          },
        },
      );
      if (
        (result.error as NodeJS.ErrnoException | undefined)?.code ===
        "ENOENT"
      ) {
        continue;
      }
      executed = true;
      assert.equal(
        result.status,
        0,
        `${result.stdout}${result.stderr}`,
      );
      assert.match(
        result.stdout,
        /CASE:cln-001-linked-reference/u,
      );
      assert.match(
        result.stdout,
        /CASE:cln-002-isolated-reference/u,
      );
      break;
    }
    if (!executed) {
      context.skip("Lua 5.4 interpreter not found");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
