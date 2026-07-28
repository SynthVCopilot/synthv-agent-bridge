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

test("protocol v2 uses the compact request and response envelope", () => {
  const parsedRequest = parseBridgeRequest({
    v: 2,
    id: "AbCdEfGh12345678",
    a: "get_project_info",
    p: { compact: true },
  });
  assert.equal(parsedRequest.protocolVersion, 2);
  assert.equal(parsedRequest.requestId, "AbCdEfGh12345678");
  assert.equal(parsedRequest.action, "get_project_info");
  assert.deepEqual(parsedRequest.payload, { compact: true });

  const parsedSuccess = parseBridgeResponse({
    v: 2,
    id: "AbCdEfGh12345678",
    r: { connected: true },
  });
  assert.equal(parsedSuccess.ok, true);
  assert.deepEqual(parsedSuccess.ok ? parsedSuccess.result : null, {
    connected: true,
  });

  const parsedError = parseBridgeResponse({
    v: 2,
    id: "AbCdEfGh12345678",
    e: { code: "STALE_NOTE", message: "changed" },
  });
  assert.equal(parsedError.ok, false);
  assert.equal(parsedError.ok ? "" : parsedError.error.code, "STALE_NOTE");
});

test("protocol parsers reject mismatched versions and request IDs", () => {
  assert.throws(
    () =>
      parseBridgeRequest({
        protocolVersion: 3,
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

test("parseBridgeStatus validates a present session token", () => {
  assert.throws(
    () =>
      parseBridgeStatus({
        protocolVersion: 1,
        state: "running",
        updatedAtEpochMs: 1234,
        bridgeVersion: "0.1.0",
        host: {},
        projectFile: "song.svp",
        ipcDirectory: "C:\\Temp",
        sessionToken: 123,
      }),
    /sessionToken must be a string/u,
  );
});
