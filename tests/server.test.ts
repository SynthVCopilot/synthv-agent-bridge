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
    registered.filter((name) => name !== "bridge_status").sort(),
    [...BRIDGE_ACTIONS].sort(),
  );
});
