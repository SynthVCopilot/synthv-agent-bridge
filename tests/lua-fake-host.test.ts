import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface LuaRun {
  readonly available: boolean;
  readonly status: number | null;
  readonly output: string;
}

let cachedRun: LuaRun | undefined;

function runFakeHost(): LuaRun {
  if (cachedRun !== undefined) {
    return cachedRun;
  }
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "synthv-v3-lua-fake-host-"),
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
        [path.resolve("scripts", "mock-synthv-smoke.lua")],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            SYNTHV_AGENT_BRIDGE_DIR: directory,
            BRIDGE_SCRIPT: path.resolve(
              "synthv",
              "SynthVAgentBridge.lua",
            ),
          },
        },
      );
      if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      cachedRun = {
        available: true,
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
      return cachedRun;
    }
    cachedRun = {
      available: false,
      status: null,
      output: "Lua 5.4 interpreter not found",
    };
    return cachedRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertMarker(
  context: { skip(message?: string): void },
  marker: string,
): void {
  const result = runFakeHost();
  if (!result.available) {
    context.skip(result.output);
    return;
  }
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`CASE:${marker}`, "u"));
}

test("Fake Host: shared Group content writes reject before Undo", (context) => {
  assertMarker(context, "shared-group-default-reject");
});

test("Fake Host: component build mismatch is rejected before action dispatch", (context) => {
  assertMarker(context, "build-mismatch-blocks-command");
});

test("Fake Host: isolated clone receives a different Group UUID", (context) => {
  assertMarker(context, "isolated-clone-uuid");
});

test("Fake Host: clearing an isolated clone leaves its source unchanged", (context) => {
  assertMarker(context, "clone-source-unchanged");
});

test("Fake Host: stale Automation rejects before Undo without raw fingerprints", (context) => {
  assertMarker(context, "stale-before-undo-and-redacted");
});

test("Fake Host: already-satisfied mixer command creates no Undo", (context) => {
  assertMarker(context, "already-satisfied-no-undo");
});

test("Fake Host: mixer emits bounded Lua command-stage timings", (context) => {
  assertMarker(context, "mixer-lua-stage-timings");
});

test("Fake Host: mixer completes its effect plan before Undo", (context) => {
  assertMarker(context, "mixer-effect-plan-before-undo");
});

test("Fake Host: focused mixer reads carry the Track guard for writeIntent Contexts", (context) => {
  assertMarker(context, "focused-mixer-write-context");
});

test("Fake Host: time-axis reads return independent bounded mark pages", (context) => {
  assertMarker(context, "query-time-axis-page");
});

test("Fake Host: Track and Note Group collections return bounded pages", (context) => {
  assertMarker(context, "query-track-page");
  assertMarker(context, "query-note-group-page");
});

test("Fake Host: computed data and Pitch Controls return bounded pages", (context) => {
  assertMarker(context, "query-track-notes-page");
  assertMarker(context, "query-track-group-page");
  assertMarker(context, "query-computed-page");
  assertMarker(context, "query-pitch-control-page");
});

test("Fake Host: compact Automation reads omit unrequested point arrays", (context) => {
  assertMarker(context, "query-automation-summary");
});

test("Fake Host: aggregate tuning uses one Undo for multiple curves", (context) => {
  assertMarker(context, "aggregate-tuning-single-undo");
});

test("Fake Host: dependent partial failure reports one Undo recovery", (context) => {
  assertMarker(context, "dependent-partial-write-undo");
});

test("Fake Host: closed Automation range verifies endpoint removal", (context) => {
  assertMarker(context, "automation-closed-range-postcondition");
});

test("Fake Host: closed Automation range includes the host-exclusive end", (context) => {
  assertMarker(context, "automation-closed-range-host-semantics");
});

test("Fake Host: postcondition fault injection fails with Undo guidance", (context) => {
  assertMarker(context, "write-postcondition-failure");
});

test("Fake Host: mutation fault injection requires one Undo recovery", (context) => {
  assertMarker(context, "mixer-mutation-failure-undo");
});
