import { randomBytes } from "node:crypto";

import { BridgeError, BridgeProtocolError } from "./errors.js";

export type V3ContextTargetKind =
  | "automation"
  | "group"
  | "libraryGroup"
  | "timeAxis"
  | "track"
  | "unknown";

export type V3ContextMode = "readOnly" | "writeIntent";

export interface V3ContextEntry {
  readonly mode?: V3ContextMode;
  readonly sessionToken?: string;
  readonly sourceAction?: string;
  readonly targetKind?: V3ContextTargetKind;
  readonly trackIndex?: number;
  readonly groupIndex?: number;
  readonly groupUuid?: string;
  readonly libraryIndex?: number;
  readonly trackFingerprint?: string;
  readonly referenceFingerprint?: string;
  readonly expectedFingerprint?: string;
  readonly noteFingerprints: ReadonlyMap<number, string>;
  readonly pitchControlFingerprints: ReadonlyMap<number, string>;
  readonly automationFingerprints: ReadonlyMap<string, string>;
}

interface StoredV3Context extends V3ContextEntry {
  readonly mode: V3ContextMode;
  readonly token: string;
  readonly weight: number;
}

function requireToken(value: string): string {
  if (!/^ctx_[A-Za-z0-9_-]{16,}$/u.test(value)) {
    throw new BridgeProtocolError("contextId must be a valid v3 context handle");
  }
  return value;
}

export class V3ContextStore {
  private readonly entries = new Map<string, StoredV3Context>();
  private totalWeight = 0;

  public constructor(
    private readonly maximumEntries = 1_024,
    private readonly maximumWeight = 20_000,
  ) {
    if (
      !Number.isInteger(maximumEntries) ||
      maximumEntries < 1 ||
      !Number.isInteger(maximumWeight) ||
      maximumWeight < 1
    ) {
      throw new Error("Context limits must be positive integers");
    }
  }

  public issue(entry: V3ContextEntry): string {
    let token: string;
    do {
      token = `ctx_${randomBytes(16).toString("base64url")}`;
    } while (this.entries.has(token));

    const weight =
      1 +
      entry.noteFingerprints.size +
      entry.pitchControlFingerprints.size +
      entry.automationFingerprints.size;
    this.entries.set(token, {
      ...entry,
      mode: entry.mode ?? "writeIntent",
      token,
      weight,
    });
    this.totalWeight += weight;
    while (
      this.entries.size > this.maximumEntries ||
      this.totalWeight > this.maximumWeight
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      this.totalWeight -= evicted?.weight ?? 0;
    }
    return token;
  }

  public resolve(
    token: string,
    requiredMode?: V3ContextMode,
  ): V3ContextEntry {
    const normalized = requireToken(token);
    const entry = this.entries.get(normalized);
    if (entry === undefined) {
      throw new BridgeError(
        "The v3 context is unknown or expired; query the target again.",
        "UNKNOWN_CONTEXT",
        { contextId: normalized },
      );
    }
    if (requiredMode === "writeIntent" && entry.mode !== "writeIntent") {
      throw new BridgeError(
        "This context is read-only; query the target again with contextMode=writeIntent.",
        "CONTEXT_NOT_WRITE_CAPABLE",
        { contextId: normalized },
      );
    }
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    return entry;
  }

  public clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}
