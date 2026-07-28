import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig builds all IPC paths from a shared directory", () => {
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: "./relative-ipc",
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "1234",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "7",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "4567",
      SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS: "890",
    },
    "/unused",
  );

  assert.equal(config.paths.directory, path.resolve("./relative-ipc"));
  assert.equal(config.paths.requestFile.endsWith("synthv-agent-bridge.request.json"), true);
  assert.equal(config.paths.processingFile.endsWith("synthv-agent-bridge.processing.json"), true);
  assert.equal(config.paths.reloadFile.endsWith("synthv-agent-bridge.reload"), true);
  assert.equal(config.paths.installFile.endsWith("synthv-agent-bridge.install.json"), true);
  assert.equal(
    config.paths.sidebarInstructionFile.endsWith(
      "synthv-agent-bridge.sidebar.instruction.txt",
    ),
    true,
  );
  assert.equal(
    config.paths.sidebarPreviewFile.endsWith(
      "synthv-agent-bridge.sidebar.preview.json",
    ),
    true,
  );
  assert.equal(
    config.paths.sidebarCommandFile.endsWith(
      "synthv-agent-bridge.sidebar.command.txt",
    ),
    true,
  );
  assert.equal(
    config.paths.sidebarHistoryFile.endsWith(
      "synthv-agent-bridge.sidebar.history.json",
    ),
    true,
  );
  assert.equal(
    config.paths.sidebarStateFile.endsWith(
      "synthv-agent-bridge.sidebar.state.txt",
    ),
    true,
  );
  assert.equal(config.timeoutMs, 1234);
  assert.equal(config.pollIntervalMs, 7);
  assert.equal(config.staleRequestMs, 4567);
  assert.equal(config.statusStaleMs, 890);
});

test("loadConfig rejects invalid positive integer settings", () => {
  assert.throws(
    () => loadConfig({ SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "0" }, "/tmp"),
    /must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ SYNTHV_AGENT_BRIDGE_POLL_MS: "1.5" }, "/tmp"),
    /must be a positive integer/,
  );
});

test("loadConfig requires stale recovery to outlive the response timeout", () => {
  assert.throws(
    () =>
      loadConfig(
        {
          SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "5000",
          SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "5000",
        },
        "/tmp",
      ),
    /must be greater than SYNTHV_AGENT_BRIDGE_TIMEOUT_MS/,
  );
});

test("loadConfig uses the low-latency P1 response poll by default", () => {
  assert.equal(loadConfig({}, "/tmp").pollIntervalMs, 10);
});

test("loadConfig ignores the removed legacy MCP-surface switch", () => {
  const config = loadConfig(
    { SYNTHV_AGENT_BRIDGE_MCP_SURFACE: "legacy" },
    "/tmp",
  );
  assert.equal("mcpSurface" in config, false);
});
