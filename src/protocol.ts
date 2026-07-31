import { PROTOCOL_VERSION } from "./config.js";

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
  "clone_track_shell",
  "delete_track",
  "update_group",
  "set_group_voice",
  "apply_group_tuning",
  "delete_group_reference",
  "add_notes",
  "edit_notes",
  "transform_notes",
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
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly traceId: string;
  readonly expectedExecutorBuildId: string;
  readonly action: BridgeAction;
  readonly payload: Record<string, unknown>;
}

export interface BridgeRemoteErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface BridgeStageTiming {
  readonly stage: string;
  readonly durationMs: number;
}

export interface BridgeResponseTelemetry {
  readonly totalMs: number;
  readonly stages: readonly BridgeStageTiming[];
}

export type BridgeResponse =
  | {
      readonly protocolVersion:
        typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly traceId: string;
      readonly executorBuildId: string;
      readonly telemetry?: BridgeResponseTelemetry;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly protocolVersion:
        typeof PROTOCOL_VERSION;
      readonly requestId: string;
      readonly traceId: string;
      readonly executorBuildId: string;
      readonly telemetry?: BridgeResponseTelemetry;
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
  readonly sessionToken?: string;
  readonly executorBuildId?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export class ProtocolValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

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

function asRequestId(value: unknown, path: string): string {
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

function parseResponseTelemetry(value: unknown): BridgeResponseTelemetry {
  const telemetry = asRecord(value, "m");
  const telemetryKeys = Object.keys(telemetry);
  if (
    telemetryKeys.some(
      (key) => key !== "totalMs" && key !== "stages",
    )
  ) {
    fail("m", "must contain only totalMs and stages");
  }
  const totalMs = asFiniteNumber(telemetry.totalMs, "m.totalMs");
  if (totalMs < 0) {
    fail("m.totalMs", "must be non-negative");
  }
  if (!Array.isArray(telemetry.stages) || telemetry.stages.length > 24) {
    fail("m.stages", "must be an array with at most 24 entries");
  }
  const stages = telemetry.stages.map((value, index) => {
    const stage = asRecord(value, `m.stages[${index}]`);
    const keys = Object.keys(stage);
    if (
      keys.length !== 2 ||
      !keys.includes("stage") ||
      !keys.includes("durationMs")
    ) {
      fail(
        `m.stages[${index}]`,
        "must contain only stage and durationMs",
      );
    }
    const stageName = asString(stage.stage, `m.stages[${index}].stage`);
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(stageName)) {
      fail(
        `m.stages[${index}].stage`,
        "must be a short alphanumeric stage name",
      );
    }
    const durationMs = asFiniteNumber(
      stage.durationMs,
      `m.stages[${index}].durationMs`,
    );
    if (durationMs < 0) {
      fail(`m.stages[${index}].durationMs`, "must be non-negative");
    }
    return { stage: stageName, durationMs };
  });
  return { totalMs, stages };
}

function assertWireVersion(value: unknown, path = "v"): asserts value is typeof PROTOCOL_VERSION {
  if (value !== PROTOCOL_VERSION) {
    fail(path, `must equal ${PROTOCOL_VERSION}`);
  }
}

export function parseBridgeRequest(value: unknown): BridgeRequest {
  const record = asRecord(value, "request");
  assertWireVersion(record.v);
  const action = asString(record.a, "a");
  if (!ACTION_SET.has(action)) {
    fail("a", "is not supported");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: asRequestId(record.id, "id"),
    traceId: asRequestId(record.t, "t"),
    expectedExecutorBuildId: asString(record.b, "b"),
    action: action as BridgeAction,
    payload: asRecord(record.p, "p"),
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
  assertWireVersion(record.v);
  const telemetry =
    record.m === undefined
      ? {}
      : { telemetry: parseResponseTelemetry(record.m) };
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: asRequestId(record.id, "id"),
    traceId: asRequestId(record.t, "t"),
    executorBuildId: asString(record.b, "b"),
    ...telemetry,
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

export function parseBridgeStatus(value: unknown): BridgeStatus {
  const record = asRecord(value, "status");
  assertWireVersion(record.protocolVersion, "protocolVersion");
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
  const sessionToken = record.sessionToken;
  if (sessionToken !== undefined && typeof sessionToken !== "string") {
    fail("sessionToken", "must be a string when present");
  }
  const executorBuildId = record.executorBuildId;
  if (executorBuildId !== undefined && typeof executorBuildId !== "string") {
    fail("executorBuildId", "must be a string when present");
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
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(executorBuildId === undefined ? {} : { executorBuildId }),
    ...(message === undefined ? {} : { message }),
  };
}
