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
import { shadowQueryProjection } from "../src/v3-query-projector.js";

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
    bridgeVersion: "0.2.0-alpha.1",
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
          contextId: "ctx_track_1",
        },
        {
          trackIndex: 2,
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
    privateFieldCount: 2,
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

  const bridge = serveRead(config, "list_tracks", trackListResult());
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
    privateFieldCount: 2,
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
    privateFieldCount: 2,
  });
});
