import { BridgeError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

export interface V3CapabilityStability {
  readonly availability: "partiallyAvailable" | "experimentalDisabled";
  readonly classification: "experimental";
  readonly disabledIntents?: readonly string[];
  readonly reason: string;
}

const ISOLATED_GROUP_CLONE_REASON =
  "isolated Group-reference clone is disabled after a reproducible SynthV 2.2.1 native crash during Undo; linked clone remains available.";
const TRANSACTION_REASON =
  "transactions are disabled because the recorded SynthV 2.2.1 native-crash risk has not passed the required repetition matrix.";
const HOST_CLONE_REASON =
  "host clone actions and their harmony wrapper are disabled after reproducible SynthV 2.2.1 native crashes during isolated Group Undo and Track shell creation.";

const ACTION_STABILITY = new Map<string, V3CapabilityStability>([
  [
    "clone_group_reference",
    {
      availability: "partiallyAvailable",
      classification: "experimental",
      disabledIntents: ["isolated"],
      reason: ISOLATED_GROUP_CLONE_REASON,
    },
  ],
  [
    "apply_transaction",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: TRANSACTION_REASON,
    },
  ],
  [
    "clone_note_group",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: HOST_CLONE_REASON,
    },
  ],
  [
    "clone_track",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: HOST_CLONE_REASON,
    },
  ],
  [
    "clone_track_shell",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: HOST_CLONE_REASON,
    },
  ],
  [
    "create_harmony_track",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: HOST_CLONE_REASON,
    },
  ],
  [
    "rollback_transaction",
    {
      availability: "experimentalDisabled",
      classification: "experimental",
      reason: TRANSACTION_REASON,
    },
  ],
]);

export function describeV3CapabilityStability(
  action: string,
): V3CapabilityStability | undefined {
  return ACTION_STABILITY.get(action);
}

export function assertV3CapabilityEnabled(
  action: string,
  args: JsonRecord,
): void {
  const stability = ACTION_STABILITY.get(action);
  if (stability === undefined) {
    return;
  }
  const disabledIntent =
    Array.isArray(stability.disabledIntents) &&
    typeof args.cloneIntent === "string" &&
    stability.disabledIntents.includes(args.cloneIntent);
  if (
    stability.availability !== "experimentalDisabled" &&
    !disabledIntent
  ) {
    return;
  }
  throw new BridgeError(
    stability.reason,
    "EXPERIMENTAL_CAPABILITY_DISABLED",
    {
      action,
      classification: stability.classification,
      ...(disabledIntent ? { cloneIntent: args.cloneIntent } : {}),
      undoRequired: false,
    },
  );
}
