import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BRIDGE_ACTIONS } from "../src/protocol.js";
import { TRACK_DISPLAY_COLOR_PATTERN } from "../src/server.js";

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
