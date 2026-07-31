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

test("Fake Host: protocol v1 and v2 fail with PROTOCOL_MISMATCH", (context) => {
  assertMarker(context, "protocol-v1-v2-rejected");
});

test("CLN-001: linked reference keeps its Group UUID and increments reference count", (context) => {
  assertMarker(context, "cln-001-linked-reference");
});

test("CLN-002: isolated clone has a distinct UUID and one reference", (context) => {
  assertMarker(context, "cln-002-isolated-reference");
});

test("CLN-003: deleting the isolated clone note leaves source notes unchanged", (context) => {
  assertMarker(context, "cln-003-isolated-note-delete");
});

test("CLN-004: isolated Automation mutation leaves the source curve unchanged", (context) => {
  assertMarker(context, "cln-004-isolated-automation");
});

test("CLN-005: ambiguous non-main Track clone rejects before Undo", (context) => {
  assertMarker(context, "cln-005-ambiguous-track-clone");
});

test("CLN-006: Track shell is verified empty without changing its source", (context) => {
  assertMarker(context, "cln-006-empty-track-shell");
});

test("Fake Host: clone source snapshots fail closed on authoritative getter failures", (context) => {
  assertMarker(context, "clone-source-snapshot-getter-failure");
});

test("Fake Host: Track shell preflight fails closed on authoritative getter failures", (context) => {
  assertMarker(context, "clone-shell-preflight-getter-failure");
});

test("Fake Host: Track shell postconditions fail closed with Undo guidance on authoritative getter failures", (context) => {
  assertMarker(context, "clone-shell-postcondition-getter-failure");
});

test("CLN-007: detached Vocal state requires manual review without identity claims", (context) => {
  assertMarker(context, "cln-007-manual-vocal-review");
});

test("Fake Host: isolated clone preserves source notes, Automation, and Smart Pitch", (context) => {
  assertMarker(context, "clone-source-snapshot-unchanged");
});

test("Fake Host: stale Automation rejects before Undo without raw fingerprints", (context) => {
  assertMarker(context, "stale-before-undo-and-redacted");
});

test("Fake Host: already-satisfied mixer command creates no Undo", (context) => {
  assertMarker(context, "already-satisfied-no-undo");
});

test("SAF-007: already-satisfied note edit creates no Undo", (context) => {
  assertMarker(context, "note-edit-already-satisfied");
});

test("SAF-008: ignored note setter fails its postcondition with Undo guidance", (context) => {
  assertMarker(context, "note-edit-postcondition-failure");
});

test("SAF-008: ignored note deletion fails its postcondition with Undo guidance", (context) => {
  assertMarker(context, "note-delete-postcondition-failure");
});

test("SAF-008: note deletion verifies remaining note order", (context) => {
  assertMarker(context, "note-delete-order-postcondition");
});

test("CMD-005: rounded identity transform returns alreadySatisfied without Undo", (context) => {
  assertMarker(context, "note-transform-already-satisfied");
});

test("CMD-006: ignored transformed value fails through the note postcondition", (context) => {
  assertMarker(context, "note-transform-postcondition-failure");
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

test("CMD-005: standalone Smart Pitch no-op creates no Undo", (context) => {
  assertMarker(context, "pitch-control-already-satisfied");
});

test("CMD-005: Automation set no-op creates no Undo", (context) => {
  assertMarker(context, "automation-set-already-satisfied");
});

test("CMD-005: Automation clear no-op creates no Undo", (context) => {
  assertMarker(context, "automation-clear-already-satisfied");
});

test("CMD-005: Automation simplify no-op creates no Undo", (context) => {
  assertMarker(context, "automation-simplify-already-satisfied");
});

test("CMD-006: standalone Smart Pitch addition verifies complete Group content", (context) => {
  assertMarker(context, "pitch-control-add-postcondition-failure");
});

test("CMD-006: standalone Smart Pitch edit verifies complete Group content", (context) => {
  assertMarker(context, "pitch-control-edit-postcondition-failure");
});

test("CMD-006: standalone Smart Pitch deletion verifies complete Group content", (context) => {
  assertMarker(context, "pitch-control-delete-postcondition-failure");
});

test("Fake Host: aggregate tuning uses one Undo for multiple curves", (context) => {
  assertMarker(context, "aggregate-tuning-single-undo");
});

test("AUT-004: aggregate tuning includes Smart Pitch in the same Undo", (context) => {
  assertMarker(context, "aggregate-tuning-smart-pitch");
});

test("CMD-001: aggregate tuning uses the authoritative command-stage order", (context) => {
  assertMarker(context, "aggregate-tuning-pipeline-stages");
});

test("CMD-005: already-satisfied aggregate tuning creates no Undo", (context) => {
  assertMarker(context, "aggregate-tuning-already-satisfied");
});

test("CMD-006: aggregate note postcondition failure requires one Undo", (context) => {
  assertMarker(context, "aggregate-tuning-postcondition-failure");
});

test("CMD-005: an already-satisfied transaction creates no Undo", (context) => {
  assertMarker(context, "transaction-already-satisfied");
});

test("SAF-006: dependent failure after a no-op step requires no Undo", (context) => {
  assertMarker(context, "transaction-dependent-no-write-failure");
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
