import { randomBytes } from "node:crypto";

import { BridgeError } from "./errors.js";

export type GuardBinding =
  | {
      readonly kind: "note";
      readonly trackIndex: number;
      readonly groupUuid: string;
      readonly noteIndex: number;
    }
  | {
      readonly kind: "automation";
      readonly trackIndex: number;
      readonly groupUuid: string;
      readonly parameter: string;
    }
  | {
      readonly kind: "range_cursor";
      readonly trackIndex: number;
      readonly groupIndex: number;
      readonly groupUuid: string;
      readonly anchorNoteIndex: number;
      readonly nextNoteIndex: number;
    };

export type GuardExpectation =
  | {
      readonly kind: "note";
      readonly trackIndex: number;
      readonly groupUuid?: string;
      readonly noteIndex: number;
    }
  | {
      readonly kind: "automation";
      readonly trackIndex: number;
      readonly groupUuid?: string;
      readonly parameter: string;
    }
  | {
      readonly kind: "range_cursor";
    };

export interface GuardTokenResolution {
  readonly fingerprint: string;
  readonly binding: GuardBinding;
}

interface GuardTokenEntry extends GuardTokenResolution {
  readonly token: string;
  readonly reverseKey: string;
}

function bindingKey(binding: GuardBinding): string {
  if (binding.kind === "note") {
    return [
      binding.kind,
      binding.trackIndex,
      binding.groupUuid,
      binding.noteIndex,
    ].join(":");
  }
  if (binding.kind === "range_cursor") {
    return [
      binding.kind,
      binding.trackIndex,
      binding.groupIndex,
      binding.groupUuid,
      binding.anchorNoteIndex,
      binding.nextNoteIndex,
    ].join(":");
  }
  return [
    binding.kind,
    binding.trackIndex,
    binding.groupUuid,
    binding.parameter,
  ].join(":");
}

function expectationMatches(
  binding: GuardBinding,
  expectation: GuardExpectation,
): boolean {
  if (
    binding.kind !== expectation.kind
  ) {
    return false;
  }
  if (
    binding.kind === "range_cursor" &&
    expectation.kind === "range_cursor"
  ) {
    return true;
  }
  if (
    expectation.kind === "range_cursor" ||
    binding.trackIndex !== expectation.trackIndex ||
    (expectation.groupUuid !== undefined &&
      binding.groupUuid !== expectation.groupUuid)
  ) {
    return false;
  }
  if (binding.kind === "note" && expectation.kind === "note") {
    return binding.noteIndex === expectation.noteIndex;
  }
  if (binding.kind === "automation" && expectation.kind === "automation") {
    return binding.parameter === expectation.parameter;
  }
  return false;
}

export class GuardTokenStore {
  private readonly entries = new Map<string, GuardTokenEntry>();
  private readonly reverse = new Map<string, string>();

  public constructor(private readonly maximumEntries = 20_000) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("maximumEntries must be a positive integer");
    }
  }

  public issue(fingerprint: string, binding: GuardBinding): string {
    if (fingerprint.length === 0) {
      throw new Error("Cannot issue a Guard Token for an empty fingerprint");
    }
    const reverseKey = `${bindingKey(binding)}\0${fingerprint}`;
    const existingToken = this.reverse.get(reverseKey);
    if (existingToken !== undefined) {
      const existingEntry = this.entries.get(existingToken);
      if (existingEntry !== undefined) {
        this.entries.delete(existingToken);
        this.entries.set(existingToken, existingEntry);
        return existingToken;
      }
      this.reverse.delete(reverseKey);
    }

    const prefix =
      binding.kind === "note"
        ? "ng_"
        : binding.kind === "automation"
          ? "ag_"
          : "rc_";
    let token: string;
    do {
      token = `${prefix}${randomBytes(16).toString("base64url")}`;
    } while (this.entries.has(token));

    const entry = { token, fingerprint, binding, reverseKey };
    this.entries.set(token, entry);
    this.reverse.set(reverseKey, token);
    this.evictIfNeeded();
    return token;
  }

  public resolve(
    token: string,
    expectation: GuardExpectation,
  ): GuardTokenResolution {
    const entry = this.entries.get(token);
    if (entry === undefined) {
      throw new BridgeError(
        "The Guard Token is unknown or expired; read the target again.",
        "UNKNOWN_GUARD_TOKEN",
        { guardToken: token },
      );
    }
    if (!expectationMatches(entry.binding, expectation)) {
      throw new BridgeError(
        "The Guard Token does not belong to the requested SynthV target.",
        "GUARD_TOKEN_SCOPE_MISMATCH",
        { guardToken: token, expectedKind: expectation.kind },
      );
    }
    this.entries.delete(token);
    this.entries.set(token, entry);
    return { fingerprint: entry.fingerprint, binding: entry.binding };
  }

  public consume(
    token: string,
    expectation: GuardExpectation,
  ): GuardTokenResolution {
    const resolution = this.resolve(token, expectation);
    const entry = this.entries.get(token);
    this.entries.delete(token);
    if (entry !== undefined) {
      this.reverse.delete(entry.reverseKey);
    }
    return resolution;
  }

  public clear(): void {
    this.entries.clear();
    this.reverse.clear();
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maximumEntries) {
      const oldestToken = this.entries.keys().next().value as string | undefined;
      if (oldestToken === undefined) {
        return;
      }
      const oldestEntry = this.entries.get(oldestToken);
      this.entries.delete(oldestToken);
      if (oldestEntry !== undefined) {
        this.reverse.delete(oldestEntry.reverseKey);
      }
    }
  }
}
