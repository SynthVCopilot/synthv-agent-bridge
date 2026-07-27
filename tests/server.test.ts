import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../src/config.js";
import { BRIDGE_ACTIONS } from "../src/protocol.js";
import {
  createServer,
  TRACK_DISPLAY_COLOR_PATTERN,
} from "../src/server.js";

test("track color schema accepts public RGB and native ARGB forms", () => {
  for (const value of ["#D6BC43", "ffd6bc43", "#FFD6BC43"]) {
    assert.match(value, TRACK_DISPLAY_COLOR_PATTERN);
  }

  for (const value of ["D6BC43", "#D6BC4", "#GGGGGG", "ffd6bc4300"]) {
    assert.doesNotMatch(value, TRACK_DISPLAY_COLOR_PATTERN);
  }
});

test("every protocol action is registered exactly once as an MCP tool", async () => {
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
    [...BRIDGE_ACTIONS].sort(),
  );
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

test("P4 exposes eight v2 tools under a 6 KB metadata budget", async () => {
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
        "sv_read",
        "sv_edit",
        "sv_delete",
        "sv_transaction",
        "sv_ui",
        "sv_sidebar",
      ],
    );
    assert.ok(JSON.stringify(tools.tools).length < 6_000);
  } finally {
    await client.close();
    await server.close();
  }
});

test("P4 keeps the complete legacy tool surface isolated behind configuration", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    loadConfig(
      { SYNTHV_AGENT_BRIDGE_MCP_SURFACE: "legacy" },
      "/tmp",
    ),
  );
  const client = new Client({ name: "legacy-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, BRIDGE_ACTIONS.length + 4);
    assert.equal(tools.tools.some((tool) => tool.name === "edit_notes"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "sv_edit"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("v2 add_notes can create an editable non-main note group", async () => {
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
  assert.match(compiledServer, /without per-mode discovery/);
  assert.match(bridgeSource, /currentModes = {}/);
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
