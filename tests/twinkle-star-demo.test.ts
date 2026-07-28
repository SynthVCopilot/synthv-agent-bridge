import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type DemoNote = {
  noteIndex: number;
  onsetQuarter: number;
  durationQuarter: number;
  pitch: number;
  lyrics: string;
};

type DemoPoint = {
  quarter: number;
  value: number;
};

type DemoTemplate = {
  schemaVersion: number;
  id: string;
  progressHeadings: Array<{
    step: number;
    en: string;
    "zh-CN": string;
  }>;
  workflow: {
    publicMcpToolCount: number;
    scoreAction: string;
    tuningAction: string;
    grouping: string;
    requiresExplicitUserOptIn: boolean;
    requiresVocalModeOnboardingBeforeTuning: boolean;
    pauseAfterScoreCreationForVocalSelection: boolean;
    publishRawMcpPayloads: boolean;
    phraseReadProjection: {
      svReadTopLevelInclude: string[];
      automationParameters: string[];
      pitchAnalysisFrames: number;
    };
  };
  safety: {
    demoGroupOnly: boolean;
    preserveExistingProjectContent: boolean;
    preserveExistingNoteGeometry: boolean;
    treatUnknownProvenanceAsUserOwned: boolean;
    neverGuessVocalIdentity: boolean;
    neverGuessVocalModeNames: boolean;
    automationRangeSource: string;
  };
  score: {
    phraseRanges: Array<[number, number]>;
    phraseEndNoteIndices: number[];
    notes: DemoNote[];
  };
  tuningProfile: {
    groupVoice: Record<string, number>;
    vocalModePolicy: {
      useOnlyExactUserProvidedNames: boolean;
      preserveUnmatchedModes: boolean;
      roleProfiles: Array<{
        role: string;
        pitch: number;
        timbre: number;
        pronunciation: number;
      }>;
    };
    notePolicy: {
      connectInsidePhraseExactly: boolean;
      phraseEndNoteIndices: number[];
    };
    automation: Array<{
      parameter: string;
      clearMode: string;
      points: DemoPoint[];
    }>;
  };
  verification: {
    expectedNoteCount: number;
    expectedPhraseGapCount: number;
    expectedOverlapCount: number;
    requiredAutomationParameters: string[];
  };
};

const template = JSON.parse(
  await readFile(
    new URL("../../examples/twinkle-star-demo.json", import.meta.url),
    "utf8",
  ),
) as DemoTemplate;

test("Twinkle Star demo keeps the compact surface and prints every stage", () => {
  assert.equal(template.schemaVersion, 1);
  assert.equal(template.id, "twinkle-star-mandarin");
  assert.equal(template.workflow.publicMcpToolCount, 8);
  assert.equal(template.workflow.scoreAction, "add_notes");
  assert.equal(template.workflow.tuningAction, "apply_group_tuning");
  assert.equal(template.workflow.grouping, "ensureNonMain");
  assert.equal(template.workflow.requiresExplicitUserOptIn, true);
  assert.equal(
    template.workflow.requiresVocalModeOnboardingBeforeTuning,
    true,
  );
  assert.equal(
    template.workflow.pauseAfterScoreCreationForVocalSelection,
    true,
  );
  assert.equal(template.workflow.publishRawMcpPayloads, false);
  assert.ok(
    template.workflow.phraseReadProjection.svReadTopLevelInclude.includes(
      "automation",
    ),
  );
  assert.ok(
    template.workflow.phraseReadProjection.svReadTopLevelInclude.includes(
      "pitchAnalysis",
    ),
  );
  assert.deepEqual(
    template.workflow.phraseReadProjection.automationParameters,
    template.verification.requiredAutomationParameters,
  );
  assert.ok(template.workflow.phraseReadProjection.pitchAnalysisFrames > 0);

  assert.equal(template.progressHeadings.length, 5);
  for (const [index, heading] of template.progressHeadings.entries()) {
    const step = index + 1;
    assert.equal(heading.step, step);
    assert.match(heading.en, new RegExp(`^Demo ${step}/5: `, "u"));
    assert.match(heading["zh-CN"], new RegExp(`^Demo ${step}/5：`, "u"));
  }
});

test("Twinkle Star demo never changes user-owned project material", () => {
  assert.equal(template.safety.demoGroupOnly, true);
  assert.equal(template.safety.preserveExistingProjectContent, true);
  assert.equal(template.safety.preserveExistingNoteGeometry, true);
  assert.equal(template.safety.treatUnknownProvenanceAsUserOwned, true);
  assert.equal(template.safety.neverGuessVocalIdentity, true);
  assert.equal(template.safety.neverGuessVocalModeNames, true);
  assert.equal(
    template.safety.automationRangeSource,
    "same_fresh_synthv_read",
  );
});

test("Twinkle Star score has 42 notes and only five declared phrase gaps", () => {
  const { notes, phraseRanges, phraseEndNoteIndices } = template.score;
  assert.equal(notes.length, 42);
  assert.equal(template.verification.expectedNoteCount, 42);
  assert.deepEqual(phraseEndNoteIndices, [7, 14, 21, 28, 35, 42]);
  assert.deepEqual(
    template.tuningProfile.notePolicy.phraseEndNoteIndices,
    phraseEndNoteIndices,
  );
  assert.equal(template.tuningProfile.notePolicy.connectInsidePhraseExactly, true);

  const coveredIndices = phraseRanges.flatMap(([first, last]) =>
    Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
  );
  assert.deepEqual(
    coveredIndices,
    Array.from({ length: 42 }, (_, index) => index + 1),
  );

  let gapCount = 0;
  let overlapCount = 0;
  for (const [index, note] of notes.entries()) {
    assert.equal(note.noteIndex, index + 1);
    assert.ok(Number.isFinite(note.onsetQuarter));
    assert.ok(Number.isFinite(note.durationQuarter));
    assert.ok(note.durationQuarter > 0);
    assert.ok(Number.isInteger(note.pitch));
    assert.ok(note.pitch >= 0 && note.pitch <= 127);
    assert.notEqual(note.lyrics, "");

    const next = notes[index + 1];
    if (next === undefined) {
      continue;
    }
    const delta = next.onsetQuarter - (note.onsetQuarter + note.durationQuarter);
    if (delta > 0) {
      gapCount += 1;
      assert.ok(phraseEndNoteIndices.includes(note.noteIndex));
    } else if (delta < 0) {
      overlapCount += 1;
    } else {
      assert.equal(phraseEndNoteIndices.includes(note.noteIndex), false);
    }
  }

  assert.equal(gapCount, template.verification.expectedPhraseGapCount);
  assert.equal(overlapCount, template.verification.expectedOverlapCount);
  assert.equal(notes.map((note) => note.lyrics).join(""), "一闪一闪亮晶晶满天都是小星星挂在天空放光明好像许多小眼睛一闪一闪亮晶晶满天都是小星星");
});

test("Twinkle Star tuning values are explicit and automation stays range-guarded", () => {
  for (const [parameter, value] of Object.entries(
    template.tuningProfile.groupVoice,
  )) {
    const minimum = parameter === "loudness" ? -48 : -1;
    const maximum = parameter === "loudness" ? 12 : 1;
    assert.ok(value >= minimum && value <= maximum, parameter);
  }

  assert.equal(
    template.tuningProfile.vocalModePolicy.useOnlyExactUserProvidedNames,
    true,
  );
  assert.equal(
    template.tuningProfile.vocalModePolicy.preserveUnmatchedModes,
    true,
  );
  for (const role of template.tuningProfile.vocalModePolicy.roleProfiles) {
    assert.notEqual(role.role, "");
    for (const value of [role.pitch, role.timbre, role.pronunciation]) {
      assert.ok(value >= 0 && value <= 150);
    }
  }

  const automations = template.tuningProfile.automation;
  const parameters = automations.map((automation) => automation.parameter);
  assert.deepEqual(
    parameters,
    template.verification.requiredAutomationParameters,
  );
  assert.equal(new Set(parameters).size, parameters.length);
  for (const automation of automations) {
    assert.equal(automation.clearMode, "all");
    assert.ok(automation.points.length >= 2);
    for (const [index, point] of automation.points.entries()) {
      assert.ok(Number.isFinite(point.quarter));
      assert.ok(Number.isFinite(point.value));
      const previous = automation.points[index - 1];
      if (previous !== undefined) {
        assert.ok(point.quarter > previous.quarter);
      }
    }
  }
});
