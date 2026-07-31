import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  STAGE3_QUERY_ACTIONS,
  STAGE3_VERIFIED_WRITE_ACTIONS,
  createStage3ReadPlan,
  createStage3WritePlan,
  runStage3ReadValidation,
} from "../src/release-validation-v3.js";

test("Stage 3 read plan schedules exactly 1,000 calls across all 17 Query actions", () => {
  const plan = createStage3ReadPlan(1_000);

  assert.equal(plan.length, 1_000);
  assert.deepEqual(
    plan.slice(0, 17).map((entry) => entry.action),
    STAGE3_QUERY_ACTIONS,
  );

  const counts = new Map<string, number>();
  for (const entry of plan) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  assert.equal(counts.size, 17);
  assert.deepEqual(
    STAGE3_QUERY_ACTIONS.map((action) => counts.get(action)),
    [59, 59, 59, 59, 59, 59, 59, 59, 59, 59, 59, 59, 59, 59, 58, 58, 58],
  );
});

test("Stage 3 write plan schedules 200 calls with at least three per verified action", () => {
  const plan = createStage3WritePlan();
  assert.equal(STAGE3_VERIFIED_WRITE_ACTIONS.length, 31);
  assert.equal(plan.length, 200);
  assert.deepEqual(
    plan.slice(0, STAGE3_VERIFIED_WRITE_ACTIONS.length).map((entry) => entry.action),
    STAGE3_VERIFIED_WRITE_ACTIONS,
  );
  const counts = new Map<string, number>();
  for (const entry of plan) {
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  assert.equal(counts.size, STAGE3_VERIFIED_WRITE_ACTIONS.length);
  assert.ok([...counts.values()].every((count) => count >= 3));
  assert.deepEqual(
    STAGE3_VERIFIED_WRITE_ACTIONS.map((action) => counts.get(action)),
    [
      ...Array.from({ length: 14 }, () => 7),
      ...Array.from({ length: 17 }, () => 6),
    ],
  );
});

test("Stage 3 write plan rejects a count that cannot cover every action three times", () => {
  assert.throws(
    () => createStage3WritePlan(92),
    /must be at least 93/u,
  );
});

test("Stage 3 write/Undo driver has one reversible fixture for every verified write", () => {
  const source = readFileSync("scripts/stage3-write-undo-v3.mjs", "utf8");

  for (const action of STAGE3_VERIFIED_WRITE_ACTIONS) {
    assert.match(source, new RegExp(`case "${action}"`, "u"), action);
  }
  assert.match(source, /payload\.outcome !== "changed"/u);
  assert.match(source, /payload\.undoRecords !== 1/u);
  assert.match(source, /payload\.verified !== true/u);
  assert.match(source, /requiresVisibleSynthVUndo: true/u);
  assert.match(source, /reread\.trackedTakeIds/u);
  assert.match(source, /endPosition: 10_000_000_000, parameter: "tension", threshold: 4/u);
  assert.match(source, /mode: "linked-clone-write"/u);
  assert.match(source, /30 - state\.completed\.length/u);
  assert.match(source, /afterDigest !== state\.pending\.beforeDigest/u);
  assert.match(source, /afterDigest !== state\.preparedDigest/u);
  const visibleUndoSource = readFileSync("scripts/stage3-visible-undo-loop.ps1", "utf8");
  assert.match(visibleUndoSource, /GetForegroundWindow/u);
  assert.match(visibleUndoSource, /ShowWindowAsync/u);
  assert.match(visibleUndoSource, /Wait-SynthVForeground/u);
  assert.match(visibleUndoSource, /-AttemptCount 3/u);
  assert.match(visibleUndoSource, /verified as the foreground window before visible Undo/u);
});

test("Stage 3 four-hour soak keeps writes, reads, reloads, and idle time in one run", () => {
  const source = readFileSync("scripts/stage3-four-hour-soak.ps1", "utf8");

  assert.match(source, /\[double\]\$DurationHours = 4/u);
  assert.match(source, /\[int\]\$WriteCount = 200/u);
  assert.match(source, /"--iterations", "17"/u);
  assert.match(source, /"--mode", "reload"/u);
  assert.match(source, /Invoke-VisibleUndo|stage3-visible-undo-loop/u);
  assert.match(source, /while \(\[DateTimeOffset\]::UtcNow -lt \$scheduledNext\)/u);
  assert.match(source, /\$final\.ordinaryCompletedCount -ne \$WriteCount/u);
  assert.match(source, /\$final\.linkedCloneCount -ne 0/u);
  assert.match(source, /\$final\.preparedDigest -ne \[string\]\$initial\.preparedDigest/u);
  assert.match(source, /\$readCount -ne \$expectedReadCount/u);
  assert.match(source, /\$reloadCount -ne \$expectedReloadCount/u);
  assert.match(source, /\[switch\]\$Resume/u);
  assert.match(source, /recoveredAfterInterruption/u);
});

test("Stage 3 resource monitor samples settled and post-batch host state", () => {
  const source = readFileSync("scripts/stage3-resource-monitor.ps1", "utf8");

  assert.match(source, /synthvWorkingSetBytes/u);
  assert.match(source, /synthvPrivateBytes/u);
  assert.match(source, /heartbeatAgeMs/u);
  assert.match(source, /SYNTHV_AGENT_BRIDGE_DIR/u);
  assert.match(source, /missingHeartbeatSampleCount/u);
  assert.match(source, /staleResidualSampleCount/u);
  assert.match(source, /Get-CompletedBatchIndex/u);
  assert.match(source, /\[int\]\$BatchSettleSeconds = 60/u);
  assert.match(source, /\[int\]\$WarmupWrites = 10/u);
  assert.match(source, /cycleIndex -ge \$WarmupWrites/u);
  assert.match(source, /\$pendingBatchDue/u);
  assert.match(source, /\$batchSamples\.Count -eq 10/u);
  assert.match(source, /-le 1\.2/u);
  assert.match(source, /Test-MonotonicGrowth/u);
  assert.match(source, /workingSetMonotonicGrowth/u);
  assert.match(source, /privateMonotonicGrowth/u);
  assert.match(source, /\[switch\]\$Resume/u);
});

test("release validation CLI dry-run emits a redacted plan without connecting to SynthV", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/release-validation-v3.mjs",
      "--dry-run",
      "--iterations",
      "34",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    actionCount: 17,
    actionDistribution: Object.fromEntries(
      STAGE3_QUERY_ACTIONS.map((action) => [action, 2]),
    ),
    dryRun: true,
    iterations: 34,
    mode: "stage3Reads",
    projectDataIncluded: false,
  });
});

test("release validation CLI refuses the full read matrix before Stage 2 acknowledgement", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/release-validation-v3.mjs",
      "--live",
      "--project-file",
      "D:\\Projects\\sv\\test.svp",
      "--track-index",
      "1",
      "--group-index",
      "2",
      "--note-index",
      "1",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires explicit --stage2-complete/u);
});

test("Stage 3 stability CLI dry-run declares the reduced-capability and lifecycle matrices", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/stage3-stability-v3.mjs", "--dry-run", "--mode", "all"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.dryRun, true);
  assert.equal(payload.mode, "stage3Stability");
  assert.equal(payload.projectDataIncluded, false);
  assert.equal(payload.traceOverheadLimitPercent, 5);
  assert.deepEqual(payload.writeUndo, {
    actionCount: 31,
    actionDistribution: Object.fromEntries(
      STAGE3_VERIFIED_WRITE_ACTIONS.map((action, index) => [
        action,
        index < 14 ? 7 : 6,
      ]),
    ),
    linkedCloneUndoCycles: 30,
    ordinaryWriteUndoCycles: 200,
    requiresVisibleSynthVUndo: true,
  });
  assert.deepEqual(payload.formalCounts, {
    concurrency: 200,
    experimental: 30,
    reload: 30,
    trace: 100,
    transaction: 100,
  });
});

test("Stage 3 stability CLI refuses formal live counts before Stage 2 acknowledgement", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/stage3-stability-v3.mjs",
      "--live",
      "--mode",
      "concurrency",
      "--project-file",
      "D:\\Projects\\sv\\test.svp",
      "--track-index",
      "1",
      "--group-index",
      "2",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires explicit --stage2-complete/u);
});

test("Stage 3 read runner stops before the next query when the SynthV Session changes", async () => {
  let probes = 0;
  let queries = 0;

  await assert.rejects(
    runStage3ReadValidation({
      baseline: {
        executorBuildId: "executor-a",
        projectFile: "D:\\Projects\\sv\\test.svp",
        sessionToken: "session-a",
      },
      plan: createStage3ReadPlan(2),
      probeBaseline: async () => {
        probes += 1;
        return {
          executorBuildId: "executor-a",
          projectFile: "D:\\Projects\\sv\\test.svp",
          sessionToken: probes === 1 ? "session-a" : "session-b",
        };
      },
      runQuery: async () => {
        queries += 1;
        return { responseBytes: 128, responseCharacters: 128 };
      },
    }),
    /Stage 3 baseline changed: sessionToken/u,
  );
  assert.equal(queries, 1);
});

test("Stage 3 read runner stops on an oversized public Query response", async () => {
  const baseline = {
    executorBuildId: "executor-a",
    projectFile: "D:\\Projects\\sv\\test.svp",
    sessionToken: "session-a",
  };
  let queries = 0;

  await assert.rejects(
    runStage3ReadValidation({
      baseline,
      plan: createStage3ReadPlan(2),
      probeBaseline: async () => baseline,
      runQuery: async () => {
        queries += 1;
        return { responseBytes: 20_001, responseCharacters: 10 };
      },
    }),
    /Stage 3 response budget exceeded: convert_pitch/u,
  );
  assert.equal(queries, 1);
});
