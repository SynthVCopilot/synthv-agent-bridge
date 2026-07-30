import { isDeepStrictEqual } from "node:util";

type JsonRecord = Record<string, unknown>;

export interface QueryProjectionShadow {
  readonly state: "matched" | "mismatch";
  readonly comparedFieldCount: number;
  readonly differenceCount: number;
  readonly privateFieldCount: number;
}

interface QueryProjectionDefinition {
  readonly publicFields: ReadonlySet<string>;
  readonly defaultFields: readonly string[];
  readonly privateFields: ReadonlySet<string>;
}

function projectionDefinition(
  publicFields: readonly string[],
  defaultFields: readonly string[],
  privateFields: readonly string[],
): QueryProjectionDefinition {
  return {
    publicFields: new Set(publicFields),
    defaultFields,
    privateFields: new Set(privateFields),
  };
}

const QUERY_PROJECTION_DEFINITIONS: Readonly<
  Record<string, QueryProjectionDefinition>
> = {
  get_track_mixer: projectionDefinition(
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
  get_group_voice: projectionDefinition(
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
  definition: QueryProjectionDefinition,
): JsonRecord {
  const result: JsonRecord = {};
  for (const field of fields) {
    if (
      definition.publicFields.has(field) &&
      Object.prototype.hasOwnProperty.call(source, field)
    ) {
      result[field] = source[field];
    }
  }
  for (const field of ENVELOPE_FIELDS) {
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

export function supportsShadowQueryProjection(action: string): boolean {
  return QUERY_PROJECTION_DEFINITIONS[action] !== undefined;
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
  const candidate = copyPresentFields(
    source,
    publicProjection,
    requestedFields ?? definition.defaultFields,
    definition,
  );
  const differences = differenceCount(publicProjection, candidate);
  const privateFieldCount = [...definition.privateFields].filter((field) =>
    Object.prototype.hasOwnProperty.call(source, field),
  ).length;
  return {
    state: differences === 0 ? "matched" : "mismatch",
    comparedFieldCount: new Set([
      ...Object.keys(publicProjection),
      ...Object.keys(candidate),
    ]).size,
    differenceCount: differences,
    privateFieldCount,
  };
}
