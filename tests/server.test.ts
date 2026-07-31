import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../src/config.js";
import { LOCAL_ACTIONS } from "../src/local-actions.js";
import { BRIDGE_ACTIONS } from "../src/protocol.js";
import { TRANSACTION_STEP_ACTIONS } from "../src/sidebar-coordinator.js";
import {
  createServer,
  TRACK_DISPLAY_COLOR_PATTERN,
} from "../src/server.js";
import { V3_INTERNAL_ADAPTER_NAMES } from "../src/v3-surface.js";

test("track color schema accepts public RGB and native ARGB forms", () => {
  for (const value of ["#D6BC43", "ffd6bc43", "#FFD6BC43"]) {
    assert.match(value, TRACK_DISPLAY_COLOR_PATTERN);
  }

  for (const value of ["D6BC43", "#D6BC4", "#GGGGGG", "ffd6bc4300"]) {
    assert.doesNotMatch(value, TRACK_DISPLAY_COLOR_PATTERN);
  }
});

test("every protocol action has exactly one internal action definition", async () => {
  const compiledServer = await readFile(
    new URL("../src/server.js", import.meta.url),
    "utf8",
  );
  const registered = [
    ...compiledServer.matchAll(/server\.registerTool\(\s*"([^"]+)"/g),
  ].map((match) => match[1]);

  assert.equal(new Set(registered).size, registered.length);
  assert.deepEqual(
    registered
      .filter(
        (name) =>
          name !== "bridge_status" &&
          name !== "sidebar_get_request" &&
          name !== "sidebar_status" &&
          name !== "sidebar_publish_preview",
      )
      .sort(),
    [...BRIDGE_ACTIONS, ...LOCAL_ACTIONS].sort(),
  );
});

test("Vocal template track creation is available to transactions and sidebar previews", () => {
  assert.ok(TRANSACTION_STEP_ACTIONS.includes("clone_track_shell"));
});

test("MCP tool text results use compact JSON", async () => {
  const compiledServer = await readFile(
    new URL("../src/server.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    compiledServer,
    /JSON\.stringify\(value,\s*null,\s*2\)/,
  );
});

test("server close is idempotent and stops Sidebar after transport failure", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-server-close-test-"),
  );
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const server = createServer(loadConfig({}, directory));
  let transportCloseCount = 0;
  server.server.close = async () => {
    transportCloseCount += 1;
    throw new Error("injected transport close failure");
  };

  const firstClose = server.close();
  const concurrentClose = server.close();

  assert.strictEqual(firstClose, concurrentClose);
  await assert.rejects(firstClose, /injected transport close failure/u);
  assert.equal(transportCloseCount, 1);
  const status = await readFile(
    loadConfig({}, directory).paths.sidebarClientStatusFile,
    "utf8",
  );
  assert.match(status, /state=stopped/u);
});

test("v3 exposes six semantic tools under a 6 KB metadata budget", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, "/tmp"));
  const client = new Client({ name: "p4-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "sv_status",
        "sv_describe",
        "sv_query",
        "sv_command",
        "sv_ui",
        "sv_review",
      ],
    );
    assert.ok(JSON.stringify(tools.tools).length < 6_000);
    const describe = tools.tools.find((tool) => tool.name === "sv_describe");
    const describeProperties = (
      describe?.inputSchema as {
        readonly properties?: Record<string, unknown>;
      }
    )?.properties;
    assert.ok(describeProperties?.action !== undefined);
    assert.equal(describeProperties?.actions, undefined);

    const statusTool = tools.tools.find((tool) => tool.name === "sv_status");
    const statusProperties = (
      statusTool?.inputSchema as {
        readonly properties?: Record<string, unknown>;
      }
    )?.properties;
    assert.match(JSON.stringify(statusProperties?.operation), /diagnostics/u);
    assert.ok(statusProperties?.level !== undefined);

    const diagnosticsResult = await client.callTool({
      name: "sv_status",
      arguments: {
        operation: "diagnostics",
        level: "support",
        limit: 2,
      },
    });
    const diagnosticsContent = (
      diagnosticsResult as {
        readonly content: readonly {
          readonly type: string;
          readonly text?: string;
        }[];
      }
    ).content;
    const diagnosticsText = diagnosticsContent.find(
      (entry) => entry.type === "text",
    );
    const diagnosticsRaw = diagnosticsText?.text;
    assert.equal(typeof diagnosticsRaw, "string");
    const diagnostics = JSON.parse(
      diagnosticsRaw as string,
    ) as Record<string, unknown>;
    assert.equal(
      (diagnostics.observability as Record<string, unknown>).level,
      "support",
    );
    assert.ok(JSON.stringify(diagnostics).length <= 16_384);

    const statusResult = await client.callTool({
      name: "sv_status",
      arguments: { operation: "bridge" },
    });
    const statusContent = (
      statusResult as {
        readonly content: readonly {
          readonly type: string;
          readonly text?: string;
        }[];
      }
    ).content;
    const statusText = statusContent.find(
      (entry) => entry.type === "text",
    );
    const statusRaw = statusText?.text;
    assert.equal(typeof statusRaw, "string");
    const status = JSON.parse(
      statusRaw as string,
    ) as Record<string, unknown>;
    assert.equal(status.observability, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("v3 private adapters cannot be confused with public or legacy MCP tools", () => {
  const names = Object.values(V3_INTERNAL_ADAPTER_NAMES);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^v3_internal_/u);
    assert.doesNotMatch(
      name,
      /^sv_(?:read|edit|delete|transaction|sidebar)$/u,
    );
  }
});

test("v3 add_notes can create an editable non-main note group", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /ensureNonMain/);
  assert.match(bridgeSource, /grouping == "ensureNonMain" and reference:isMain\(\)/);
  assert.match(bridgeSource, /project:addNoteGroup\(detachedGroup\)/);
  assert.match(bridgeSource, /track:addGroupReference\(detachedReference\)/);
  assert.match(bridgeSource, /detachedReference:setVoice\(reference:getVoice\(\)\)/);
});

test("empty Vocal Mode maps are initialized by clone validation", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /identified from their panel screenshot/);
  assert.match(compiledServer, /do not probe guesses/);
  assert.match(compiledServer, /Omit all locators to use the current piano-roll Group/);
  assert.match(bridgeSource, /currentModes = {}/);
  assert.match(bridgeSource, /resolveCurrentOrExplicitVoiceGroup/);
  assert.match(bridgeSource, /allowAdditionalVocalModes = true/);
  assert.match(
    bridgeSource,
    /ask the user for the exact names shown for the current singer/,
  );
  assert.match(bridgeSource, /kind = "vocal_mode_names"/);
  assert.match(bridgeSource, /doNotRetryGuesses = true/);
  assert.doesNotMatch(
    bridgeSource,
    /The current voice does not expose this Vocal Mode/,
  );
});

test("same-Group tuning is one prevalidated Lua undo record", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /"apply_group_tuning"/);
  assert.match(compiledServer, /\.min\(0\)\.max\(150\)/);
  assert.match(compiledServer, /strength: z\.number\(\)\.finite\(\)\.min\(-1\)\.max\(1\)/);
  assert.match(bridgeSource, /function handlers\.apply_group_tuning/);
  assert.match(bridgeSource, /local PHONEME_ATTRIBUTE_RANGES/);
  assert.match(bridgeSource, /reason = "not_probed_write_verified"/);
  assert.match(bridgeSource, /undoRecordCount = 1/);
  assert.match(bridgeSource, /partialWritePossible = true/);
  assert.match(bridgeSource, /undoRequired = true/);
  assert.match(
    bridgeSource,
    /Use SynthV Edit > Undo once before any retry/,
  );
  assert.doesNotMatch(
    compiledServer,
    /Atomically apply one same-Group tuning pass/,
  );

  const handlerStart = bridgeSource.indexOf(
    "function handlers.apply_group_tuning",
  );
  const handlerEnd = bridgeSource.indexOf(
    "function handlers.get_editor_view",
    handlerStart,
  );
  const handler = bridgeSource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf("prepareGroupVoiceUpdate") >= 0);
  assert.ok(handler.indexOf("prepareNoteChanges") >= 0);
  assert.ok(handler.indexOf("definition.range") >= 0);
  assert.match(handler, /executeCommandPipeline/);
  assert.match(handler, /snapshotPitchControlContent/);
  assert.doesNotMatch(handler, /createUndoRecord\(project\)/);
});

test("deterministic note transforms stay guarded and use one edit undo boundary", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /"transform_notes"/);
  assert.match(compiledServer, /args\.target=contextNotes/);
  assert.match(compiledServer, /explicit numeric transform/);

  const handlerStart = bridgeSource.indexOf(
    "function handlers.transform_notes",
  );
  const handlerEnd = bridgeSource.indexOf(
    "local function makeDeterministicRandom",
    handlerStart,
  );
  const handler = bridgeSource.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0);
  assert.match(handler, /validateFingerprint/);
  assert.match(handler, /getBlickFromSeconds/);
  assert.match(handler, /handlers\.edit_notes/);
  assert.match(handler, /never chooses musical intent or target notes/);
  assert.doesNotMatch(handler, /createUndoRecord\(project\)/);

  const editHandlerStart = bridgeSource.indexOf(
    "function handlers.edit_notes",
  );
  const editHandler = bridgeSource.slice(
    editHandlerStart,
    handlerStart,
  );
  assert.match(editHandler, /executeCommandPipeline/);
  assert.match(editHandler, /HOST_POSTCONDITION_FAILED/);
  assert.match(editHandler, /snapshotNoteContent/);
});

test("automation writes fail closed without the fresh host definition range", async () => {
  const bridgeSource = await readFile(
    new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
    "utf8",
  );
  assert.match(
    bridgeSource,
    /local function requireAutomationDefinitionRange/,
  );
  assert.match(bridgeSource, /Automation\.getDefinition\(\)\.range/);

  const ordinaryStart = bridgeSource.indexOf(
    "function handlers.set_automation_points",
  );
  const ordinaryEnd = bridgeSource.indexOf(
    "function handlers.clear_automation",
    ordinaryStart,
  );
  assert.match(
    bridgeSource.slice(ordinaryStart, ordinaryEnd),
    /requireAutomationDefinitionRange/,
  );

  const batchStart = bridgeSource.indexOf(
    "function handlers.apply_group_tuning",
  );
  const batchEnd = bridgeSource.indexOf(
    "function handlers.get_editor_view",
    batchStart,
  );
  assert.match(
    bridgeSource.slice(batchStart, batchEnd),
    /requireAutomationDefinitionRange/,
  );
});

test("P1 uses low-latency host polling and exposes selective phoneme computation", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /includeComputedPhonemes/);
  assert.match(bridgeSource, /local POLL_INTERVAL_MS = 25/);
  assert.match(bridgeSource, /local HEARTBEAT_EVERY_POLLS = 40/);
  assert.match(bridgeSource, /local SESSION_CHECK_EVERY_POLLS = 10/);
});

test("P2 exposes one bounded write-ready phrase context", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /get_phrase_context/);
  assert.match(compiledServer, /compactPhraseContextGuards/);
  assert.match(compiledServer, /pitchAnalysisFrames/);
  assert.match(bridgeSource, /function handlers\.get_phrase_context/);
  assert.match(bridgeSource, /recommendationLimit/);
  assert.match(bridgeSource, /summarizePhraseAutomation/);
  assert.match(bridgeSource, /compactPhraseNoteDefaults/);
  assert.match(bridgeSource, /noteDefaultsOmitted = true/);
});

test("P3 exposes explicit coverage, guarded cursors, and one-sweep multi-range reads", async () => {
  const [compiledServer, bridgeSource] = await Promise.all([
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(
      new URL("../../synthv/SynthVAgentBridge.lua", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(compiledServer, /resolvePhraseCursorPayload/);
  assert.match(compiledServer, /cursorToken/);
  assert.match(compiledServer, /rangeMatch/);
  assert.match(compiledServer, /ranges/);
  assert.match(bridgeSource, /findFirstNoteOnsetAtLeast/);
  assert.match(bridgeSource, /STALE_RANGE_CURSOR/);
  assert.match(bridgeSource, /multi_range_overlap_sweep/);
  assert.match(bridgeSource, /rangeScannedNoteCount/);
});
