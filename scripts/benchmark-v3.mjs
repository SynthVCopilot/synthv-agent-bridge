#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../dist/src/config.js";
import { createServer } from "../dist/src/server.js";
import {
  commandOutcome,
  runWithTrace,
} from "../dist/src/v3-command-kernel.js";
import {
  V3_PERFORMANCE_BUDGETS,
  percentile95,
  serializedCharacterCount,
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

function benchmark(iterations, operation) {
  const durations = [];
  let lastValue;
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    lastValue = operation();
    durations.push(performance.now() - startedAt);
  }
  return {
    iterations,
    p95Ms: Number(percentile95(durations).toFixed(3)),
    maximumMs: Number(Math.max(...durations).toFixed(3)),
    resultCharacters: serializedCharacterCount(lastValue),
  };
}

const query = benchmark(ITERATIONS, () =>
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
);

let command;
await runWithTrace(async () => {
  command = benchmark(ITERATIONS, () =>
    commandOutcome("set_track_mixer", {
      changedCount: 1,
      undoRecordCount: 1,
      verified: true,
    }),
  );
});

const result = {
  benchmark: "v3-synthetic-query-command",
  generatedAt: new Date().toISOString(),
  node: process.version,
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
