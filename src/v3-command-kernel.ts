import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { toPublicError, type PublicError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

export type V3Outcome = "changed" | "alreadySatisfied" | "failed";

export interface TraceContext {
  readonly traceId: string;
  readonly startedAtMs: number;
  readonly stages: {
    readonly stage: string;
    readonly elapsedMs: number;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }[];
}

const traceStorage = new AsyncLocalStorage<TraceContext>();
interface StoredTrace {
  readonly traceId: string;
  readonly startedAtEpochMs: number;
  readonly durationMs: number;
  readonly stages: readonly {
    readonly stage: string;
    readonly elapsedMs: number;
    readonly durationMs: number;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }[];
}

const recentTraces: StoredTrace[] = [];
const TRACE_METADATA_KEYS = new Set([
  "action",
  "tool",
  "requestBytes",
  "responseBytes",
  "durationMs",
  "luaTotalMs",
  "cache",
  "entryCount",
  "outcome",
  "projectionParity",
  "comparedFieldCount",
  "differenceCount",
  "privateFieldCount",
]);
const MAX_TRACE_STAGES = 64;

function createTraceId(): string {
  return `tr_${randomBytes(12).toString("base64url")}`;
}

export function traceIdForCurrentOperation(): string {
  return traceStorage.getStore()?.traceId ?? createTraceId();
}

export async function runWithTrace<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const existing = traceStorage.getStore();
  if (existing !== undefined) {
    return operation();
  }
  return traceStorage.run(
    { traceId: createTraceId(), startedAtMs: Date.now(), stages: [] },
    async () => {
      traceStage("accepted");
      try {
        return await operation();
      } finally {
        traceStage("projected");
        const context = traceStorage.getStore();
        if (context !== undefined) {
          let previousElapsedMs = 0;
          recentTraces.push({
            traceId: context.traceId,
            startedAtEpochMs: context.startedAtMs,
            durationMs: Date.now() - context.startedAtMs,
            stages: context.stages.map((entry) => {
              const durationMs = Math.max(
                0,
                entry.elapsedMs - previousElapsedMs,
              );
              previousElapsedMs = entry.elapsedMs;
              const metadata = sanitizeTraceMetadata(entry.metadata);
              return {
                stage: entry.stage,
                elapsedMs: entry.elapsedMs,
                durationMs,
                ...(metadata === undefined ? {} : { metadata }),
              };
            }),
          });
          while (recentTraces.length > 100) {
            recentTraces.shift();
          }
        }
      }
    },
  );
}

export function currentTraceId(): string | undefined {
  return traceStorage.getStore()?.traceId;
}

export function traceStage(
  stage: string,
  metadata?: Readonly<Record<string, string | number | boolean>>,
): void {
  const context = traceStorage.getStore();
  if (context === undefined) {
    return;
  }
  if (context.stages.length >= MAX_TRACE_STAGES) {
    return;
  }
  context.stages.push({
    stage,
    elapsedMs: Date.now() - context.startedAtMs,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

export function recentTraceSummaries(
  limit = 5,
): readonly {
  readonly traceId: string;
  readonly durationMs: number;
  readonly stages: readonly string[];
}[] {
  return recentTraces
    .slice(-Math.max(0, Math.min(limit, 20)))
    .map((trace) => ({
      traceId: trace.traceId,
      durationMs: trace.durationMs,
      stages: trace.stages.map((entry) => entry.stage),
    }));
}

function sanitizeTraceMetadata(
  metadata:
    | Readonly<Record<string, string | number | boolean>>
    | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!TRACE_METADATA_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      result[key] = value.slice(0, 100);
    } else if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result[key] = value;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export interface TraceDiagnosticsOptions {
  readonly level: "support" | "debug";
  readonly traceId?: string;
  readonly limit?: number;
}

export function traceDiagnostics(
  options: TraceDiagnosticsOptions,
): JsonRecord {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const matching = recentTraces.filter(
    (trace) =>
      options.traceId === undefined || trace.traceId === options.traceId,
  );
  let traces = matching.slice(-limit).map((trace) => ({
    traceId: trace.traceId,
    startedAtEpochMs: trace.startedAtEpochMs,
    durationMs: trace.durationMs,
    stages: trace.stages.map((entry) =>
      options.level === "support"
        ? {
            stage: entry.stage,
            durationMs:
              typeof entry.metadata?.durationMs === "number"
                ? entry.metadata.durationMs
                : entry.durationMs,
          }
        : {
            stage: entry.stage,
            elapsedMs: entry.elapsedMs,
            durationMs:
              typeof entry.metadata?.durationMs === "number"
                ? entry.metadata.durationMs
                : entry.durationMs,
            ...(entry.metadata === undefined
              ? {}
              : { metadata: entry.metadata }),
          },
    ),
  }));
  const budget = options.level === "support" ? 8_192 : 16_384;
  let result: JsonRecord = {
    level: options.level,
    traceCount: traces.length,
    traces,
  };
  while (traces.length > 1 && JSON.stringify(result).length > budget) {
    traces = traces.slice(1);
    result = {
      level: options.level,
      traceCount: traces.length,
      truncated: true,
      traces,
    };
  }
  if (JSON.stringify(result).length > budget) {
    result = {
      level: options.level,
      traceCount: 0,
      truncated: true,
      reason: "diagnostic_size_budget",
      traces: [],
    };
  }
  return result;
}

function changedCount(result: JsonRecord): number | undefined {
  if (
    typeof result.changedCount === "number" &&
    Number.isInteger(result.changedCount) &&
    result.changedCount >= 0
  ) {
    return result.changedCount;
  }
  for (const [key, value] of Object.entries(result)) {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      /(?:added|changed|cleared|created|deleted|edited|removed|updated)Count$/u.test(
        key,
      )
    ) {
      return value;
    }
  }
  if (result.changed === false || result.alreadySatisfied === true) {
    return 0;
  }
  return undefined;
}

function copyDurableIdentifiers(
  source: JsonRecord,
  target: JsonRecord,
): void {
  let copied = 0;
  for (const [key, value] of Object.entries(source)) {
    if (copied >= 8) {
      break;
    }
    if (
      (typeof value === "string" &&
        value.length <= 128 &&
        /(?:Id|Uuid)$/u.test(key) &&
        !/fingerprint/iu.test(key)) ||
      (typeof value === "number" && /(?:Index|TakeId)$/u.test(key))
    ) {
      target[key] = value;
      copied += 1;
    }
  }
}

export function commandOutcome(
  action: string,
  result: JsonRecord,
): JsonRecord {
  const count = changedCount(result);
  const outcome: Exclude<V3Outcome, "failed"> =
    count === 0 ? "alreadySatisfied" : "changed";
  const projected: JsonRecord = {
    outcome,
    traceId: traceIdForCurrentOperation(),
    action,
    changedCount: count ?? 1,
    undoRecords:
      typeof result.undoRecordCount === "number"
        ? result.undoRecordCount
        : outcome === "alreadySatisfied"
          ? 0
          : 1,
    verified:
      typeof result.verified === "boolean" ? result.verified : true,
  };
  copyDurableIdentifiers(result, projected);
  if (typeof result.contextId === "string") {
    projected.contextId = result.contextId;
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    projected.warnings = result.warnings
      .slice(0, 4)
      .map((warning) => redactValue(warning));
  }
  if (JSON.stringify(projected).length > 2_048) {
    projected.warnings = [
      "Additional warnings were omitted to satisfy the public response budget.",
    ];
  }
  return projected;
}

const SENSITIVE_KEY =
  /(?:fingerprint|lyrics?|phonemes?|notes?|points?|automation|pitchCurve|traceback|requestedValue|actualValue)/iu;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return { redactedArrayLength: value.length };
  }
  if (typeof value !== "object" || value === null) {
    return typeof value === "string" && value.length > 256
      ? { redactedStringLength: value.length }
      : value;
  }
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "expected" || key === "actual") &&
      typeof child === "string" &&
      child.length > 0
    ) {
      result[key] = {
        redactedStringLength: child.length,
      };
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (
      (key === "issues" || key === "warnings" || key === "path") &&
      Array.isArray(child)
    ) {
      result[key] = child
        .slice(0, 16)
        .map((entry) => redactValue(entry, depth + 1));
      continue;
    }
    result[key] = redactValue(child, depth + 1);
  }
  return result;
}

function redactedPublicError(error: unknown): PublicError {
  const source = toPublicError(error);
  const message =
    source.message.length > 1_024
      ? `${source.message.slice(0, 1_024)}…`
      : source.message;
  return source.details === undefined
    ? { ...source, message }
    : { ...source, message, details: redactValue(source.details) };
}

export function failedOutcome(
  error: unknown,
  phase: string,
): JsonRecord {
  const publicError = redactedPublicError(error);
  const details =
    typeof publicError.details === "object" &&
    publicError.details !== null &&
    !Array.isArray(publicError.details)
      ? (publicError.details as JsonRecord)
      : undefined;
  const result: JsonRecord = {
    outcome: "failed",
    traceId: traceIdForCurrentOperation(),
    phase,
    wrote: details?.partialWritePossible === true,
    undoRequired: details?.undoRequired === true,
    retry:
      details?.undoRequired === true
        ? "undo_once_then_query_again"
        : publicError.code === "SYNTHV_SESSION_CHANGED" ||
            publicError.code.startsWith("STALE_")
          ? "query_again"
          : "correct_request",
    error: publicError,
  };
  if (JSON.stringify(result).length > 4_096) {
    result.error = {
      code: publicError.code,
      message: publicError.message,
      details: {
        redacted: true,
        reason: "public_error_size_budget",
      },
    };
  }
  return result;
}
