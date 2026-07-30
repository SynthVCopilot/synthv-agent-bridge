import { isDeepStrictEqual } from "node:util";

type JsonRecord = Record<string, unknown>;

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
    ["trackCount", "tracks"],
    ["trackCount", "tracks"],
    [],
    "tracks",
    [
      "trackIndex",
      "mainGroupUuid",
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
    ["fingerprint", "trackFingerprint", "referenceFingerprint"],
  ),
  list_note_groups: collectionProjectionDefinition(
    ["groupCount", "groups"],
    ["groupCount", "groups"],
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
