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
import { V3ContextStore } from "../src/v3-context-store.js";
import { commandPolicyFor } from "../src/v3-command-policy.js";
import { v3Testing } from "../src/v3-surface.js";

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
    projectFile: "clone-command-test.svp",
    ipcDirectory: config.paths.directory,
    sessionToken: "clone-command-session",
  });
}

async function serveOneCloneCommand(
  config: BridgeConfig,
  response: Record<string, unknown> = {
    changedCount: 1,
    verified: true,
    targetGroupUuid: "00000000-0000-4000-8000-000000000099",
    trackIndex: 3,
  },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try {
      await fs.rename(config.paths.requestFile, config.paths.processingFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for clone command IPC");
      }
      await sleep(5);
    }
  }
  const request = parseBridgeRequest(
    JSON.parse(await fs.readFile(config.paths.processingFile, "utf8")),
  );
  await writeJsonAtomically(config.paths.responseFile, {
    v: 3,
    id: request.requestId,
    t: request.traceId,
    b: EXECUTOR_BUILD_ID,
    r: response,
  });
  await fs.rm(config.paths.processingFile, { force: true });
  return request.payload;
}

test("clone command policy declares linked, isolated, and shell ownership intent", () => {
  assert.deepEqual(commandPolicyFor("clone_group_reference"), {
    category: "edit",
    targetAggregates: ["GroupContent", "GroupReference"],
    contextKinds: ["track", "group", "automation"],
    ownershipPolicies: ["sharedGroupContent", "referenceLocal"],
    cloneIntents: ["linked", "isolated"],
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "hostReadback",
    transactionEligibility: "eligible",
  });
  assert.deepEqual(commandPolicyFor("clone_track"), {
    category: "edit",
    targetAggregates: ["GroupContent", "GroupReference", "TrackShell"],
    contextKinds: ["track"],
    ownershipPolicies: [
      "sharedGroupContent",
      "referenceLocal",
      "trackShell",
    ],
    cloneIntents: ["isolated"],
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "hostReadback",
    transactionEligibility: "eligible",
    contextExpansion: { trackGuard: true },
  });
  assert.deepEqual(commandPolicyFor("clone_track_shell"), {
    category: "edit",
    targetAggregates: ["TrackShell"],
    contextKinds: ["track"],
    ownershipPolicies: ["trackShell"],
    cloneIntents: ["shell"],
    expectedEffectPolicy: "allowAlreadySatisfied",
    postconditionStrategy: "hostReadback",
    transactionEligibility: "eligible",
    contextExpansion: { trackGuard: true },
  });
});

test("v3 clone commands require a named cloneIntent and reject deepCopy", () => {
  const contexts = new V3ContextStore();

  assert.throws(
    () =>
      v3Testing.expandContext(
        "clone_group_reference",
        {
          cloneIntent: "isolated",
          deepCopy: true,
          sourceTrackIndex: 1,
          sourceGroupIndex: 2,
          targetTrackIndex: 2,
        },
        undefined,
        contexts,
      ),
    /deepCopy is not accepted/u,
  );
  assert.throws(
    () =>
      v3Testing.expandContext(
        "clone_group_reference",
        {
          sourceTrackIndex: 1,
          sourceGroupIndex: 2,
          targetTrackIndex: 2,
        },
        undefined,
        contexts,
      ),
    /cloneIntent is required/u,
  );
  assert.throws(
    () =>
      v3Testing.expandContext(
        "clone_track",
        {
          cloneIntent: "linked",
          trackIndex: 1,
        },
        undefined,
        contexts,
      ),
    /cloneIntent must be isolated/u,
  );
  assert.deepEqual(
    v3Testing.expandContext(
      "clone_track_shell",
      {
        cloneIntent: "shell",
        trackIndex: 1,
      },
      undefined,
      contexts,
    ),
    {
      cloneIntent: "shell",
      trackIndex: 1,
    },
  );
});

test("sv_describe publishes cloneIntent without legacy clone booleans", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-clone-describe-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "v3-clone-describe-test",
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

  for (const [action, cloneIntents] of [
    ["clone_group_reference", ["linked", "isolated"]],
    ["clone_track", ["isolated"]],
    ["clone_track_shell", ["shell"]],
  ] as const) {
    const result = toolJson(
      await client.callTool({
        name: "sv_describe",
        arguments: { action },
      }),
    );
    const described = (result.actions as Record<string, unknown>[])[0];
    assert.ok(described);
    const schema = described?.inputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    assert.deepEqual(
      (properties.cloneIntent as Record<string, unknown>).enum,
      cloneIntents,
    );
    assert.equal("deepCopy" in properties, false);
    assert.equal("linked" in properties, false);
    assert.ok((schema.required as string[]).includes("cloneIntent"));
    if (action === "clone_group_reference") {
      assert.deepEqual(described.stability, {
        availability: "partiallyAvailable",
        classification: "experimental",
        disabledIntents: ["isolated"],
        reason:
          "isolated Group-reference clone is disabled after a reproducible SynthV 2.2.1 native crash during Undo; linked clone remains available.",
      });
    }
  }
});

test("sv_describe and sv_command expose only script-data writes", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-script-data-command-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "v3-script-data-command-test",
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
      arguments: { action: "script_data" },
    }),
  );
  const actionDescription = (
    described.actions as Record<string, unknown>[]
  )[0] as Record<string, unknown>;
  const schema = actionDescription.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  assert.deepEqual(
    (properties.operation as Record<string, unknown>).enum,
    ["set", "remove"],
  );

  for (const operation of ["get", "list"]) {
    const rejected = toolJson(
      await client.callTool({
        name: "sv_command",
        arguments: {
          action: "script_data",
          args: {
            operation,
            objectType: "project",
            key: "synthv-agent-bridge.test",
          },
        },
      }),
    );
    assert.equal(rejected.outcome, "failed");
    assert.equal(rejected.phase, "freshRead");
    assert.equal(rejected.wrote, false);
    assert.equal(rejected.undoRequired, false);
    assert.equal(
      (rejected.error as Record<string, unknown>).code,
      "BRIDGE_PROTOCOL_ERROR",
    );
  }
});

test("disabled experimental capabilities fail before project IPC", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-disabled-capability-"),
  );
  const config = loadConfig({}, directory);
  await writeStatus(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({
    name: "v3-disabled-capability-test",
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

  for (const action of ["apply_transaction", "rollback_transaction"]) {
    const described = toolJson(
      await client.callTool({
        name: "sv_describe",
        arguments: { action },
      }),
    );
    const actionDescription = (
      described.actions as Record<string, unknown>[]
    )[0];
    assert.equal(
      (
        actionDescription?.stability as Record<string, unknown>
      ).availability,
      "experimentalDisabled",
    );
  }

  for (const [action, args] of [
    [
      "clone_group_reference",
      {
        cloneIntent: "isolated",
        sourceTrackIndex: 1,
        sourceGroupIndex: 2,
        targetTrackIndex: 1,
      },
    ],
    ["clone_note_group", {}],
    ["clone_track", { cloneIntent: "isolated", trackIndex: 1 }],
    ["clone_track_shell", { cloneIntent: "shell", trackIndex: 1 }],
    ["create_harmony_track", { sourceTrackIndex: 1, intervalSemitones: 3 }],
    ["apply_transaction", {}],
    ["rollback_transaction", {}],
  ] as const) {
    const result = await client.callTool({
      name: "sv_command",
      arguments: { action, args },
    });
    const failure = toolJson(result);
    assert.equal(result.isError, true);
    assert.equal(
      (failure.error as Record<string, unknown>).code,
      "EXPERIMENTAL_CAPABILITY_DISABLED",
    );
    await assert.rejects(fs.access(config.paths.requestFile), {
      code: "ENOENT",
    });
  }
});

test("sv_command preserves cloneIntent through internal action parsing", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-clone-command-"),
  );
  const config = loadConfig(
    {
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
    name: "v3-clone-command-test",
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

  for (const fixture of [
    {
      action: "clone_group_reference",
      cloneIntent: "linked",
      args: {
        sourceTrackIndex: 1,
        sourceGroupIndex: 2,
        targetTrackIndex: 2,
      },
    },
  ] as const) {
    const bridge = serveOneCloneCommand(config);
    const result = await client.callTool({
      name: "sv_command",
      arguments: {
        action: fixture.action,
        args: {
          cloneIntent: fixture.cloneIntent,
          ...fixture.args,
        },
      },
    });
    const payload = await bridge;
    assert.equal(result.isError, undefined);
    assert.equal(payload.cloneIntent, fixture.cloneIntent);
    assert.equal("deepCopy" in payload, false);
    assert.equal("linked" in payload, false);
  }
});

test("sv_command exposes manual review warnings through the bounded public outcome", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-clone-warning-"),
  );
  const config = loadConfig(
    {
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
    name: "v3-clone-warning-test",
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

  const bridge = serveOneCloneCommand(config, {
    changedCount: 1,
    verified: true,
    trackIndex: 3,
    manualReviewWarnings: [
      {
        code: "NON_MAIN_VOCAL_REVIEW_REQUIRED",
        groupCount: 2,
        message:
          "Review each detached non-main Group Vocal in SynthV; the official scripting API cannot read or verify Vocal identity.",
        notes: ["private lyric material"],
      },
    ],
  });
  const result = toolJson(
    await client.callTool({
      name: "sv_command",
      arguments: {
        action: "clone_group_reference",
        args: {
          cloneIntent: "linked",
          sourceTrackIndex: 1,
          sourceGroupIndex: 2,
          targetTrackIndex: 2,
        },
      },
    }),
  );
  await bridge;

  assert.deepEqual(result.warnings, [
    {
      code: "NON_MAIN_VOCAL_REVIEW_REQUIRED",
      groupCount: 2,
      message:
        "Review each detached non-main Group Vocal in SynthV; the official scripting API cannot read or verify Vocal identity.",
      notes: "[redacted]",
    },
  ]);
  assert.equal("manualReviewWarnings" in result, false);
  assert.ok(JSON.stringify(result).length <= 2_048);
});
