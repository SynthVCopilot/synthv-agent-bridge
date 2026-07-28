import assert from "node:assert/strict";
import test from "node:test";

import { GuardTokenStore } from "../src/guard-token-store.js";
import { V2ContextStore } from "../src/v2-context-store.js";
import { V2SessionTracker, v2Testing } from "../src/v2-surface.js";

const GROUP_UUID = "8ab8ba75-f776-402b-a8bb-ee1f64bcf95e";

test("v2 context expands one scope guard across a batch note edit", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    referenceFingerprint: "reference",
    noteFingerprints: new Map([
      [7, "note-7"],
      [8, "note-8"],
    ]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  const expanded = v2Testing.expandContext(
    "edit_notes",
    {
      edits: [
        { index: 7, changes: { pitch: 64 } },
        { noteIndex: 8, changes: { duration: 123 } },
      ],
    },
    contextId,
    contexts,
  );

  assert.equal(expanded.trackIndex, 2);
  assert.equal(expanded.groupIndex, 3);
  assert.equal(expanded.groupUuid, GROUP_UUID);
  assert.deepEqual(expanded.edits, [
    { noteIndex: 7, fingerprint: "note-7", changes: { pitch: 64 } },
    { noteIndex: 8, fingerprint: "note-8", changes: { duration: 123 } },
  ]);
});

test("v2 context refuses a note missing from the original read", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    trackIndex: 1,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map([[1, "note-1"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(
    () =>
      v2Testing.expandContext(
        "delete_notes",
        { notes: [{ index: 2 }] },
        contextId,
        contexts,
      ),
    /does not contain a guard/u,
  );
});

test("v2 context expands one same-Group tuning batch", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    referenceFingerprint: "reference",
    noteFingerprints: new Map([[7, "note-7"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map([
      ["loudness", "loudness-guard"],
      ["tension", "tension-guard"],
    ]),
  });

  const expanded = v2Testing.expandContext(
    "apply_group_tuning",
    {
      summary: "one pass",
      voice: { vocalModes: [{ name: "Soft", pitch: 20 }] },
      noteEdits: [
        {
          index: 7,
          phonemeChanges: {
            phonemeAttributes: [{ strength: 0.8 }],
          },
        },
      ],
      automations: [
        { parameter: "loudness", clearMode: "none", points: [] },
        { parameter: "tension", clearMode: "none", points: [] },
      ],
    },
    contextId,
    contexts,
  );

  assert.equal(expanded.trackIndex, 2);
  assert.equal(expanded.groupIndex, 3);
  assert.equal(expanded.groupUuid, GROUP_UUID);
  assert.equal(expanded.referenceFingerprint, "reference");
  assert.deepEqual(expanded.noteEdits, [
    {
      noteIndex: 7,
      fingerprint: "note-7",
      phonemeChanges: {
        phonemeAttributes: [{ strength: 0.8 }],
      },
    },
  ]);
  assert.deepEqual(expanded.automations, [
    {
      parameter: "loudness",
      expectedFingerprint: "loudness-guard",
      clearMode: "none",
      points: [],
    },
    {
      parameter: "tension",
      expectedFingerprint: "tension-guard",
      clearMode: "none",
      points: [],
    },
  ]);
});

test("v2 note insertion ensures an editable non-main group by default", () => {
  const contexts = new V2ContextStore();
  const automatic = v2Testing.expandContext(
    "add_notes",
    { trackIndex: 1, groupIndex: 1, notes: [] },
    undefined,
    contexts,
  );
  const explicitTarget = v2Testing.expandContext(
    "add_notes",
    {
      trackIndex: 1,
      groupIndex: 1,
      notes: [],
      grouping: "target",
    },
    undefined,
    contexts,
  );

  assert.equal(automatic.grouping, "ensureNonMain");
  assert.equal(explicitTarget.grouping, "target");
});

test("v2 Group Voice refresh defaults to a compact write-ready projection", () => {
  assert.deepEqual(v2Testing.defaultReadFields("get_group_voice"), [
    "trackIndex",
    "groupIndex",
    "parameters",
    "vocalModes",
  ]);
  assert.equal(v2Testing.defaultReadFields("get_project_info"), undefined);

  const projected = v2Testing.projectFields(
    {
      trackIndex: 1,
      groupIndex: 2,
      parameters: { tension: 0 },
      vocalModes: { Soft: { pitch: 10 } },
      rawVoice: { duplicated: true },
      experimentalUnison: { singers: 1 },
      phonemeCapabilities: { strengthRetained: true },
      contextId: "ctx_voice",
    },
    v2Testing.defaultReadFields("get_group_voice") ?? [],
  );

  assert.deepEqual(projected, {
    trackIndex: 1,
    groupIndex: 2,
    parameters: { tension: 0 },
    vocalModes: { Soft: { pitch: 10 } },
    contextId: "ctx_voice",
  });
  assert.ok(JSON.stringify(projected).length < 220);
});

test("v2 context store evicts by total guard weight", () => {
  const contexts = new V2ContextStore(10, 3);
  const first = contexts.issue({
    noteFingerprints: new Map([
      [1, "one"],
      [2, "two"],
    ]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });
  const second = contexts.issue({
    noteFingerprints: new Map([[3, "three"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(() => contexts.resolve(first), /unknown or expired/u);
  assert.equal(contexts.resolve(second).noteFingerprints.get(3), "three");
});

test("session changes clear context and Guard Token stores", () => {
  const tracker = new V2SessionTracker();
  assert.equal(tracker.observe(undefined), undefined);
  assert.equal(tracker.observe("session-a"), undefined);
  assert.equal(tracker.observe("session-a"), undefined);
  assert.deepEqual(tracker.observe("session-b"), {
    previousSessionToken: "session-a",
    currentSessionToken: "session-b",
  });

  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    noteFingerprints: new Map([[1, "note"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });
  contexts.clear();
  assert.throws(() => contexts.resolve(contextId), /unknown or expired/u);

  const guards = new GuardTokenStore();
  const guardToken = guards.issue("note", {
    kind: "note",
    trackIndex: 1,
    groupUuid: GROUP_UUID,
    noteIndex: 1,
  });
  guards.clear();
  assert.throws(
    () =>
      guards.resolve(guardToken, {
        kind: "note",
        trackIndex: 1,
        groupUuid: GROUP_UUID,
        noteIndex: 1,
      }),
    /unknown or expired/u,
  );
});

test("v2 phrase projection removes unused sections and redundant note fields", () => {
  const result = {
    notes: [
      {
        noteIndex: 1,
        onset: 10,
        duration: 20,
        endPosition: 30,
        absoluteOnset: 110,
        absoluteEnd: 130,
        absoluteOnsetSeconds: 1,
        absoluteEndSeconds: 1.5,
        absoluteDurationSeconds: 0.5,
        pitch: 60,
      },
    ],
    voice: {},
    automation: [],
    analysis: {},
    recommendations: [],
    pitchAnalysis: {},
    selectionContext: {},
  };

  v2Testing.projectIncludes(result, ["notes", "analysis"]);
  v2Testing.compactPhraseNotes(result);

  assert.deepEqual(Object.keys(result).sort(), ["analysis", "notes"]);
  const note = result.notes[0];
  assert.ok(note);
  assert.equal("absoluteOnset" in note, false);
  assert.equal("absoluteEndSeconds" in note, false);
  assert.equal(note.absoluteDurationSeconds, 0.5);
  assert.equal(note.onset, 10);
});

test("v2 dense rows preserve every note field", () => {
  const notes = Array.from({ length: 24 }, (_, index) => ({
    noteIndex: index + 1,
    lyrics: `词${index + 1}`,
    pitch: 60 + (index % 5),
  }));
  const result: Record<string, unknown> = { notes };
  v2Testing.denseNotes(result, "auto");

  assert.equal(result.noteFormat, "rows");
  assert.deepEqual(result.notes, {
    columns: ["noteIndex", "lyrics", "pitch"],
    rows: notes.map((note) => [note.noteIndex, note.lyrics, note.pitch]),
  });
});
