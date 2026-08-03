#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  STAGE3_VERIFIED_WRITE_ACTIONS,
  createStage3WritePlan,
} from "../dist/src/release-validation-v3.js";

const STATE_FILE = path.join(os.tmpdir(), "synthv-agent-stage3-write-undo.json");
const SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Stage 3 Write Probe</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><lyric><text>la</text></lyric></note>
  </measure></part>
</score-partwise>
`;

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseArguments(argv) {
  let mode;
  let index;
  let projectFile;
  let trackIndex = 1;
  let groupIndex = 2;
  let noteIndex = 1;
  let stateFile = STATE_FILE;
  for (let offset = 0; offset < argv.length; offset += 1) {
    const argument = argv[offset];
    if (argument === "--mode") {
      mode = argv[++offset];
    } else if (argument === "--index") {
      index = parsePositiveInteger(argv[++offset], "--index");
    } else if (argument === "--project-file") {
      projectFile = argv[++offset];
    } else if (argument === "--track-index") {
      trackIndex = parsePositiveInteger(argv[++offset], "--track-index");
    } else if (argument === "--group-index") {
      groupIndex = parsePositiveInteger(argv[++offset], "--group-index");
    } else if (argument === "--note-index") {
      noteIndex = parsePositiveInteger(argv[++offset], "--note-index");
    } else if (argument === "--state-file") {
      stateFile = argv[++offset];
    } else {
      throw new TypeError(`Unknown argument: ${String(argument)}`);
    }
  }
  if (!["prepare", "write", "linked-clone-write", "verify", "status", "cleanup"].includes(mode)) {
    throw new TypeError(
      "--mode must be prepare, write, linked-clone-write, verify, status, or cleanup.",
    );
  }
  if ((mode === "write" || mode === "linked-clone-write") && index === undefined) {
    throw new TypeError(`--mode ${mode} requires --index.`);
  }
  if (mode === "prepare") {
    if (projectFile === undefined || !path.isAbsolute(projectFile)) {
      throw new TypeError("--mode prepare requires an absolute --project-file.");
    }
  }
  return { groupIndex, index, mode, noteIndex, projectFile, stateFile, trackIndex };
}

function readToolPayload(result, label) {
  const block = result.content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  if (block?.type !== "text") throw new Error(`${label} returned no JSON text.`);
  const payload = JSON.parse(block.text);
  if (
    result.isError === true ||
    payload?.outcome === "failed" ||
    payload?.error !== undefined
  ) {
    const code = payload?.error?.code ?? "UNKNOWN";
    const message = payload?.error?.message ?? `${label} failed.`;
    throw new Error(`${label} failed with ${String(code)}: ${String(message)}`);
  }
  return payload;
}

async function openClient() {
  const transport = new StdioClientTransport({
    args: ["dist/src/cli.js"],
    command: process.execPath,
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "synthv-agent-stage3-write-undo", version: "0.3.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

async function query(client, action, args, contextMode = "readOnly") {
  return readToolPayload(
    await client.callTool({
      name: "sv_query",
      arguments: { action, args, contextMode, dense: "never" },
    }),
    `sv_query:${action}`,
  );
}

async function command(client, action, args, contextId) {
  const payload = readToolPayload(
    await client.callTool({
      name: "sv_command",
      arguments: {
        action,
        args,
        ...(contextId === undefined ? {} : { contextId }),
        expectedEffect: "mustChange",
      },
    }),
    `sv_command:${action}`,
  );
  if (
    payload.outcome !== "changed" ||
    payload.undoRecords !== 1 ||
    payload.verified !== true
  ) {
    throw new Error(
      `sv_command:${action} did not report changed/one Undo/verified: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (
      key === "traceId" ||
      key === "contextId" ||
      key === "cursorToken" ||
      key === "currentEditor" ||
      key === "selectionContext" ||
      key === "selected"
    ) {
      continue;
    }
    result[key] = normalize(value[key]);
  }
  return result;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

async function captureState(client, fixture) {
  const project = await query(client, "get_project_info", {});
  const tracks = await query(client, "list_tracks", { limit: 128, offset: 0 });
  const groups = await query(client, "list_note_groups", { limit: 128, offset: 0 });
  const timeAxis = await query(client, "get_time_axis", {
    measureLimit: 1000,
    tempoLimit: 1000,
  });
  const trackDetails = [];
  for (const track of tracks.tracks) {
    trackDetails.push(
      await query(client, "get_track_notes", {
        groupLimit: 128,
        groupOffset: 0,
        limit: 5000,
        offset: 0,
        trackIndex: track.trackIndex,
      }),
    );
  }
  const target = { groupIndex: fixture.groupIndex, trackIndex: fixture.trackIndex };
  const [voice, phonemes, retakes, pitchControls, loudness, tension, breathiness] =
    await Promise.all([
      query(client, "get_group_voice", target),
      query(client, "get_note_phoneme_data", {
        ...target,
        includeComputedAttributes: false,
        includeComputedPhonemes: false,
        includeRawAttributes: true,
        limit: 1000,
        offset: 0,
        responseMode: "full",
      }),
      query(client, "get_note_retakes", { ...target, noteIndex: fixture.noteIndex + 1 }),
      query(client, "get_pitch_controls", { ...target, limit: 1000, offset: 0 }),
      query(client, "get_automation", {
        ...target,
        parameter: "loudness",
        rangeBegin: 0,
        rangeEnd: 10_000_000_000,
        responseMode: "full",
      }),
      query(client, "get_automation", {
        ...target,
        parameter: "tension",
        rangeBegin: 0,
        rangeEnd: 10_000_000_000,
        responseMode: "full",
      }),
      query(client, "get_automation", {
        ...target,
        parameter: "breathiness",
        rangeBegin: 0,
        rangeEnd: 10_000_000_000,
        responseMode: "full",
      }),
    ]);
  return normalize({
    automations: { breathiness, loudness, tension },
    groups,
    phonemes,
    pitchControls,
    project,
    retakes,
    timeAxis,
    trackDetails,
    tracks,
    voice,
  });
}

function itemContext(items, predicate, label) {
  const matches = items.filter(predicate);
  if (matches.length !== 1 || typeof matches[0]?.contextId !== "string") {
    throw new Error(`Expected one write Context for ${label}; found ${matches.length}.`);
  }
  return matches[0];
}

async function targetNotes(client, fixture, noteIndex, limit = 1) {
  const payload = await query(
    client,
    "get_track_notes",
    {
      groupIndex: fixture.groupIndex,
      limit,
      offset: noteIndex - 1,
      trackIndex: fixture.trackIndex,
    },
    "writeIntent",
  );
  return itemContext(payload.groups, (group) => group.groupIndex === fixture.groupIndex, "notes");
}

async function targetVoice(client, fixture, trackIndex = fixture.trackIndex, groupIndex = fixture.groupIndex) {
  return query(client, "get_group_voice", { groupIndex, trackIndex }, "writeIntent");
}

async function targetAutomation(client, fixture, parameter) {
  return query(
    client,
    "get_automation",
    {
      groupIndex: fixture.groupIndex,
      parameter,
      responseMode: "compact",
      trackIndex: fixture.trackIndex,
    },
    "writeIntent",
  );
}

async function targetRetakes(client, fixture) {
  return query(
    client,
    "get_note_retakes",
    {
      groupIndex: fixture.groupIndex,
      noteIndex: fixture.noteIndex + 1,
      trackIndex: fixture.trackIndex,
    },
    "writeIntent",
  );
}

async function targetPitch(client, fixture) {
  return query(
    client,
    "get_pitch_controls",
    {
      groupIndex: fixture.groupIndex,
      limit: 1000,
      offset: 0,
      trackIndex: fixture.trackIndex,
    },
    "writeIntent",
  );
}

async function prepare(options) {
  const { client } = await openClient();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "synthv-stage3-write-"));
  const scoreFile = path.join(temporaryDirectory, "probe.musicxml");
  await writeFile(scoreFile, SCORE_XML, "utf8");
  try {
    const status = readToolPayload(
      await client.callTool({ name: "sv_status", arguments: { operation: "bridge" } }),
      "sv_status",
    );
    if (
      status.connected !== true ||
      status.fresh !== true ||
      status.coherence?.state !== "matched" ||
      status.coherence?.writesAllowed !== true ||
      path.resolve(status.status?.projectFile ?? "").toLocaleLowerCase("en-US") !==
        path.resolve(options.projectFile).toLocaleLowerCase("en-US")
    ) {
      throw new Error("Bridge is not fresh, coherent, write-enabled, and on the requested project.");
    }

    const scratchTrack = await command(client, "add_track", { name: "Stage 3 Scratch Track" });
    await command(client, "create_note_group", {
      name: "Stage 3 Referenced Scratch",
      notes: [{ duration: 705_600_000, lyrics: "la", onset: 0, pitch: 67 }],
    });
    await command(client, "create_note_group", {
      name: "Stage 3 Unused Scratch",
      notes: [{ duration: 705_600_000, lyrics: "la", onset: 0, pitch: 69 }],
    });
    const tracks = await query(client, "list_tracks", { limit: 128, offset: 0 }, "writeIntent");
    const scratchTrackRead = itemContext(
      tracks.tracks,
      (track) => track.name === "Stage 3 Scratch Track",
      "scratch Track",
    );
    if (
      Number.isSafeInteger(scratchTrack.trackIndex) &&
      scratchTrack.trackIndex !== scratchTrackRead.trackIndex
    ) {
      throw new Error("Scratch Track acknowledgement disagreed with its fresh read.");
    }
    const scratchTrackIndex = scratchTrackRead.trackIndex;
    const libraryGroups = await query(
      client,
      "list_note_groups",
      { limit: 128, offset: 0 },
      "writeIntent",
    );
    const referencedGroupRead = itemContext(
      libraryGroups.groups,
      (group) => group.name === "Stage 3 Referenced Scratch",
      "referenced scratch Group",
    );
    const unusedGroupRead = itemContext(
      libraryGroups.groups,
      (group) => group.name === "Stage 3 Unused Scratch",
      "unused scratch Group",
    );
    await command(
      client,
      "add_group_reference",
      { trackIndex: scratchTrackIndex, timeOffset: 2_822_400_000 },
      referencedGroupRead.contextId,
    );

    const fixture = {
      groupIndex: options.groupIndex,
      noteIndex: options.noteIndex,
      projectFile: options.projectFile,
      referencedLibraryIndex: referencedGroupRead.libraryIndex,
      scratchTrackIndex,
      trackIndex: options.trackIndex,
      unusedLibraryIndex: unusedGroupRead.libraryIndex,
    };
    const retakeContext = await targetRetakes(client, fixture);
    const generated = await command(
      client,
      "generate_note_retake",
      {
        activate: false,
        newDuration: false,
        newPitch: true,
        newTimbre: false,
        noteIndex: fixture.noteIndex + 1,
      },
      retakeContext.contextId,
    );
    let takeId = generated.generatedTakeId ?? generated.takeId;
    if (!Number.isSafeInteger(takeId)) {
      const reread = await query(client, "get_note_retakes", {
        groupIndex: fixture.groupIndex,
        noteIndex: fixture.noteIndex + 1,
        trackIndex: fixture.trackIndex,
      });
      const ids = [
        ...(reread.trackedTakeIds ?? []),
        ...(reread.retakes ?? reread.takes ?? []).map((take) => take.takeId ?? take.id),
      ].filter((value) => Number.isSafeInteger(value) && value > 0);
      takeId = Math.max(...ids);
    }
    if (!Number.isSafeInteger(takeId) || takeId < 1) {
      throw new Error("Scratch Retake setup did not expose a non-default takeId.");
    }
    fixture.takeId = takeId;
    const baseline = await captureState(client, fixture);
    const state = {
      completed: [],
      createdAt: new Date().toISOString(),
      executorBuildId: status.status.executorBuildId,
      fixture,
      pending: null,
      preparedDigest: digest(baseline),
      scoreFile,
      sessionToken: status.status.sessionToken,
      temporaryDirectory,
    };
    await writeFile(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return {
      fixture,
      mode: "prepare",
      preparedDigest: state.preparedDigest,
      setupUndoRecords: 5,
      stateFile: options.stateFile,
    };
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function loadState(stateFile) {
  return JSON.parse(await readFile(stateFile, "utf8"));
}

async function buildWrite(client, state, planEntry) {
  const fixture = state.fixture;
  const iteration = planEntry.actionIteration;
  switch (planEntry.action) {
    case "set_time_axis": {
      const context = await query(client, "get_time_axis", { measureLimit: 8, tempoLimit: 8 }, "writeIntent");
      return { args: { tempoMarks: [{ bpm: 121, position: 0 }] }, contextId: context.contextId };
    }
    case "create_note_group":
      return {
        args: {
          name: `Stage 3 Created ${iteration}`,
          notes: [{ duration: 705_600_000, lyrics: "la", onset: 0, pitch: 72 }],
        },
      };
    case "delete_note_group": {
      const groups = await query(client, "list_note_groups", { limit: 128, offset: 0 }, "writeIntent");
      const target = itemContext(
        groups.groups,
        (group) => group.name === "Stage 3 Unused Scratch",
        "unused library Group",
      );
      return { args: {}, contextId: target.contextId };
    }
    case "add_group_reference": {
      const groups = await query(
        client,
        "list_note_groups",
        { limit: 128, offset: 0 },
        "writeIntent",
      );
      const target = itemContext(
        groups.groups,
        (group) => group.name === "Stage 3 Unused Scratch",
        "unused library Group",
      );
      return {
        args: { trackIndex: fixture.scratchTrackIndex, timeOffset: 4_233_600_000 },
        contextId: target.contextId,
      };
    }
    case "add_track":
      return { args: { name: `Stage 3 Added ${iteration}` } };
    case "update_track": {
      const tracks = await query(client, "list_tracks", { limit: 128, offset: 0 }, "writeIntent");
      const target = itemContext(
        tracks.tracks,
        (track) => track.trackIndex === fixture.scratchTrackIndex,
        "scratch Track",
      );
      return { args: { name: `Stage 3 Scratch Changed ${iteration}` }, contextId: target.contextId };
    }
    case "delete_track": {
      const tracks = await query(client, "list_tracks", { limit: 128, offset: 0 }, "writeIntent");
      const target = itemContext(
        tracks.tracks,
        (track) => track.trackIndex === fixture.scratchTrackIndex,
        "scratch Track",
      );
      return { args: {}, contextId: target.contextId };
    }
    case "update_group": {
      const target = await targetVoice(client, fixture);
      return { args: { muted: true }, contextId: target.contextId };
    }
    case "set_group_voice": {
      const target = await targetVoice(client, fixture);
      return { args: { parameters: { tension: 0.11 } }, contextId: target.contextId };
    }
    case "apply_group_tuning": {
      const target = await targetVoice(client, fixture);
      return {
        args: { summary: "Stage 3 reversible tuning probe", voice: { parameters: { tension: 0.11 } } },
        contextId: target.contextId,
      };
    }
    case "delete_group_reference": {
      const target = await targetVoice(client, fixture, fixture.scratchTrackIndex, 2);
      return { args: {}, contextId: target.contextId };
    }
    case "import_monophonic_score": {
      const inspected = await query(client, "inspect_score_file", {
        filePath: state.scoreFile,
        previewNoteLimit: 8,
      });
      const target = await targetVoice(client, fixture);
      return {
        args: {
          expectedFileFingerprint: inspected.fileFingerprint,
          filePath: state.scoreFile,
          grouping: "target",
          onsetBlickOffset: 2_822_400_000,
          rightsConfirmed: true,
        },
        contextId: target.contextId,
      };
    }
    case "add_notes": {
      const target = await targetVoice(client, fixture);
      return {
        args: { notes: [{ duration: 705_600_000, lyrics: "la", onset: 2_822_400_000, pitch: 67 }] },
        contextId: target.contextId,
      };
    }
    case "edit_notes": {
      const target = await targetNotes(client, fixture, 3);
      return { args: { edits: [{ changes: { detune: 6 }, noteIndex: 3 }] }, contextId: target.contextId };
    }
    case "transform_notes": {
      const target = await targetNotes(client, fixture, 3);
      return {
        args: { target: "contextNotes", transform: { pitchOffsetSemitones: 1 } },
        contextId: target.contextId,
      };
    }
    case "set_note_phoneme_properties": {
      const target = await targetNotes(client, fixture, 2);
      return {
        args: { edits: [{ changes: { evenSyllableDuration: false }, noteIndex: 2 }] },
        contextId: target.contextId,
      };
    }
    case "generate_note_retake": {
      const target = await targetRetakes(client, fixture);
      return {
        args: {
          activate: false,
          newDuration: false,
          newPitch: true,
          newTimbre: true,
          noteIndex: fixture.noteIndex + 1,
        },
        contextId: target.contextId,
      };
    }
    case "activate_note_retake": {
      const target = await targetRetakes(client, fixture);
      return {
        args: { noteIndex: fixture.noteIndex + 1, takeId: fixture.takeId },
        contextId: target.contextId,
      };
    }
    case "add_pitch_controls": {
      const target = await targetVoice(client, fixture);
      return {
        args: { pitchControls: [{ kind: "point", pitch: -0.25, position: 1_764_000_000 }] },
        contextId: target.contextId,
      };
    }
    case "edit_pitch_controls": {
      const target = await targetPitch(client, fixture);
      return {
        args: { edits: [{ changes: { pitch: 0.3 }, pitchControlIndex: 1 }] },
        contextId: target.contextId,
      };
    }
    case "simplify_automation": {
      const target = await targetAutomation(client, fixture, "tension");
      return {
        args: { beginPosition: 0, endPosition: 10_000_000_000, parameter: "tension", threshold: 4 },
        contextId: target.contextId,
      };
    }
    case "set_automation_points": {
      const target = await targetAutomation(client, fixture, "tension");
      return {
        args: { clearMode: "none", parameter: "tension", points: [{ position: 1_058_400_000, value: 0.14 }] },
        contextId: target.contextId,
      };
    }
    case "script_data":
      return {
        args: {
          key: "synthv-agent-bridge.stage3-write",
          objectType: "project",
          operation: "set",
          value: { actionIteration: iteration },
        },
      };
    case "set_track_mixer": {
      const target = await query(client, "get_track_mixer", { trackIndex: fixture.trackIndex }, "writeIntent");
      return { args: { pan: 0.05 }, contextId: target.contextId };
    }
    case "humanize_notes": {
      const target = await targetNotes(client, fixture, 3);
      return {
        args: {
          maxDurationOffset: 1000,
          maxOnsetOffset: 0,
          notes: [{ noteIndex: 3 }],
          preserveChords: true,
          seed: 42,
        },
        contextId: target.contextId,
      };
    }
    case "apply_expression_preset": {
      const target = await targetNotes(client, fixture, 2);
      return {
        args: { notes: [{ noteIndex: 2 }], preset: "vibrato", strength: 0.5 },
        contextId: target.contextId,
      };
    }
    case "fit_lyrics": {
      const target = await targetNotes(client, fixture, 2);
      return {
        args: { fillRemainder: "reject", notes: [{ noteIndex: 2 }], syllables: ["明"] },
        contextId: target.contextId,
      };
    }
    case "delete_notes": {
      const target = await targetNotes(client, fixture, 3);
      return { args: { notes: [{ noteIndex: 3 }] }, contextId: target.contextId };
    }
    case "delete_note_retake": {
      const target = await targetRetakes(client, fixture);
      return {
        args: { noteIndex: fixture.noteIndex + 1, takeId: fixture.takeId },
        contextId: target.contextId,
      };
    }
    case "delete_pitch_controls": {
      const target = await targetPitch(client, fixture);
      return {
        args: { pitchControls: [{ pitchControlIndex: 1 }] },
        contextId: target.contextId,
      };
    }
    case "clear_automation": {
      const target = await targetAutomation(client, fixture, "tension");
      return { args: { parameter: "tension" }, contextId: target.contextId };
    }
    default:
      throw new Error(`No Stage 3 write fixture for ${String(planEntry.action)}.`);
  }
}

async function runWrite(options) {
  const state = await loadState(options.stateFile);
  if (state.pending !== null) {
    throw new Error(`Write ${state.pending.index} is still awaiting one visible SynthV Undo.`);
  }
  const plan = createStage3WritePlan();
  const entry = plan[options.index - 1];
  if (entry === undefined) throw new Error("--index is outside the 200-call Stage 3 plan.");
  const expectedNext = state.completed.length + 1;
  if (options.index !== expectedNext) {
    throw new Error(`Expected write index ${expectedNext}, received ${options.index}.`);
  }
  const { client } = await openClient();
  try {
    const before = await captureState(client, state.fixture);
    const beforeDigest = digest(before);
    if (beforeDigest !== state.preparedDigest) {
      throw new Error("Prepared Stage 3 fixture drifted before the next write.");
    }
    const built = await buildWrite(client, state, entry);
    const outcome = await command(client, entry.action, built.args, built.contextId);
    state.pending = {
      action: entry.action,
      actionIteration: entry.actionIteration,
      beforeDigest,
      index: options.index,
      outcome,
      writtenAt: new Date().toISOString(),
    };
    await writeFile(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return {
      action: entry.action,
      actionIteration: entry.actionIteration,
      index: options.index,
      mode: "write",
      outcome,
      requiresVisibleSynthVUndo: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runLinkedCloneWrite(options) {
  const state = await loadState(options.stateFile);
  if (state.pending !== null) {
    throw new Error(`Write ${state.pending.index} is still awaiting one visible SynthV Undo.`);
  }
  if (state.completed.some((entry) => entry.action !== "clone_group_reference")) {
    throw new Error("Linked-clone validation requires a freshly prepared runtime state.");
  }
  const expectedNext = state.completed.length + 1;
  if (options.index !== expectedNext || options.index > 30) {
    throw new Error(`Expected linked-clone index ${expectedNext} in the 30-call matrix.`);
  }

  const { client } = await openClient();
  try {
    const before = await captureState(client, state.fixture);
    const beforeDigest = digest(before);
    if (beforeDigest !== state.preparedDigest) {
      throw new Error("Prepared Stage 3 fixture drifted before the next linked clone.");
    }
    const source = await query(
      client,
      "get_track_notes",
      {
        groupIndex: 2,
        limit: 8,
        offset: 0,
        trackIndex: state.fixture.scratchTrackIndex,
      },
      "writeIntent",
    );
    const sourceGroup = itemContext(
      source.groups,
      (group) => group.groupIndex === 2,
      "linked-clone source Group Reference",
    );
    await query(
      client,
      "list_tracks",
      { limit: 128, offset: 0 },
      "writeIntent",
    );
    const outcome = await command(
      client,
      "clone_group_reference",
      { cloneIntent: "linked", targetTrackIndex: state.fixture.trackIndex },
      sourceGroup.contextId,
    );
    state.pending = {
      action: "clone_group_reference",
      actionIteration: options.index,
      beforeDigest,
      index: options.index,
      outcome,
      writtenAt: new Date().toISOString(),
    };
    await writeFile(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return {
      action: "clone_group_reference",
      actionIteration: options.index,
      index: options.index,
      mode: "linked-clone-write",
      outcome,
      requiresVisibleSynthVUndo: true,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyUndo(options) {
  const state = await loadState(options.stateFile);
  if (state.pending === null) throw new Error("No Stage 3 write is awaiting Undo verification.");
  const { client } = await openClient();
  try {
    const after = await captureState(client, state.fixture);
    const afterDigest = digest(after);
    if (afterDigest !== state.pending.beforeDigest || afterDigest !== state.preparedDigest) {
      throw new Error(
        `Visible SynthV Undo did not restore the prepared fixture (expected ${state.preparedDigest}, got ${afterDigest}).`,
      );
    }
    const completed = {
      action: state.pending.action,
      actionIteration: state.pending.actionIteration,
      completedAt: new Date().toISOString(),
      index: state.pending.index,
      restoredDigest: afterDigest,
      undoVerified: true,
    };
    state.completed.push(completed);
    state.pending = null;
    await writeFile(options.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return {
      ...completed,
      completedCount: state.completed.length,
      mode: "verify",
      remainingCount:
        completed.action === "clone_group_reference"
          ? 30 - state.completed.length
          : 200 - state.completed.length,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function status(options) {
  const state = await loadState(options.stateFile);
  const counts = Object.fromEntries(STAGE3_VERIFIED_WRITE_ACTIONS.map((action) => [action, 0]));
  let linkedCloneCount = 0;
  for (const entry of state.completed) {
    if (entry.action === "clone_group_reference") linkedCloneCount += 1;
    else counts[entry.action] += 1;
  }
  const ordinaryCompletedCount = state.completed.length - linkedCloneCount;
  return {
    actionCounts: counts,
    completedCount: state.completed.length,
    linkedCloneCount,
    linkedCloneRemainingCount: 30 - linkedCloneCount,
    mode: "status",
    ordinaryCompletedCount,
    pending: state.pending,
    preparedDigest: state.preparedDigest,
    remainingCount: 200 - ordinaryCompletedCount,
    stateFile: options.stateFile,
  };
}

async function cleanup(options) {
  const state = await loadState(options.stateFile);
  await rm(state.temporaryDirectory, { force: true, recursive: true });
  await rm(options.stateFile, { force: true });
  return { mode: "cleanup", removedRuntimeState: true };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result =
    options.mode === "prepare"
      ? await prepare(options)
      : options.mode === "write"
        ? await runWrite(options)
        : options.mode === "linked-clone-write"
          ? await runLinkedCloneWrite(options)
      : options.mode === "verify"
          ? await verifyUndo(options)
          : options.mode === "status"
            ? await status(options)
            : await cleanup(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
