import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BridgeError, BridgeProtocolError, toPublicError } from "./errors.js";
import type { GuardTokenStore } from "./guard-token-store.js";
import {
  V2ContextStore,
  type V2ContextEntry,
} from "./v2-context-store.js";

type JsonRecord = Record<string, unknown>;
type RegisterTool = McpServer["registerTool"];

export type V2ToolDefinitions = ReadonlyMap<string, RegisteredTool>;

const V2_INCLUDE_VALUES = [
  "notes",
  "voice",
  "automation",
  "analysis",
  "recommendations",
  "pitchAnalysis",
  "selection",
  "diagnostics",
] as const;

const EXPLICIT_DELETE_ACTIONS = new Set([
  "clear_automation",
  "delete_group_reference",
  "delete_note_group",
  "delete_note_retake",
  "delete_notes",
  "delete_pitch_controls",
  "delete_track",
]);

const TRANSACTION_ACTIONS = new Set([
  "apply_transaction",
  "rollback_transaction",
]);

const UI_ACTIONS = new Set([
  "convert_editor_coordinates",
  "get_editor_view",
  "get_selection",
  "host_clipboard",
  "playback",
  "set_editor_view",
  "set_selection",
  "show_dialog",
  "snap_position",
]);

const STATUS_OPERATIONS = {
  bridge: "bridge_status",
  host: "get_host_info",
  ping: "ping",
  reload: "reload_bridge",
} as const;

const SIDEBAR_OPERATIONS = {
  get: "sidebar_get_request",
  publish: "sidebar_publish_preview",
  status: "sidebar_status",
} as const;

const NOTE_ARRAY_FIELDS: Readonly<Record<string, string>> = {
  apply_group_tuning: "noteEdits",
  apply_expression_preset: "notes",
  delete_notes: "notes",
  edit_notes: "edits",
  fit_lyrics: "notes",
  humanize_notes: "notes",
  set_note_phoneme_properties: "edits",
  transform_notes: "notes",
};

const PITCH_ARRAY_FIELDS: Readonly<Record<string, string>> = {
  delete_pitch_controls: "pitchControls",
  edit_pitch_controls: "edits",
};

const TRACK_GUARD_ACTIONS = new Set([
  "clone_track",
  "delete_track",
  "set_track_mixer",
  "update_track",
]);

const REFERENCE_GUARD_ACTIONS = new Set([
  "apply_group_tuning",
  "delete_group_reference",
  "set_group_voice",
  "update_group",
]);

const AUTOMATION_GUARD_ACTIONS = new Set([
  "clear_automation",
  "set_automation_points",
  "simplify_automation",
]);

const RETAKE_GUARD_ACTIONS = new Set([
  "activate_note_retake",
  "delete_note_retake",
  "generate_note_retake",
]);

const GROUP_LOCATOR_ACTIONS = new Set([
  "activate_note_retake",
  "add_notes",
  "add_pitch_controls",
  "apply_group_tuning",
  "apply_expression_preset",
  "clear_automation",
  "delete_group_reference",
  "delete_note_retake",
  "delete_notes",
  "delete_pitch_controls",
  "edit_notes",
  "edit_pitch_controls",
  "fit_lyrics",
  "generate_note_retake",
  "get_automation",
  "get_computed_group_data",
  "get_group_voice",
  "get_note_phoneme_data",
  "get_note_retakes",
  "get_phrase_context",
  "get_pitch_controls",
  "humanize_notes",
  "sample_automation",
  "set_automation_points",
  "set_group_voice",
  "set_note_phoneme_properties",
  "simplify_automation",
  "transform_notes",
  "update_group",
]);

const DIAGNOSTIC_FIELDS = new Set([
  "attributesPending",
  "computedPhonemesIncluded",
  "matchedNoteCount",
  "noteDefaultsOmitted",
  "phonemesPending",
  "rangeScannedNoteCount",
  "responseMode",
  "returnedNoteCount",
  "returnedNoteOffset",
  "scannedNoteCount",
  "secondsPrecision",
  "serializationScannedNoteCount",
]);

const DEFAULT_READ_FIELDS: Readonly<Record<string, readonly string[]>> = {
  get_group_voice: [
    "trackIndex",
    "groupIndex",
    "parameters",
    "vocalModes",
  ],
};

function defaultReadFields(action: string): readonly string[] | undefined {
  return DEFAULT_READ_FIELDS[action];
}

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function optionalRecord(value: unknown, path: string): JsonRecord | undefined {
  return value === undefined ? undefined : asRecord(value, path);
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isInteger(value) ? (value as number) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: toPublicError(error) }),
      },
    ],
  };
}

function readJsonResult(result: CallToolResult): unknown {
  const block = result.content.find(
    (value) => value.type === "text" && typeof value.text === "string",
  );
  if (block?.type !== "text") {
    throw new BridgeProtocolError("The internal tool did not return JSON text");
  }
  try {
    return JSON.parse(block.text) as unknown;
  } catch (error) {
    throw new BridgeProtocolError("The internal tool returned invalid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseToolInput(tool: RegisteredTool, args: JsonRecord): unknown {
  const schema = tool.inputSchema as
    | { parse?: (value: unknown) => unknown }
    | undefined;
  return typeof schema?.parse === "function" ? schema.parse(args) : args;
}

async function invokeTool(
  definitions: V2ToolDefinitions,
  action: string,
  args: JsonRecord,
): Promise<CallToolResult> {
  const tool = definitions.get(action);
  if (tool === undefined) {
    throw new BridgeProtocolError(`Unknown SynthV action: ${action}`);
  }
  if (typeof tool.handler !== "function") {
    throw new BridgeProtocolError(`SynthV action ${action} is not directly callable`);
  }
  const parsed = parseToolInput(tool, args);
  const handler = tool.handler as (
    input: unknown,
    extra?: unknown,
  ) => CallToolResult | Promise<CallToolResult>;
  return handler(parsed);
}

function isReadAction(tool: RegisteredTool): boolean {
  return tool.annotations?.readOnlyHint === true;
}

function assertActionCategory(
  definitions: V2ToolDefinitions,
  action: string,
  category: "read" | "edit" | "delete" | "ui" | "transaction",
): void {
  const tool = definitions.get(action);
  if (tool === undefined) {
    throw new BridgeProtocolError(`Unknown SynthV action: ${action}`);
  }
  const accepted =
    category === "read"
      ? isReadAction(tool) &&
        !UI_ACTIONS.has(action) &&
        !Object.values(STATUS_OPERATIONS).includes(
          action as (typeof STATUS_OPERATIONS)[keyof typeof STATUS_OPERATIONS],
        )
      : category === "delete"
        ? EXPLICIT_DELETE_ACTIONS.has(action)
        : category === "ui"
          ? UI_ACTIONS.has(action)
          : category === "transaction"
            ? TRANSACTION_ACTIONS.has(action)
            : !isReadAction(tool) &&
              !EXPLICIT_DELETE_ACTIONS.has(action) &&
              !UI_ACTIONS.has(action) &&
              !TRANSACTION_ACTIONS.has(action) &&
              !Object.values(SIDEBAR_OPERATIONS).includes(
                action as (typeof SIDEBAR_OPERATIONS)[keyof typeof SIDEBAR_OPERATIONS],
              ) &&
              action !== "reload_bridge";
  if (!accepted) {
    throw new BridgeProtocolError(
      `${action} is not available through sv_${category}`,
    );
  }
}

function contextEntry(
  root: JsonRecord,
  noteFingerprints: ReadonlyMap<number, string> = new Map(),
  pitchControlFingerprints: ReadonlyMap<number, string> = new Map(),
  automationFingerprints: ReadonlyMap<string, string> = new Map(),
): V2ContextEntry {
  const voice = optionalRecord(root.voice, "result.voice");
  const trackIndex = optionalInteger(root.trackIndex);
  const groupIndex = optionalInteger(root.groupIndex);
  const groupUuid = optionalString(root.groupUuid);
  const libraryIndex = optionalInteger(root.libraryIndex);
  const trackFingerprint = optionalString(
    root.trackFingerprint ??
      (root.mainGroupUuid === undefined ? undefined : root.fingerprint),
  );
  const referenceFingerprint = optionalString(
    root.referenceFingerprint ?? voice?.referenceFingerprint,
  );
  const expectedFingerprint = optionalString(
    root.expectedFingerprint ?? root.fingerprint,
  );
  return {
    ...(trackIndex === undefined ? {} : { trackIndex }),
    ...(groupIndex === undefined ? {} : { groupIndex }),
    ...(groupUuid === undefined ? {} : { groupUuid }),
    ...(libraryIndex === undefined ? {} : { libraryIndex }),
    ...(trackFingerprint === undefined ? {} : { trackFingerprint }),
    ...(referenceFingerprint === undefined ? {} : { referenceFingerprint }),
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    noteFingerprints,
    pitchControlFingerprints,
    automationFingerprints,
  };
}

function consumeNoteGuards(
  root: JsonRecord,
  notes: unknown,
  guardTokens: GuardTokenStore,
): Map<number, string> {
  const fingerprints = new Map<number, string>();
  if (!Array.isArray(notes)) {
    return fingerprints;
  }
  const trackIndex = optionalInteger(root.trackIndex);
  const groupUuid = optionalString(root.groupUuid);
  for (const value of notes) {
    const note = asRecord(value, "result.notes[]");
    const noteIndex = optionalInteger(note.noteIndex);
    if (noteIndex === undefined) {
      continue;
    }
    const fingerprint = optionalString(note.fingerprint);
    const guardToken = optionalString(note.guardToken);
    if (fingerprint !== undefined) {
      fingerprints.set(noteIndex, fingerprint);
      delete note.fingerprint;
    } else if (
      guardToken !== undefined &&
      trackIndex !== undefined &&
      groupUuid !== undefined
    ) {
      fingerprints.set(
        noteIndex,
        guardTokens.consume(guardToken, {
          kind: "note",
          trackIndex,
          groupUuid,
          noteIndex,
        }).fingerprint,
      );
      delete note.guardToken;
    }
  }
  return fingerprints;
}

function consumePitchGuards(
  controls: unknown,
): Map<number, string> {
  const fingerprints = new Map<number, string>();
  if (!Array.isArray(controls)) {
    return fingerprints;
  }
  for (const value of controls) {
    const control = asRecord(value, "result.pitchControls[]");
    const index = optionalInteger(control.pitchControlIndex);
    const fingerprint = optionalString(control.fingerprint);
    if (index !== undefined && fingerprint !== undefined) {
      fingerprints.set(index, fingerprint);
      delete control.fingerprint;
    }
  }
  return fingerprints;
}

function consumeAutomationGuards(
  root: JsonRecord,
  automation: unknown,
  guardTokens: GuardTokenStore,
): Map<string, string> {
  const fingerprints = new Map<string, string>();
  const values = Array.isArray(automation) ? automation : [automation];
  const trackIndex = optionalInteger(root.trackIndex);
  const groupUuid = optionalString(root.groupUuid);
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const curve = asRecord(value, "result.automation[]");
    const parameter = optionalString(curve.parameter);
    if (parameter === undefined) {
      continue;
    }
    const fingerprint = optionalString(curve.fingerprint);
    const guardToken = optionalString(curve.guardToken);
    if (fingerprint !== undefined) {
      fingerprints.set(parameter, fingerprint);
      delete curve.fingerprint;
    } else if (
      guardToken !== undefined &&
      trackIndex !== undefined &&
      groupUuid !== undefined
    ) {
      fingerprints.set(
        parameter,
        guardTokens.consume(guardToken, {
          kind: "automation",
          trackIndex,
          groupUuid,
          parameter,
        }).fingerprint,
      );
      delete curve.guardToken;
    }
  }
  return fingerprints;
}

function hasContextGuards(entry: V2ContextEntry): boolean {
  return (
    entry.trackIndex !== undefined ||
    entry.groupUuid !== undefined ||
    entry.trackFingerprint !== undefined ||
    entry.referenceFingerprint !== undefined ||
    entry.expectedFingerprint !== undefined ||
    entry.noteFingerprints.size > 0 ||
    entry.pitchControlFingerprints.size > 0 ||
    entry.automationFingerprints.size > 0
  );
}

function addRootContext(
  root: JsonRecord,
  contexts: V2ContextStore,
  guardTokens: GuardTokenStore,
): string | undefined {
  const noteFingerprints = consumeNoteGuards(root, root.notes, guardTokens);
  const pitchFingerprints = consumePitchGuards(root.pitchControls);
  const automationFingerprints = consumeAutomationGuards(
    root,
    root.automation ?? (root.parameter === undefined ? undefined : root),
    guardTokens,
  );
  const entry = contextEntry(
    root,
    noteFingerprints,
    pitchFingerprints,
    automationFingerprints,
  );
  if (!hasContextGuards(entry)) {
    return undefined;
  }
  const contextId = contexts.issue(entry);
  root.contextId = contextId;
  delete root.fingerprint;
  delete root.trackFingerprint;
  delete root.referenceFingerprint;
  delete root.groupUuid;
  const voice = optionalRecord(root.voice, "result.voice");
  if (voice !== undefined) {
    delete voice.referenceFingerprint;
  }
  return contextId;
}

function addNestedContexts(
  action: string,
  root: JsonRecord,
  contexts: V2ContextStore,
  guardTokens: GuardTokenStore,
): void {
  if (action === "list_tracks" && Array.isArray(root.tracks)) {
    for (const value of root.tracks) {
      addRootContext(asRecord(value, "result.tracks[]"), contexts, guardTokens);
    }
    return;
  }
  if (action === "list_note_groups" && Array.isArray(root.groups)) {
    for (const value of root.groups) {
      addRootContext(asRecord(value, "result.groups[]"), contexts, guardTokens);
    }
    return;
  }
  if (action === "get_track_notes" && Array.isArray(root.groups)) {
    const trackIndex = optionalInteger(root.trackIndex);
    for (const value of root.groups) {
      const group = asRecord(value, "result.groups[]");
      if (trackIndex !== undefined) {
        group.trackIndex = trackIndex;
      }
      addRootContext(group, contexts, guardTokens);
    }
    delete root.trackFingerprint;
    return;
  }
  if (action === "get_selection") {
    const current = optionalRecord(root.current, "result.current");
    if (current !== undefined) {
      const selectedNotes = root.selectedNotes;
      const selectedPitchControls = root.selectedPitchControls;
      current.notes = selectedNotes;
      current.pitchControls = selectedPitchControls;
      const contextId = addRootContext(current, contexts, guardTokens);
      if (contextId !== undefined) {
        root.contextId = contextId;
      }
      delete current.notes;
      delete current.pitchControls;
      root.selectedNotes = selectedNotes;
      root.selectedPitchControls = selectedPitchControls;
    }
    return;
  }
  addRootContext(root, contexts, guardTokens);
}

function stripDiagnostics(root: JsonRecord): void {
  for (const field of DIAGNOSTIC_FIELDS) {
    delete root[field];
  }
}

function projectIncludes(
  root: JsonRecord,
  include: readonly (typeof V2_INCLUDE_VALUES)[number][] | undefined,
): void {
  if (include === undefined) {
    return;
  }
  const selected = new Set(include);
  const fields: ReadonlyArray<
    readonly [(typeof V2_INCLUDE_VALUES)[number], string]
  > = [
    ["notes", "notes"],
    ["voice", "voice"],
    ["automation", "automation"],
    ["analysis", "analysis"],
    ["recommendations", "recommendations"],
    ["pitchAnalysis", "pitchAnalysis"],
    ["selection", "selectionContext"],
  ];
  for (const [option, field] of fields) {
    if (!selected.has(option)) {
      delete root[field];
    }
  }
}

function compactPhraseNotes(root: JsonRecord): void {
  if (!Array.isArray(root.notes)) {
    return;
  }
  let absolutePitchDefaultsToPitch = false;
  for (const value of root.notes) {
    const note = asRecord(value, "result.notes[]");
    delete note.absoluteEnd;
    delete note.absoluteEndSeconds;
    delete note.absoluteOnset;
    delete note.durationQuarters;
    delete note.endPosition;
    delete note.onsetQuarters;
    if (
      typeof note.absolutePitch === "number" &&
      note.absolutePitch === note.pitch
    ) {
      delete note.absolutePitch;
      absolutePitchDefaultsToPitch = true;
    }
  }
  if (absolutePitchDefaultsToPitch) {
    root.noteDefaults = {
      ...optionalRecord(root.noteDefaults, "result.noteDefaults"),
      absolutePitch: "pitch",
    };
  }
}

function projectFields(root: JsonRecord, fields: readonly string[]): JsonRecord {
  const projected: JsonRecord = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(root, field)) {
      projected[field] = root[field];
    }
  }
  if (root.contextId !== undefined) {
    projected.contextId = root.contextId;
  }
  if (root.page !== undefined) {
    projected.page = root.page;
  }
  if (root.hasMore !== undefined) {
    projected.hasMore = root.hasMore;
  }
  if (root.sessionReset !== undefined) {
    projected.sessionReset = root.sessionReset;
  }
  return projected;
}

function denseNotes(root: JsonRecord, mode: "auto" | "never" | "always"): void {
  if (!Array.isArray(root.notes)) {
    return;
  }
  if (
    mode === "never" ||
    (mode === "auto" && root.notes.length < 24)
  ) {
    return;
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const value of root.notes) {
    const note = asRecord(value, "result.notes[]");
    for (const key of Object.keys(note)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  root.notes = {
    columns,
    rows: root.notes.map((value) => {
      const note = asRecord(value, "result.notes[]");
      return columns.map((column) => note[column] ?? null);
    }),
  };
  root.noteFormat = "rows";
}

function normalizeItemIndex(
  item: JsonRecord,
  canonical: "noteIndex" | "pitchControlIndex",
): number {
  const value = item[canonical] ?? item.index;
  if (!Number.isInteger(value)) {
    throw new BridgeProtocolError(
      `${canonical} or index must be a 1-based integer`,
    );
  }
  item[canonical] = value;
  delete item.index;
  return value as number;
}

function expandGuardedArray(
  args: JsonRecord,
  field: string,
  canonical: "noteIndex" | "pitchControlIndex",
  fingerprints: ReadonlyMap<number, string>,
): void {
  if (!Array.isArray(args[field])) {
    return;
  }
  for (const value of args[field]) {
    const item = asRecord(value, `${field}[]`);
    const index = normalizeItemIndex(item, canonical);
    if (item.fingerprint === undefined) {
      const fingerprint = fingerprints.get(index);
      if (fingerprint === undefined) {
        throw new BridgeProtocolError(
          `contextId does not contain a guard for ${canonical} ${index}`,
        );
      }
      item.fingerprint = fingerprint;
    }
  }
}

function expandContext(
  action: string,
  args: JsonRecord,
  contextId: string | undefined,
  contexts: V2ContextStore,
): JsonRecord {
  const result = { ...args };
  if (action === "add_notes") {
    result.grouping ??= "ensureNonMain";
  }
  if (
    action === "transform_notes" &&
    result.target !== undefined &&
    result.target !== "contextNotes"
  ) {
    throw new BridgeProtocolError(
      "transform_notes args.target must be contextNotes",
    );
  }
  if (
    action === "transform_notes" &&
    result.target === "contextNotes" &&
    contextId === undefined
  ) {
    throw new BridgeProtocolError(
      "transform_notes args.target=contextNotes requires a fresh contextId",
    );
  }
  if (contextId === undefined) {
    return result;
  }
  const context = contexts.resolve(contextId);

  if (action === "transform_notes" && result.target === "contextNotes") {
    if (result.notes !== undefined) {
      throw new BridgeProtocolError(
        "transform_notes args.target=contextNotes cannot be combined with args.notes",
      );
    }
    const notes = [...context.noteFingerprints.entries()]
      .sort(([left], [right]) => left - right)
      .map(([noteIndex, fingerprint]) => ({ noteIndex, fingerprint }));
    if (notes.length === 0) {
      throw new BridgeProtocolError(
        "contextId does not contain any note guards for transform_notes",
      );
    }
    if (notes.length > 512) {
      throw new BridgeProtocolError(
        "transform_notes accepts at most 512 context notes",
      );
    }
    result.notes = notes;
    delete result.target;
  }

  if (GROUP_LOCATOR_ACTIONS.has(action)) {
    result.trackIndex ??= context.trackIndex;
    result.groupIndex ??= context.groupIndex;
    result.groupUuid ??= context.groupUuid;
  }
  if (TRACK_GUARD_ACTIONS.has(action)) {
    result.trackIndex ??= context.trackIndex;
    result.trackFingerprint ??= context.trackFingerprint;
  }
  if (REFERENCE_GUARD_ACTIONS.has(action)) {
    result.referenceFingerprint ??= context.referenceFingerprint;
  }
  if (action === "set_time_axis") {
    result.expectedFingerprint ??= context.expectedFingerprint;
  }
  if (action === "delete_note_group") {
    result.libraryIndex ??= context.libraryIndex;
    result.groupUuid ??= context.groupUuid;
    result.expectedFingerprint ??= context.expectedFingerprint;
  }
  if (action === "clone_note_group") {
    result.libraryIndex ??= context.libraryIndex;
    result.groupUuid ??= context.groupUuid;
    result.expectedFingerprint ??= context.expectedFingerprint;
    result.trackIndex ??= context.trackIndex;
    result.groupIndex ??= context.groupIndex;
  }
  if (action === "add_group_reference") {
    result.trackIndex ??= context.trackIndex;
    result.trackFingerprint ??= context.trackFingerprint;
    if (context.libraryIndex !== undefined) {
      result.targetLibraryIndex ??= context.libraryIndex;
      result.targetGroupUuid ??= context.groupUuid;
      result.targetFingerprint ??= context.expectedFingerprint;
    }
  }
  if (action === "clone_group_reference") {
    if (context.referenceFingerprint !== undefined) {
      result.sourceTrackIndex ??= context.trackIndex;
      result.sourceGroupIndex ??= context.groupIndex;
      result.sourceGroupUuid ??= context.groupUuid;
      result.sourceReferenceFingerprint ??= context.referenceFingerprint;
    } else {
      result.targetTrackIndex ??= context.trackIndex;
      result.targetTrackFingerprint ??= context.trackFingerprint;
    }
  }
  if (action === "create_harmony_track") {
    result.sourceTrackIndex ??= context.trackIndex;
    result.sourceTrackFingerprint ??= context.trackFingerprint;
  }
  if (action === "script_data") {
    result.trackIndex ??= context.trackIndex;
    result.groupIndex ??= context.groupIndex;
    result.groupUuid ??= context.groupUuid;
    const objectType = optionalString(result.objectType);
    if (objectType === "track" || objectType === "mixer") {
      result.trackFingerprint ??= context.trackFingerprint;
    } else if (objectType === "reference") {
      result.referenceFingerprint ??= context.referenceFingerprint;
    } else if (objectType === "timeAxis" || objectType === "automation") {
      result.expectedFingerprint ??= context.expectedFingerprint;
    }
  }

  const noteField = NOTE_ARRAY_FIELDS[action];
  if (noteField !== undefined) {
    expandGuardedArray(
      result,
      noteField,
      "noteIndex",
      context.noteFingerprints,
    );
  }
  if (RETAKE_GUARD_ACTIONS.has(action)) {
    const noteIndex = normalizeItemIndex(result, "noteIndex");
    result.fingerprint ??= context.noteFingerprints.get(noteIndex);
  }
  const pitchField = PITCH_ARRAY_FIELDS[action];
  if (pitchField !== undefined) {
    expandGuardedArray(
      result,
      pitchField,
      "pitchControlIndex",
      context.pitchControlFingerprints,
    );
  }
  if (AUTOMATION_GUARD_ACTIONS.has(action)) {
    const parameter = optionalString(result.parameter);
    if (parameter !== undefined) {
      result.expectedFingerprint ??=
        context.automationFingerprints.get(parameter);
    }
  }
  if (action === "apply_expression_preset") {
    const parameter =
      result.preset === "breathiness" ? "breathiness" : "loudness";
    result.expectedAutomationFingerprint ??=
      context.automationFingerprints.get(parameter);
  }
  if (action === "apply_group_tuning" && Array.isArray(result.automations)) {
    for (const value of result.automations) {
      const update = asRecord(value, "automations[]");
      const parameter = optionalString(update.parameter);
      if (
        parameter !== undefined &&
        update.expectedFingerprint === undefined
      ) {
        update.expectedFingerprint =
          context.automationFingerprints.get(parameter);
      }
    }
  }
  return result;
}

export const v2Testing = {
  compactPhraseNotes,
  defaultReadFields,
  denseNotes,
  expandContext,
  projectFields,
  projectIncludes,
  stripDiagnostics,
};

function expandTransactionContexts(
  args: JsonRecord,
  contexts: V2ContextStore,
): JsonRecord {
  if (!Array.isArray(args.steps)) {
    return args;
  }
  const expandSteps = (value: unknown, path: string): unknown => {
    if (!Array.isArray(value)) {
      return value;
    }
    return value.map((stepValue) => {
      const step = asRecord(stepValue, `${path}[]`);
      const action = optionalString(step.action);
      if (action === undefined) {
        return step;
      }
      const payload = asRecord(step.payload, `${path}[].payload`);
      const contextId = optionalString(step.contextId ?? payload.contextId);
      const cleanPayload = { ...payload };
      delete cleanPayload.contextId;
      return {
        ...step,
        payload: expandContext(action, cleanPayload, contextId, contexts),
        contextId: undefined,
      };
    });
  };
  return {
    ...args,
    steps: expandSteps(args.steps, "steps"),
    ...(args.rollbackSteps === undefined
      ? {}
      : { rollbackSteps: expandSteps(args.rollbackSteps, "rollbackSteps") }),
  };
}

function minimalWriteResult(
  action: string,
  value: unknown,
  contexts: V2ContextStore,
  guardTokens: GuardTokenStore,
): JsonRecord {
  const root = asRecord(value, "result");
  addNestedContexts(action, root, contexts, guardTokens);
  const result: JsonRecord = { action };
  let changed: number | undefined;
  for (const [key, child] of Object.entries(root)) {
    if (
      changed === undefined &&
      typeof child === "number" &&
      /(?:added|changed|cleared|created|deleted|edited|removed|updated)Count$/u.test(
        key,
      )
    ) {
      changed = child;
    }
    if (
      typeof child === "string" &&
      /(?:Id|Uuid)$/u.test(key) &&
      !/fingerprint/iu.test(key)
    ) {
      result[key] = child;
    } else if (
      typeof child === "number" &&
      /(?:Index|TakeId)$/u.test(key)
    ) {
      result[key] = child;
    } else if (key === "verified" && typeof child === "boolean") {
      result.verified = child;
    }
  }
  result.changed = changed ?? 1;
  if (root.contextId !== undefined) {
    result.contextId = root.contextId;
  }
  return result;
}

function describeTool(name: string, tool: RegisteredTool): JsonRecord {
  const schema = tool.inputSchema;
  let inputSchema: unknown = {};
  if (schema !== undefined) {
    try {
      const converted = z.toJSONSchema(schema as z.ZodType);
      delete (converted as JsonRecord).$schema;
      inputSchema = converted;
    } catch {
      inputSchema = { type: "object" };
    }
  }
  const contextHint =
    name === "transform_notes"
      ? "With a fresh phrase/note contextId, set args.target to contextNotes and omit notes and the Group locator; every guarded note in that exact read scope becomes a target. Alternatively supply note indices and omit fingerprints."
      : NOTE_ARRAY_FIELDS[name] !== undefined
      ? "With sv_edit/sv_delete contextId, use item index or noteIndex and omit item fingerprints and the Group locator."
      : PITCH_ARRAY_FIELDS[name] !== undefined
        ? "With contextId from get_pitch_controls, use item index or pitchControlIndex and omit item fingerprints and the Group locator."
        : AUTOMATION_GUARD_ACTIONS.has(name)
          ? "With contextId from an automation read, omit expectedFingerprint and the Group locator."
          : TRACK_GUARD_ACTIONS.has(name)
            ? "With contextId from list_tracks, omit trackIndex and trackFingerprint."
            : REFERENCE_GUARD_ACTIONS.has(name)
              ? "With contextId from a Group/voice read, omit the Group locator and referenceFingerprint."
              : GROUP_LOCATOR_ACTIONS.has(name)
                ? "A compatible contextId may supply trackIndex, groupIndex, and groupUuid."
                : undefined;
  return {
    action: name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema,
    ...(contextHint === undefined ? {} : { v2Context: contextHint }),
    category: EXPLICIT_DELETE_ACTIONS.has(name)
      ? "delete"
      : TRANSACTION_ACTIONS.has(name)
        ? "transaction"
        : UI_ACTIONS.has(name)
          ? "ui"
          : isReadAction(tool)
            ? "read"
            : "edit",
  };
}

function catalog(definitions: V2ToolDefinitions): JsonRecord {
  const categories: Record<string, string[]> = {
    read: [],
    edit: [],
    delete: [],
    ui: [],
    transaction: [],
  };
  for (const [name, tool] of definitions) {
    if (
      name.startsWith("sidebar_") ||
      name === "bridge_status" ||
      name === "reload_bridge" ||
      name === "ping" ||
      name === "get_host_info"
    ) {
      continue;
    }
    const category = EXPLICIT_DELETE_ACTIONS.has(name)
      ? "delete"
      : TRANSACTION_ACTIONS.has(name)
        ? "transaction"
        : UI_ACTIONS.has(name)
          ? "ui"
          : isReadAction(tool)
            ? "read"
            : "edit";
    categories[category]?.push(name);
  }
  return {
    protocol: "mcp-v2",
    indices: "1-based",
    categories,
    workflow:
      "Describe unfamiliar actions, read fresh state, then edit with the returned contextId.",
  };
}

async function invokeV2(
  definitions: V2ToolDefinitions,
  action: string,
  args: JsonRecord,
): Promise<CallToolResult> {
  try {
    return await invokeTool(definitions, action, args);
  } catch (error) {
    return errorResult(error);
  }
}

export interface V2SessionChange {
  readonly previousSessionToken: string;
  readonly currentSessionToken: string;
}

export class V2SessionTracker {
  private sessionToken: string | undefined;

  public observe(sessionToken: string | undefined): V2SessionChange | undefined {
    if (sessionToken === undefined || sessionToken.length === 0) {
      return undefined;
    }
    if (this.sessionToken === undefined) {
      this.sessionToken = sessionToken;
      return undefined;
    }
    if (this.sessionToken === sessionToken) {
      return undefined;
    }
    const change = {
      previousSessionToken: this.sessionToken,
      currentSessionToken: sessionToken,
    };
    this.sessionToken = sessionToken;
    return change;
  }
}

export function registerV2Surface(
  registerTool: RegisterTool,
  definitions: V2ToolDefinitions,
  guardTokens: GuardTokenStore,
  getSessionToken?: () => Promise<string | undefined>,
): void {
  const contexts = new V2ContextStore();
  const sessionTracker = new V2SessionTracker();
  const observeSession = async (): Promise<V2SessionChange | undefined> => {
    const change = sessionTracker.observe(await getSessionToken?.());
    if (change !== undefined) {
      contexts.clear();
      guardTokens.clear();
    }
    return change;
  };
  const sessionChangedError = (change: V2SessionChange): BridgeError =>
    new BridgeError(
      "SynthV was restarted or the Bridge was reloaded. Cached contexts and Guard Tokens were cleared; read the target again before writing.",
      "SYNTHV_SESSION_CHANGED",
      {
        ...change,
        cachesCleared: true,
        requiredAction: "read_target_again",
      },
    );
  const sessionResetResult = (change: V2SessionChange): JsonRecord => ({
    code: "SYNTHV_SESSION_CHANGED",
    message:
      "SynthV restart or Bridge reload detected. Cached contexts and Guard Tokens were cleared; this read is fresh.",
    ...change,
    cachesCleared: true,
  });
  const argsSchema = z.record(z.string(), z.unknown()).default({});
  const actionSchema = z
    .string()
    .min(1)
    .max(100)
    .describe("Action name returned by sv_describe.");
  const contextIdSchema = z
    .string()
    .min(20)
    .max(128)
    .optional()
    .describe("Fresh contextId returned by a v2 read.");

  registerTool(
    "sv_status",
    {
      title: "SynthV Status",
      description: "Read Bridge/host status, ping, or hot-reload the Bridge.",
      inputSchema: {
        operation: z.enum(["bridge", "host", "ping", "reload"]).default("bridge"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      invokeV2(definitions, STATUS_OPERATIONS[input.operation], {}),
  );

  registerTool(
    "sv_describe",
    {
      title: "Describe SynthV Actions",
      description:
        "List available actions or return just-in-time schemas for up to 16 actions.",
      inputSchema: {
        actions: z.array(z.string().min(1).max(100)).max(16).default([]),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        if (input.actions.length === 0) {
          return jsonResult(catalog(definitions));
        }
        return jsonResult({
          actions: input.actions.map((action) => {
            const tool = definitions.get(action);
            if (tool === undefined) {
              throw new BridgeProtocolError(`Unknown SynthV action: ${action}`);
            }
            return describeTool(action, tool);
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "sv_read",
    {
      title: "Read SynthV",
      description:
        "Run one read action. Reuse contextId for scoped reads/writes; phrase and Group Voice reads default to compact projected data.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
        include: z.array(z.enum(V2_INCLUDE_VALUES)).max(8).optional(),
        fields: z.array(z.string().min(1).max(100)).max(64).optional(),
        dense: z.enum(["auto", "never", "always"]).default("auto"),
        debug: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertActionCategory(definitions, input.action, "read");
        const sessionChange = await observeSession();
        if (sessionChange !== undefined && input.contextId !== undefined) {
          throw sessionChangedError(sessionChange);
        }
        const include =
          input.include ??
          (input.action === "get_phrase_context"
            ? ["notes", "voice", "analysis"]
            : undefined);
        let args = expandContext(
          input.action,
          { ...input.args },
          input.contextId,
          contexts,
        );
        if (input.action === "get_phrase_context") {
          args = {
            ...args,
            include,
            automationParameters: include?.includes("automation")
              ? args.automationParameters
              : [],
            recommendationLimit: include?.includes("recommendations")
              ? args.recommendationLimit
              : 0,
            pitchAnalysisFrames: include?.includes("pitchAnalysis")
              ? args.pitchAnalysisFrames
              : 0,
          };
        } else if (
          input.action === "get_note_phoneme_data" ||
          input.action === "get_automation" ||
          input.action === "sample_automation"
        ) {
          args.responseMode = "compact";
        }
        const result = await invokeTool(definitions, input.action, args);
        if (result.isError) {
          return result;
        }
        const root = asRecord(readJsonResult(result), "result");
        if (sessionChange !== undefined) {
          root.sessionReset = sessionResetResult(sessionChange);
        }
        addNestedContexts(input.action, root, contexts, guardTokens);
        if (input.action === "get_phrase_context") {
          projectIncludes(root, include);
          compactPhraseNotes(root);
        }
        if (!input.debug) {
          stripDiagnostics(root);
        }
        denseNotes(root, input.dense);
        const fields =
          input.fields ?? defaultReadFields(input.action);
        return jsonResult(
          fields === undefined ? root : projectFields(root, fields),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const registerWrite = (
    name: "sv_edit" | "sv_delete",
    category: "edit" | "delete",
  ): void => {
    registerTool(
      name,
      {
        title: category === "edit" ? "Edit SynthV" : "Delete SynthV Data",
        description:
          category === "edit"
            ? "Run one validated project-write action. Prefer a fresh contextId; minimal acknowledgements are the default."
            : "Run one validated delete/clear action with fresh guards. Minimal acknowledgements are the default.",
        inputSchema: {
          action: actionSchema,
          args: argsSchema,
          contextId: contextIdSchema,
          response: z.enum(["minimal", "full"]).default("minimal"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: category === "delete",
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (input) => {
        try {
          assertActionCategory(definitions, input.action, category);
          const sessionChange = await observeSession();
          if (sessionChange !== undefined) {
            throw sessionChangedError(sessionChange);
          }
          const args = expandContext(
            input.action,
            { ...input.args },
            input.contextId,
            contexts,
          );
          if (
            input.action === "set_note_phoneme_properties" ||
            input.action === "set_automation_points"
          ) {
            args.responseMode = "compact";
          }
          const result = await invokeTool(definitions, input.action, args);
          if (result.isError || input.response === "full") {
            return result;
          }
          return jsonResult(
            minimalWriteResult(
              input.action,
              readJsonResult(result),
              contexts,
              guardTokens,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  };
  registerWrite("sv_edit", "edit");
  registerWrite("sv_delete", "delete");

  registerTool(
    "sv_transaction",
    {
      title: "Run SynthV Transaction",
      description:
        "Apply or roll back a validated transaction. Step payloads may carry contextId.",
      inputSchema: {
        action: z.enum(["apply_transaction", "rollback_transaction"]),
        args: argsSchema,
        response: z.enum(["minimal", "full"]).default("minimal"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertActionCategory(definitions, input.action, "transaction");
        const sessionChange = await observeSession();
        if (sessionChange !== undefined) {
          throw sessionChangedError(sessionChange);
        }
        const args =
          input.action === "apply_transaction"
            ? expandTransactionContexts({ ...input.args }, contexts)
            : input.args;
        const result = await invokeTool(definitions, input.action, args);
        if (result.isError || input.response === "full") {
          return result;
        }
        return jsonResult(
          minimalWriteResult(
            input.action,
            readJsonResult(result),
            contexts,
            guardTokens,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "sv_ui",
    {
      title: "Control SynthV UI",
      description:
        "Run a selection, viewport, clipboard, dialog, snapping, coordinate, or playback action.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        assertActionCategory(definitions, input.action, "ui");
        const sessionChange = await observeSession();
        if (sessionChange !== undefined && input.contextId !== undefined) {
          throw sessionChangedError(sessionChange);
        }
        const result = await invokeTool(
          definitions,
          input.action,
          expandContext(
            input.action,
            { ...input.args },
            input.contextId,
            contexts,
          ),
        );
        if (result.isError || input.action !== "get_selection") {
          return result;
        }
        const root = asRecord(readJsonResult(result), "result");
        if (sessionChange !== undefined) {
          root.sessionReset = sessionResetResult(sessionChange);
        }
        addNestedContexts(input.action, root, contexts, guardTokens);
        stripDiagnostics(root);
        return jsonResult(root);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTool(
    "sv_sidebar",
    {
      title: "Use SynthV Sidebar",
      description:
        "Read sidebar requests/status or publish one guarded preview for confirmation.",
      inputSchema: {
        operation: z.enum(["get", "status", "publish"]),
        args: argsSchema,
        contextId: contextIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const action = SIDEBAR_OPERATIONS[input.operation];
        let args = { ...input.args };
        if (input.operation === "publish") {
          const sessionChange = await observeSession();
          if (sessionChange !== undefined) {
            throw sessionChangedError(sessionChange);
          }
          const previewAction = optionalString(args.action);
          const payload = optionalRecord(args.payload, "args.payload");
          if (previewAction !== undefined && payload !== undefined) {
            const expandedPayload =
              previewAction === "apply_transaction"
                ? expandTransactionContexts({ ...payload }, contexts)
                : expandContext(
                    previewAction,
                    { ...payload },
                    input.contextId,
                    contexts,
                  );
            args = {
              ...args,
              payload: expandedPayload,
            };
          }
        }
        return await invokeTool(definitions, action, args);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
