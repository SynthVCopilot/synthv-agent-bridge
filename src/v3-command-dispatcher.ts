import { BridgeError, BridgeProtocolError } from "./errors.js";
import { traceStage } from "./v3-command-kernel.js";

export type V3ExpectedEffect =
  | "allowAlreadySatisfied"
  | "mustChange";

export interface V3CommandDispatchResult
  extends Readonly<Record<string, unknown>> {
  readonly outcome: "changed" | "alreadySatisfied";
  readonly traceId: string;
  readonly action: string;
  readonly changedCount: number;
  readonly undoRecords: number;
  readonly verified: boolean;
}

export interface V3CommandDispatchRequest {
  readonly action: string;
  readonly expectedEffect: V3ExpectedEffect;
  readonly invoke: () => Promise<V3CommandDispatchResult>;
  readonly invalidate?: (
    result: V3CommandDispatchResult,
  ) => void | Promise<void>;
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BridgeProtocolError(
      `The internal command result has an invalid ${field}`,
      { field },
    );
  }
}

function validateCommandResult(
  action: string,
  result: V3CommandDispatchResult,
): void {
  if (result.action !== action) {
    throw new BridgeProtocolError(
      "The internal command result action does not match the request",
      {
        expectedAction: action,
        actualAction: result.action,
      },
    );
  }
  if (
    result.outcome !== "changed" &&
    result.outcome !== "alreadySatisfied"
  ) {
    throw new BridgeProtocolError(
      "The internal command result has an invalid outcome",
    );
  }
  assertNonNegativeInteger(result.changedCount, "changedCount");
  assertNonNegativeInteger(result.undoRecords, "undoRecords");
  if (result.verified !== true) {
    throw new BridgeProtocolError(
      "The internal command result was not verified",
    );
  }
  if (result.outcome === "alreadySatisfied") {
    if (result.changedCount !== 0 || result.undoRecords !== 0) {
      throw new BridgeProtocolError(
        "An already-satisfied command must have zero changes and zero Undo records",
      );
    }
    return;
  }
  if (result.changedCount < 1 || result.undoRecords !== 1) {
    throw new BridgeProtocolError(
      "A changed command must report a positive effect and one Undo record",
    );
  }
}

export async function dispatchV3Command(
  request: V3CommandDispatchRequest,
): Promise<V3CommandDispatchResult> {
  traceStage("contextResolved", { action: request.action });
  const result = await request.invoke();
  validateCommandResult(request.action, result);
  traceStage("verified", {
    action: request.action,
    outcome: result.outcome,
  });

  if (
    request.expectedEffect === "mustChange" &&
    result.outcome === "alreadySatisfied"
  ) {
    throw new BridgeError(
      "The command was expected to change SynthV state but the target was already satisfied.",
      "HOST_POSTCONDITION_FAILED",
      {
        action: request.action,
        partialWritePossible: false,
        undoRequired: false,
      },
    );
  }

  if (result.outcome === "changed") {
    await request.invalidate?.(result);
    traceStage("cacheInvalidated", {
      action: request.action,
      cache: request.invalidate === undefined ? "none" : "invalidated",
    });
  }
  return result;
}
