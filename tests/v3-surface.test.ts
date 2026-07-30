import assert from "node:assert/strict";
import test from "node:test";

import { GuardTokenStore } from "../src/guard-token-store.js";
import { V3ContextStore as V2ContextStore } from "../src/v3-context-store.js";
import {
  V3SessionTracker as V2SessionTracker,
  v3Testing as v2Testing,
} from "../src/v3-surface.js";

const GROUP_UUID = "8ab8ba75-f776-402b-a8bb-ee1f64bcf95e";

test("v3 context expands one scope guard across a batch note edit", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
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

test("v3 context refuses a note missing from the original read", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
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

test("v3 context expands one same-Group tuning batch", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_phrase_context",
    targetKind: "group",
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

test("v3 expands every guarded context note for one deterministic transform", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    referenceFingerprint: "reference",
    noteFingerprints: new Map([
      [8, "note-8"],
      [7, "note-7"],
    ]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  const expanded = v2Testing.expandContext(
    "transform_notes",
    {
      target: "contextNotes",
      transform: { onsetOffsetSeconds: 2 },
    },
    contextId,
    contexts,
  );

  assert.equal(expanded.trackIndex, 2);
  assert.equal(expanded.groupIndex, 3);
  assert.equal(expanded.groupUuid, GROUP_UUID);
  assert.equal(expanded.target, undefined);
  assert.deepEqual(expanded.notes, [
    { noteIndex: 7, fingerprint: "note-7" },
    { noteIndex: 8, fingerprint: "note-8" },
  ]);
});

test("v3 context-note transforms reject ambiguous or missing context targets", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 1,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map([[1, "note-1"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(
    () =>
      v2Testing.expandContext(
        "transform_notes",
        {
          target: "contextNotes",
          notes: [{ index: 1 }],
          transform: { pitchOffsetSemitones: 1 },
        },
        contextId,
        contexts,
      ),
    /cannot be combined with args\.notes/u,
  );
  assert.throws(
    () =>
      v2Testing.expandContext(
        "transform_notes",
        {
          target: "contextNotes",
          transform: { pitchOffsetSemitones: 1 },
        },
        undefined,
        contexts,
      ),
    /requires a fresh contextId/u,
  );
});

test("v3 note insertion ensures an editable non-main group by default", () => {
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
  const scoreImport = v2Testing.expandContext(
    "import_monophonic_score",
    {
      trackIndex: 1,
      groupIndex: 1,
      filePath: "D:\\scores\\lead.musicxml",
      expectedFileFingerprint: `sha256:${"a".repeat(64)}`,
      rightsConfirmed: true,
    },
    undefined,
    contexts,
  );

  assert.equal(automatic.grouping, "ensureNonMain");
  assert.equal(explicitTarget.grouping, "target");
  assert.equal(scoreImport.grouping, "ensureNonMain");
});

test("v3 score import inherits only the target Group locator from context", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map(),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  const expanded = v2Testing.expandContext(
    "import_monophonic_score",
    {
      filePath: "D:\\scores\\lead.mid",
      expectedFileFingerprint: `sha256:${"b".repeat(64)}`,
      rightsConfirmed: true,
    },
    contextId,
    contexts,
  );

  assert.equal(expanded.trackIndex, 2);
  assert.equal(expanded.groupIndex, 3);
  assert.equal(expanded.groupUuid, GROUP_UUID);
  assert.equal(expanded.grouping, "ensureNonMain");
});

test("get_track_notes nested Group contexts retain the parent track locator", () => {
  const contexts = new V2ContextStore();
  const guards = new GuardTokenStore();
  const result: Record<string, unknown> = {
    track: {
      trackIndex: 4,
      fingerprint: "main-group:track-main",
      mainGroupUuid: "track-main",
    },
    groups: [
      {
        groupIndex: 2,
        groupUuid: GROUP_UUID,
        referenceFingerprint: "reference",
        notes: [{ noteIndex: 7, fingerprint: "note-7" }],
      },
    ],
  };

  v2Testing.addNestedContexts(
    "get_track_notes",
    result,
    contexts,
    guards,
  );

  const group = (result.groups as Array<Record<string, unknown>>)[0];
  assert.ok(group);
  assert.equal(group.trackIndex, 4);
  assert.equal(typeof group.contextId, "string");
  const context = contexts.resolve(group.contextId as string);
  assert.equal(context.sourceAction, "get_track_notes");
  assert.equal(context.targetKind, "group");
  assert.equal(context.trackIndex, 4);
  assert.equal(context.groupIndex, 2);
  assert.equal(context.groupUuid, GROUP_UUID);
  assert.equal(context.noteFingerprints.get(7), "note-7");
});

test("list_note_groups writeIntent Context retains private library guards", () => {
  const contexts = new V2ContextStore();
  const result: {
    groups: Record<string, unknown>[];
  } = {
    groups: [
      {
        libraryIndex: 3,
        groupUuid: GROUP_UUID,
        fingerprint: "library-group-fingerprint",
        name: "Shared Group",
        referenceCount: 2,
      },
    ],
  };

  v2Testing.addNestedContexts(
    "list_note_groups",
    result,
    contexts,
    new GuardTokenStore(),
    "writeIntent",
    "library-session",
  );

  const group = result.groups[0];
  assert.equal(typeof group?.contextId, "string");
  assert.equal(group?.groupUuid, undefined);
  assert.equal(group?.fingerprint, undefined);
  assert.deepEqual(
    v2Testing.expandContext(
      "delete_note_group",
      {},
      group?.contextId as string,
      contexts,
    ),
    {
      libraryIndex: 3,
      groupUuid: GROUP_UUID,
      expectedFingerprint: "library-group-fingerprint",
    },
  );
});

test("locator-only reads do not mint write-capable contexts", () => {
  const contexts = new V2ContextStore();
  const result: Record<string, unknown> = {
    trackIndex: 2,
    trackName: "Lead",
    gainDecibel: 0,
  };

  v2Testing.addNestedContexts(
    "get_track_mixer",
    result,
    contexts,
    new GuardTokenStore(),
  );

  assert.equal(result.contextId, undefined);
});

test("focused mixer guards mint a scoped writeIntent Context without exposing the guard", () => {
  const contexts = new V2ContextStore();
  const result: Record<string, unknown> = {
    trackIndex: 2,
    trackName: "Lead",
    trackFingerprint: "main-group:private-track-uuid",
    gainDecibel: 0,
  };

  v2Testing.addNestedContexts(
    "get_track_mixer",
    result,
    contexts,
    new GuardTokenStore(),
    "writeIntent",
    "session-a",
  );

  assert.equal(typeof result.contextId, "string");
  assert.equal(result.trackFingerprint, undefined);
  const context = contexts.resolve(result.contextId as string, "writeIntent");
  assert.equal(context.targetKind, "track");
  assert.equal(context.trackIndex, 2);
  assert.equal(context.trackFingerprint, "main-group:private-track-uuid");
  assert.equal(context.sessionToken, "session-a");
});

test("contextId rejects explicit scope conflicts and incompatible targets", () => {
  const contexts = new V2ContextStore();
  const groupContextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map([[1, "note-1"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(
    () =>
      v2Testing.expandContext(
        "edit_notes",
        {
          trackIndex: 9,
          edits: [{ noteIndex: 1, changes: { pitch: 61 } }],
        },
        groupContextId,
        contexts,
      ),
    /trackIndex conflicts/u,
  );

  const trackContextId = contexts.issue({
    sourceAction: "list_tracks",
    targetKind: "track",
    trackIndex: 2,
    trackFingerprint: "track",
    noteFingerprints: new Map(),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });
  assert.throws(
    () =>
      v2Testing.expandContext(
        "edit_notes",
        { edits: [{ noteIndex: 1, fingerprint: "note", changes: { pitch: 61 } }] },
        trackContextId,
        contexts,
      ),
    /cannot target edit_notes/u,
  );
});

test("set_selection consumes only a compatible piano-roll Group context", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map([[1, "note-1"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.deepEqual(
    v2Testing.expandContext(
      "set_selection",
      {
        scope: "pianoRoll",
        operation: "replace",
        kind: "notes",
        notes: [{ noteIndex: 1 }],
      },
      contextId,
      contexts,
    ),
    {
      scope: "pianoRoll",
      operation: "replace",
      kind: "notes",
      notes: [{ noteIndex: 1 }],
      trackIndex: 2,
      groupIndex: 3,
      groupUuid: GROUP_UUID,
    },
  );

  assert.throws(
    () =>
      v2Testing.expandContext(
        "set_selection",
        {
          scope: "pianoRoll",
          operation: "replace",
          kind: "notes",
          trackIndex: 9,
          notes: [{ noteIndex: 1 }],
        },
        contextId,
        contexts,
      ),
    /trackIndex conflicts/u,
  );
});

test("contextId fails closed for UI operations that do not consume it", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "get_track_notes",
    targetKind: "group",
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map(),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(
    () =>
      v2Testing.expandContext(
        "playback",
        { operation: "status" },
        contextId,
        contexts,
      ),
    /cannot target playback/u,
  );
  assert.throws(
    () =>
      v2Testing.expandContext(
        "set_selection",
        {
          scope: "arrangement",
          operation: "replace",
          kind: "groups",
          groups: [{ trackIndex: 2, groupIndex: 3 }],
        },
        contextId,
        contexts,
      ),
    /cannot target set_selection/u,
  );
  assert.throws(
    () =>
      v2Testing.expandContext(
        "set_selection",
        { scope: "pianoRoll", operation: "clear", kind: "notes" },
        contextId,
        contexts,
      ),
    /cannot target set_selection/u,
  );
});

test("untyped contexts fail closed even for otherwise compatible actions", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    trackIndex: 2,
    groupIndex: 3,
    groupUuid: GROUP_UUID,
    noteFingerprints: new Map([[1, "note-1"]]),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.throws(
    () =>
      v2Testing.expandContext(
        "edit_notes",
        { edits: [{ noteIndex: 1, changes: { pitch: 61 } }] },
        contextId,
        contexts,
      ),
    /cannot target edit_notes/u,
  );
});

test("track contexts locate track reads without becoming Group contexts", () => {
  const contexts = new V2ContextStore();
  const contextId = contexts.issue({
    sourceAction: "list_tracks",
    targetKind: "track",
    trackIndex: 5,
    trackFingerprint: "track-5",
    noteFingerprints: new Map(),
    pitchControlFingerprints: new Map(),
    automationFingerprints: new Map(),
  });

  assert.deepEqual(
    v2Testing.expandContext("get_track_notes", {}, contextId, contexts),
    { trackIndex: 5 },
  );
});

test("v3 Group Voice refresh defaults to a compact write-ready projection", () => {
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

test("v3 context store evicts by total guard weight", () => {
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

test("reload waiting observes a delayed SynthV session token", async () => {
  const tokens = ["session-a", "session-a", "session-b"];
  const changed = await v2Testing.waitForSessionTokenChange(
    async () => tokens.shift(),
    "session-a",
    100,
    1,
  );
  assert.equal(changed, "session-b");

  const unchanged = await v2Testing.waitForSessionTokenChange(
    async () => "session-a",
    "session-a",
    0,
    1,
  );
  assert.equal(unchanged, undefined);
});

test("v3 phrase reads promote nested include projections before Guard capture", () => {
  const args: Record<string, unknown> = {
    include: [
      "notes",
      "voice",
      "automation",
      "analysis",
      "pitchAnalysis",
    ],
    automationParameters: [
      "loudness",
      "tension",
      "breathiness",
      "pitchDelta",
      "vibratoEnv",
    ],
    pitchAnalysisFrames: 168,
  };

  const include = v2Testing.normalizePhraseReadInclude(undefined, args);

  assert.deepEqual(include, [
    "notes",
    "voice",
    "automation",
    "analysis",
    "pitchAnalysis",
  ]);
  assert.equal("include" in args, false);
  assert.deepEqual(args.automationParameters, [
    "loudness",
    "tension",
    "breathiness",
    "pitchDelta",
    "vibratoEnv",
  ]);
  assert.equal(args.pitchAnalysisFrames, 168);
});

test("v3 phrase reads reject conflicting include locations", () => {
  assert.throws(
    () =>
      v2Testing.normalizePhraseReadInclude(
        ["notes", "voice", "automation"],
        { include: ["notes", "voice", "pitchAnalysis"] },
      ),
    /supplied in both sv_query\.include and args\.include with different values/u,
  );

  const duplicateArgs: Record<string, unknown> = {
    include: ["automation", "voice", "notes"],
  };
  assert.deepEqual(
    v2Testing.normalizePhraseReadInclude(
      ["notes", "voice", "automation"],
      duplicateArgs,
    ),
    ["notes", "voice", "automation"],
  );
  assert.equal("include" in duplicateArgs, false);
});

test("explicit phrase diagnostics survive the default non-debug projection", () => {
  assert.equal(
    v2Testing.shouldStripDiagnostics(
      "get_phrase_context",
      ["notes", "diagnostics"],
      false,
    ),
    false,
  );
  assert.equal(
    v2Testing.shouldStripDiagnostics(
      "get_phrase_context",
      ["notes"],
      false,
    ),
    true,
  );
  assert.equal(
    v2Testing.shouldStripDiagnostics("get_phrase_context", ["notes"], true),
    false,
  );
});

test("v3 phrase projection removes unused sections and redundant note fields", () => {
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

test("v3 dense rows preserve every note field", () => {
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
