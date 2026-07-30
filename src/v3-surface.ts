import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BridgeError, BridgeProtocolError, toPublicError } from "./errors.js";
import type { GuardTokenStore } from "./guard-token-store.js";
import {
  V3ContextStore,
  type V3ContextEntry,
  type V3ContextMode,
  type V3ContextTargetKind,
} from "./v3-context-store.js";
import { V3SnapshotCache } from "./v3-snapshot-cache.js";
import {
  contextExpansionForAction,
  contextKindsForAction,
  isV3InfrastructureAction,
  optionalCommandPolicy,
} from "./v3-command-policy.js";
import {
  commandOutcome,
  traceStage,
} from "./v3-command-kernel.js";
import {
  enforceQueryResponseBudget,
  prepareQueryArguments,
  projectQueryResult,
  queryProjectorTesting,
  snapshotQueryProjectionSource,
} from "./v3-query-projector.js";

type JsonRecord = Record<string, unknown>;
type RegisterTool = McpServer["registerTool"];

export type ActionToolDefinitions = ReadonlyMap<string, RegisteredTool>;

const V3_INCLUDE_VALUES = [
  "notes",
  "voice",
  "automation",
  "analysis",
  "recommendations",
  "pitchAnalysis",
  "selection",
  "diagnostics",
] as const;

type V3IncludeValue = (typeof V3_INCLUDE_VALUES)[number];

const DEFAULT_PHRASE_INCLUDE: readonly V3IncludeValue[] = [
  "notes",
  "voice",
  "analysis",
];

const V3_INCLUDE_VALUE_SET = new Set<string>(V3_INCLUDE_VALUES);

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

function parseActionInput(
  tool: RegisteredTool,
  action: string,
  args: JsonRecord,
): unknown {
  const schema = tool.inputSchema as
    | {
        parse?: (value: unknown) => unknown;
        safeParse?: (value: unknown) =>
          | { readonly success: true; readonly data: unknown }
          | {
              readonly success: false;
              readonly error: {
                readonly issues: readonly {
                  readonly code: string;
                  readonly path: readonly PropertyKey[];
                  readonly message: string;
                }[];
              };
            };
      }
    | undefined;
  let parsed: unknown = args;
  if (typeof schema?.safeParse === "function") {
    const validation = schema.safeParse(args);
    if (!validation.success) {
      throw new BridgeError(
        `Invalid arguments for ${action}`,
        "INVALID_ARGUMENT",
        {
          action,
          issues: validation.error.issues.map(({ code, path, message }) => ({
            code,
            path,
            message,
          })),
        },
      );
    }
    parsed = validation.data;
  } else if (typeof schema?.parse === "function") {
    parsed = schema.parse(args);
  }
  if (contextExpansionForAction(action)?.sharedGroupContent !== true) {
    return parsed;
  }
  const result = asRecord(parsed, `${action} args`);
  const policy = args.sharedGroupPolicy;
  if (
    policy !== undefined &&
    policy !== "reject" &&
    policy !== "allowAllReferences"
  ) {
    throw new BridgeProtocolError(
      "sharedGroupPolicy must be reject or allowAllReferences",
    );
  }
  const expectedReferenceCount = args.expectedReferenceCount;
  if (
    expectedReferenceCount !== undefined &&
    (!Number.isInteger(expectedReferenceCount) ||
      (expectedReferenceCount as number) < 1)
  ) {
    throw new BridgeProtocolError(
      "expectedReferenceCount must be a positive integer",
    );
  }
  if (policy !== undefined) {
    result.sharedGroupPolicy = policy;
  }
  if (expectedReferenceCount !== undefined) {
    result.expectedReferenceCount = expectedReferenceCount;
  }
  return result;
}

async function invokeActionTool(
  definitions: ActionToolDefinitions,
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
  const parsed = parseActionInput(tool, action, args);
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
  definitions: ActionToolDefinitions,
  action: string,
  category: "read" | "edit" | "delete" | "ui" | "transaction",
): void {
  const tool = definitions.get(action);
  if (tool === undefined) {
    throw new BridgeProtocolError(`Unknown SynthV action: ${action}`);
  }
  const policy = optionalCommandPolicy(action);
  const accepted =
    category === "read"
      ? policy === undefined && isReadAction(tool) && !isV3InfrastructureAction(action)
      : policy?.category === category;
  if (!accepted) {
    throw new BridgeProtocolError(
      `${action} is not available through sv_${category}`,
    );
  }
}

function contextEntry(
  sourceAction: string,
  root: JsonRecord,
  mode: V3ContextMode,
  sessionToken: string | undefined,
  noteFingerprints: ReadonlyMap<number, string> = new Map(),
  pitchControlFingerprints: ReadonlyMap<number, string> = new Map(),
  automationFingerprints: ReadonlyMap<string, string> = new Map(),
): V3ContextEntry {
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
  const targetKind: V3ContextTargetKind =
    sourceAction === "get_time_axis" || sourceAction === "set_time_axis"
      ? "timeAxis"
      : sourceAction === "list_note_groups" ||
          libraryIndex !== undefined
        ? "libraryGroup"
        : automationFingerprints.size > 0 ||
            sourceAction === "get_automation" ||
            sourceAction === "sample_automation"
          ? "automation"
          : groupUuid !== undefined
            ? "group"
            : trackFingerprint !== undefined
              ? "track"
              : "unknown";
  return {
    mode,
    ...(sessionToken === undefined ? {} : { sessionToken }),
    sourceAction,
    targetKind,
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

function hasContextGuards(entry: V3ContextEntry): boolean {
  return (
    entry.trackFingerprint !== undefined ||
    entry.referenceFingerprint !== undefined ||
    entry.expectedFingerprint !== undefined ||
    entry.noteFingerprints.size > 0 ||
    entry.pitchControlFingerprints.size > 0 ||
    entry.automationFingerprints.size > 0
  );
}

function addRootContext(
  sourceAction: string,
  root: JsonRecord,
  contexts: V3ContextStore,
  guardTokens: GuardTokenStore,
  mode: V3ContextMode,
  sessionToken: string | undefined,
): string | undefined {
  const noteFingerprints = consumeNoteGuards(root, root.notes, guardTokens);
  const singleNoteIndex = optionalInteger(root.noteIndex);
  const singleNoteFingerprint = optionalString(root.noteFingerprint);
  if (singleNoteIndex !== undefined && singleNoteFingerprint !== undefined) {
    noteFingerprints.set(singleNoteIndex, singleNoteFingerprint);
    delete root.noteFingerprint;
  }
  const pitchFingerprints = consumePitchGuards(root.pitchControls);
  const automationFingerprints = consumeAutomationGuards(
    root,
    root.automation ?? (root.parameter === undefined ? undefined : root),
    guardTokens,
  );
  const entry = contextEntry(
    sourceAction,
    root,
    mode,
    sessionToken,
    noteFingerprints,
    pitchFingerprints,
    automationFingerprints,
  );
  const contextId = hasContextGuards(entry) ? contexts.issue(entry) : undefined;
  if (contextId !== undefined) {
    root.contextId = contextId;
  }
  delete root.fingerprint;
  delete root.trackFingerprint;
  delete root.referenceFingerprint;
  delete root.groupUuid;
  delete root.mainGroupUuid;
  const voice = optionalRecord(root.voice, "result.voice");
  if (voice !== undefined) {
    delete voice.referenceFingerprint;
  }
  return contextId;
}

function addNestedContexts(
  action: string,
  root: JsonRecord,
  contexts: V3ContextStore,
  guardTokens: GuardTokenStore,
  mode: V3ContextMode = "writeIntent",
  sessionToken?: string,
): void {
  if (action === "list_tracks" && Array.isArray(root.tracks)) {
    for (const value of root.tracks) {
      addRootContext(
        action,
        asRecord(value, "result.tracks[]"),
        contexts,
        guardTokens,
        mode,
        sessionToken,
      );
    }
    return;
  }
  if (action === "list_note_groups" && Array.isArray(root.groups)) {
    for (const value of root.groups) {
      addRootContext(
        action,
        asRecord(value, "result.groups[]"),
        contexts,
        guardTokens,
        mode,
        sessionToken,
      );
    }
    return;
  }
  if (action === "get_track_notes" && Array.isArray(root.groups)) {
    const track = optionalRecord(root.track, "result.track");
    const trackIndex = optionalInteger(root.trackIndex ?? track?.trackIndex);
    for (const value of root.groups) {
      const group = asRecord(value, "result.groups[]");
      if (trackIndex !== undefined) {
        group.trackIndex = trackIndex;
      }
      addRootContext(
        action,
        group,
        contexts,
        guardTokens,
        mode,
        sessionToken,
      );
    }
    if (track !== undefined) {
      delete track.fingerprint;
      delete track.trackFingerprint;
      delete track.referenceFingerprint;
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
      const contextId = addRootContext(
        action,
        current,
        contexts,
        guardTokens,
        mode,
        sessionToken,
      );
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
  addRootContext(
    action,
    root,
    contexts,
    guardTokens,
    mode,
    sessionToken,
  );
}

function sameIncludeSelection(
  left: readonly V3IncludeValue[],
  right: readonly V3IncludeValue[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function normalizePhraseReadInclude(
  topLevelInclude: readonly V3IncludeValue[] | undefined,
  args: JsonRecord,
): readonly V3IncludeValue[] {
  const nestedValue = args.include;
  if (nestedValue === undefined) {
    return topLevelInclude ?? DEFAULT_PHRASE_INCLUDE;
  }
  if (!Array.isArray(nestedValue) || nestedValue.length > 8) {
    throw new BridgeProtocolError(
      "get_phrase_context args.include must be an array of at most 8 projection names; prefer the top-level sv_query.include field",
    );
  }
  const nestedInclude = nestedValue.map((value, index) => {
    if (typeof value !== "string" || !V3_INCLUDE_VALUE_SET.has(value)) {
      throw new BridgeProtocolError(
        `get_phrase_context args.include[${index}] is not a supported sv_query projection`,
      );
    }
    return value as V3IncludeValue;
  });
  delete args.include;
  if (
    topLevelInclude !== undefined &&
    !sameIncludeSelection(topLevelInclude, nestedInclude)
  ) {
    throw new BridgeProtocolError(
      "get_phrase_context include was supplied in both sv_query.include and args.include with different values; use the top-level sv_query.include field",
    );
  }
  return topLevelInclude ?? nestedInclude;
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
    } else {
      const fingerprint = fingerprints.get(index);
      if (fingerprint !== undefined && item.fingerprint !== fingerprint) {
        throw new BridgeError(
          `The explicit ${canonical} guard conflicts with contextId`,
          "CONTEXT_SCOPE_MISMATCH",
          { field: `${field}[].fingerprint`, index },
        );
      }
    }
  }
}

function mergeContextField(
  result: JsonRecord,
  field: string,
  contextValue: unknown,
  contextId: string,
): void {
  if (contextValue === undefined) {
    return;
  }
  const explicitValue = result[field];
  if (explicitValue !== undefined && explicitValue !== contextValue) {
    throw new BridgeError(
      `${field} conflicts with the target bound to contextId`,
      "CONTEXT_SCOPE_MISMATCH",
      {
        contextId,
        field,
        expected: contextValue,
        actual: explicitValue,
      },
    );
  }
  result[field] ??= contextValue;
}

function compatibleContextKinds(
  action: string,
  args: JsonRecord,
): readonly V3ContextTargetKind[] {
  if (action === "script_data") {
    const objectType = optionalString(args.objectType);
    if (objectType === "track" || objectType === "mixer") {
      return ["track"];
    }
    if (
      objectType === "group" ||
      objectType === "reference" ||
      objectType === "note" ||
      objectType === "retakes" ||
      objectType === "automation" ||
      objectType === "pitchControl"
    ) {
      return ["group", "automation"];
    }
    if (objectType === "timeAxis") {
      return ["timeAxis"];
    }
    return [];
  }
  if (action === "set_selection") {
    const scope = optionalString(args.scope) ?? "pianoRoll";
    const operation = optionalString(args.operation);
    const kind = optionalString(args.kind);
    if (
      scope === "pianoRoll" &&
      (operation === "replace" ||
        operation === "add" ||
        operation === "remove") &&
      (kind === "notes" ||
        kind === "pitchControls" ||
        kind === "automationPoints")
    ) {
      return ["group", "automation"];
    }
    return [];
  }
  return contextKindsForAction(action);
}

function assertContextCompatible(
  action: string,
  args: JsonRecord,
  contextId: string,
  context: V3ContextEntry,
): void {
  const accepted = compatibleContextKinds(action, args);
  if (
    context.targetKind !== undefined &&
    accepted.includes(context.targetKind)
  ) {
    return;
  }
  throw new BridgeError(
    `contextId from ${context.sourceAction ?? "another read"} cannot target ${action}`,
    "CONTEXT_INCOMPATIBLE",
    {
      contextId,
      action,
      sourceAction: context.sourceAction,
      targetKind: context.targetKind,
      acceptedTargetKinds: accepted,
      untypedContext: context.targetKind === undefined,
    },
  );
}

function expandContext(
  action: string,
  args: JsonRecord,
  contextId: string | undefined,
  contexts: V3ContextStore,
  requiredMode?: V3ContextMode,
): JsonRecord {
  const result = { ...args };
  const cloneIntents = optionalCommandPolicy(action)?.cloneIntents;
  if (cloneIntents !== undefined) {
    if (Object.prototype.hasOwnProperty.call(result, "deepCopy")) {
      throw new BridgeProtocolError(
        `${action} args.deepCopy is not accepted; use cloneIntent`,
      );
    }
    const cloneIntent = optionalString(result.cloneIntent);
    if (cloneIntent === undefined) {
      throw new BridgeProtocolError(`${action} args.cloneIntent is required`);
    }
    if (!cloneIntents.some((allowed) => allowed === cloneIntent)) {
      throw new BridgeProtocolError(
        `${action} args.cloneIntent must be ${cloneIntents.join(" or ")}`,
      );
    }
  }
  if (action === "add_notes" || action === "import_monophonic_score") {
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
  const context = contexts.resolve(contextId, requiredMode);
  assertContextCompatible(action, result, contextId, context);
  const contextExpansion = contextExpansionForAction(action);

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

  if (
    contextExpansion?.groupLocator === true ||
    (action === "set_selection" &&
      compatibleContextKinds(action, result).length > 0)
  ) {
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
    mergeContextField(result, "groupIndex", context.groupIndex, contextId);
    mergeContextField(result, "groupUuid", context.groupUuid, contextId);
  }
  if (contextExpansion?.trackGuard === true) {
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
    mergeContextField(
      result,
      "trackFingerprint",
      context.trackFingerprint,
      contextId,
    );
  }
  if (contextExpansion?.trackLocator === true) {
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
  }
  if (contextExpansion?.referenceGuard === true) {
    mergeContextField(
      result,
      "referenceFingerprint",
      context.referenceFingerprint,
      contextId,
    );
  }
  if (action === "set_time_axis") {
    mergeContextField(
      result,
      "expectedFingerprint",
      context.expectedFingerprint,
      contextId,
    );
  }
  if (action === "delete_note_group") {
    mergeContextField(result, "libraryIndex", context.libraryIndex, contextId);
    mergeContextField(result, "groupUuid", context.groupUuid, contextId);
    mergeContextField(
      result,
      "expectedFingerprint",
      context.expectedFingerprint,
      contextId,
    );
  }
  if (action === "clone_note_group") {
    mergeContextField(result, "libraryIndex", context.libraryIndex, contextId);
    mergeContextField(result, "groupUuid", context.groupUuid, contextId);
    mergeContextField(
      result,
      "expectedFingerprint",
      context.expectedFingerprint,
      contextId,
    );
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
    mergeContextField(result, "groupIndex", context.groupIndex, contextId);
  }
  if (action === "add_group_reference") {
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
    mergeContextField(
      result,
      "trackFingerprint",
      context.trackFingerprint,
      contextId,
    );
    if (context.libraryIndex !== undefined) {
      mergeContextField(
        result,
        "targetLibraryIndex",
        context.libraryIndex,
        contextId,
      );
      mergeContextField(
        result,
        "targetGroupUuid",
        context.groupUuid,
        contextId,
      );
      mergeContextField(
        result,
        "targetFingerprint",
        context.expectedFingerprint,
        contextId,
      );
    }
  }
  if (action === "clone_group_reference") {
    if (context.referenceFingerprint !== undefined) {
      mergeContextField(
        result,
        "sourceTrackIndex",
        context.trackIndex,
        contextId,
      );
      mergeContextField(
        result,
        "sourceGroupIndex",
        context.groupIndex,
        contextId,
      );
      mergeContextField(
        result,
        "sourceGroupUuid",
        context.groupUuid,
        contextId,
      );
      mergeContextField(
        result,
        "sourceReferenceFingerprint",
        context.referenceFingerprint,
        contextId,
      );
    } else {
      mergeContextField(
        result,
        "targetTrackIndex",
        context.trackIndex,
        contextId,
      );
      mergeContextField(
        result,
        "targetTrackFingerprint",
        context.trackFingerprint,
        contextId,
      );
    }
  }
  if (action === "create_harmony_track") {
    mergeContextField(
      result,
      "sourceTrackIndex",
      context.trackIndex,
      contextId,
    );
    mergeContextField(
      result,
      "sourceTrackFingerprint",
      context.trackFingerprint,
      contextId,
    );
  }
  if (action === "script_data") {
    mergeContextField(result, "trackIndex", context.trackIndex, contextId);
    mergeContextField(result, "groupIndex", context.groupIndex, contextId);
    mergeContextField(result, "groupUuid", context.groupUuid, contextId);
    const objectType = optionalString(result.objectType);
    if (objectType === "track" || objectType === "mixer") {
      mergeContextField(
        result,
        "trackFingerprint",
        context.trackFingerprint,
        contextId,
      );
    } else if (objectType === "reference") {
      mergeContextField(
        result,
        "referenceFingerprint",
        context.referenceFingerprint,
        contextId,
      );
    } else if (objectType === "timeAxis" || objectType === "automation") {
      mergeContextField(
        result,
        "expectedFingerprint",
        context.expectedFingerprint,
        contextId,
      );
    }
  }

  const noteField = contextExpansion?.noteArrayField;
  if (noteField !== undefined) {
    expandGuardedArray(
      result,
      noteField,
      "noteIndex",
      context.noteFingerprints,
    );
  }
  if (contextExpansion?.retakeGuard === true) {
    const noteIndex = normalizeItemIndex(result, "noteIndex");
    mergeContextField(
      result,
      "fingerprint",
      context.noteFingerprints.get(noteIndex),
      contextId,
    );
  }
  const pitchField = contextExpansion?.pitchArrayField;
  if (pitchField !== undefined) {
    expandGuardedArray(
      result,
      pitchField,
      "pitchControlIndex",
      context.pitchControlFingerprints,
    );
  }
  if (contextExpansion?.automationGuard === true) {
    const parameter = optionalString(result.parameter);
    if (parameter !== undefined) {
      mergeContextField(
        result,
        "expectedFingerprint",
        context.automationFingerprints.get(parameter),
        contextId,
      );
    }
  }
  if (action === "apply_expression_preset") {
    const parameter =
      result.preset === "breathiness" ? "breathiness" : "loudness";
    mergeContextField(
      result,
      "expectedAutomationFingerprint",
      context.automationFingerprints.get(parameter),
      contextId,
    );
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
      } else if (parameter !== undefined) {
        const fingerprint = context.automationFingerprints.get(parameter);
        if (
          fingerprint !== undefined &&
          update.expectedFingerprint !== fingerprint
        ) {
          throw new BridgeError(
            "An automation guard conflicts with contextId",
            "CONTEXT_SCOPE_MISMATCH",
            { contextId, parameter },
          );
        }
      }
    }
  }
  return result;
}

export const v3Testing = {
  addNestedContexts,
  expandContext,
  normalizePhraseReadInclude,
  ...queryProjectorTesting,
  waitForSessionTokenChange,
};

function expandTransactionContexts(
  args: JsonRecord,
  contexts: V3ContextStore,
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
        payload: expandContext(
          action,
          cleanPayload,
          contextId,
          contexts,
          "writeIntent",
        ),
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
  contexts: V3ContextStore,
  guardTokens: GuardTokenStore,
  sessionToken: string | undefined,
): JsonRecord {
  const root = asRecord(value, "result");
  addNestedContexts(
    action,
    root,
    contexts,
    guardTokens,
    "writeIntent",
    sessionToken,
  );
  return commandOutcome(action, root);
}

function describeActionTool(name: string, tool: RegisteredTool): JsonRecord {
  const commandPolicy = optionalCommandPolicy(name);
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
  if (
    contextExpansionForAction(name)?.sharedGroupContent === true &&
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    !Array.isArray(inputSchema)
  ) {
    const schemaRecord = inputSchema as JsonRecord;
    const properties =
      typeof schemaRecord.properties === "object" &&
      schemaRecord.properties !== null &&
      !Array.isArray(schemaRecord.properties)
        ? (schemaRecord.properties as JsonRecord)
        : {};
    properties.sharedGroupPolicy = {
      type: "string",
      enum: ["reject", "allowAllReferences"],
      default: "reject",
      description:
        "Reject content writes when the Note Group has multiple references. Use allowAllReferences only for an intentional linked edit and also supply expectedReferenceCount.",
    };
    properties.expectedReferenceCount = {
      type: "integer",
      minimum: 1,
      description:
        "Fresh referenceCount from list_note_groups. Required with sharedGroupPolicy=allowAllReferences and checked again before writing.",
    };
    schemaRecord.properties = properties;
  }
  if (
    commandPolicy?.cloneIntents !== undefined &&
    typeof inputSchema === "object" &&
    inputSchema !== null &&
    !Array.isArray(inputSchema)
  ) {
    const schemaRecord = inputSchema as JsonRecord;
    const properties =
      typeof schemaRecord.properties === "object" &&
      schemaRecord.properties !== null &&
      !Array.isArray(schemaRecord.properties)
        ? (schemaRecord.properties as JsonRecord)
        : {};
    delete properties.deepCopy;
    delete properties.linked;
    properties.cloneIntent = {
      type: "string",
      enum: [...commandPolicy.cloneIntents],
      description:
        "Explicit ownership intent for this clone command. Generic deepCopy and legacy boolean clone flags are not accepted.",
    };
    schemaRecord.properties = properties;
    const required = Array.isArray(schemaRecord.required)
      ? schemaRecord.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    schemaRecord.required = [
      ...required.filter((value) => value !== "linked"),
      ...(required.includes("cloneIntent") ? [] : ["cloneIntent"]),
    ];
  }
  const contextExpansion = contextExpansionForAction(name);
  const contextHint =
    name === "transform_notes"
      ? "With a fresh phrase/note contextId, set args.target to contextNotes and omit notes and the Group locator; every guarded note in that exact read scope becomes a target. Alternatively supply note indices and omit fingerprints."
      : contextExpansion?.noteArrayField !== undefined
      ? "With sv_command contextId, use item index or noteIndex and omit item fingerprints and the Group locator."
      : contextExpansion?.pitchArrayField !== undefined
        ? "With contextId from get_pitch_controls, use item index or pitchControlIndex and omit item fingerprints and the Group locator."
        : contextExpansion?.automationGuard === true
          ? "With contextId from an automation read, omit expectedFingerprint and the Group locator."
          : contextExpansion?.trackGuard === true
            ? "With contextId from list_tracks, omit trackIndex and trackFingerprint."
            : contextExpansion?.referenceGuard === true
              ? "With contextId from a Group/voice read, omit the Group locator and referenceFingerprint."
              : contextExpansion?.groupLocator === true
                ? "A compatible contextId may supply trackIndex, groupIndex, and groupUuid."
                : undefined;
  return {
    action: name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(commandPolicy?.cloneIntents === undefined
      ? tool.description === undefined
        ? {}
        : { description: tool.description }
      : {
          description:
            name === "clone_group_reference"
              ? "Create a linked Reference to the same GroupContent or an isolated Reference to a newly cloned Note Group, with UUID and reference-count verification."
              : name === "clone_track_shell"
                ? "Create one verified-empty Track shell with the host-cloned main Vocal context and no Vocal identity claim."
                : "Create an isolated Track clone whose vocal GroupContent targets are UUID-separated and source-verified; detached non-main Vocals require manual review.",
        }),
    inputSchema,
    ...(contextHint === undefined ? {} : { v3Context: contextHint }),
    category:
      commandPolicy?.category ??
      (isReadAction(tool) ? "read" : "edit"),
  };
}

function catalog(definitions: ActionToolDefinitions): JsonRecord {
  const categories: Record<string, string[]> = {
    read: [],
    edit: [],
    delete: [],
    ui: [],
    transaction: [],
  };
  for (const [name, tool] of definitions) {
    if (isV3InfrastructureAction(name)) {
      continue;
    }
    const category =
      optionalCommandPolicy(name)?.category ??
      (isReadAction(tool) ? "read" : undefined);
    if (category === undefined) {
      throw new BridgeProtocolError(`No v3 command policy for ${name}`);
    }
    categories[category]?.push(name);
  }
  return {
    protocol: "mcp-v3",
    indices: "1-based",
    categories,
    workflow:
      "Describe unfamiliar actions, read fresh state, then edit with the returned contextId.",
  };
}

async function invokeV3(
  definitions: ActionToolDefinitions,
  action: string,
  args: JsonRecord,
): Promise<CallToolResult> {
  try {
    return await invokeActionTool(definitions, action, args);
  } catch (error) {
    return errorResult(error);
  }
}

export interface V3SessionChange {
  readonly previousSessionToken: string;
  readonly currentSessionToken: string;
}

export class V3SessionTracker {
  private sessionToken: string | undefined;

  public observe(sessionToken: string | undefined): V3SessionChange | undefined {
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

async function waitForSessionTokenChange(
  getSessionToken: () => Promise<string | undefined>,
  previousSessionToken: string,
  timeoutMs = 5_000,
  pollIntervalMs = 25,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const currentSessionToken = await getSessionToken();
    if (
      currentSessionToken !== undefined &&
      currentSessionToken.length > 0 &&
      currentSessionToken !== previousSessionToken
    ) {
      return currentSessionToken;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}

export function registerV3Surface(
  registerTool: RegisterTool,
  definitions: ActionToolDefinitions,
  guardTokens: GuardTokenStore,
  getSessionToken?: () => Promise<string | undefined>,
): void {
  const contexts = new V3ContextStore();
  const snapshots = new V3SnapshotCache();
  const sessionTracker = new V3SessionTracker();
  const observeSessionToken = (
    sessionToken: string | undefined,
  ): V3SessionChange | undefined => {
    const change = sessionTracker.observe(sessionToken);
    if (change !== undefined) {
      contexts.clear();
      guardTokens.clear();
      snapshots.clear();
    }
    return change;
  };
  const observeSession = async (): Promise<V3SessionChange | undefined> =>
    observeSessionToken(await getSessionToken?.());
  const sessionChangedError = (change: V3SessionChange): BridgeError =>
    new BridgeError(
      "SynthV was restarted or the Bridge was reloaded. Cached contexts and Guard Tokens were cleared; read the target again before writing.",
      "SYNTHV_SESSION_CHANGED",
      {
        ...change,
        cachesCleared: true,
        requiredAction: "read_target_again",
      },
    );
  const sessionResetResult = (change: V3SessionChange): JsonRecord => ({
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
    .describe("Fresh contextId returned by sv_query.");

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
    async (input) => {
      const reloadPreviousSessionToken =
        input.operation === "reload" && getSessionToken !== undefined
          ? await getSessionToken()
          : undefined;
      if (reloadPreviousSessionToken !== undefined) {
        observeSessionToken(reloadPreviousSessionToken);
      }
      const result = await invokeV3(
        definitions,
        STATUS_OPERATIONS[input.operation],
        {},
      );
      if (
        input.operation !== "reload" ||
        result.isError ||
        getSessionToken === undefined ||
        reloadPreviousSessionToken === undefined
      ) {
        return result;
      }
      const currentSessionToken = await waitForSessionTokenChange(
        getSessionToken,
        reloadPreviousSessionToken,
      );
      if (currentSessionToken === undefined) {
        return result;
      }
      const change = observeSessionToken(currentSessionToken);
      const root = asRecord(readJsonResult(result), "result");
      root.previousSessionToken = reloadPreviousSessionToken;
      root.sessionToken = currentSessionToken;
      root.cachesCleared = change !== undefined;
      root.sessionChangeObserved = true;
      return jsonResult(root);
    },
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
            return describeActionTool(action, tool);
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
        "Run one read action. Reuse contextId for scoped reads/writes; phrase and Group Voice reads default to compact projected data. For get_phrase_context, top-level include is canonical and args.include is promoted when supplied alone.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
        contextMode: z
          .enum(["readOnly", "writeIntent"])
          .default("readOnly"),
        include: z.array(z.enum(V3_INCLUDE_VALUES)).max(8).optional(),
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
        const includeWasExplicit =
          input.action === "get_phrase_context" &&
          (input.include !== undefined ||
            Object.prototype.hasOwnProperty.call(input.args, "include"));
        const rawArgs = { ...input.args };
        const include =
          input.action === "get_phrase_context"
            ? normalizePhraseReadInclude(input.include, rawArgs)
            : input.include;
        const prepared = prepareQueryArguments(input.action, rawArgs);
        let args = expandContext(
          input.action,
          prepared.args,
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
        const result = await invokeActionTool(definitions, input.action, args);
        if (result.isError) {
          return result;
        }
        const root = asRecord(readJsonResult(result), "result");
        const shadowSource = snapshotQueryProjectionSource(
          input.action,
          root,
        );
        if (sessionChange !== undefined) {
          root.sessionReset = sessionResetResult(sessionChange);
        }
        addNestedContexts(
          input.action,
          root,
          contexts,
          guardTokens,
          input.contextMode,
          await getSessionToken?.(),
        );
        const projected = projectQueryResult(
          input.action,
          root,
          {
            ...(include === undefined ? {} : { include }),
            ...(input.fields === undefined ? {} : { fields: input.fields }),
            dense: input.dense,
            debug: input.debug,
            explicitlyScoped:
              prepared.explicitlyScoped ||
              includeWasExplicit ||
              input.fields !== undefined,
            ...(shadowSource === undefined ? {} : { shadowSource }),
          },
        );
        traceStage("queryProjected", {
          action: input.action,
          responseCharacters: projected.responseCharacters,
          budgetExceeded: projected.budgetExceeded,
          budgetClass: projected.budgetClass,
          projectionStrategy: projected.strategy,
        });
        enforceQueryResponseBudget(input.action, projected);
        const shadow = projected.shadow;
        if (shadow !== undefined) {
          traceStage("shadowProjected", {
            action: input.action,
            projectionParity: shadow.state,
            comparedFieldCount: shadow.comparedFieldCount,
            ...(shadow.comparedItemCount === undefined
              ? {}
              : { comparedItemCount: shadow.comparedItemCount }),
            differenceCount: shadow.differenceCount,
            privateFieldCount: shadow.privateFieldCount,
          });
        }
        return jsonResult(projected.publicProjection);
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
            "writeIntent",
          );
          if (
            input.action === "set_note_phoneme_properties" ||
            input.action === "set_automation_points"
          ) {
            args.responseMode = "compact";
          }
          const result = await invokeActionTool(definitions, input.action, args);
          if (result.isError || input.response === "full") {
            return result;
          }
          return jsonResult(
            minimalWriteResult(
              input.action,
              readJsonResult(result),
              contexts,
              guardTokens,
              await getSessionToken?.(),
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
        const result = await invokeActionTool(definitions, input.action, args);
        if (result.isError || input.response === "full") {
          return result;
        }
        return jsonResult(
          minimalWriteResult(
            input.action,
            readJsonResult(result),
            contexts,
            guardTokens,
            await getSessionToken?.(),
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
        const result = await invokeActionTool(
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
        addNestedContexts(
          input.action,
          root,
          contexts,
          guardTokens,
          "readOnly",
          await getSessionToken?.(),
        );
        queryProjectorTesting.stripDiagnostics(root);
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
                    "writeIntent",
                  );
            args = {
              ...args,
              payload: expandedPayload,
            };
          }
        }
        return await invokeActionTool(definitions, action, args);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
