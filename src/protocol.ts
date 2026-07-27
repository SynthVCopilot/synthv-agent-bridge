import {
  CURRENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./config.js";

export const BRIDGE_ACTIONS = [
  "ping",
  "reload_bridge",
  "get_host_info",
  "host_clipboard",
  "show_dialog",
  "convert_pitch",
  "get_project_info",
  "get_time_axis",
  "convert_time",
  "set_time_axis",
  "list_tracks",
  "list_note_groups",
  "create_note_group",
  "clone_note_group",
  "delete_note_group",
  "add_group_reference",
  "clone_group_reference",
  "get_track_notes",
  "get_group_voice",
  "get_note_phoneme_data",
  "get_phrase_context",
  "get_selection",
  "set_selection",
  "get_computed_group_data",
  "add_track",
  "update_track",
  "clone_track",
  "delete_track",
  "update_group",
  "set_group_voice",
  "delete_group_reference",
  "add_notes",
  "edit_notes",
  "set_note_phoneme_properties",
  "delete_notes",
  "get_note_retakes",
  "generate_note_retake",
  "activate_note_retake",
  "delete_note_retake",
  "get_pitch_controls",
  "add_pitch_controls",
  "edit_pitch_controls",
  "delete_pitch_controls",
  "get_automation",
  "sample_automation",
  "simplify_automation",
  "set_automation_points",
  "clear_automation",
  "get_editor_view",
  "set_editor_view",
  "snap_position",
  "convert_editor_coordinates",
  "script_data",
  "get_track_mixer",
  "set_track_mixer",
  "apply_transaction",
  "rollback_transaction",
  "create_harmony_track",
  "humanize_notes",
  "apply_expression_preset",
  "fit_lyrics",
  "playback",
] as const;

export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

export interface BridgeRequest {
  readonly protocolVersion:
    | typeof PROTOCOL_VERSION
    | typeof CURRENT_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly action: BridgeAction;
  readonly createdAt?: string;
  readonly payload: Record<string, unknown>;
}

export interface BridgeRemoteErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type BridgeResponse =
  | {
      readonly protocolVersion:
        | typeof PROTOCOL_VERSION
        | typeof CURRENT_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly completedAt?: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly protocolVersion:
        | typeof PROTOCOL_VERSION
        | typeof CURRENT_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly completedAt?: string;
      readonly ok: false;
      readonly error: BridgeRemoteErrorPayload;
    };

export interface BridgeHostInfo {
  readonly osType?: string;
  readonly osName?: string;
  readonly hostName?: string;
  readonly hostVersion?: string;
  readonly hostVersionNumber?: number;
  readonly languageCode?: string;
  readonly [key: string]: unknown;
}

export interface BridgeStatus {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly state: "running" | "stopped" | "error";
  readonly updatedAtEpochMs: number;
  readonly bridgeVersion: string;
  readonly host: BridgeHostInfo;
  readonly projectFile: string;
  readonly ipcDirectory: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export class ProtocolValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_SET = new Set<string>(BRIDGE_ACTIONS);

function fail(path: string, expectation: string): never {
  throw new ProtocolValidationError(`${path} ${expectation}.`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function asUuid(value: unknown, path: string): string {
  const result = asString(value, path);
  if (!UUID_PATTERN.test(result)) {
    fail(path, "must be a UUID");
  }
  return result;
}

function asV2RequestId(value: unknown, path: string): string {
  const result = asString(value, path);
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(result)) {
    fail(path, "must be an 8-64 character base64url identifier");
  }
  return result;
}

function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  return value;
}

function asIsoDateTime(value: unknown, path: string): string {
  const result = asString(value, path);
  if (!Number.isFinite(Date.parse(result))) {
    fail(path, "must be an ISO date-time string");
  }
  return result;
}

function assertProtocolVersion(value: unknown): asserts value is typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) {
    fail("protocolVersion", `must equal ${PROTOCOL_VERSION}`);
  }
}

export function parseBridgeRequest(value: unknown): BridgeRequest {
  const record = asRecord(value, "request");
  if (record.v === CURRENT_PROTOCOL_VERSION) {
    const action = asString(record.a, "a");
    if (!ACTION_SET.has(action)) {
      fail("a", "is not supported");
    }
    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: asV2RequestId(record.id, "id"),
      action: action as BridgeAction,
      payload: asRecord(record.p, "p"),
    };
  }
  assertProtocolVersion(record.protocolVersion);
  const action = asString(record.action, "action");
  if (!ACTION_SET.has(action)) {
    fail("action", "is not supported");
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: asUuid(record.requestId, "requestId"),
    action: action as BridgeAction,
    createdAt: asIsoDateTime(record.createdAt, "createdAt"),
    payload: asRecord(record.payload, "payload"),
  };
}

export function safeParseBridgeRequest(
  value: unknown,
): { readonly success: true; readonly data: BridgeRequest } | { readonly success: false } {
  try {
    return { success: true, data: parseBridgeRequest(value) };
  } catch {
    return { success: false };
  }
}

export function parseBridgeResponse(value: unknown): BridgeResponse {
  const record = asRecord(value, "response");
  if (record.v === CURRENT_PROTOCOL_VERSION) {
    const base = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      requestId: asV2RequestId(record.id, "id"),
    } as const;
    if (Object.prototype.hasOwnProperty.call(record, "r")) {
      if (Object.prototype.hasOwnProperty.call(record, "e")) {
        fail("response", "must not contain both r and e");
      }
      return { ...base, ok: true, result: record.r };
    }
    const error = asRecord(record.e, "e");
    const details = Object.prototype.hasOwnProperty.call(error, "details")
      ? { details: error.details }
      : {};
    return {
      ...base,
      ok: false,
      error: {
        code: asString(error.code, "e.code"),
        message: asString(error.message, "e.message"),
        ...details,
      },
    };
  }
  assertProtocolVersion(record.protocolVersion);
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: asUuid(record.requestId, "requestId"),
    completedAt: asIsoDateTime(record.completedAt, "completedAt"),
  } as const;

  if (record.ok === true) {
    return { ...base, ok: true, result: record.result };
  }
  if (record.ok !== false) {
    fail("ok", "must be a boolean");
  }

  const error = asRecord(record.error, "error");
  const details = Object.prototype.hasOwnProperty.call(error, "details")
    ? { details: error.details }
    : {};
  return {
    ...base,
    ok: false,
    error: {
      code: asString(error.code, "error.code"),
      message: asString(error.message, "error.message"),
      ...details,
    },
  };
}

export function parseBridgeStatus(value: unknown): BridgeStatus {
  const record = asRecord(value, "status");
  assertProtocolVersion(record.protocolVersion);
  const state = asString(record.state, "state");
  if (state !== "running" && state !== "stopped" && state !== "error") {
    fail("state", "must be running, stopped, or error");
  }

  const hostRecord = asRecord(record.host, "host");
  const host: BridgeHostInfo = { ...hostRecord };
  const stringHostFields = [
    "osType",
    "osName",
    "hostName",
    "hostVersion",
    "languageCode",
  ] as const;
  for (const field of stringHostFields) {
    if (hostRecord[field] !== undefined && typeof hostRecord[field] !== "string") {
      fail(`host.${field}`, "must be a string when present");
    }
  }
  if (
    hostRecord.hostVersionNumber !== undefined &&
    (typeof hostRecord.hostVersionNumber !== "number" ||
      !Number.isFinite(hostRecord.hostVersionNumber))
  ) {
    fail("host.hostVersionNumber", "must be a finite number when present");
  }

  const message = record.message;
  if (message !== undefined && typeof message !== "string") {
    fail("message", "must be a string when present");
  }

  return {
    ...record,
    protocolVersion: PROTOCOL_VERSION,
    state,
    updatedAtEpochMs: asFiniteNumber(record.updatedAtEpochMs, "updatedAtEpochMs"),
    bridgeVersion: asString(record.bridgeVersion, "bridgeVersion"),
    host,
    projectFile:
      typeof record.projectFile === "string"
        ? record.projectFile
        : fail("projectFile", "must be a string"),
    ipcDirectory:
      typeof record.ipcDirectory === "string"
        ? record.ipcDirectory
        : fail("ipcDirectory", "must be a string"),
    ...(message === undefined ? {} : { message }),
  };
}
