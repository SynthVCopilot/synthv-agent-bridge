import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  BUILD_IDENTITY,
  EXECUTOR_BUILD_ID,
  SIDEBAR_BUILD_ID,
} from "../src/build-info.js";
import { BridgeError } from "../src/errors.js";
import {
  commandOutcome,
  currentTraceId,
  failedOutcome,
  runWithTrace,
  traceDiagnostics,
  traceStage,
} from "../src/v3-command-kernel.js";
import { V3ContextStore } from "../src/v3-context-store.js";
import { V3SnapshotCache } from "../src/v3-snapshot-cache.js";

function emptyContext(mode: "readOnly" | "writeIntent") {
  return {
    mode,
    sourceAction: "get_track_mixer",
    targetKind: "track" as const,
    trackIndex: 1,
    trackFingerprint: "private-track-fingerprint",
    noteFingerprints: new Map<number, string>(),
    pitchControlFingerprints: new Map<number, string>(),
    automationFingerprints: new Map<string, string>(),
  };
}

test("local builds capture the current Git commit in Build Identity", () => {
  const expectedCommit = execFileSync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  ).trim();

  assert.equal(BUILD_IDENTITY.gitCommit, expectedCommit);
});

test("component Build IDs derive from the exact Lua source fingerprints", () => {
  assert.equal(
    EXECUTOR_BUILD_ID,
    `sv3-lua-${BUILD_IDENTITY.version}-${BUILD_IDENTITY.executor.sourceFingerprint.slice(0, 12)}`,
  );
  assert.equal(
    SIDEBAR_BUILD_ID,
    `sv3-sidebar-${BUILD_IDENTITY.version}-${BUILD_IDENTITY.sidebar.sourceFingerprint.slice(0, 12)}`,
  );
});

test("v3 read-only contexts cannot authorize a command", () => {
  const contexts = new V3ContextStore();
  const readOnly = contexts.issue(emptyContext("readOnly"));
  assert.throws(
    () => contexts.resolve(readOnly, "writeIntent"),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "CONTEXT_NOT_WRITE_CAPABLE",
  );

  const writeIntent = contexts.issue(emptyContext("writeIntent"));
  assert.equal(contexts.resolve(writeIntent, "writeIntent").mode, "writeIntent");
});

test("v3 command outcomes distinguish changes from already-satisfied state", async () => {
  await runWithTrace(async () => {
    const changed = commandOutcome("set_track_mixer", {
      changedCount: 2,
      undoRecordCount: 1,
      verified: true,
    });
    assert.equal(changed.outcome, "changed");
    assert.equal(changed.changedCount, 2);
    assert.equal(changed.undoRecords, 1);

    const alreadySatisfied = commandOutcome("set_track_mixer", {
      changedCount: 0,
      undoRecordCount: 0,
      verified: true,
    });
    assert.equal(alreadySatisfied.outcome, "alreadySatisfied");
    assert.equal(alreadySatisfied.changedCount, 0);
    assert.equal(alreadySatisfied.undoRecords, 0);

    const bounded = commandOutcome("set_track_mixer", {
      changedCount: 1,
      undoRecordCount: 1,
      verified: true,
      warnings: Array.from({ length: 100 }, () => "w".repeat(10_000)),
    });
    assert.ok(JSON.stringify(bounded).length <= 2_048);
  });
});

test("v3 public stale errors stay bounded and redact raw project fingerprints", async () => {
  await runWithTrace(async () => {
    const rawFingerprint = `group|${"private-note-data".repeat(20_000)}`;
    const failure = failedOutcome(
      new BridgeError(
        "The Automation curve changed",
        "STALE_AUTOMATION",
        {
          expected: rawFingerprint,
          actual: `${rawFingerprint}-changed`,
          points: Array.from({ length: 500 }, (_, index) => [index, index]),
          undoRequired: false,
        },
      ),
      "guarded",
    );
    const serialized = JSON.stringify(failure);
    assert.ok(serialized.length < 4_096);
    assert.doesNotMatch(serialized, /private-note-data/u);
    assert.doesNotMatch(serialized, /"points":\[/u);
    assert.equal(failure.outcome, "failed");
    assert.equal(failure.retry, "query_again");

    const shortFingerprint = failedOutcome(
      new BridgeError("changed", "STALE_NOTE", {
        expected: "note|private-short-fingerprint",
        actual: "note|changed-short-fingerprint",
      }),
      "guarded",
    );
    assert.doesNotMatch(
      JSON.stringify(shortFingerprint),
      /private-short-fingerprint/u,
    );
  });
});

test("v3 applies the public error size budget to non-sensitive diagnostic fields", async () => {
  await runWithTrace(async () => {
    const failure = failedOutcome(
      new BridgeError("x".repeat(10_000), "INTERNAL_ERROR", {
        diagnostics: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, index) => [
            `field${index}`,
            `value-${index}`,
          ]),
        ),
      }),
      "mutated",
    );
    assert.ok(JSON.stringify(failure).length <= 4_096);
  });
});

test("v3 partial-write failures always require one explicit Undo recovery", async () => {
  await runWithTrace(async () => {
    const failure = failedOutcome(
      new BridgeError(
        "A dependent command failed",
        "HOST_POSTCONDITION_FAILED",
        {
          partialWritePossible: true,
          undoRequired: true,
        },
      ),
      "verified",
    );
    assert.equal(failure.wrote, true);
    assert.equal(failure.undoRequired, true);
    assert.equal(failure.retry, "undo_once_then_query_again");
  });
});

test("v3 diagnostics are explicit, bounded, and redact non-telemetry metadata", async () => {
  let traceId = "";
  await runWithTrace(async () => {
    traceId = currentTraceId() ?? "";
    traceStage("freshRead", {
      action: "get_phrase_context",
      responseBytes: 512,
      lyrics: "private project lyrics",
    });
    traceStage("verified", {
      durationMs: 3.5,
      fingerprint: "private-fingerprint",
    });
  });

  const support = traceDiagnostics({
    level: "support",
    traceId,
    limit: 1,
  });
  const debug = traceDiagnostics({
    level: "debug",
    traceId,
    limit: 1,
  });
  const supportText = JSON.stringify(support);
  const debugText = JSON.stringify(debug);

  assert.equal(support.level, "support");
  assert.equal(debug.level, "debug");
  assert.match(supportText, /freshRead/u);
  assert.match(debugText, /get_phrase_context/u);
  assert.doesNotMatch(supportText, /private project lyrics|private-fingerprint/u);
  assert.doesNotMatch(debugText, /private project lyrics|private-fingerprint/u);
  assert.ok(supportText.length <= 8_192);
  assert.ok(debugText.length <= 16_384);
});

test("v3 snapshot cache is session/reference/projection scoped and disposable", () => {
  const cache = new V3SnapshotCache(2, 10_000, 1_000);
  const identity = {
    sessionToken: "session-a",
    targetKind: "ComputedPerformance",
    locator: "track:1/reference:2",
    projection: "computedPitch",
    dependencyDigest: "guard-a",
  };
  cache.set(identity, { frames: [1, 2, 3] }, 100);
  assert.deepEqual(cache.get(identity, 150), {
    value: { frames: [1, 2, 3] },
    freshness: "sessionCached",
    ageMs: 50,
  });
  assert.equal(
    cache.get({ ...identity, locator: "track:2/reference:2" }, 150),
    undefined,
  );
  assert.equal(cache.invalidateSession("session-a"), 1);
  assert.equal(cache.stats().entries, 0);
});
