import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  commandOutcome,
  failedOutcome,
  runWithTrace,
} from "../src/v3-command-kernel.js";
import {
  V3_PERFORMANCE_BUDGETS,
  percentile95,
  serializedCharacterCount,
} from "../src/v3-performance.js";
import { projectQueryResult } from "../src/v3-query-projector.js";

function phraseFixture(noteCount: number): Record<string, unknown> {
  return {
    trackIndex: 1,
    groupIndex: 1,
    noteCount,
    notes: Array.from({ length: noteCount }, (_, index) => ({
      noteIndex: index + 1,
      onset: index * 120,
      duration: 120,
      pitch: 60 + (index % 12),
      lyrics: `sy${index % 8}`,
      phonemes: "s y",
      attributes: {
        pitchTransition: 0.2,
        vibratoDepth: 0.1,
      },
    })),
  };
}

test("PERF-001: ordinary Query fixture p95 stays below 20 KB", () => {
  const sizes = Array.from({ length: 100 }, (_, index) => {
    const projected = projectQueryResult(
      "get_phrase_context",
      phraseFixture(8 + (index % 57)),
      {
        include: ["notes"],
        dense: "auto",
        debug: false,
        explicitlyScoped: false,
      },
    );
    return projected.responseCharacters;
  });

  assert.ok(
    percentile95(sizes) <=
      V3_PERFORMANCE_BUDGETS.ordinaryQueryCharacters,
  );
});

test("PERF-002: command and error envelopes satisfy their public budgets", async () => {
  await runWithTrace(async () => {
    const acknowledgement = commandOutcome("set_track_mixer", {
      changedCount: 1,
      undoRecordCount: 1,
      verified: true,
    });
    const acknowledgementCharacters =
      serializedCharacterCount(acknowledgement);
    assert.ok(
      acknowledgementCharacters <=
        V3_PERFORMANCE_BUDGETS.commandAcknowledgementCharacters,
    );

    const fingerprint = `private-fingerprint-${"x".repeat(100_000)}`;
    const failure = failedOutcome(
      new BridgeError("stale", "STALE_AUTOMATION", {
        expected: fingerprint,
        actual: `${fingerprint}-changed`,
      }),
      "guarded",
    );
    const failureText = JSON.stringify(failure);
    assert.ok(
      failureText.length <= V3_PERFORMANCE_BUDGETS.publicErrorCharacters,
    );
    assert.doesNotMatch(failureText, /private-fingerprint/u);
  });
});

test("PERF-003: normal trace metadata costs less than 1 KB", async () => {
  await runWithTrace(async () => {
    const acknowledgement = commandOutcome("set_track_mixer", {
      changedCount: 1,
      undoRecordCount: 1,
      verified: true,
    });
    const withTrace = serializedCharacterCount(acknowledgement);
    const withoutTrace = serializedCharacterCount({
      ...acknowledgement,
      traceId: undefined,
    });
    assert.ok(
      withTrace - withoutTrace <=
        V3_PERFORMANCE_BUDGETS.normalTraceOverheadCharacters,
    );
  });
});

test("PERF-004: the reproducible v3 benchmark script is present", async () => {
  await access(path.resolve("scripts", "benchmark-v3.mjs"));
});

test("PERF-005: the benchmark exercises the six-tool catalog and public envelopes", () => {
  const raw = execFileSync(
    process.execPath,
    [path.resolve("scripts", "benchmark-v3.mjs"), "--json"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(raw) as {
    readonly toolCatalog: {
      readonly toolCount: number;
      readonly characters: number;
    };
    readonly query: { readonly resultCharacters: number };
    readonly command: { readonly resultCharacters: number };
  };
  assert.equal(result.toolCatalog.toolCount, 6);
  assert.ok(
    result.toolCatalog.characters <=
      V3_PERFORMANCE_BUDGETS.toolCatalogCharacters,
  );
  assert.ok(
    result.query.resultCharacters <=
      V3_PERFORMANCE_BUDGETS.ordinaryQueryCharacters,
  );
  assert.ok(
    result.command.resultCharacters <=
      V3_PERFORMANCE_BUDGETS.commandAcknowledgementCharacters,
  );
});
