#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { getMaxListeners, setMaxListeners } from "node:events";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  STAGE3_VERIFIED_WRITE_ACTIONS,
  createStage3WritePlan,
} from "../dist/src/release-validation-v3.js";

const FORMAL_COUNTS = Object.freeze({
  concurrency: 200,
  experimental: 30,
  reload: 30,
  trace: 100,
  transaction: 100,
});
const TRACE_OVERHEAD_LIMIT_PERCENT = 5;

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv) {
  let dryRun = false;
  let live = false;
  let mode = "all";
  let count;
  let projectFile;
  let trackIndex;
  let groupIndex;
  let stage2Complete = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--live") {
      live = true;
      continue;
    }
    if (argument === "--stage2-complete") {
      stage2Complete = true;
      continue;
    }
    if (
      argument === "--mode" ||
      argument === "--count" ||
      argument === "--project-file" ||
      argument === "--track-index" ||
      argument === "--group-index"
    ) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new TypeError(`${argument} requires a value.`);
      }
      if (argument === "--mode") {
        mode = value;
      } else if (argument === "--count") {
        count = positiveInteger(value, argument);
      } else if (argument === "--project-file") {
        projectFile = value;
      } else if (argument === "--track-index") {
        trackIndex = positiveInteger(value, argument);
      } else {
        groupIndex = positiveInteger(value, argument);
      }
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${String(argument)}`);
  }
  if (dryRun === live) {
    throw new TypeError("Supply exactly one of --dry-run or --live.");
  }
  if (!["all", "concurrency", "experimental", "reload", "trace-ab"].includes(mode)) {
    throw new TypeError(`Unknown --mode: ${mode}`);
  }
  if (live && mode === "all") {
    throw new TypeError("Live validation requires one explicit --mode.");
  }
  if (live) {
    if (projectFile === undefined || trackIndex === undefined || groupIndex === undefined) {
      throw new TypeError(
        "Live validation requires --project-file, --track-index, and --group-index.",
      );
    }
    if (!path.isAbsolute(projectFile)) {
      throw new TypeError("--project-file must be an absolute path.");
    }
    const formalCount =
      mode === "trace-ab"
        ? FORMAL_COUNTS.trace
        : FORMAL_COUNTS[mode];
    if ((count ?? formalCount) >= formalCount && !stage2Complete) {
      throw new TypeError(
        `The formal Stage 3 ${mode} matrix requires explicit --stage2-complete acknowledgement.`,
      );
    }
  }
  return {
    count,
    dryRun,
    groupIndex,
    live,
    mode,
    projectFile,
    stage2Complete,
    trackIndex,
  };
}

function planFor(mode, count) {
  const selected = mode === "all"
    ? ["concurrency", "experimental", "reload", "trace-ab"]
    : [mode];
  return Object.fromEntries(
    selected.map((entry) => {
      if (entry === "experimental") {
        const repetitions = count ?? FORMAL_COUNTS.experimental;
        const transactionRepetitions = count ?? FORMAL_COUNTS.transaction;
        return [entry, {
          disabledActionRepetitions: repetitions,
          disabledActions: 7,
          dependentTransactionPatterns: 2,
          dependentTransactionRepetitions: transactionRepetitions,
          expectedFailClosedCalls:
            repetitions * 6 + transactionRepetitions * 2,
        }];
      }
      const defaultCount = entry === "trace-ab"
        ? FORMAL_COUNTS.trace
        : FORMAL_COUNTS[entry];
      return [entry, { callsOrCycles: count ?? defaultCount }];
    }),
  );
}

function writeUndoPlan() {
  const actionDistribution = Object.fromEntries(
    STAGE3_VERIFIED_WRITE_ACTIONS.map((action) => [action, 0]),
  );
  for (const entry of createStage3WritePlan()) {
    actionDistribution[entry.action] += 1;
  }
  return {
    actionCount: STAGE3_VERIFIED_WRITE_ACTIONS.length,
    actionDistribution,
    linkedCloneUndoCycles: 30,
    ordinaryWriteUndoCycles: 200,
    requiresVisibleSynthVUndo: true,
  };
}

function childEnvironment(traceEnabled) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      environment[key] = value;
    }
  }
  if (traceEnabled !== undefined) {
    environment.SYNTHV_AGENT_TRACE_ENABLED = traceEnabled ? "1" : "0";
  }
  return environment;
}

async function openClient(traceEnabled) {
  const transport = new StdioClientTransport({
    args: ["dist/src/cli.js"],
    command: process.execPath,
    cwd: process.cwd(),
    env: childEnvironment(traceEnabled),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "synthv-agent-stage3-stability", version: "0.3.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

function parseToolPayload(result, toolName) {
  const content = result.content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  if (content?.type !== "text") {
    throw new Error(`${toolName} returned no JSON text.`);
  }
  try {
    return { isError: result.isError === true, payload: JSON.parse(content.text) };
  } catch {
    throw new Error(`${toolName} returned invalid JSON.`);
  }
}

function requireSuccess(result, toolName) {
  const parsed = parseToolPayload(result, toolName);
  if (
    parsed.isError ||
    parsed.payload?.outcome === "failed" ||
    parsed.payload?.error !== undefined
  ) {
    const code = parsed.payload?.error?.code ?? "UNKNOWN";
    throw new Error(`${toolName} failed with ${String(code)}.`);
  }
  return parsed.payload;
}

function normalizeProjectFile(value) {
  return path.resolve(value).toLocaleLowerCase("en-US");
}

async function bridgeBaseline(client, expectedProjectFile) {
  const payload = requireSuccess(
    await client.callTool({ name: "sv_status", arguments: { operation: "bridge" } }),
    "sv_status",
  );
  if (
    payload?.connected !== true ||
    payload?.fresh !== true ||
    payload?.coherence?.state !== "matched" ||
    payload?.coherence?.writesAllowed !== true ||
    typeof payload?.status?.projectFile !== "string" ||
    typeof payload?.status?.sessionToken !== "string" ||
    typeof payload?.status?.executorBuildId !== "string"
  ) {
    throw new Error("Bridge baseline is not connected, fresh, coherent, and write-enabled.");
  }
  if (
    normalizeProjectFile(payload.status.projectFile) !==
    normalizeProjectFile(expectedProjectFile)
  ) {
    throw new Error("Active SynthV project does not match --project-file.");
  }
  return {
    executorBuildId: payload.status.executorBuildId,
    projectFile: payload.status.projectFile,
    sessionToken: payload.status.sessionToken,
  };
}

function assertStableBaseline(expected, actual, includeSession = true) {
  for (const field of ["executorBuildId", "projectFile"]) {
    if (expected[field] !== actual[field]) {
      throw new Error(`Stage 3 baseline changed: ${field}`);
    }
  }
  if (includeSession && expected.sessionToken !== actual.sessionToken) {
    throw new Error("Stage 3 baseline changed: sessionToken");
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

async function mixerQuery(client, trackIndex, contextMode = "readOnly") {
  const startedAt = performance.now();
  const payload = requireSuccess(
    await client.callTool({
      name: "sv_query",
      arguments: {
        action: "get_track_mixer",
        args: { trackIndex },
        contextMode,
        dense: "never",
      },
    }),
    "sv_query:get_track_mixer",
  );
  return { durationMs: performance.now() - startedAt, payload };
}

async function runConcurrency(options) {
  const count = options.count ?? FORMAL_COUNTS.concurrency;
  const { client, transport } = await openClient();
  try {
    const childInput = transport._process?.stdin;
    if (childInput !== undefined) {
      setMaxListeners(
        Math.max(getMaxListeners(childInput), count + 16),
        childInput,
      );
    }
    const baseline = await bridgeBaseline(client, options.projectFile);
    const startedAt = performance.now();
    const results = await Promise.all(
      Array.from({ length: count }, () => mixerQuery(client, options.trackIndex)),
    );
    const traceIds = new Set(results.map(({ payload }) => payload.traceId));
    if (traceIds.has(undefined) || traceIds.size !== count) {
      throw new Error("Concurrent requests did not return one unique trace ID each.");
    }
    assertStableBaseline(
      baseline,
      await bridgeBaseline(client, options.projectFile),
    );
    const durations = results.map((result) => result.durationMs);
    return {
      completedRequests: count,
      evidenceClassification:
        count >= FORMAL_COUNTS.concurrency ? "stage3ConcurrencyMatrix" : "developmentSmoke",
      mode: "concurrency",
      projectDataIncluded: false,
      requestLoss: 0,
      timingMs: {
        maximum: Number(Math.max(...durations).toFixed(3)),
        p95: Number(percentile(durations, 0.95).toFixed(3)),
        total: Number((performance.now() - startedAt).toFixed(3)),
      },
      uniqueTraceIds: traceIds.size,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForReload(client, expectedProjectFile, previousSessionToken) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const baseline = await bridgeBaseline(client, expectedProjectFile);
      if (baseline.sessionToken !== previousSessionToken) {
        return baseline;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Bridge reload did not produce a fresh Session.${
      lastError instanceof Error ? ` Last status: ${lastError.message}` : ""
    }`,
  );
}

async function runReload(options) {
  const count = options.count ?? FORMAL_COUNTS.reload;
  const { client } = await openClient();
  try {
    let baseline = await bridgeBaseline(client, options.projectFile);
    const initial = baseline;
    const durations = [];
    const invalidationCodes = {};
    for (let iteration = 0; iteration < count; iteration += 1) {
      const mixer = await mixerQuery(client, options.trackIndex, "writeIntent");
      if (
        typeof mixer.payload.contextId !== "string" ||
        typeof mixer.payload.gainDecibel !== "number"
      ) {
        throw new Error("Mixer write-intent query did not return its Context and current gain.");
      }
      const startedAt = performance.now();
      requireSuccess(
        await client.callTool({ name: "sv_status", arguments: { operation: "reload" } }),
        "sv_status:reload",
      );
      const reloaded = await waitForReload(
        client,
        options.projectFile,
        baseline.sessionToken,
      );
      assertStableBaseline(initial, reloaded, false);
      const staleResult = parseToolPayload(
        await client.callTool({
          name: "sv_command",
          arguments: {
            action: "set_track_mixer",
            args: { gainDecibel: mixer.payload.gainDecibel },
            contextId: mixer.payload.contextId,
          },
        }),
        "sv_command:stale-context",
      );
      const invalidationCode = staleResult.payload?.error?.code;
      if (
        staleResult.isError !== true ||
        !["SYNTHV_SESSION_CHANGED", "UNKNOWN_CONTEXT"].includes(invalidationCode) ||
        staleResult.payload?.error?.details?.undoRequired === true
      ) {
        throw new Error(
          `A pre-reload Context was not invalidated before mutation; received ${String(invalidationCode)}.`,
        );
      }
      invalidationCodes[invalidationCode] =
        (invalidationCodes[invalidationCode] ?? 0) + 1;
      durations.push(performance.now() - startedAt);
      baseline = reloaded;
    }
    return {
      completedReloads: count,
      evidenceClassification:
        count >= FORMAL_COUNTS.reload ? "stage3ReloadMatrix" : "developmentSmoke",
      mode: "reload",
      projectDataIncluded: false,
      invalidationCodes,
      sessionInvalidations: count,
      timingMs: {
        maximum: Number(Math.max(...durations).toFixed(3)),
        p95: Number(percentile(durations, 0.95).toFixed(3)),
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function experimentalScenarios(repetitions, transactionRepetitions) {
  const actions = [
    ["clone_group_reference", { cloneIntent: "isolated" }],
    ["clone_note_group", {}],
    ["clone_track", { cloneIntent: "isolated" }],
    ["clone_track_shell", { cloneIntent: "shell" }],
    ["create_harmony_track", {}],
    ["rollback_transaction", {}],
  ];
  const scenarios = [];
  for (const [action, args] of actions) {
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      scenarios.push({ action, args, kind: "disabledAction" });
    }
  }
  for (const kind of ["wouldSucceed", "dependentPreflightFailure"]) {
    for (let iteration = 0; iteration < transactionRepetitions; iteration += 1) {
      scenarios.push({
        action: "apply_transaction",
        args: { summary: `redacted-${kind}`, steps: [] },
        kind,
      });
    }
  }
  return scenarios;
}

async function runExperimental(options) {
  const repetitions = options.count ?? FORMAL_COUNTS.experimental;
  const transactionRepetitions = options.count ?? FORMAL_COUNTS.transaction;
  const scenarios = experimentalScenarios(repetitions, transactionRepetitions);
  const { client } = await openClient();
  try {
    const baseline = await bridgeBaseline(client, options.projectFile);
    const actionCounts = {};
    for (let index = 0; index < scenarios.length; index += 1) {
      const scenario = scenarios[index];
      const result = parseToolPayload(
        await client.callTool({
          name: "sv_command",
          arguments: { action: scenario.action, args: scenario.args },
        }),
        `sv_command:${scenario.action}`,
      );
      if (
        result.isError !== true ||
        result.payload?.error?.code !== "EXPERIMENTAL_CAPABILITY_DISABLED" ||
        result.payload?.error?.details?.undoRequired !== false
      ) {
        throw new Error(`${scenario.action} did not fail closed before mutation.`);
      }
      const key = `${scenario.action}:${scenario.kind}`;
      actionCounts[key] = (actionCounts[key] ?? 0) + 1;
      if ((index + 1) % 20 === 0) {
        assertStableBaseline(
          baseline,
          await bridgeBaseline(client, options.projectFile),
        );
      }
    }
    assertStableBaseline(
      baseline,
      await bridgeBaseline(client, options.projectFile),
    );
    return {
      actionCounts,
      completedFailClosedCalls: scenarios.length,
      evidenceClassification:
        repetitions >= FORMAL_COUNTS.experimental &&
        transactionRepetitions >= FORMAL_COUNTS.transaction
          ? "stage3ReducedCapabilityMatrix"
          : "developmentSmoke",
      mode: "experimental",
      projectDataIncluded: false,
      unexpectedWrites: 0,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function tracePhase(options, enabled, count) {
  const { client } = await openClient(enabled);
  try {
    const baseline = await bridgeBaseline(client, options.projectFile);
    for (let iteration = 0; iteration < 10; iteration += 1) {
      await mixerQuery(client, options.trackIndex);
    }
    const durations = [];
    for (let iteration = 0; iteration < count; iteration += 1) {
      durations.push((await mixerQuery(client, options.trackIndex)).durationMs);
    }
    assertStableBaseline(
      baseline,
      await bridgeBaseline(client, options.projectFile),
    );
    return durations;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runTraceAb(options) {
  const count = options.count ?? FORMAL_COUNTS.trace;
  const first = Math.ceil(count / 2);
  const second = Math.floor(count / 2);
  const traceOff = await tracePhase(options, false, first);
  const traceOn = await tracePhase(options, true, first);
  if (second > 0) {
    traceOn.push(...await tracePhase(options, true, second));
    traceOff.push(...await tracePhase(options, false, second));
  }
  const offP95 = percentile(traceOff, 0.95);
  const onP95 = percentile(traceOn, 0.95);
  const overheadPercent = offP95 === 0
    ? Number.POSITIVE_INFINITY
    : ((onP95 - offP95) / offP95) * 100;
  const passed = overheadPercent < TRACE_OVERHEAD_LIMIT_PERCENT;
  return {
    evidenceClassification:
      count >= FORMAL_COUNTS.trace ? "stage3TraceAb" : "developmentSmoke",
    mode: "trace-ab",
    passed,
    projectDataIncluded: false,
    samplesPerState: count,
    thresholdPercent: TRACE_OVERHEAD_LIMIT_PERCENT,
    timingMs: {
      traceOffP95: Number(offP95.toFixed(3)),
      traceOnP95: Number(onP95.toFixed(3)),
      traceOverheadPercent: Number(overheadPercent.toFixed(3)),
    },
  };
}

async function runLive(options) {
  switch (options.mode) {
    case "concurrency":
      return runConcurrency(options);
    case "experimental":
      return runExperimental(options);
    case "reload":
      return runReload(options);
    case "trace-ab":
      return runTraceAb(options);
    default:
      throw new Error(`Unsupported live mode: ${options.mode}`);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = options.dryRun
    ? {
        dryRun: true,
        formalCounts: FORMAL_COUNTS,
        mode: "stage3Stability",
        plan: planFor(options.mode, options.count),
        projectDataIncluded: false,
        traceOverheadLimitPercent: TRACE_OVERHEAD_LIMIT_PERCENT,
        writeUndo: writeUndoPlan(),
      }
    : await runLive(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.mode === "trace-ab" && result.passed !== true) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
