import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EXECUTOR_BUILD_ID } from "../src/build-info.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { parseBridgeRequest } from "../src/protocol.js";
import { createServer } from "../src/server.js";
import {
  enforceQueryResponseBudget,
  prepareQueryArguments,
  projectQueryResult,
  queryProjectionActionNames,
  queryProjectionPolicy,
  shadowQueryProjection,
} from "../src/v3-query-projector.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function writeStatus(config: BridgeConfig): Promise<void> {
  await writeJsonAtomically(config.paths.statusFile, {
    protocolVersion: 3,
    protocolVersions: [3],
    preferredProtocolVersion: 3,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.2.0",
    executorBuildId: EXECUTOR_BUILD_ID,
    host: { osType: "Windows" },
    projectFile: "query-shadow-test.svp",
    ipcDirectory: config.paths.directory,
    sessionToken: "query-shadow-session",
  });
}

async function serveRead(
  config: BridgeConfig,
  expectedAction: string,
  result: Record<string, unknown>,
  inspectPayload?: (payload: Record<string, unknown>) => void,
): Promise<number> {
  while (true) {
    try {
      await fs.rename(config.paths.requestFile, config.paths.processingFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await sleep(5);
    }
  }
  const request = parseBridgeRequest(
    JSON.parse(await fs.readFile(config.paths.processingFile, "utf8")),
  );
  assert.equal(request.action, expectedAction);
  inspectPayload?.(request.payload);
  await writeJsonAtomically(config.paths.responseFile, {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    r: result,
  });
  await fs.rm(config.paths.processingFile, { force: true });
  return 1;
}

async function serveMixerRead(config: BridgeConfig): Promise<number> {
  return serveRead(config, "get_track_mixer", {
    trackIndex: 1,
    trackName: "Mixer test",
    gainDecibel: -3,
    pan: 0.25,
    muted: false,
    solo: true,
    trackFingerprint: "private-track-fingerprint",
  });
}

function trackListResult(): Record<string, unknown> {
  return {
    trackCount: 2,
    tracks: [
      {
        trackIndex: 1,
        fingerprint: "private-track-fingerprint-1",
        mainGroupUuid: "main-group-1",
        name: "Lead",
        displayColor: "#D6BC43",
        displayColorArgb: "#FFD6BC43",
        displayColorRgb: "#D6BC43",
        displayOrder: 2,
        duration: 7_200,
        groupCount: 2,
        noteCount: 42,
        bounced: false,
        mixer: {
          gainDecibel: 0,
          pan: 0,
          muted: false,
          solo: false,
        },
      },
      {
        trackIndex: 2,
        trackFingerprint: "private-track-fingerprint-2",
        mainGroupUuid: "main-group-2",
        name: "Harmony",
        displayColor: "",
        displayOrder: 1,
        duration: 6_400,
        groupCount: 1,
        noteCount: 21,
        bounced: true,
        mixer: {
          gainDecibel: -3,
          pan: 0.25,
          muted: true,
          solo: false,
        },
      },
    ],
  };
}

function noteGroupListResult(): Record<string, unknown> {
  return {
    groupCount: 2,
    groups: [
      {
        libraryIndex: 1,
        groupUuid: "private-group-uuid-1",
        fingerprint: "private-group-fingerprint-1",
        name: "Shared Lead",
        noteCount: 42,
        pitchControlCount: 5,
        referenceCount: 2,
      },
      {
        libraryIndex: 2,
        groupUuid: "private-group-uuid-2",
        fingerprint: "private-group-fingerprint-2",
        name: "Isolated Harmony",
        noteCount: 21,
        pitchControlCount: 0,
        referenceCount: 1,
      },
    ],
  };
}

function toolJson(result: unknown): Record<string, unknown> {
  const root = result as {
    readonly content?: readonly {
      readonly type: string;
      readonly text?: string;
    }[];
  };
  const text = root.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as Record<string, unknown>;
}

const EXPECTED_QUERY_ACTIONS = [
  "convert_pitch",
  "get_project_info",
  "inspect_score_file",
  "get_time_axis",
  "convert_time",
  "list_tracks",
  "list_note_groups",
  "get_track_notes",
  "get_group_voice",
  "get_note_phoneme_data",
  "get_phrase_context",
  "get_computed_group_data",
  "get_note_retakes",
  "get_pitch_controls",
  "get_automation",
  "sample_automation",
  "get_track_mixer",
] as const;

test("v3 Query policy classifies every public read Action", () => {
  assert.deepEqual(
    [...queryProjectionActionNames()].sort(),
    [...EXPECTED_QUERY_ACTIONS].sort(),
  );
  assert.equal(queryProjectionPolicy("convert_pitch").strategy, "fixed");
  assert.equal(queryProjectionPolicy("list_tracks").strategy, "offsetPage");
  assert.equal(queryProjectionPolicy("get_phrase_context").strategy, "cursorPage");
  assert.equal(queryProjectionPolicy("get_automation").strategy, "rangeSummary");
  assert.equal(
    queryProjectionPolicy("sample_automation").strategy,
    "explicitBounded",
  );
  assert.throws(
    () => queryProjectionPolicy("unknown_read"),
    /No v3 Query projection policy/u,
  );
});

test("v3 Query policy registry exactly matches the live sv_describe read catalog", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-query-policy-catalog-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "v3-query-policy-catalog-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const described = toolJson(
    await client.callTool({
      name: "sv_describe",
      arguments: {},
    }),
  );
  const categories = described.categories as {
    readonly read: readonly string[];
  };
  assert.deepEqual(
    [...queryProjectionActionNames()].sort(),
    [...categories.read].sort(),
  );
});

test("v3 Query policy applies bounded defaults without treating them as caller scope", () => {
  assert.deepEqual(prepareQueryArguments("list_tracks", {}), {
    args: { offset: 0, limit: 128 },
    explicitlyScoped: false,
  });
  assert.deepEqual(prepareQueryArguments("get_track_notes", { trackIndex: 1 }), {
    args: {
      trackIndex: 1,
      groupOffset: 0,
      groupLimit: 1,
      offset: 0,
      limit: 64,
    },
    explicitlyScoped: false,
  });
  assert.deepEqual(
    prepareQueryArguments("get_phrase_context", {
      trackIndex: 1,
      limit: 12,
    }),
    {
      args: { trackIndex: 1, offset: 0, limit: 12 },
      explicitlyScoped: true,
    },
  );
  assert.deepEqual(prepareQueryArguments("get_time_axis", {}), {
    args: {
      tempoOffset: 0,
      tempoLimit: 128,
      measureOffset: 0,
      measureLimit: 128,
    },
    explicitlyScoped: false,
  });
  assert.equal(
    prepareQueryArguments("sample_automation", {
      trackIndex: 1,
      groupIndex: 1,
      parameter: "loudness",
      positions: [0],
    }).explicitlyScoped,
    true,
  );
});

test("shared v3 Query Projector preserves compact phrase and dense-row semantics", () => {
  const root: Record<string, unknown> = {
    trackIndex: 1,
    notes: Array.from({ length: 24 }, (_, index) => ({
      noteIndex: index + 1,
      onset: index * 10,
      duration: 10,
      endPosition: index * 10 + 10,
      absoluteOnset: index * 10,
      absoluteEnd: index * 10 + 10,
      absoluteOnsetSeconds: index / 10,
      absoluteEndSeconds: (index + 1) / 10,
      absoluteDurationSeconds: 0.1,
      pitch: 60,
      absolutePitch: 60,
    })),
    voice: { parameters: {} },
    analysis: { gapCount: 0 },
    recommendations: [{ noteIndex: 1 }],
    contextId: "ctx_phrase",
  };
  const result = projectQueryResult("get_phrase_context", root, {
    include: ["notes", "analysis"],
    dense: "auto",
    debug: false,
    explicitlyScoped: true,
  });

  assert.deepEqual(Object.keys(result.publicProjection).sort(), [
    "analysis",
    "contextId",
    "noteDefaults",
    "noteFormat",
    "notes",
    "trackIndex",
  ]);
  assert.equal(result.publicProjection.noteFormat, "rows");
  const notes = result.publicProjection.notes as {
    readonly columns: readonly string[];
    readonly rows: readonly unknown[][];
  };
  assert.ok(notes.columns.includes("noteIndex"));
  assert.equal(notes.columns.includes("absoluteOnset"), false);
  assert.equal(notes.rows.length, 24);
  assert.equal(
    result.responseCharacters,
    JSON.stringify({
      traceId: "tr_0000000000000000",
      ...result.publicProjection,
    }).length,
  );
  assert.equal(result.budgetClass, "explicitScope");
  assert.equal(result.budgetExceeded, false);
});

test("computed-data projection preserves retry-critical pending state", () => {
  const result = projectQueryResult(
    "get_computed_group_data",
    {
      noteCount: 42,
      returnedNoteOffset: 0,
      returnedNoteCount: 0,
      computedPhonemes: [],
      computedAttributes: [],
      phonemesPending: true,
      attributesPending: true,
      page: {
        offset: 0,
        limit: 64,
        requestedCount: 42,
        returnedCount: 0,
        nextOffset: 0,
        retryOffset: 0,
      },
    },
    {
      dense: "never",
      debug: false,
      explicitlyScoped: false,
    },
  );

  assert.equal(result.publicProjection.phonemesPending, true);
  assert.equal(result.publicProjection.attributesPending, true);
  assert.deepEqual(
    (result.publicProjection.page as Record<string, unknown>).retryOffset,
    0,
  );
});

test("ordinary v3 Query responses fail closed above the model-facing budget", () => {
  const largeRoot = {
    trackIndex: 1,
    notes: [{ noteIndex: 1, lyrics: "x".repeat(21_000) }],
  };
  const ordinary = projectQueryResult(
    "get_phrase_context",
    structuredClone(largeRoot),
    {
      include: ["notes"],
      dense: "never",
      debug: false,
      explicitlyScoped: false,
    },
  );
  assert.equal(ordinary.budgetClass, "ordinary");
  assert.equal(ordinary.budgetExceeded, true);
  assert.throws(
    () => enforceQueryResponseBudget("get_phrase_context", ordinary),
    (error: unknown) => {
      const value = error as {
        readonly code?: string;
        readonly details?: Record<string, unknown>;
      };
      assert.equal(value.code, "QUERY_RESPONSE_BUDGET_EXCEEDED");
      assert.equal(value.details?.budgetCharacters, 20_000);
      assert.equal(
        JSON.stringify(value).includes("x".repeat(100)),
        false,
      );
      return true;
    },
  );

  const explicit = projectQueryResult(
    "get_phrase_context",
    structuredClone(largeRoot),
    {
      include: ["notes"],
      dense: "never",
      debug: false,
      explicitlyScoped: true,
    },
  );
  assert.equal(explicit.budgetExceeded, true);
  assert.equal(explicit.budgetClass, "explicitScope");
  assert.ok(explicit.responseCharacters > 20_000);
  assert.doesNotThrow(() =>
    enforceQueryResponseBudget("get_phrase_context", explicit),
  );
});

test("sv_query returns a bounded public failure instead of an oversized default payload", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-query-budget-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-query-budget-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const privateLyrics = "private-lyric-".repeat(2_000);
  const bridge = serveRead(config, "get_phrase_context", {
    trackIndex: 1,
    groupIndex: 1,
    groupUuid: "private-group-uuid",
    notes: [
      {
        noteIndex: 1,
        pitch: 60,
        lyrics: privateLyrics,
        fingerprint: "private-note-fingerprint",
      },
    ],
    voice: { referenceFingerprint: "private-reference-fingerprint" },
    automation: [],
    analysis: { gapCount: 0 },
  });
  const result = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "get_phrase_context",
      args: { trackIndex: 1, groupIndex: 1 },
      contextMode: "readOnly",
    },
  });
  assert.equal(await bridge, 1);
  const failure = toolJson(result);
  assert.equal(failure.outcome, "failed");
  const error = failure.error as Record<string, unknown>;
  assert.equal(error.code, "QUERY_RESPONSE_BUDGET_EXCEEDED");
  assert.equal(failure.phase, "projected");
  const serialized = JSON.stringify(failure);
  assert.ok(serialized.length <= 4_096);
  assert.doesNotMatch(serialized, /private-lyric/u);
  assert.doesNotMatch(serialized, /private-note-fingerprint/u);

  const diagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: failure.traceId,
        limit: 1,
      },
    }),
  );
  const observability = diagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Record<string, unknown>;
      }[];
    }[];
  };
  const queryProjected = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "queryProjected",
  );
  assert.equal(queryProjected?.metadata?.budgetClass, "ordinary");
  assert.equal(queryProjected?.metadata?.budgetExceeded, true);
  assert.equal(typeof queryProjected?.metadata?.responseCharacters, "number");
});

test("irrelevant top-level include cannot bypass the ordinary Query budget", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-query-include-budget-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-query-include-budget-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const bridge = serveRead(config, "list_tracks", {
    tracks: [
      {
        trackIndex: 1,
        name: "oversized-track-name-".repeat(1_200),
        trackFingerprint: "private-track-fingerprint",
      },
    ],
    totalTrackCount: 1,
    returnedTrackCount: 1,
    offset: 0,
    limit: 128,
    hasMore: false,
  });
  const result = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_tracks",
      args: {},
      include: ["notes"],
      contextMode: "readOnly",
    },
  });
  assert.equal(await bridge, 1);
  const failure = toolJson(result);
  assert.equal(failure.outcome, "failed");
  assert.equal(
    (failure.error as Record<string, unknown>).code,
    "QUERY_RESPONSE_BUDGET_EXCEEDED",
  );
  assert.equal(failure.phase, "projected");
});

test("v3 mixer projector rejects private fields even when explicitly requested", () => {
  const publicProjection = {
    trackIndex: 1,
    contextId: "ctx_public",
  };
  assert.deepEqual(
    shadowQueryProjection(
      "get_track_mixer",
      {
        trackIndex: 1,
        trackFingerprint: "private-track-fingerprint",
      },
      publicProjection,
      ["trackIndex", "trackFingerprint"],
    ),
    {
      state: "matched",
      comparedFieldCount: 2,
      differenceCount: 0,
      privateFieldCount: 1,
    },
  );
});

test("v3 mixer projector reports mismatches without returning project values", () => {
  const report = shadowQueryProjection(
    "get_track_mixer",
    { gainDecibel: -3 },
    { gainDecibel: 0 },
    ["gainDecibel"],
  );
  assert.deepEqual(report, {
    state: "mismatch",
    comparedFieldCount: 1,
    differenceCount: 1,
    privateFieldCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(report), /-3/u);
});

test("v3 Group Voice projector keeps explicit diagnostics but rejects private Guards", () => {
  const publicProjection = {
    trackIndex: 1,
    rawVoice: { paramTension: 0.25 },
    contextId: "ctx_group_voice",
  };
  assert.deepEqual(
    shadowQueryProjection(
      "get_group_voice",
      {
        trackIndex: 1,
        groupUuid: "private-group-uuid",
        referenceFingerprint: "private-reference-fingerprint",
        rawVoice: { paramTension: 0.25 },
      },
      publicProjection,
      ["trackIndex", "rawVoice", "groupUuid", "referenceFingerprint"],
    ),
    {
      state: "matched",
      comparedFieldCount: 3,
      differenceCount: 0,
      privateFieldCount: 2,
    },
  );
});

test("v3 Track collection projector preserves order and nested Contexts", () => {
  const report = shadowQueryProjection(
    "list_tracks",
    trackListResult(),
    {
      trackCount: 2,
      tracks: [
        {
          trackIndex: 1,
          name: "Lead",
          displayColor: "#D6BC43",
          displayColorArgb: "#FFD6BC43",
          displayColorRgb: "#D6BC43",
          displayOrder: 2,
          duration: 7_200,
          groupCount: 2,
          noteCount: 42,
          bounced: false,
          mixer: {
            gainDecibel: 0,
            pan: 0,
            muted: false,
            solo: false,
          },
          contextId: "ctx_track_1",
        },
        {
          trackIndex: 2,
          name: "Harmony",
          displayColor: "",
          displayOrder: 1,
          duration: 6_400,
          groupCount: 1,
          noteCount: 21,
          bounced: true,
          mixer: {
            gainDecibel: -3,
            pan: 0.25,
            muted: true,
            solo: false,
          },
          contextId: "ctx_track_2",
        },
      ],
    },
  );
  assert.deepEqual(report, {
    state: "matched",
    comparedFieldCount: 2,
    comparedItemCount: 2,
    differenceCount: 0,
    privateFieldCount: 4,
  });
});

test("v3 Track collection mismatch reports counts without Track values", () => {
  const report = shadowQueryProjection(
    "list_tracks",
    {
      trackCount: 1,
      tracks: [
        {
          trackIndex: 1,
          fingerprint: "private-track-fingerprint",
          name: "Source secret name",
        },
      ],
    },
    {
      trackCount: 1,
      tracks: [
        {
          trackIndex: 1,
          name: "Different public name",
          contextId: "ctx_track",
        },
      ],
    },
  );
  assert.deepEqual(report, {
    state: "mismatch",
    comparedFieldCount: 2,
    comparedItemCount: 1,
    differenceCount: 1,
    privateFieldCount: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /Source secret name|Different public name/u,
  );
});

test("v3 Note Group collection projector preserves ownership summaries and nested Contexts", () => {
  const report = shadowQueryProjection(
    "list_note_groups",
    noteGroupListResult(),
    {
      groupCount: 2,
      groups: [
        {
          libraryIndex: 1,
          name: "Shared Lead",
          noteCount: 42,
          pitchControlCount: 5,
          referenceCount: 2,
          contextId: "ctx_group_1",
        },
        {
          libraryIndex: 2,
          name: "Isolated Harmony",
          noteCount: 21,
          pitchControlCount: 0,
          referenceCount: 1,
          contextId: "ctx_group_2",
        },
      ],
    },
  );
  assert.deepEqual(report, {
    state: "matched",
    comparedFieldCount: 2,
    comparedItemCount: 2,
    differenceCount: 0,
    privateFieldCount: 4,
  });
});

test("v3 Note Group collection mismatch reports counts without Group values", () => {
  const report = shadowQueryProjection(
    "list_note_groups",
    {
      groupCount: 1,
      groups: [
        {
          libraryIndex: 1,
          groupUuid: "private-group-uuid",
          fingerprint: "private-group-fingerprint",
          name: "Source secret name",
          referenceCount: 2,
        },
      ],
    },
    {
      groupCount: 1,
      groups: [
        {
          libraryIndex: 1,
          name: "Different public name",
          referenceCount: 1,
          contextId: "ctx_group",
        },
      ],
    },
  );
  assert.deepEqual(report, {
    state: "mismatch",
    comparedFieldCount: 2,
    comparedItemCount: 1,
    differenceCount: 1,
    privateFieldCount: 2,
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /Source secret name|Different public name|private-group/u,
  );
});

test("v3 mixer query shadow-compares its projection without another host read", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-query-shadow-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({ name: "v3-query-shadow-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const bridge = serveMixerRead(config);
  const queryResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "get_track_mixer",
      contextMode: "readOnly",
      args: { trackIndex: 1 },
      fields: [
        "trackIndex",
        "trackName",
        "gainDecibel",
        "pan",
        "muted",
        "solo",
        "trackFingerprint",
      ],
    },
  });
  const hostReadCount = await bridge;
  const query = toolJson(queryResult);

  assert.equal(hostReadCount, 1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(query).filter(
        ([key]) => key !== "traceId" && key !== "contextId",
      ),
    ),
    {
      trackIndex: 1,
      trackName: "Mixer test",
      gainDecibel: -3,
      pan: 0.25,
      muted: false,
      solo: true,
    },
  );
  assert.equal(typeof query.contextId, "string");
  assert.equal(query.trackFingerprint, undefined);

  const diagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: query.traceId,
        limit: 1,
      },
    }),
  );
  const observability = diagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const shadowStage = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "shadowProjected",
  );
  assert.deepEqual(shadowStage?.metadata, {
    action: "get_track_mixer",
    projectionParity: "matched",
    comparedFieldCount: 7,
    differenceCount: 0,
    privateFieldCount: 1,
  });
  const projectedStage = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "queryProjected",
  );
  assert.equal(projectedStage?.metadata?.action, "get_track_mixer");
  assert.equal(projectedStage?.metadata?.projectionStrategy, "fixed");
  assert.equal(projectedStage?.metadata?.budgetExceeded, false);
  assert.equal(typeof projectedStage?.metadata?.durationMs, "number");
  assert.equal(typeof projectedStage?.metadata?.responseCharacters, "number");
});

test("v3 Group Voice query shadow-compares its compact default with one host read", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-group-voice-shadow-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-group-voice-shadow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const bridge = serveRead(config, "get_group_voice", {
    trackIndex: 1,
    groupIndex: 2,
    groupUuid: "private-group-uuid",
    referenceFingerprint: "private-reference-fingerprint",
    parameters: { loudness: 0, tension: 0.25 },
    vocalModes: { Soft: { pitch: 20 } },
    rawVoice: { paramTension: 0.25 },
    experimentalUnison: { documented: false },
    phonemeCapabilities: { probed: false },
    selectionContext: { selected: true },
  });
  const queryResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "get_group_voice",
      contextMode: "readOnly",
      args: { trackIndex: 1, groupIndex: 2 },
    },
  });
  const hostReadCount = await bridge;
  const query = toolJson(queryResult);

  assert.equal(hostReadCount, 1);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(query).filter(
        ([key]) => key !== "traceId" && key !== "contextId",
      ),
    ),
    {
      trackIndex: 1,
      groupIndex: 2,
      parameters: { loudness: 0, tension: 0.25 },
      vocalModes: { Soft: { pitch: 20 } },
    },
  );
  assert.equal(typeof query.contextId, "string");
  assert.equal(query.groupUuid, undefined);
  assert.equal(query.referenceFingerprint, undefined);
  assert.equal(query.rawVoice, undefined);

  const diagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: query.traceId,
        limit: 1,
      },
    }),
  );
  const observability = diagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const shadowStage = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "shadowProjected",
  );
  assert.deepEqual(shadowStage?.metadata, {
    action: "get_group_voice",
    projectionParity: "matched",
    comparedFieldCount: 5,
    differenceCount: 0,
    privateFieldCount: 2,
  });

  const explicitBridge = serveRead(config, "get_group_voice", {
    trackIndex: 1,
    groupIndex: 2,
    groupUuid: "private-group-uuid",
    referenceFingerprint: "private-reference-fingerprint",
    parameters: { loudness: 0, tension: 0.25 },
    vocalModes: { Soft: { pitch: 20 } },
    rawVoice: { paramTension: 0.25 },
    experimentalUnison: { documented: false },
    phonemeCapabilities: { probed: false },
    selectionContext: { selected: true },
  });
  const explicitResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "get_group_voice",
      contextMode: "readOnly",
      args: { trackIndex: 1, groupIndex: 2 },
      fields: [
        "trackIndex",
        "groupIndex",
        "rawVoice",
        "experimentalUnison",
        "phonemeCapabilities",
        "selectionContext",
        "groupUuid",
        "referenceFingerprint",
      ],
    },
  });
  assert.equal(await explicitBridge, 1);
  const explicitQuery = toolJson(explicitResult);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(explicitQuery).filter(
        ([key]) => key !== "traceId" && key !== "contextId",
      ),
    ),
    {
      trackIndex: 1,
      groupIndex: 2,
      rawVoice: { paramTension: 0.25 },
      experimentalUnison: { documented: false },
      phonemeCapabilities: { probed: false },
      selectionContext: { selected: true },
    },
  );
  assert.equal(typeof explicitQuery.contextId, "string");
  assert.equal(explicitQuery.groupUuid, undefined);
  assert.equal(explicitQuery.referenceFingerprint, undefined);

  const explicitDiagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: explicitQuery.traceId,
        limit: 1,
      },
    }),
  );
  const explicitObservability = explicitDiagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const explicitShadowStage =
    explicitObservability.traces[0]?.stages.find(
      (stage) => stage.stage === "shadowProjected",
    );
  assert.deepEqual(explicitShadowStage?.metadata, {
    action: "get_group_voice",
    projectionParity: "matched",
    comparedFieldCount: 7,
    differenceCount: 0,
    privateFieldCount: 2,
  });
});

test("v3 Track collection shadow-compares nested Contexts with one host read", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-track-list-shadow-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-track-list-shadow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const bridge = serveRead(
    config,
    "list_tracks",
    trackListResult(),
    (payload) => {
      assert.deepEqual(payload, { offset: 0, limit: 128 });
    },
  );
  const queryResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_tracks",
      contextMode: "readOnly",
      args: {},
    },
  });
  assert.equal(await bridge, 1);
  const query = toolJson(queryResult);
  assert.equal(query.trackCount, 2);
  const tracks = query.tracks as Record<string, unknown>[];
  assert.deepEqual(
    tracks.map((track) => track.name),
    ["Lead", "Harmony"],
  );
  assert.equal(typeof tracks[0]?.contextId, "string");
  assert.equal(typeof tracks[1]?.contextId, "string");
  assert.equal(tracks[0]?.fingerprint, undefined);
  assert.equal(tracks[1]?.trackFingerprint, undefined);
  assert.equal(tracks[0]?.mainGroupUuid, undefined);
  assert.equal(tracks[1]?.mainGroupUuid, undefined);
  assert.deepEqual(tracks[0]?.mixer, {
    gainDecibel: 0,
    pan: 0,
    muted: false,
    solo: false,
  });
  assert.equal(tracks[0]?.displayColorArgb, "#FFD6BC43");
  assert.equal(tracks[1]?.displayColorArgb, undefined);

  const diagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: query.traceId,
        limit: 1,
      },
    }),
  );
  const observability = diagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const shadowStage = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "shadowProjected",
  );
  assert.deepEqual(shadowStage?.metadata, {
    action: "list_tracks",
    projectionParity: "matched",
    comparedFieldCount: 2,
    comparedItemCount: 2,
    differenceCount: 0,
    privateFieldCount: 4,
  });

  const countBridge = serveRead(config, "list_tracks", trackListResult());
  const countResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_tracks",
      contextMode: "readOnly",
      args: {},
      fields: ["trackCount"],
    },
  });
  assert.equal(await countBridge, 1);
  const countQuery = toolJson(countResult);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(countQuery).filter(([key]) => key !== "traceId"),
    ),
    { trackCount: 2 },
  );
  const countDiagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: countQuery.traceId,
        limit: 1,
      },
    }),
  );
  const countObservability = countDiagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const countShadowStage =
    countObservability.traces[0]?.stages.find(
      (stage) => stage.stage === "shadowProjected",
    );
  assert.deepEqual(countShadowStage?.metadata, {
    action: "list_tracks",
    projectionParity: "matched",
    comparedFieldCount: 1,
    comparedItemCount: 0,
    differenceCount: 0,
    privateFieldCount: 4,
  });
});

test("v3 Note Group collection shadow-compares ownership Contexts with one host read", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-note-group-list-shadow-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-note-group-list-shadow-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const bridge = serveRead(
    config,
    "list_note_groups",
    noteGroupListResult(),
    (payload) => {
      assert.deepEqual(payload, { offset: 0, limit: 128 });
    },
  );
  const queryResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_note_groups",
      contextMode: "writeIntent",
      args: {},
    },
  });
  assert.equal(await bridge, 1);
  const query = toolJson(queryResult);
  assert.equal(query.groupCount, 2);
  const groups = query.groups as Record<string, unknown>[];
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Shared Lead", "Isolated Harmony"],
  );
  assert.deepEqual(
    groups.map((group) => group.referenceCount),
    [2, 1],
  );
  assert.equal(typeof groups[0]?.contextId, "string");
  assert.equal(typeof groups[1]?.contextId, "string");
  assert.equal(groups[0]?.groupUuid, undefined);
  assert.equal(groups[0]?.fingerprint, undefined);

  const diagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: query.traceId,
        limit: 1,
      },
    }),
  );
  const observability = diagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const shadowStage = observability.traces[0]?.stages.find(
    (stage) => stage.stage === "shadowProjected",
  );
  assert.deepEqual(shadowStage?.metadata, {
    action: "list_note_groups",
    projectionParity: "matched",
    comparedFieldCount: 2,
    comparedItemCount: 2,
    differenceCount: 0,
    privateFieldCount: 4,
  });

  const countBridge = serveRead(
    config,
    "list_note_groups",
    noteGroupListResult(),
  );
  const countResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_note_groups",
      contextMode: "readOnly",
      args: {},
      fields: ["groupCount"],
    },
  });
  assert.equal(await countBridge, 1);
  const countQuery = toolJson(countResult);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(countQuery).filter(([key]) => key !== "traceId"),
    ),
    { groupCount: 2 },
  );
  const countDiagnostics = toolJson(
    await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "debug",
        traceId: countQuery.traceId,
        limit: 1,
      },
    }),
  );
  const countObservability = countDiagnostics.observability as {
    readonly traces: readonly {
      readonly stages: readonly {
        readonly stage: string;
        readonly metadata?: Readonly<Record<string, unknown>>;
      }[];
    }[];
  };
  const countShadowStage =
    countObservability.traces[0]?.stages.find(
      (stage) => stage.stage === "shadowProjected",
    );
  assert.deepEqual(countShadowStage?.metadata, {
    action: "list_note_groups",
    projectionParity: "matched",
    comparedFieldCount: 1,
    comparedItemCount: 0,
    differenceCount: 0,
    privateFieldCount: 4,
  });
});

test("get_track_notes never exposes the nested private main Group locator", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-track-notes-privacy-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-track-notes-privacy-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const privateMainGroupUuid = "private-main-group-uuid";
  const resultFixture = {
    trackIndex: 1,
    track: {
      trackIndex: 1,
      name: "Lead",
      fingerprint: "private-track-fingerprint",
      mainGroupUuid: privateMainGroupUuid,
    },
    groupCount: 1,
    groups: [
      {
        groupIndex: 1,
        groupUuid: privateMainGroupUuid,
        referenceFingerprint: "private-reference-fingerprint",
        noteCount: 0,
        notes: [],
      },
    ],
  };
  const variants = [
    {},
    { fields: ["track"] },
    { debug: true },
  ] as const;

  for (const variant of variants) {
    const bridge = serveRead(config, "get_track_notes", resultFixture);
    const response = await client.callTool({
      name: "sv_query",
      arguments: {
        action: "get_track_notes",
        contextMode: "readOnly",
        args: { trackIndex: 1 },
        ...variant,
      },
    });
    assert.equal(await bridge, 1);
    assert.doesNotMatch(
      JSON.stringify(toolJson(response)),
      /private-main-group-uuid/u,
    );
  }
});
