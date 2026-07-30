import { isDeepStrictEqual } from "node:util";

type JsonRecord = Record<string, unknown>;

export interface QueryProjectionShadow {
  readonly state: "matched" | "mismatch";
  readonly comparedFieldCount: number;
  readonly differenceCount: number;
  readonly privateFieldCount: number;
}

const TRACK_MIXER_FIELDS = [
  "trackIndex",
  "trackName",
  "gainDecibel",
  "pan",
  "muted",
  "solo",
] as const;

const TRACK_MIXER_FIELD_SET = new Set<string>(TRACK_MIXER_FIELDS);
const TRACK_MIXER_PRIVATE_FIELDS = new Set([
  "trackFingerprint",
  "fingerprint",
  "referenceFingerprint",
]);

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
): JsonRecord {
  const result: JsonRecord = {};
  for (const field of fields) {
    if (
      TRACK_MIXER_FIELD_SET.has(field) &&
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

export function shadowQueryProjection(
  action: string,
  source: JsonRecord,
  publicProjection: JsonRecord,
  requestedFields?: readonly string[],
): QueryProjectionShadow | undefined {
  if (action !== "get_track_mixer") {
    return undefined;
  }
  const candidate = copyPresentFields(
    source,
    publicProjection,
    requestedFields ?? TRACK_MIXER_FIELDS,
  );
  const differences = differenceCount(publicProjection, candidate);
  const privateFieldCount = [...TRACK_MIXER_PRIVATE_FIELDS].filter((field) =>
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
