import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import {
  BridgeBusyError,
  BridgeRemoteError,
  BridgeTimeoutError,
} from "../src/errors.js";
import { FileIpcClient } from "../src/ipc/file-ipc-client.js";
import { parseBridgeRequest } from "../src/protocol.js";

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

test("FileIpcClient performs a correlated request/response round trip", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  const bridge = serveRequests(fixture.config, 1, (request) => ({
    protocolVersion: 1,
    requestId: request.requestId,
    completedAt: new Date().toISOString(),
    ok: true,
    result: { echoedAction: request.action, payload: request.payload },
  }));

  const result = await fixture.client.send<{ echoedAction: string; payload: unknown }>(
    "get_project_info",
    { detail: true },
  );
  await bridge;

  assert.equal(result.echoedAction, "get_project_info");
  assert.deepEqual(result.payload, { detail: true });
  await assert.rejects(fs.access(fixture.config.paths.lockFile), /ENOENT/);
});

test("FileIpcClient serializes concurrent calls on one client", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  const observed: string[] = [];
  const bridge = serveRequests(fixture.config, 2, (request, index) => {
    observed.push(request.action);
    return {
      protocolVersion: 1,
      requestId: request.requestId,
      completedAt: new Date().toISOString(),
      ok: true,
      result: index,
    };
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

  const bridge = serveRequests(fixture.config, 1, (request) => ({
    protocolVersion: 1,
    requestId: request.requestId,
    completedAt: new Date().toISOString(),
    ok: false,
    error: { code: "STALE_NOTE", message: "The note changed" },
  }));

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
    await sleep(300);
    await fs.rm(fixture.config.paths.processingFile, { force: true });
  })();

  await assert.rejects(
    fixture.client.send("ping"),
    (error: unknown) => error instanceof BridgeTimeoutError,
  );
  await fs.access(fixture.config.paths.processingFile);
  await assert.rejects(
    fixture.client.send("ping"),
    (error: unknown) => error instanceof BridgeBusyError,
  );
  await bridge;
});

test("getStatus distinguishes fresh and stale heartbeats", async (context) => {
  const fixture = await createFixture();
  context.after(async () => fs.rm(fixture.directory, { recursive: true, force: true }));

  await writeJsonAtomically(fixture.config.paths.statusFile, {
    protocolVersion: 1,
    state: "running",
    updatedAtEpochMs: Date.now(),
    bridgeVersion: "0.1.0",
    host: { osType: "Linux" },
    projectFile: "song.svp",
    ipcDirectory: fixture.directory,
  });
  assert.equal((await fixture.client.getStatus()).connected, true);

  await writeJsonAtomically(fixture.config.paths.statusFile, {
    protocolVersion: 1,
    state: "running",
    updatedAtEpochMs: Date.now() - 5000,
    bridgeVersion: "0.1.0",
    host: { osType: "Linux" },
    projectFile: "song.svp",
    ipcDirectory: fixture.directory,
  });
  const stale = await fixture.client.getStatus();
  assert.equal(stale.connected, false);
  assert.equal(stale.fresh, false);
});
