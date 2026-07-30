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

async function writeStatus(
  config: BridgeConfig,
  sessionToken: string,
): Promise<void> {
  await writeJsonAtomically(config.paths.statusFile, {
    protocolVersion: 3,
    protocolVersions: [3],
    preferredProtocolVersion: 3,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.2.0-alpha.1",
    executorBuildId: EXECUTOR_BUILD_ID,
    host: { osType: "Windows" },
    projectFile: "session-test.svp",
    ipcDirectory: config.paths.directory,
    sessionToken,
  });
}

async function serveTrackList(config: BridgeConfig): Promise<void> {
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
  assert.equal(request.action, "list_tracks");
  await writeJsonAtomically(config.paths.responseFile, {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    r: {
      tracks: [
        {
          trackIndex: 1,
          trackFingerprint: "private-track-fingerprint",
          name: "Track",
        },
      ],
    },
  });
  await fs.rm(config.paths.processingFile, { force: true });
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

test("v3 rejects an old write context through the public MCP path after session change", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-session-test-"),
  );
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config, "session-a");

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({ name: "v3-session-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const bridge = serveTrackList(config);
  const queryResult = await client.callTool({
    name: "sv_query",
    arguments: {
      action: "list_tracks",
      contextMode: "writeIntent",
      args: {},
    },
  });
  await bridge;
  const query = toolJson(queryResult);
  const tracks = query.tracks as Record<string, unknown>[];
  const contextId = tracks[0]?.contextId;
  assert.equal(typeof contextId, "string");
  assert.equal(tracks[0]?.trackFingerprint, undefined);

  await writeStatus(config, "session-b");
  const commandResult = await client.callTool({
    name: "sv_command",
    arguments: {
      action: "set_track_mixer",
      contextId,
      args: { gainDecibel: -3 },
    },
  });
  assert.equal(commandResult.isError, true);
  const failure = toolJson(commandResult);
  assert.equal(failure.outcome, "failed");
  assert.equal(
    (failure.error as Record<string, unknown>).code,
    "SYNTHV_SESSION_CHANGED",
  );
  await assert.rejects(fs.access(config.paths.requestFile), { code: "ENOENT" });
});

test("v3 public command blocks a mismatched active executor before project IPC", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-build-test-"),
  );
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  await writeStatus(config, "session-build-mismatch");
  const status = JSON.parse(
    await fs.readFile(config.paths.statusFile, "utf8"),
  ) as Record<string, unknown>;
  status.executorBuildId = "old-executor-build";
  await writeJsonAtomically(config.paths.statusFile, status);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({ name: "v3-build-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const commandResult = await client.callTool({
    name: "sv_command",
    arguments: {
      action: "set_track_mixer",
      args: {
        trackIndex: 1,
        gainDecibel: -3,
      },
    },
  });
  assert.equal(commandResult.isError, true);
  const failure = toolJson(commandResult);
  assert.equal(failure.outcome, "failed");
  assert.equal(
    (failure.error as Record<string, unknown>).code,
    "BUILD_MISMATCH",
  );
  await assert.rejects(fs.access(config.paths.requestFile), { code: "ENOENT" });
});
