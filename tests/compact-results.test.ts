import assert from "node:assert/strict";
import test from "node:test";

import {
  compactAutomationGuard,
  compactPhonemeGuards,
  compactPhraseContextGuards,
  compactTransactionGuards,
  resolveAutomationGuardPayload,
  resolvePhraseCursorPayload,
  resolvePhonemeGuardPayload,
  resolveTransactionGuardPayload,
} from "../src/compact-results.js";
import { BridgeError } from "../src/errors.js";
import { GuardTokenStore } from "../src/guard-token-store.js";

const GROUP_UUID = "8ab8ba75-f776-402b-a8bb-ee1f64bcf95e";

function noteFingerprint(noteIndex: number): string {
  return [
    GROUP_UUID,
    noteIndex,
    noteIndex * 705_600_000,
    352_800_000,
    60 + (noteIndex % 12),
    0,
    "3:词",
    "0:",
    "0:",
    "4:sing",
    "true",
    "0:",
    1,
    '151:{"evenSyllableDuration":true,"languageOverride":"","muted":false,"phonemes":[],"phonesetOverride":""}',
  ].join("|");
}

test("GuardTokenStore reuses bindings and rejects a different scope", () => {
  const store = new GuardTokenStore();
  const binding = {
    kind: "note" as const,
    trackIndex: 1,
    groupUuid: GROUP_UUID,
    noteIndex: 7,
  };
  const token = store.issue(noteFingerprint(7), binding);
  assert.equal(store.issue(noteFingerprint(7), binding), token);
  assert.match(token, /^ng_[A-Za-z0-9_-]{22}$/);
  assert.equal(
    store.resolve(token, {
      kind: "note",
      trackIndex: 1,
      groupUuid: GROUP_UUID,
      noteIndex: 7,
    }).fingerprint,
    noteFingerprint(7),
  );
  assert.throws(
    () =>
      store.resolve(token, {
        kind: "note",
        trackIndex: 1,
        groupUuid: GROUP_UUID,
        noteIndex: 8,
      }),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "GUARD_TOKEN_SCOPE_MISMATCH",
  );
});

test("compact phoneme Guards keep a 21-note tuning context below 4 KB", () => {
  const store = new GuardTokenStore();
  const raw = {
    trackIndex: 1,
    groupIndex: 2,
    groupUuid: GROUP_UUID,
    matchedNoteCount: 21,
    returnedNoteCount: 21,
    responseMode: "compact",
    notes: Array.from({ length: 21 }, (_, index) => ({
      noteIndex: index + 1,
      fingerprint: noteFingerprint(index + 1),
      lyrics: "词",
      computedPhonemes: "ts`h i N",
      absoluteOnsetSeconds: 182 + index * 0.45,
      absoluteDurationSeconds: 0.3,
      selected: false,
    })),
  };
  const compact = compactPhonemeGuards(raw, store) as {
    notes: Array<Record<string, unknown>>;
  };
  const serialized = JSON.stringify(compact);
  assert.ok(serialized.length < 4_000, `compact result was ${serialized.length} chars`);
  assert.doesNotMatch(serialized, /fingerprint/);
  assert.equal(compact.notes.length, 21);
  assert.match(String(compact.notes[0]?.guardToken), /^ng_/);

  const first = compact.notes[0];
  assert.ok(first);
  const payload = resolvePhonemeGuardPayload(
    {
      trackIndex: 1,
      groupIndex: 2,
      responseMode: "compact",
      edits: [
        {
          noteIndex: 1,
          guardToken: first.guardToken,
          changes: { phonemeAttributes: [{ strength: 0.8 }] },
        },
      ],
    },
    store,
  );
  assert.equal(payload.groupUuid, GROUP_UUID);
  const edits = payload.edits as Array<Record<string, unknown>>;
  assert.equal(edits[0]?.fingerprint, noteFingerprint(1));
  assert.equal(edits[0]?.guardToken, undefined);
});

test("P2 compacts one write-ready phrase context below 8 KB", () => {
  const store = new GuardTokenStore();
  const automationFingerprints = [
    "loudness",
    "tension",
    "breathiness",
  ].map(
    (parameter) =>
      `${GROUP_UUID}|${parameter}|Linear|${"[[0,0],".repeat(400)}[]`,
  );
  const raw = {
    trackIndex: 1,
    groupIndex: 2,
    groupUuid: GROUP_UUID,
    matchedNoteCount: 21,
    returnedNoteCount: 21,
    responseMode: "compact",
    scope: { source: "seconds_range" },
    voice: {
      referenceFingerprint: `${GROUP_UUID}|voice|Soft=25`,
      parameters: { loudness: -3, tension: 0.2, breathiness: -0.1 },
      vocalModes: {
        Soft: { pitch: 25, timbre: 20, pronunciation: 5 },
        Powerful: { pitch: 10, timbre: 20, pronunciation: 0 },
      },
    },
    analysis: {
      noteCount: 21,
      durationSeconds: 9.3,
      pitchRangeSemitones: 12,
      sustainedNoteCount: 2,
    },
    recommendations: [
      {
        kind: "pitch_transition",
        priority: "medium",
        noteIndices: [8, 9],
        intervalSemitones: 7,
      },
    ],
    notes: Array.from({ length: 21 }, (_, index) => ({
      noteIndex: index + 1,
      fingerprint: noteFingerprint(index + 1),
      lyrics: "词",
      computedPhonemes: "ts`h i N",
      onset: index * 352_800_000,
      duration: 282_240_000,
      absoluteOnsetSeconds: 182 + index * 0.45,
      absoluteDurationSeconds: 0.3,
      absolutePitch: 60 + (index % 8),
      selected: false,
    })),
    automation: automationFingerprints.map((fingerprint, index) => ({
      parameter: ["loudness", "tension", "breathiness"][index],
      fingerprint,
      pointCountInRange: 4,
      samples: { start: 0, middle: 0.2, ending: 0 },
      minimum: 0,
      maximum: 0.2,
      range: 0.2,
    })),
  };
  const rawLength = JSON.stringify(raw).length;
  const compact = compactPhraseContextGuards(raw, store) as {
    notes: Array<Record<string, unknown>>;
    automation: Array<Record<string, unknown>>;
  };
  const serialized = JSON.stringify(compact);
  assert.ok(
    serialized.length < 8_000,
    `compact phrase context was ${serialized.length} chars`,
  );
  assert.ok(
    serialized.length < rawLength * 0.4,
    `compact phrase context retained too much guard data (${serialized.length}/${rawLength})`,
  );
  assert.doesNotMatch(serialized, /fingerprint/u);
  assert.match(String(compact.notes[0]?.guardToken), /^ng_/u);
  assert.match(String(compact.automation[0]?.guardToken), /^ag_/u);

  const payload = resolveAutomationGuardPayload(
    {
      trackIndex: 1,
      groupIndex: 2,
      parameter: "loudness",
      expectedGuardToken: compact.automation[0]?.guardToken,
      points: [{ position: 1, value: 0.1 }],
    },
    store,
  );
  assert.equal(payload.groupUuid, GROUP_UUID);
  assert.equal(payload.expectedFingerprint, automationFingerprints[0]);
});

test("P3 range cursors are opaque, locator-bound, and fingerprint-guarded", () => {
  const store = new GuardTokenStore();
  const raw = {
    trackIndex: 1,
    groupIndex: 2,
    groupUuid: GROUP_UUID,
    responseMode: "compact",
    hasMore: true,
    notes: [
      {
        noteIndex: 7,
        fingerprint: noteFingerprint(7),
        lyrics: "词",
      },
    ],
    automation: [],
    page: {
      firstNoteIndex: 7,
      lastNoteIndex: 7,
      nextNoteIndex: 8,
    },
    pageCursor: {
      anchorNoteIndex: 7,
      nextNoteIndex: 8,
      fingerprint: noteFingerprint(7),
    },
  };
  const compact = compactPhraseContextGuards(raw, store) as {
    page: Record<string, unknown>;
  };
  assert.match(String(compact.page.cursorToken), /^rc_/u);
  assert.doesNotMatch(JSON.stringify(compact), /fingerprint/u);

  const resolved = resolvePhraseCursorPayload(
    {
      cursorToken: compact.page.cursorToken,
      offset: 0,
      limit: 16,
    },
    store,
  );
  assert.equal(resolved.trackIndex, 1);
  assert.equal(resolved.groupIndex, 2);
  assert.equal(resolved.groupUuid, GROUP_UUID);
  assert.equal(resolved.preferSelectedNotes, false);
  assert.deepEqual(resolved.pageCursor, {
    anchorNoteIndex: 7,
    nextNoteIndex: 8,
    fingerprint: noteFingerprint(7),
  });

  assert.throws(
    () =>
      resolvePhraseCursorPayload(
        {
          cursorToken: compact.page.cursorToken,
          startSeconds: 10,
        },
        store,
      ),
    /cannot be combined with cursorToken/u,
  );
});

test("compact automation Guards round-trip without exposing the curve fingerprint", () => {
  const store = new GuardTokenStore();
  const fingerprint = `${GROUP_UUID}|loudness|cubic|${"[]".repeat(1_000)}`;
  const compact = compactAutomationGuard(
    {
      trackIndex: 1,
      groupIndex: 2,
      groupUuid: GROUP_UUID,
      parameter: "loudness",
      fingerprint,
      pointCount: 54,
      points: [{ position: 0, value: 0 }],
    },
    store,
  ) as Record<string, unknown>;
  assert.equal(compact.fingerprint, undefined);
  assert.match(String(compact.guardToken), /^ag_/);

  const payload = resolveAutomationGuardPayload(
    {
      trackIndex: 1,
      groupIndex: 2,
      parameter: "loudness",
      expectedGuardToken: compact.guardToken,
      points: [{ position: 1, value: 0.1 }],
      responseMode: "compact",
    },
    store,
  );
  assert.equal(payload.groupUuid, GROUP_UUID);
  assert.equal(payload.expectedFingerprint, fingerprint);
  assert.equal(payload.expectedGuardToken, undefined);
});

test("transactions resolve input Guards and compact each guarded step result", () => {
  const store = new GuardTokenStore();
  const compactNote = compactPhonemeGuards(
    {
      trackIndex: 1,
      groupIndex: 2,
      groupUuid: GROUP_UUID,
      responseMode: "compact",
      notes: [
        {
          noteIndex: 3,
          fingerprint: noteFingerprint(3),
          lyrics: "词",
        },
      ],
    },
    store,
  ) as { notes: Array<Record<string, unknown>> };
  const curveFingerprint = `${GROUP_UUID}|tension|linear|[[0,0]]`;
  const compactCurve = compactAutomationGuard(
    {
      trackIndex: 1,
      groupIndex: 2,
      groupUuid: GROUP_UUID,
      parameter: "tension",
      fingerprint: curveFingerprint,
      points: [{ position: 0, value: 0 }],
    },
    store,
  ) as Record<string, unknown>;
  const request = resolveTransactionGuardPayload(
    {
      summary: "Compact guarded transaction",
      steps: [
        {
          action: "set_note_phoneme_properties",
          payload: {
            trackIndex: 1,
            groupIndex: 2,
            responseMode: "compact",
            edits: [
              {
                noteIndex: 3,
                guardToken: compactNote.notes[0]?.guardToken,
                changes: { evenSyllableDuration: true },
              },
            ],
          },
        },
        {
          action: "set_automation_points",
          payload: {
            trackIndex: 1,
            groupIndex: 2,
            parameter: "tension",
            expectedGuardToken: compactCurve.guardToken,
            responseMode: "compact",
            points: [{ position: 1, value: 0.2 }],
          },
        },
      ],
    },
    store,
  );
  const steps = request.steps as Array<{
    action: string;
    payload: Record<string, unknown>;
  }>;
  assert.equal(steps[0]?.payload.groupUuid, GROUP_UUID);
  assert.equal(
    (steps[0]?.payload.edits as Array<Record<string, unknown>>)[0]
      ?.fingerprint,
    noteFingerprint(3),
  );
  assert.equal(steps[1]?.payload.expectedFingerprint, curveFingerprint);

  const compactResult = compactTransactionGuards(
    request,
    {
      transactionId: "tx-1",
      results: [
        {
          trackIndex: 1,
          groupIndex: 2,
          groupUuid: GROUP_UUID,
          responseMode: "compact",
          notes: [{ noteIndex: 3, fingerprint: "updated-note" }],
        },
        {
          trackIndex: 1,
          groupIndex: 2,
          groupUuid: GROUP_UUID,
          parameter: "tension",
          responseMode: "compact",
          fingerprint: "updated-curve",
          pointCount: 2,
        },
      ],
    },
    store,
  ) as { results: Array<Record<string, unknown>> };
  const serialized = JSON.stringify(compactResult);
  assert.doesNotMatch(serialized, /fingerprint/u);
  const noteResult = compactResult.results[0] as {
    notes: Array<Record<string, unknown>>;
  };
  assert.match(String(noteResult.notes[0]?.guardToken), /^ng_/u);
  assert.match(String(compactResult.results[1]?.guardToken), /^ag_/u);
});
