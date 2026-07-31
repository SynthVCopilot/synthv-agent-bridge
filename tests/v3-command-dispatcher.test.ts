import assert from "node:assert/strict";
import test from "node:test";

import { BridgeError, BridgeProtocolError } from "../src/errors.js";
import {
  dispatchV3Command,
  type V3CommandDispatchResult,
} from "../src/v3-command-dispatcher.js";
import {
  currentTraceId,
  runWithTrace,
  traceDiagnostics,
} from "../src/v3-command-kernel.js";

function changedResult(
  overrides: Partial<V3CommandDispatchResult> = {},
): V3CommandDispatchResult {
  return {
    outcome: "changed",
    traceId: "tr_adapter",
    action: "set_track_mixer",
    changedCount: 1,
    undoRecords: 1,
    verified: true,
    ...overrides,
  };
}

test("v3 dispatcher accepts one verified change and invalidates after verification", async () => {
  const events: string[] = [];
  let traceId = "";

  const result = await runWithTrace(async () => {
    traceId = currentTraceId() ?? "";
    return dispatchV3Command({
      action: "set_track_mixer",
      expectedEffect: "allowAlreadySatisfied",
      invoke: async () => {
        events.push("invoke");
        return changedResult();
      },
      invalidate: async () => {
        events.push("invalidate");
      },
    });
  });

  assert.equal(result.outcome, "changed");
  assert.deepEqual(events, ["invoke", "invalidate"]);
  const diagnostics = traceDiagnostics({
    level: "debug",
    traceId,
    limit: 1,
  });
  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /"stage":"contextResolved"/u);
  assert.match(serialized, /"stage":"verified"/u);
  assert.match(serialized, /"stage":"cacheInvalidated"/u);
});

test("v3 dispatcher treats an already-satisfied command as zero-effect without invalidation", async () => {
  let invalidated = false;
  const result = await dispatchV3Command({
    action: "set_track_mixer",
    expectedEffect: "allowAlreadySatisfied",
    invoke: async () =>
      changedResult({
        outcome: "alreadySatisfied",
        changedCount: 0,
        undoRecords: 0,
      }),
    invalidate: async () => {
      invalidated = true;
    },
  });

  assert.equal(result.outcome, "alreadySatisfied");
  assert.equal(invalidated, false);
});

test("v3 dispatcher enforces mustChange centrally", async () => {
  await assert.rejects(
    dispatchV3Command({
      action: "set_track_mixer",
      expectedEffect: "mustChange",
      invoke: async () =>
        changedResult({
          outcome: "alreadySatisfied",
          changedCount: 0,
          undoRecords: 0,
        }),
    }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "HOST_POSTCONDITION_FAILED",
  );
});

test("v3 dispatcher rejects malformed changed and already-satisfied results", async () => {
  for (const result of [
    changedResult({ changedCount: 0 }),
    changedResult({ undoRecords: 0 }),
    changedResult({ verified: false }),
    changedResult({
      outcome: "alreadySatisfied",
      changedCount: 1,
      undoRecords: 0,
    }),
    changedResult({
      outcome: "alreadySatisfied",
      changedCount: 0,
      undoRecords: 1,
    }),
  ]) {
    await assert.rejects(
      dispatchV3Command({
        action: "set_track_mixer",
        expectedEffect: "allowAlreadySatisfied",
        invoke: async () => result,
      }),
      (error: unknown) => error instanceof BridgeProtocolError,
    );
  }
});

test("v3 dispatcher rejects an action mismatch before cache invalidation", async () => {
  let invalidated = false;
  await assert.rejects(
    dispatchV3Command({
      action: "set_track_mixer",
      expectedEffect: "allowAlreadySatisfied",
      invoke: async () => changedResult({ action: "delete_track" }),
      invalidate: async () => {
        invalidated = true;
      },
    }),
    (error: unknown) => error instanceof BridgeProtocolError,
  );
  assert.equal(invalidated, false);
});
