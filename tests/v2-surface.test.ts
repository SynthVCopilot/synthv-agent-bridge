import assert from "node:assert/strict";
import test from "node:test";

import { V2ContextStore } from "../src/v2-context-store.js";
import { v2Testing } from "../src/v2-surface.js";

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
