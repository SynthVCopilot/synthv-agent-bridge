import { isDeepStrictEqual } from "node:util";

import { BridgeError } from "./errors.js";
import { V3_PERFORMANCE_BUDGETS } from "./v3-performance.js";

type JsonRecord = Record<string, unknown>;

export const ORDINARY_QUERY_RESPONSE_BUDGET_CHARACTERS =
  V3_PERFORMANCE_BUDGETS.ordinaryQueryCharacters;
const TRACE_ID_PLACEHOLDER = "tr_0000000000000000";

const QUERY_ENVELOPE_FIELDS = [
  "contextId",
  "page",
  "hasMore",
  "sessionReset",
] as const;

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

export type QueryProjectionStrategy =
  | "fixed"
  | "offsetPage"
  | "cursorPage"
  | "rangeSummary"
  | "explicitBounded";

export interface QueryProjectionPolicy {
  readonly strategy: QueryProjectionStrategy;
  readonly defaultLimit?: number;
  readonly explicitScopeFields: readonly string[];
}

function queryPolicy(
  strategy: QueryProjectionStrategy,
  explicitScopeFields: readonly string[] = [],
  defaultLimit?: number,
): QueryProjectionPolicy {
  return {
    strategy,
    explicitScopeFields,
    ...(defaultLimit === undefined ? {} : { defaultLimit }),
  };
}

const QUERY_PROJECTION_POLICIES: Readonly<
  Record<string, QueryProjectionPolicy>
> = {
  convert_pitch: queryPolicy("fixed"),
  get_project_info: queryPolicy("fixed"),
  inspect_score_file: queryPolicy("explicitBounded", [
    "previewNoteLimit",
    "partIndex",
    "partId",
    "voice",
    "staff",
    "midiTrackIndex",
    "midiChannel",
  ]),
  get_time_axis: queryPolicy(
    "offsetPage",
    ["tempoOffset", "tempoLimit", "measureOffset", "measureLimit"],
    128,
  ),
  convert_time: queryPolicy("fixed"),
  list_tracks: queryPolicy("offsetPage", ["offset", "limit"], 128),
  list_note_groups: queryPolicy("offsetPage", ["offset", "limit"], 128),
  get_track_notes: queryPolicy(
    "offsetPage",
    ["groupIndex", "groupOffset", "groupLimit", "offset", "limit"],
    64,
  ),
  get_group_voice: queryPolicy("fixed"),
  get_note_phoneme_data: queryPolicy(
    "offsetPage",
    [
      "offset",
      "limit",
      "noteIndices",
      "startSeconds",
      "endSeconds",
    ],
    64,
  ),
  get_phrase_context: queryPolicy(
    "cursorPage",
    [
      "cursorToken",
      "offset",
      "limit",
      "noteIndices",
      "startSeconds",
      "endSeconds",
      "ranges",
    ],
    64,
  ),
  get_computed_group_data: queryPolicy(
    "offsetPage",
    ["offset", "limit", "pitchSample"],
    64,
  ),
  get_note_retakes: queryPolicy("fixed"),
  get_pitch_controls: queryPolicy(
    "offsetPage",
    ["offset", "limit", "sampleOffsets"],
    64,
  ),
  get_automation: queryPolicy("rangeSummary", [
    "rangeBegin",
    "rangeEnd",
  ]),
  sample_automation: queryPolicy("explicitBounded", ["positions"]),
  get_track_mixer: queryPolicy("fixed"),
};

export function queryProjectionActionNames(): readonly string[] {
  return Object.keys(QUERY_PROJECTION_POLICIES);
}

export function queryProjectionPolicy(action: string): QueryProjectionPolicy {
  const policy = QUERY_PROJECTION_POLICIES[action];
  if (policy === undefined) {
    throw new Error(`No v3 Query projection policy for ${action}`);
  }
  return policy;
}

function owns(record: JsonRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

export interface PreparedQueryArguments {
  readonly args: JsonRecord;
  readonly explicitlyScoped: boolean;
}

export function prepareQueryArguments(
  action: string,
  inputArgs: JsonRecord,
): PreparedQueryArguments {
  const policy = queryProjectionPolicy(action);
  const args = { ...inputArgs };
  const explicitlyScoped =
    policy.strategy === "explicitBounded" ||
    policy.explicitScopeFields.some((field) => owns(inputArgs, field));
  if (action === "get_time_axis") {
    args.tempoOffset ??= 0;
    args.tempoLimit ??= policy.defaultLimit;
    args.measureOffset ??= 0;
    args.measureLimit ??= policy.defaultLimit;
  } else if (action === "get_track_notes") {
    args.groupOffset ??= 0;
    args.groupLimit ??= 1;
    args.offset ??= 0;
    args.limit ??= policy.defaultLimit;
  } else if (
    policy.strategy === "offsetPage" ||
    policy.strategy === "cursorPage"
  ) {
    args.offset ??= 0;
    args.limit ??= policy.defaultLimit;
  }
  return { args, explicitlyScoped };
}

function projectIncludes(
  root: JsonRecord,
  include: readonly string[] | undefined,
): void {
  if (include === undefined) {
    return;
  }
  const selected = new Set(include);
  const fields: ReadonlyArray<readonly [string, string]> = [
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
    const note = optionalRecord(value);
    if (note === undefined) {
      continue;
    }
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
      ...(optionalRecord(root.noteDefaults) ?? {}),
      absolutePitch: "pitch",
    };
  }
}

function stripDiagnostics(root: JsonRecord, preserveComputedPending = false): void {
  for (const field of DIAGNOSTIC_FIELDS) {
    if (
      preserveComputedPending &&
      (field === "attributesPending" || field === "phonemesPending")
    ) {
      continue;
    }
    delete root[field];
  }
}

function shouldStripDiagnostics(
  action: string,
  include: readonly string[] | undefined,
  debug: boolean,
): boolean {
  return (
    !debug &&
    !(action === "get_phrase_context" && include?.includes("diagnostics") === true)
  );
}

function denseNotes(
  root: JsonRecord,
  mode: "auto" | "never" | "always",
): void {
  if (!Array.isArray(root.notes)) {
    return;
  }
  if (mode === "never" || (mode === "auto" && root.notes.length < 24)) {
    return;
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const value of root.notes) {
    const note = optionalRecord(value);
    if (note === undefined) {
      continue;
    }
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
      const note = optionalRecord(value);
      return note === undefined
        ? columns.map(() => null)
        : columns.map((column) => note[column] ?? null);
    }),
  };
  root.noteFormat = "rows";
}

function projectFields(root: JsonRecord, fields: readonly string[]): JsonRecord {
  const projected: JsonRecord = {};
  for (const field of fields) {
    if (owns(root, field)) {
      projected[field] = root[field];
    }
  }
  for (const field of QUERY_ENVELOPE_FIELDS) {
    if (owns(root, field)) {
      projected[field] = root[field];
    }
  }
  return projected;
}

export interface QueryProjectionOptions {
  readonly include?: readonly string[];
  readonly fields?: readonly string[];
  readonly dense: "auto" | "never" | "always";
  readonly debug: boolean;
  readonly explicitlyScoped: boolean;
  readonly shadowSource?: JsonRecord;
}

export interface ProjectedQueryResult {
  readonly publicProjection: JsonRecord;
  readonly strategy: QueryProjectionStrategy;
  readonly budgetClass: "ordinary" | "explicitScope";
  readonly responseCharacters: number;
  readonly budgetExceeded: boolean;
  readonly shadow?: QueryProjectionShadow;
}

export function projectQueryResult(
  action: string,
  root: JsonRecord,
  options: QueryProjectionOptions,
): ProjectedQueryResult {
  const policy = queryProjectionPolicy(action);
  if (action === "get_phrase_context") {
    projectIncludes(root, options.include);
    compactPhraseNotes(root);
  }
  if (shouldStripDiagnostics(action, options.include, options.debug)) {
    stripDiagnostics(root, action === "get_computed_group_data");
  }
  denseNotes(root, options.dense);
  const fields = options.fields ?? DEFAULT_READ_FIELDS[action];
  const publicProjection =
    fields === undefined ? root : projectFields(root, fields);
  const responseCharacters = JSON.stringify(
    owns(publicProjection, "traceId")
      ? publicProjection
      : { traceId: TRACE_ID_PLACEHOLDER, ...publicProjection },
  ).length;
  const budgetClass = options.explicitlyScoped
    ? "explicitScope"
    : "ordinary";
  const budgetExceeded =
    responseCharacters > ORDINARY_QUERY_RESPONSE_BUDGET_CHARACTERS;
  const shadow = shadowQueryProjection(
    action,
    options.shadowSource ?? root,
    publicProjection,
    fields,
  );
  return {
    publicProjection,
    strategy: policy.strategy,
    budgetClass,
    responseCharacters,
    budgetExceeded,
    ...(shadow === undefined ? {} : { shadow }),
  };
}

export function enforceQueryResponseBudget(
  action: string,
  result: ProjectedQueryResult,
): void {
  if (result.budgetExceeded && result.budgetClass === "ordinary") {
    const policy = queryProjectionPolicy(action);
    throw new BridgeError(
      "The default Query result exceeds the model-facing response budget. Request a narrower page, range, include, or field projection.",
      "QUERY_RESPONSE_BUDGET_EXCEEDED",
      {
        action,
        strategy: policy.strategy,
        budgetClass: result.budgetClass,
        responseCharacters: result.responseCharacters,
        budgetCharacters: ORDINARY_QUERY_RESPONSE_BUDGET_CHARACTERS,
        requiredAction: "request_narrower_query_scope",
        ...(policy.defaultLimit === undefined
          ? {}
          : { suggestedMaximumLimit: Math.max(1, Math.floor(policy.defaultLimit / 2)) }),
      },
    );
  }
}

export const queryProjectorTesting = {
  compactPhraseNotes,
  defaultReadFields: (action: string): readonly string[] | undefined =>
    DEFAULT_READ_FIELDS[action],
  denseNotes,
  projectFields,
  projectIncludes,
  shouldStripDiagnostics,
  stripDiagnostics,
};

export interface QueryProjectionShadow {
  readonly state: "matched" | "mismatch";
  readonly comparedFieldCount: number;
  readonly comparedItemCount?: number;
  readonly differenceCount: number;
  readonly privateFieldCount: number;
}

interface FlatQueryProjectionDefinition {
  readonly kind: "flat";
  readonly publicFields: ReadonlySet<string>;
  readonly defaultFields: readonly string[];
  readonly privateFields: ReadonlySet<string>;
}

interface CollectionQueryProjectionDefinition {
  readonly kind: "collection";
  readonly publicFields: ReadonlySet<string>;
  readonly defaultFields: readonly string[];
  readonly privateFields: ReadonlySet<string>;
  readonly collectionField: string;
  readonly itemPublicFields: ReadonlySet<string>;
  readonly itemPrivateFields: ReadonlySet<string>;
}

type QueryProjectionDefinition =
  | FlatQueryProjectionDefinition
  | CollectionQueryProjectionDefinition;

function flatProjectionDefinition(
  publicFields: readonly string[],
  defaultFields: readonly string[],
  privateFields: readonly string[],
): FlatQueryProjectionDefinition {
  return {
    kind: "flat",
    publicFields: new Set(publicFields),
    defaultFields,
    privateFields: new Set(privateFields),
  };
}

function collectionProjectionDefinition(
  publicFields: readonly string[],
  defaultFields: readonly string[],
  privateFields: readonly string[],
  collectionField: string,
  itemPublicFields: readonly string[],
  itemPrivateFields: readonly string[],
): CollectionQueryProjectionDefinition {
  return {
    kind: "collection",
    publicFields: new Set(publicFields),
    defaultFields,
    privateFields: new Set(privateFields),
    collectionField,
    itemPublicFields: new Set(itemPublicFields),
    itemPrivateFields: new Set(itemPrivateFields),
  };
}

const QUERY_PROJECTION_DEFINITIONS: Readonly<
  Record<string, QueryProjectionDefinition>
> = {
  get_track_mixer: flatProjectionDefinition(
    [
      "trackIndex",
      "trackName",
      "gainDecibel",
      "pan",
      "muted",
      "solo",
    ],
    [
      "trackIndex",
      "trackName",
      "gainDecibel",
      "pan",
      "muted",
      "solo",
    ],
    ["trackFingerprint", "fingerprint", "referenceFingerprint"],
  ),
  get_group_voice: flatProjectionDefinition(
    [
      "trackIndex",
      "groupIndex",
      "parameters",
      "vocalModes",
      "rawVoice",
      "experimentalUnison",
      "phonemeCapabilities",
      "selectionContext",
    ],
    ["trackIndex", "groupIndex", "parameters", "vocalModes"],
    ["groupUuid", "referenceFingerprint", "fingerprint"],
  ),
  list_tracks: collectionProjectionDefinition(
    [
      "trackCount",
      "returnedTrackOffset",
      "returnedTrackCount",
      "tracks",
    ],
    [
      "trackCount",
      "returnedTrackOffset",
      "returnedTrackCount",
      "tracks",
    ],
    [],
    "tracks",
    [
      "trackIndex",
      "name",
      "displayColor",
      "displayColorArgb",
      "displayColorRgb",
      "displayOrder",
      "duration",
      "groupCount",
      "noteCount",
      "bounced",
      "mixer",
    ],
    [
      "mainGroupUuid",
      "fingerprint",
      "trackFingerprint",
      "referenceFingerprint",
    ],
  ),
  list_note_groups: collectionProjectionDefinition(
    [
      "groupCount",
      "returnedGroupOffset",
      "returnedGroupCount",
      "groups",
    ],
    [
      "groupCount",
      "returnedGroupOffset",
      "returnedGroupCount",
      "groups",
    ],
    [],
    "groups",
    [
      "libraryIndex",
      "name",
      "noteCount",
      "pitchControlCount",
      "referenceCount",
    ],
    ["groupUuid", "fingerprint"],
  ),
};

const ENVELOPE_FIELDS = [
  "contextId",
  "page",
  "hasMore",
  "sessionReset",
] as const;

function copyPresentFields(
  source: JsonRecord,
  publicProjection: JsonRecord,
  fields: readonly string[],
  allowedFields: ReadonlySet<string>,
  envelopeFields: readonly string[] = ENVELOPE_FIELDS,
): JsonRecord {
  const result: JsonRecord = {};
  for (const field of fields) {
    if (
      allowedFields.has(field) &&
      Object.prototype.hasOwnProperty.call(source, field)
    ) {
      result[field] = source[field];
    }
  }
  for (const field of envelopeFields) {
    if (Object.prototype.hasOwnProperty.call(publicProjection, field)) {
      result[field] = publicProjection[field];
    }
  }
  return result;
}

function differenceCount(left: JsonRecord, right: JsonRecord): number {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  let count = 0;
  for (const field of fields) {
    if (!isDeepStrictEqual(left[field], right[field])) {
      count += 1;
    }
  }
  return count;
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function projectCollection(
  source: JsonRecord,
  publicProjection: JsonRecord,
  fields: readonly string[],
  definition: CollectionQueryProjectionDefinition,
): JsonRecord {
  const candidate = copyPresentFields(
    source,
    publicProjection,
    fields.filter((field) => field !== definition.collectionField),
    definition.publicFields,
  );
  if (!fields.includes(definition.collectionField)) {
    return candidate;
  }
  const sourceItems = source[definition.collectionField];
  const publicItems = publicProjection[definition.collectionField];
  if (!Array.isArray(sourceItems)) {
    if (Object.prototype.hasOwnProperty.call(source, definition.collectionField)) {
      candidate[definition.collectionField] = sourceItems;
    }
    return candidate;
  }
  const publicArray = Array.isArray(publicItems) ? publicItems : [];
  candidate[definition.collectionField] = sourceItems.map((value, index) => {
    const sourceItem = optionalRecord(value);
    if (sourceItem === undefined) {
      return value;
    }
    const publicItem = optionalRecord(publicArray[index]) ?? {};
    return copyPresentFields(
      sourceItem,
      publicItem,
      [...definition.itemPublicFields],
      definition.itemPublicFields,
      ["contextId"],
    );
  });
  return candidate;
}

function countPrivateFields(
  source: JsonRecord,
  definition: QueryProjectionDefinition,
): number {
  let count = [...definition.privateFields].filter((field) =>
    Object.prototype.hasOwnProperty.call(source, field),
  ).length;
  if (definition.kind !== "collection") {
    return count;
  }
  const items = source[definition.collectionField];
  if (!Array.isArray(items)) {
    return count;
  }
  for (const value of items) {
    const item = optionalRecord(value);
    if (item === undefined) {
      continue;
    }
    count += [...definition.itemPrivateFields].filter((field) =>
      Object.prototype.hasOwnProperty.call(item, field),
    ).length;
  }
  return count;
}

export function snapshotQueryProjectionSource(
  action: string,
  source: JsonRecord,
): JsonRecord | undefined {
  const definition = QUERY_PROJECTION_DEFINITIONS[action];
  if (definition === undefined) {
    return undefined;
  }
  const snapshot = { ...source };
  if (definition.kind !== "collection") {
    return snapshot;
  }
  const items = source[definition.collectionField];
  if (Array.isArray(items)) {
    snapshot[definition.collectionField] = items.map((value) => {
      const item = optionalRecord(value);
      return item === undefined ? value : { ...item };
    });
  }
  return snapshot;
}

export function shadowQueryProjection(
  action: string,
  source: JsonRecord,
  publicProjection: JsonRecord,
  requestedFields?: readonly string[],
): QueryProjectionShadow | undefined {
  const definition = QUERY_PROJECTION_DEFINITIONS[action];
  if (definition === undefined) {
    return undefined;
  }
  const fields = requestedFields ?? definition.defaultFields;
  const candidate =
    definition.kind === "collection"
      ? projectCollection(source, publicProjection, fields, definition)
      : copyPresentFields(
          source,
          publicProjection,
          fields,
          definition.publicFields,
        );
  const differences = differenceCount(publicProjection, candidate);
  const privateFieldCount = countPrivateFields(source, definition);
  let comparedItemCount: number | undefined;
  if (definition.kind === "collection") {
    const items = source[definition.collectionField];
    comparedItemCount =
      fields.includes(definition.collectionField) && Array.isArray(items)
        ? items.length
        : 0;
  }
  return {
    state: differences === 0 ? "matched" : "mismatch",
    comparedFieldCount: new Set([
      ...Object.keys(publicProjection),
      ...Object.keys(candidate),
    ]).size,
    ...(comparedItemCount === undefined ? {} : { comparedItemCount }),
    differenceCount: differences,
    privateFieldCount,
  };
}
