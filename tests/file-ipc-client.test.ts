import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { EXECUTOR_BUILD_ID } from "../src/build-info.js";
import {
  BridgeBusyError,
  BridgeRemoteError,
  BridgeTimeoutError,
} from "../src/errors.js";
import { FileIpcClient } from "../src/ipc/file-ipc-client.js";
import { parseBridgeRequest } from "../src/protocol.js";
import {
  currentTraceId,
  runWithTrace,
  traceDiagnostics,
} from "../src/v3-command-kernel.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function createFixture(
  overrides: NodeJS.ProcessEnv = {},
): Promise<{
  directory: string;
  config: BridgeConfig;
  client: FileIpcClient;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synthv-agent-bridge-test-"));
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
      SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "1000",
      ...overrides,
    },
    directory,
  );
  return { directory, config, client: new FileIpcClient(config) };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function serveRequests(
  config: BridgeConfig,
  count: number,
  responder: (request: ReturnType<typeof parseBridgeRequest>, index: number) => unknown,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    let requestRaw: string | undefined;
    while (requestRaw === undefined) {
      try {
        await fs.rename(config.paths.requestFile, config.paths.processingFile);
        requestRaw = await fs.readFile(config.paths.processingFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await sleep(5);
      }
    }

    const request = parseBridgeRequest(JSON.parse(requestRaw));
    const response = responder(request, index);
    await writeJsonAtomically(config.paths.responseFile, response);
    await fs.rm(config.paths.processingFile, { force: true });
  }
}

function successResponse(
  request: ReturnType<typeof parseBridgeRequest>,
  result: unknown,
): unknown {
  return {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    r: result,
  };
}

function errorResponse(
  request: ReturnType<typeof parseBridgeRequest>,
  code: string,
  message: string,
): unknown {
  return {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    e: { code, message },
  };
}

test("FileIpcClient performs a correlated request/response round trip", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  const bridge = serveRequests(fixture.config, 1, (request) =>
    successResponse(request, {
      echoedAction: request.action,
      payload: request.payload,
      expectedExecutorBuildId: request.expectedExecutorBuildId,
    }),
  );

  const result = await fixture.client.send<{
    echoedAction: string;
    payload: unknown;
    expectedExecutorBuildId: string;
  }>(
    "get_project_info",
    { detail: true },
  );
  await bridge;

  assert.equal(result.echoedAction, "get_project_info");
  assert.deepEqual(result.payload, { detail: true });
  assert.equal(result.expectedExecutorBuildId, EXECUTOR_BUILD_ID);
  await assert.rejects(fs.access(fixture.config.paths.lockFile), /ENOENT/);
});

test("FileIpcClient folds bounded Lua timings into the active cross-layer trace", async (context) => {
  const fixture = await createFixture();
  context.after(async () =>
    fs.rm(fixture.directory, { recursive: true, force: true }),
  );
  const bridge = serveRequests(fixture.config, 1, (request) => ({
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    m: {
      totalMs: 7.5,
      stages: [
        { stage: "freshRead", durationMs: 2.25 },
        { stage: "verified", durationMs: 1.5 },
      ],
    },
    r: { trackIndex: 1 },
  }));

  let traceId = "";
  await runWithTrace(async () => {
    traceId = currentTraceId() ?? "";
    await fixture.client.send("get_track_mixer", { trackIndex: 1 });
  });
  await bridge;

  const diagnostics = traceDiagnostics({
    level: "debug",
    traceId,
    limit: 1,
  });
  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /ipcDequeued/u);
  assert.match(serialized, /luaFreshRead/u);
  assert.match(serialized, /"durationMs":2\.25/u);
  assert.match(serialized, /"luaTotalMs":7\.5/u);
});

test("FileIpcClient serializes concurrent calls on one client", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  const observed: string[] = [];
  const bridge = serveRequests(fixture.config, 2, (request, index) => {
    observed.push(request.action);
    return successResponse(request, index);
  });

  const results = await Promise.all([
    fixture.client.send<number>("ping"),
    fixture.client.send<number>("list_tracks"),
  ]);
  await bridge;

  assert.deepEqual(results, [0, 1]);
  assert.deepEqual(observed, ["ping", "list_tracks"]);
});

test("FileIpcClient maps bridge errors to BridgeRemoteError", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  const bridge = serveRequests(fixture.config, 1, (request) =>
    errorResponse(request, "STALE_NOTE", "The note changed"),
  );

  await assert.rejects(
    fixture.client.send("edit_notes", {}),
    (error: unknown) => error instanceof BridgeRemoteError && error.code === "STALE_NOTE",
  );
  await bridge;
});

test("a timeout leaves a claimed request owned by the SynthV host", async (context) => {
  const fixture = await createFixture({
    SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "75",
    SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "2000",
  });
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  let releaseClaimedRequest: () => void = () => undefined;
  const keepRequestClaimed = new Promise<void>((resolve) => {
    releaseClaimedRequest = resolve;
  });
  const bridge = (async () => {
    while (true) {
      try {
        await fs.rename(fixture.config.paths.requestFile, fixture.config.paths.processingFile);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await sleep(5);
      }
    }
    await keepRequestClaimed;
    await fs.rm(fixture.config.paths.processingFile, { force: true });
  })();

  try {
    await assert.rejects(
      fixture.client.send("ping"),
      (error: unknown) => error instanceof BridgeTimeoutError,
    );
    await fs.access(fixture.config.paths.processingFile);
    await assert.rejects(
      fixture.client.send("ping"),
      (error: unknown) => error instanceof BridgeBusyError,
    );
  } finally {
    releaseClaimedRequest();
    await bridge;
  }
});

test("getStatus distinguishes fresh and stale heartbeats", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  await writeJsonAtomically(fixture.config.paths.statusFile, {
    protocolVersion: 3,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.1.0",
    executorBuildId: "executor-test",
    host: { osType: "Linux" },
    projectFile: "song.svp",
    ipcDirectory: fixture.directory,
  });
  assert.equal((await fixture.client.getStatus()).connected, true);

  await writeJsonAtomically(fixture.config.paths.statusFile, {
    protocolVersion: 3,
    state: "running",
    updatedAtEpochMs: Date.now() - 5000,
    bridgeVersion: "0.1.0",
    executorBuildId: "executor-test",
    host: { osType: "Linux" },
    projectFile: "song.svp",
    ipcDirectory: fixture.directory,
  });
  const stale = await fixture.client.getStatus();
  assert.equal(stale.connected, false);
  assert.equal(stale.fresh, false);
});
