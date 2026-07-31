#!/usr/bin/env node

import process from "node:process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  STAGE3_QUERY_ACTIONS,
  createStage3ReadPlan,
  runStage3ReadValidation,
} from "../dist/src/release-validation-v3.js";

const SYNTHETIC_SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Stage 3 Probe</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><lyric><text>la</text></lyric></note>
  </measure></part>
</score-partwise>
`;

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv) {
  let dryRun = false;
  let live = false;
  let iterations = 1_000;
  let projectFile;
  let trackIndex;
  let groupIndex;
  let noteIndex;
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
    if (argument === "--iterations") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new TypeError("--iterations requires a value.");
      }
      iterations = parsePositiveInteger(value, "--iterations");
      index += 1;
      continue;
    }
    if (
      argument === "--project-file" ||
      argument === "--track-index" ||
      argument === "--group-index" ||
      argument === "--note-index"
    ) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new TypeError(`${argument} requires a value.`);
      }
      if (argument === "--project-file") {
        projectFile = value;
      } else if (argument === "--track-index") {
        trackIndex = parsePositiveInteger(value, argument);
      } else if (argument === "--group-index") {
        groupIndex = parsePositiveInteger(value, argument);
      } else {
        noteIndex = parsePositiveInteger(value, argument);
      }
      index += 1;
      continue;
    }
    throw new TypeError(`Unknown argument: ${String(argument)}`);
  }
  if (dryRun === live) {
    throw new TypeError("Supply exactly one of --dry-run or --live.");
  }
  if (live) {
    if (
      projectFile === undefined ||
      trackIndex === undefined ||
      groupIndex === undefined ||
      noteIndex === undefined
    ) {
      throw new TypeError(
        "Live validation requires --project-file, --track-index, --group-index, and --note-index.",
      );
    }
    if (!path.isAbsolute(projectFile)) {
      throw new TypeError("--project-file must be an absolute path.");
    }
    if (iterations >= 1_000 && !stage2Complete) {
      throw new TypeError(
        "The 1,000-read Stage 3 matrix requires explicit --stage2-complete acknowledgement.",
      );
    }
  }
  return {
    dryRun,
    groupIndex,
    iterations,
    live,
    noteIndex,
    projectFile,
    stage2Complete,
    trackIndex,
  };
}

function summarizePlan(iterations) {
  const plan = createStage3ReadPlan(iterations);
  const actionDistribution = Object.fromEntries(
    STAGE3_QUERY_ACTIONS.map((action) => [action, 0]),
  );
  for (const entry of plan) {
    actionDistribution[entry.action] += 1;
  }
  return {
    actionCount: STAGE3_QUERY_ACTIONS.length,
    actionDistribution,
    dryRun: true,
    iterations: plan.length,
    mode: "stage3Reads",
    projectDataIncluded: false,
  };
}

function queryArguments(action, target, scoreFile) {
  const group = {
    groupIndex: target.groupIndex,
    trackIndex: target.trackIndex,
  };
  switch (action) {
    case "convert_pitch":
      return { pitch: 60 };
    case "get_project_info":
      return {};
    case "inspect_score_file":
      return { filePath: scoreFile, previewNoteLimit: 1 };
    case "get_time_axis":
      return { measureLimit: 1, tempoLimit: 1 };
    case "convert_time":
      return { blicks: 0 };
    case "list_tracks":
    case "list_note_groups":
      return { limit: 128, offset: 0 };
    case "get_track_notes":
      return {
        ...group,
        limit: 1,
        offset: target.noteIndex - 1,
      };
    case "get_group_voice":
      return group;
    case "get_note_phoneme_data":
      return {
        ...group,
        includeComputedPhonemes: false,
        noteIndices: [target.noteIndex],
        responseMode: "compact",
      };
    case "get_phrase_context":
      return {
        ...group,
        automationParameters: [],
        includeComputedPhonemes: false,
        noteIndices: [target.noteIndex],
        pitchAnalysisFrames: 0,
        preferSelectedNotes: false,
        recommendationLimit: 0,
      };
    case "get_computed_group_data":
      return {
        ...group,
        includeAttributes: false,
        limit: 1,
        offset: target.noteIndex - 1,
      };
    case "get_note_retakes":
      return { ...group, noteIndex: target.noteIndex };
    case "get_pitch_controls":
      return { ...group, limit: 1, offset: 0 };
    case "get_automation":
      return { ...group, parameter: "loudness", responseMode: "compact" };
    case "sample_automation":
      return {
        ...group,
        interpolation: "native",
        parameter: "loudness",
        positions: [0],
        responseMode: "compact",
      };
    case "get_track_mixer":
      return { trackIndex: target.trackIndex };
    default:
      throw new Error(`No Stage 3 Query fixture for ${String(action)}.`);
  }
}

function readToolPayload(result, toolName) {
  const text = result.content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  if (text?.type !== "text") {
    throw new Error(`${toolName} returned no JSON text.`);
  }
  let payload;
  try {
    payload = JSON.parse(text.text);
  } catch {
    throw new Error(`${toolName} returned invalid JSON.`);
  }
  if (
    result.isError === true ||
    payload?.outcome === "failed" ||
    payload?.error !== undefined
  ) {
    const code = payload?.error?.code ?? "UNKNOWN";
    throw new Error(`${toolName} failed with ${String(code)}.`);
  }
  return { payload, text: text.text };
}

function readBridgeBaseline(payload, expectedProjectFile) {
  if (
    payload?.connected !== true ||
    payload?.fresh !== true ||
    payload?.coherence?.state !== "matched" ||
    payload?.coherence?.writesAllowed !== true
  ) {
    throw new Error("Bridge baseline is not connected, fresh, coherent, and write-enabled.");
  }
  const status = payload.status;
  if (
    typeof status?.projectFile !== "string" ||
    typeof status?.sessionToken !== "string" ||
    typeof status?.executorBuildId !== "string"
  ) {
    throw new Error("Bridge baseline is missing project, Session, or executor identity.");
  }
  if (
    path.resolve(status.projectFile).toLocaleLowerCase("en-US") !==
    path.resolve(expectedProjectFile).toLocaleLowerCase("en-US")
  ) {
    throw new Error("Active SynthV project does not match --project-file.");
  }
  return {
    executorBuildId: status.executorBuildId,
    projectFile: status.projectFile,
    sessionToken: status.sessionToken,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function runLive(options) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-agent-stage3-"),
  );
  const scoreFile = path.join(temporaryDirectory, "probe.musicxml");
  await writeFile(scoreFile, SYNTHETIC_SCORE, "utf8");
  const transport = new StdioClientTransport({
    args: ["dist/src/cli.js"],
    command: process.execPath,
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "synthv-agent-release-validation", version: "0.2.0-alpha.1" },
    { capabilities: {} },
  );
  const durations = [];
  try {
    await client.connect(transport);
    const probeBaseline = async () => {
      const result = await client.callTool({
        arguments: { operation: "bridge" },
        name: "sv_status",
      });
      return readBridgeBaseline(
        readToolPayload(result, "sv_status").payload,
        options.projectFile,
      );
    };
    const baseline = await probeBaseline();
    const target = {
      groupIndex: options.groupIndex,
      noteIndex: options.noteIndex,
      trackIndex: options.trackIndex,
    };
    const startedAt = performance.now();
    const summary = await runStage3ReadValidation({
      baseline,
      plan: createStage3ReadPlan(options.iterations),
      probeBaseline,
      runQuery: async (entry) => {
        const queryStartedAt = performance.now();
        const result = await client.callTool({
          arguments: {
            action: entry.action,
            args: queryArguments(entry.action, target, scoreFile),
            dense: "never",
          },
          name: "sv_query",
        });
        const { text } = readToolPayload(result, `sv_query:${entry.action}`);
        const durationMs = performance.now() - queryStartedAt;
        durations.push(durationMs);
        return {
          durationMs,
          responseBytes: Buffer.byteLength(text, "utf8"),
          responseCharacters: text.length,
        };
      },
    });
    return {
      actionCounts: summary.actionCounts,
      completedQueries: summary.completedQueries,
      evidenceClassification:
        options.iterations >= 1_000 ? "stage3ReadMatrix" : "developmentSmoke",
      executorBuildId: baseline.executorBuildId,
      maximumResponseBytes: summary.maximumResponseBytes,
      maximumResponseCharacters: summary.maximumResponseCharacters,
      mode: "stage3Reads",
      projectDataIncluded: false,
      timingMs: {
        maximum: Number(Math.max(...durations).toFixed(3)),
        p50: Number(percentile(durations, 0.5).toFixed(3)),
        p95: Number(percentile(durations, 0.95).toFixed(3)),
        total: Number((performance.now() - startedAt).toFixed(3)),
      },
    };
  } finally {
    await client.close().catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = options.dryRun
    ? summarizePlan(options.iterations)
    : await runLive(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
