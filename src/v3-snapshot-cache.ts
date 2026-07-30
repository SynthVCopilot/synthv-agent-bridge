export interface SnapshotIdentity {
  readonly sessionToken: string;
  readonly targetKind: string;
  readonly locator: string;
  readonly projection: string;
  readonly dependencyDigest: string;
}

export interface SnapshotHit<T> {
  readonly value: T;
  readonly freshness: "sessionCached";
  readonly ageMs: number;
}

interface SnapshotEntry<T> {
  readonly key: string;
  readonly identity: SnapshotIdentity;
  readonly value: T;
  readonly storedAtMs: number;
  readonly weight: number;
}

function snapshotKey(identity: SnapshotIdentity): string {
  return [
    identity.sessionToken,
    identity.targetKind,
    identity.locator,
    identity.projection,
    identity.dependencyDigest,
  ].join("\u0000");
}

function estimatedWeight(value: unknown): number {
  return JSON.stringify(value).length;
}

export class V3SnapshotCache {
  private readonly entries = new Map<string, SnapshotEntry<unknown>>();
  private totalWeight = 0;

  public constructor(
    private readonly maximumEntries = 128,
    private readonly maximumWeight = 4 * 1024 * 1024,
    private readonly maximumAgeMs = 30_000,
  ) {
    if (
      !Number.isInteger(maximumEntries) ||
      maximumEntries < 1 ||
      !Number.isInteger(maximumWeight) ||
      maximumWeight < 1 ||
      !Number.isInteger(maximumAgeMs) ||
      maximumAgeMs < 1
    ) {
      throw new Error("Snapshot cache limits must be positive integers");
    }
  }

  public set<T>(
    identity: SnapshotIdentity,
    value: T,
    nowMs = Date.now(),
  ): void {
    const key = snapshotKey(identity);
    const copy = structuredClone(value);
    const weight = estimatedWeight(copy);
    const prior = this.entries.get(key);
    if (prior !== undefined) {
      this.totalWeight -= prior.weight;
      this.entries.delete(key);
    }
    this.entries.set(key, {
      key,
      identity,
      value: copy,
      storedAtMs: nowMs,
      weight,
    });
    this.totalWeight += weight;
    this.evict(nowMs);
  }

  public get<T>(
    identity: SnapshotIdentity,
    nowMs = Date.now(),
  ): SnapshotHit<T> | undefined {
    const key = snapshotKey(identity);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const ageMs = Math.max(0, nowMs - entry.storedAtMs);
    if (ageMs > this.maximumAgeMs) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {
      value: structuredClone(entry.value) as T,
      freshness: "sessionCached",
      ageMs,
    };
  }

  public invalidateTarget(
    sessionToken: string,
    targetKind: string,
    locator: string,
  ): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (
        entry.identity.sessionToken === sessionToken &&
        entry.identity.targetKind === targetKind &&
        entry.identity.locator === locator
      ) {
        this.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  public invalidateSession(sessionToken?: string): number {
    if (sessionToken === undefined) {
      const removed = this.entries.size;
      this.clear();
      return removed;
    }
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.identity.sessionToken === sessionToken) {
        this.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  public clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  public stats(): {
    readonly entries: number;
    readonly estimatedWeight: number;
  } {
    return {
      entries: this.entries.size,
      estimatedWeight: this.totalWeight,
    };
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }

  private evict(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.storedAtMs > this.maximumAgeMs) {
        this.delete(key);
      }
    }
    while (
      this.entries.size > this.maximumEntries ||
      this.totalWeight > this.maximumWeight
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.delete(oldest);
    }
  }
}
