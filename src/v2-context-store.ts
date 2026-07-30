import { randomBytes } from "node:crypto";

import { BridgeError, BridgeProtocolError } from "./errors.js";

export type V2ContextTargetKind =
  | "automation"
  | "group"
  | "libraryGroup"
  | "timeAxis"
  | "track"
  | "unknown";

export interface V2ContextEntry {
  readonly sourceAction?: string;
  readonly targetKind?: V2ContextTargetKind;
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

interface StoredV2Context extends V2ContextEntry {
  readonly token: string;
  readonly weight: number;
}

function requireToken(value: string): string {
  if (!/^ctx_[A-Za-z0-9_-]{16,}$/u.test(value)) {
    throw new BridgeProtocolError("contextId must be a valid v2 context handle");
  }
  return value;
}

export class V2ContextStore {
  private readonly entries = new Map<string, StoredV2Context>();
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

  public issue(entry: V2ContextEntry): string {
    let token: string;
    do {
      token = `ctx_${randomBytes(16).toString("base64url")}`;
    } while (this.entries.has(token));

    const weight =
      1 +
      entry.noteFingerprints.size +
      entry.pitchControlFingerprints.size +
      entry.automationFingerprints.size;
    this.entries.set(token, { ...entry, token, weight });
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

  public resolve(token: string): V2ContextEntry {
    const normalized = requireToken(token);
    const entry = this.entries.get(normalized);
    if (entry === undefined) {
      throw new BridgeError(
        "The v2 context is unknown or expired; read the target again.",
        "UNKNOWN_CONTEXT",
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
