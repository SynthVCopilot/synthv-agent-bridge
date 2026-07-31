#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../dist/src/config.js";
import { BUILD_IDENTITY } from "../dist/src/build-info.js";
import { createServer } from "../dist/src/server.js";
import {
  commandOutcome,
  runWithTrace,
} from "../dist/src/v3-command-kernel.js";
import {
  V3_PERFORMANCE_BUDGETS,
  percentile95,
  serializedCharacterCount,
  serializedUtf8ByteCount,
} from "../dist/src/v3-performance.js";
import { projectQueryResult } from "../dist/src/v3-query-projector.js";

const ITERATIONS = 500;

async function measureToolCatalog() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-benchmark-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "synthv-v3-benchmark",
    version: "0.2.0-alpha.1",
  });
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = await client.listTools();
    return {
      toolCount: tools.tools.length,
      characters: serializedCharacterCount(tools.tools),
      bytes: serializedUtf8ByteCount(tools.tools),
      names: tools.tools.map((tool) => tool.name),
    };
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

function phraseFixture(noteCount = 64) {
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

function benchmark(iterations, operation, measurement) {
  const durations = [];
  let lastValue;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    lastValue = operation();
    durations.push(performance.now() - startedAt);
  }
  const p95Ms = Number(percentile95(durations).toFixed(3));
  const resultCharacters = serializedCharacterCount(lastValue);
  const resultBytes = serializedUtf8ByteCount(lastValue);
  return {
    iterations,
    p95Ms,
    maximumMs: Number(Math.max(...durations).toFixed(3)),
    resultCharacters,
    resultBytes,
    measurement: {
      ...measurement,
      responseCharacters: resultCharacters,
      responseBytes: resultBytes,
      modelFacingCharacters: resultCharacters,
      modelFacingBytes: resultBytes,
      timings: {
        queueMs: "notApplicable",
        hostReadMs: "notApplicable",
        preflightMs: "notApplicable",
        mutationMs: "notApplicable",
        verificationMs: "notApplicable",
        projectionP95Ms: p95Ms,
      },
      errorCode: null,
    },
  };
}

const queryRequest = {
  tool: "sv_query",
  action: "get_phrase_context",
  contextMode: "readOnly",
  include: ["notes"],
  dense: "auto",
  fixtureNoteCount: 64,
};
const query = benchmark(
  ITERATIONS,
  () =>
    projectQueryResult(
      "get_phrase_context",
      structuredClone(phraseFixture()),
      {
        include: ["notes"],
        dense: "auto",
        debug: false,
        explicitlyScoped: false,
      },
    ).publicProjection,
  {
    action: "get_phrase_context",
    targetKind: "GroupReference",
    projection: "notes:dense-auto",
    include: ["notes"],
    noteCount: 64,
    pitchControlCount: 0,
    automationPointCount: 0,
    targetCount: 64,
    cacheStatus: "notUsed",
    freshnessClass: "syntheticImmutableFixture",
    outcome: "projected",
    undoRecords: 0,
    requestCharacters: serializedCharacterCount(queryRequest),
    requestBytes: serializedUtf8ByteCount(queryRequest),
  },
);

let command;
const commandRequest = {
  tool: "sv_command",
  action: "set_track_mixer",
  expectedEffect: "mustChange",
  changedCount: 1,
};
await runWithTrace(async () => {
  command = benchmark(
    ITERATIONS,
    () =>
      commandOutcome("set_track_mixer", {
        changedCount: 1,
        undoRecordCount: 1,
        verified: true,
      }),
    {
      action: "set_track_mixer",
      targetKind: "TrackShell",
      projection: "compactCommandAcknowledgement",
      include: [],
      noteCount: 0,
      pitchControlCount: 0,
      automationPointCount: 0,
      targetCount: 1,
      cacheStatus: "notApplicable",
      freshnessClass: "notApplicable",
      outcome: "changed",
      undoRecords: 1,
      requestCharacters: serializedCharacterCount(commandRequest),
      requestBytes: serializedUtf8ByteCount(commandRequest),
    },
  );
});

const result = {
  benchmark: "v3-synthetic-query-command",
  generatedAt: new Date().toISOString(),
  environment: {
    bridgeVersion: BUILD_IDENTITY.version,
    protocolVersion: BUILD_IDENTITY.protocolVersion,
    gitCommit: BUILD_IDENTITY.gitCommit,
    nodeRuntime: process.version,
    executorBuildId: BUILD_IDENTITY.executor.buildId,
    sidebarBuildId: BUILD_IDENTITY.sidebar.buildId,
    synthvHost: "notConnectedSyntheticFixture",
  },
  budgets: V3_PERFORMANCE_BUDGETS,
  toolCatalog: await measureToolCatalog(),
  query,
  command,
  decisionInputs: {
    hostCacheMeasured: false,
    transportMeasured: false,
    note:
      "Synthetic results enforce projection budgets; use recorded real-host traces for cache or transport decisions.",
  },
};

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : `${JSON.stringify(result, null, 2)}\n`,
);
