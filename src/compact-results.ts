import { BridgeProtocolError } from "./errors.js";
import {
  GuardTokenStore,
  type GuardBinding,
  type GuardExpectation,
} from "./guard-token-store.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function requireInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value)) {
    throw new BridgeProtocolError(`${path} must be an integer`);
  }
  return value as number;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeProtocolError(`${path} must be a non-empty string`);
  }
  return value;
}

function addGuardToken(
  value: JsonRecord,
  store: GuardTokenStore,
  binding: GuardBinding,
): JsonRecord {
  const fingerprint = requireString(value.fingerprint, "result.fingerprint");
  const { fingerprint: _fingerprint, ...rest } = value;
  return {
    ...rest,
    guardToken: store.issue(fingerprint, binding),
  };
}

export function compactPhonemeGuards(
  result: unknown,
  store: GuardTokenStore,
): unknown {
  const root = asRecord(result, "result");
  const trackIndex = requireInteger(root.trackIndex, "result.trackIndex");
  const groupUuid = requireString(root.groupUuid, "result.groupUuid");
  if (!Array.isArray(root.notes)) {
    throw new BridgeProtocolError("result.notes must be an array");
  }
  return {
    ...root,
    notes: root.notes.map((value, index) => {
      const note = asRecord(value, `result.notes[${index}]`);
      const noteIndex = requireInteger(
        note.noteIndex,
        `result.notes[${index}].noteIndex`,
      );
      return addGuardToken(note, store, {
        kind: "note",
        trackIndex,
        groupUuid,
        noteIndex,
      });
    }),
  };
}

export function compactPhraseContextGuards(
  result: unknown,
  store: GuardTokenStore,
): unknown {
  const compactNotes = asRecord(
    compactPhonemeGuards(result, store),
    "result",
  );
  const trackIndex = requireInteger(
    compactNotes.trackIndex,
    "result.trackIndex",
  );
  const groupUuid = requireString(
    compactNotes.groupUuid,
    "result.groupUuid",
  );
  if (!Array.isArray(compactNotes.automation)) {
    throw new BridgeProtocolError("result.automation must be an array");
  }
  return {
    ...compactNotes,
    automation: compactNotes.automation.map((value, index) => {
      const summary = asRecord(
        value,
        `result.automation[${index}]`,
      );
      const parameter = requireString(
        summary.parameter,
        `result.automation[${index}].parameter`,
      );
      return addGuardToken(summary, store, {
        kind: "automation",
        trackIndex,
        groupUuid,
        parameter,
      });
    }),
  };
}

export function compactAutomationGuard(
  result: unknown,
  store: GuardTokenStore,
): unknown {
  const root = asRecord(result, "result");
  return addGuardToken(root, store, {
    kind: "automation",
    trackIndex: requireInteger(root.trackIndex, "result.trackIndex"),
    groupUuid: requireString(root.groupUuid, "result.groupUuid"),
    parameter: requireString(root.parameter, "result.parameter"),
  });
}

function optionalGroupUuid(value: unknown): string | undefined {
  return value === undefined ? undefined : requireString(value, "groupUuid");
}

function reconcileFingerprint(
  record: JsonRecord,
  tokenField: string,
  fingerprintField: string,
  store: GuardTokenStore,
  expectation: GuardExpectation,
): { readonly record: JsonRecord; readonly groupUuid?: string } {
  const tokenValue = record[tokenField];
  if (tokenValue === undefined) {
    return { record };
  }
  const token = requireString(tokenValue, tokenField);
  const resolution = store.resolve(token, expectation);
  const suppliedFingerprint = record[fingerprintField];
  if (
    suppliedFingerprint !== undefined &&
    suppliedFingerprint !== resolution.fingerprint
  ) {
    throw new BridgeProtocolError(
      `${fingerprintField} does not match ${tokenField}`,
    );
  }
  const next = { ...record, [fingerprintField]: resolution.fingerprint };
  delete next[tokenField];
  return { record: next, groupUuid: resolution.binding.groupUuid };
}

export function resolvePhonemeGuardPayload(
  input: unknown,
  store: GuardTokenStore,
): JsonRecord {
  const root = asRecord(input, "input");
  const trackIndex = requireInteger(root.trackIndex, "trackIndex");
  const requestedGroupUuid = optionalGroupUuid(root.groupUuid);
  if (!Array.isArray(root.edits)) {
    throw new BridgeProtocolError("edits must be an array");
  }
  let inferredGroupUuid: string | undefined;
  const edits = root.edits.map((value, index) => {
    const edit = asRecord(value, `edits[${index}]`);
    const noteIndex = requireInteger(
      edit.noteIndex,
      `edits[${index}].noteIndex`,
    );
    const resolved = reconcileFingerprint(
      edit,
      "guardToken",
      "fingerprint",
      store,
      {
        kind: "note",
        trackIndex,
        ...(requestedGroupUuid === undefined
          ? {}
          : { groupUuid: requestedGroupUuid }),
        noteIndex,
      },
    );
    if (
      resolved.groupUuid !== undefined &&
      inferredGroupUuid !== undefined &&
      resolved.groupUuid !== inferredGroupUuid
    ) {
      throw new BridgeProtocolError(
        "All note Guard Tokens must belong to the same Group",
      );
    }
    inferredGroupUuid = resolved.groupUuid ?? inferredGroupUuid;
    return resolved.record;
  });
  return {
    ...root,
    ...(requestedGroupUuid === undefined && inferredGroupUuid !== undefined
      ? { groupUuid: inferredGroupUuid }
      : {}),
    edits,
  };
}

export function resolveAutomationGuardPayload(
  input: unknown,
  store: GuardTokenStore,
): JsonRecord {
  const root = asRecord(input, "input");
  const trackIndex = requireInteger(root.trackIndex, "trackIndex");
  const requestedGroupUuid = optionalGroupUuid(root.groupUuid);
  const parameter = requireString(root.parameter, "parameter");
  const resolved = reconcileFingerprint(
    root,
    "expectedGuardToken",
    "expectedFingerprint",
    store,
    {
      kind: "automation",
      trackIndex,
      ...(requestedGroupUuid === undefined
        ? {}
        : { groupUuid: requestedGroupUuid }),
      parameter,
    },
  );
  return {
    ...resolved.record,
    ...(requestedGroupUuid === undefined && resolved.groupUuid !== undefined
      ? { groupUuid: resolved.groupUuid }
      : {}),
  };
}

export function resolveGuardedActionPayload(
  action: string,
  input: unknown,
  store: GuardTokenStore,
): JsonRecord {
  const root = asRecord(input, "payload");
  if (action === "set_note_phoneme_properties") {
    const hasGuardToken =
      Array.isArray(root.edits) &&
      root.edits.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          "guardToken" in value,
      );
    return hasGuardToken ? resolvePhonemeGuardPayload(root, store) : root;
  }
  if (
    action === "set_automation_points" &&
    root.expectedGuardToken !== undefined
  ) {
    return resolveAutomationGuardPayload(root, store);
  }
  return root;
}

function resolveTransactionSteps(
  value: unknown,
  path: string,
  store: GuardTokenStore,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new BridgeProtocolError(`${path} must be an array`);
  }
  return value.map((stepValue, index) => {
    const step = asRecord(stepValue, `${path}[${index}]`);
    const action = requireString(step.action, `${path}[${index}].action`);
    return {
      ...step,
      payload: resolveGuardedActionPayload(action, step.payload, store),
    };
  });
}

export function resolveTransactionGuardPayload(
  input: unknown,
  store: GuardTokenStore,
): JsonRecord {
  const root = asRecord(input, "input");
  return {
    ...root,
    steps: resolveTransactionSteps(root.steps, "steps", store),
    ...(root.rollbackSteps === undefined
      ? {}
      : {
          rollbackSteps: resolveTransactionSteps(
            root.rollbackSteps,
            "rollbackSteps",
            store,
          ),
        }),
  };
}

function compactGuardedActionResult(
  action: string,
  payload: JsonRecord,
  result: unknown,
  store: GuardTokenStore,
): unknown {
  if (payload.responseMode !== "compact") {
    return result;
  }
  if (action === "set_note_phoneme_properties") {
    return compactPhonemeGuards(result, store);
  }
  if (action === "set_automation_points") {
    return compactAutomationGuard(result, store);
  }
  return result;
}

export function compactTransactionGuards(
  input: unknown,
  result: unknown,
  store: GuardTokenStore,
): unknown {
  const request = asRecord(input, "input");
  const output = asRecord(result, "result");
  const steps = request.steps;
  const results = output.results;
  if (!Array.isArray(steps)) {
    throw new BridgeProtocolError("input.steps must be an array");
  }
  if (!Array.isArray(results)) {
    throw new BridgeProtocolError("result.results must be an array");
  }
  if (steps.length !== results.length) {
    throw new BridgeProtocolError(
      "result.results must match the transaction step count",
    );
  }
  return {
    ...output,
    results: results.map((stepResult, index) => {
      const step = asRecord(steps[index], `input.steps[${index}]`);
      const action = requireString(
        step.action,
        `input.steps[${index}].action`,
      );
      const payload = asRecord(
        step.payload,
        `input.steps[${index}].payload`,
      );
      return compactGuardedActionResult(
        action,
        payload,
        stepResult,
        store,
      );
    }),
  };
}
