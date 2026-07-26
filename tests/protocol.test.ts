import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_ACTIONS,
  parseBridgeRequest,
  parseBridgeResponse,
  parseBridgeStatus,
  ProtocolValidationError,
} from "../src/protocol.js";

const requestId = "550e8400-e29b-41d4-a716-446655440000";

test("parseBridgeRequest accepts a valid request envelope", () => {
  const parsed = parseBridgeRequest({
    protocolVersion: 1,
    requestId,
    action: "ping",
    createdAt: "2026-07-26T00:00:00.000Z",
    payload: {},
  });
  assert.equal(parsed.action, "ping");
  assert.equal(parsed.requestId, requestId);
});

test("protocol v1 recognizes every registered bridge action", () => {
  for (const action of BRIDGE_ACTIONS) {
    const parsed = parseBridgeRequest({
      protocolVersion: 1,
      requestId,
      action,
      createdAt: "2026-07-26T00:00:00.000Z",
      payload: {},
    });
    assert.equal(parsed.action, action);
  }
});

test("protocol parsers reject mismatched versions and request IDs", () => {
  assert.throws(
    () =>
      parseBridgeRequest({
        protocolVersion: 2,
        requestId,
        action: "ping",
        createdAt: "2026-07-26T00:00:00.000Z",
        payload: {},
      }),
    ProtocolValidationError,
  );

  assert.throws(
    () =>
      parseBridgeResponse({
        protocolVersion: 1,
        requestId: "not-a-uuid",
        completedAt: "2026-07-26T00:00:00Z",
        ok: true,
        result: {},
      }),
    /UUID/,
  );
});

test("parseBridgeStatus preserves host extensions and validates heartbeat fields", () => {
  const parsed = parseBridgeStatus({
    protocolVersion: 1,
    state: "running",
    updatedAtEpochMs: 1234,
    bridgeVersion: "0.1.0",
    host: { osType: "Windows", customField: "kept" },
    projectFile: "song.svp",
    ipcDirectory: "C:\\Temp",
    sessionToken: "session",
  });
  assert.equal(parsed.host.customField, "kept");
  assert.equal(parsed.sessionToken, "session");
});
