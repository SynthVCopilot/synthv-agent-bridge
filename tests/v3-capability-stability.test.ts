import assert from "node:assert/strict";
import test from "node:test";

import {
  assertV3CapabilityEnabled,
  describeV3CapabilityStability,
} from "../src/v3-capability-stability.js";

test("isolated Group-reference clone is discoverable but fails closed", () => {
  assert.doesNotThrow(() =>
    assertV3CapabilityEnabled("clone_group_reference", {
      cloneIntent: "linked",
    }),
  );
  assert.throws(
    () =>
      assertV3CapabilityEnabled("clone_group_reference", {
        cloneIntent: "isolated",
      }),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "EXPERIMENTAL_CAPABILITY_DISABLED",
      );
      return true;
    },
  );
  assert.deepEqual(describeV3CapabilityStability("clone_group_reference"), {
    availability: "partiallyAvailable",
    classification: "experimental",
    disabledIntents: ["isolated"],
    reason:
      "isolated Group-reference clone is disabled after a reproducible SynthV 2.2.1 native crash during Undo; linked clone remains available.",
  });
});

test("transaction actions are discoverable but fail closed", () => {
  for (const action of ["apply_transaction", "rollback_transaction"]) {
    assert.throws(
      () => assertV3CapabilityEnabled(action, {}),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "EXPERIMENTAL_CAPABILITY_DISABLED",
        );
        return true;
      },
    );
    assert.equal(
      describeV3CapabilityStability(action)?.availability,
      "experimentalDisabled",
    );
  }
});

test("host clone actions that depend on unstable SynthV clone primitives fail closed", () => {
  for (const [action, args] of [
    ["clone_note_group", {}],
    ["clone_track", { cloneIntent: "isolated" }],
    ["clone_track_shell", { cloneIntent: "shell" }],
    ["create_harmony_track", { sourceTrackIndex: 1, intervalSemitones: 3 }],
  ] as const) {
    assert.throws(
      () => assertV3CapabilityEnabled(action, args),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "EXPERIMENTAL_CAPABILITY_DISABLED",
        );
        return true;
      },
    );
    assert.equal(
      describeV3CapabilityStability(action)?.availability,
      "experimentalDisabled",
    );
  }
});
