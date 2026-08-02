import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import * as z from "zod/v4";

import {
  SERVER_NAME,
  SERVER_VERSION,
  type BridgeConfig,
} from "./config.js";
import {
  compactAutomationGuard,
  compactPhonemeGuards,
  compactPhraseContextGuards,
  compactTransactionGuards,
  resolveAutomationGuardPayload,
  resolvePhraseCursorPayload,
  resolvePhonemeGuardPayload,
  resolveTransactionGuardPayload,
} from "./compact-results.js";
import { BridgeError, toPublicError } from "./errors.js";
import { GuardTokenStore } from "./guard-token-store.js";
import { FileIpcClient } from "./ipc/file-ipc-client.js";
import {
  importScoreSnapshotMonophonic,
  inspectScoreSnapshot,
  readLocalScoreSnapshot,
  ScoreImportError,
  type MidiSelection,
  type LocalScoreInspection,
  type MusicXmlSelection,
  type LocalScoreImportResult,
  type ScorePreview,
} from "./score-import.js";
import { SidebarStatusMonitor } from "./sidebar-status-monitor.js";
import { registerV3Facade } from "./v3-facade.js";
import {
  assertV3CommandPolicyCatalog,
  transactionEligibleActionNames,
} from "./v3-command-policy.js";

const TRANSACTION_STEP_ACTIONS = transactionEligibleActionNames();

const indexSchema = z.number().int().min(1);
const blickSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const midiPitchSchema = z.number().int().min(0).max(127);
const fingerprintSchema = z.string().min(1);
const guardTokenSchema = z.string().min(1).max(128);
const groupUuidSchema = z.string().min(1);
const responseModeSchema = z.enum(["full", "compact"]).default("full");
export const TRACK_DISPLAY_COLOR_PATTERN =
  /^(?:#[0-9A-Fa-f]{6}|#?[0-9A-Fa-f]{8})$/;
const displayColorSchema = z
  .string()
  .regex(TRACK_DISPLAY_COLOR_PATTERN)
  .describe(
    "Track color as #RRGGBB or AARRGGBB. #RRGGBB is normalized to opaque SynthV AARRGGBB.",
  );
const languageOverrideSchema = z.enum([
  "",
  "mandarin",
  "japanese",
  "english",
  "cantonese",
]);
const rapAccentSchema = z.enum(["", "1", "2", "3", "4", "5"]);

const groupVoiceParameterChangesSchema = z
  .object({
    loudness: z.number().finite().min(-48).max(12).optional(),
    tension: z.number().finite().min(-1).max(1).optional(),
    breathiness: z.number().finite().min(-1).max(1).optional(),
    gender: z.number().finite().min(-1).max(1).optional(),
    toneShift: z.number().finite().min(-1).max(1).optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "At least one group voice parameter must be changed." },
  );

const vocalModeChangesSchema = z
  .object({
    name: z.string().min(1).max(200),
    pitch: z.number().finite().min(0).max(150).optional(),
    timbre: z.number().finite().min(0).max(150).optional(),
    pronunciation: z.number().finite().min(0).max(150).optional(),
  })
  .refine(
    (value) =>
      value.pitch !== undefined ||
      value.timbre !== undefined ||
      value.pronunciation !== undefined,
    { message: "At least one Vocal Mode axis must be changed." },
  );

const experimentalUnisonChangesSchema = z
  .object({
    singers: z.number().int().min(1).max(128).optional(),
    spacing: z.number().finite().min(0).max(1).optional(),
  })
  .refine(
    (value) => value.singers !== undefined || value.spacing !== undefined,
    { message: "At least one experimental Unison field must be changed." },
  );

const phonemeAttributeSchema = z
  .object({
    leftOffset: z.number().finite().optional(),
    position: z.number().finite().min(0).max(1).optional(),
    activity: z.number().finite().min(0).max(1).optional(),
    strength: z.number().finite().min(-1).max(1).optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "Each phoneme attribute must change at least one field." },
  );

const phonemePropertyChangesSchema = z
  .object({
    phonemeSequence: z.string().max(4000).optional(),
    languageOverride: languageOverrideSchema.optional(),
    phonesetOverride: z.string().max(200).optional(),
    evenSyllableDuration: z.boolean().optional(),
    phonemeAttributes: z.array(phonemeAttributeSchema).max(256).optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "At least one phoneme property must be changed." },
  );

const guardedPhonemeEditSchema = z
  .object({
    noteIndex: indexSchema,
    fingerprint: fingerprintSchema.optional(),
    guardToken: guardTokenSchema
      .optional()
      .describe("Short Guard Token returned by a compact phoneme read."),
    changes: phonemePropertyChangesSchema,
  })
  .refine(
    (value) =>
      value.fingerprint !== undefined || value.guardToken !== undefined,
    { message: "Each edit requires fingerprint or guardToken." },
  );

const groupLocatorShape = {
  trackIndex: indexSchema.describe("1-based track storage index."),
  groupIndex: indexSchema
    .default(1)
    .describe("1-based group index. Group 1 is always the track's main group."),
  groupUuid: groupUuidSchema
    .optional()
    .describe("Optional group UUID. When present, the bridge verifies that it matches groupIndex."),
};

const currentOrGroupLocatorShape = {
  trackIndex: indexSchema
    .optional()
    .describe(
      "1-based track storage index. Omit all locators to use the current piano-roll Group.",
    ),
  groupIndex: indexSchema
    .optional()
    .describe(
      "1-based group index. Requires trackIndex; omit both to use the current piano-roll Group.",
    ),
  groupUuid: groupUuidSchema
    .optional()
    .describe(
      "Optional group UUID guard. Requires trackIndex and verifies groupIndex.",
    ),
};

const trackGuardShape = {
  trackIndex: indexSchema.describe("1-based track storage index."),
  trackFingerprint: fingerprintSchema
    .optional()
    .describe("Latest track fingerprint from list_tracks or get_track_notes."),
};

const noteCreateSchema = z.object({
  onset: blickSchema.describe("Group-local onset in blicks."),
  duration: durationSchema.describe("Duration in blicks."),
  pitch: midiPitchSchema.describe("Group-local MIDI pitch."),
  lyrics: z.string().default("la"),
  phonemes: z.string().optional(),
  detune: z.number().finite().optional().describe("Detune in cents."),
  languageOverride: languageOverrideSchema
    .optional()
    .describe("Optional per-note language; an empty string uses the group default."),
  musicalType: z.enum(["sing", "rap"]).optional(),
  pitchAutoMode: z.boolean().optional(),
  rapAccent: rapAccentSchema.optional(),
  attributes: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Partial SynthV note attribute object passed to Note:setAttributes."),
});

const noteChangesSchema = z
  .object({
    onset: blickSchema.optional(),
    duration: durationSchema.optional(),
    pitch: midiPitchSchema.optional(),
    lyrics: z.string().optional(),
    phonemes: z.string().optional(),
    detune: z.number().finite().optional(),
    languageOverride: languageOverrideSchema.optional(),
    musicalType: z.enum(["sing", "rap"]).optional(),
    pitchAutoMode: z.boolean().optional(),
    rapAccent: rapAccentSchema.optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value: Record<string, unknown>) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one note property must be changed.",
  });

const noteTransformSchema = z
  .object({
    onsetOffsetBlick: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Signed Group-local musical-time offset in blicks."),
    onsetOffsetSeconds: z
      .number()
      .finite()
      .optional()
      .describe(
        "Signed absolute-time offset in seconds. Mutually exclusive with onsetOffsetBlick; note durations remain in blicks.",
      ),
    durationScale: z
      .number()
      .finite()
      .min(0.000001)
      .max(1000)
      .optional()
      .describe(
        "Multiply each original duration before applying durationOffsetBlick.",
      ),
    durationOffsetBlick: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        "Signed blick offset applied after durationScale and rounding.",
      ),
    pitchOffsetSemitones: z
      .number()
      .int()
      .min(-127)
      .max(127)
      .optional()
      .describe("Signed MIDI-semitone offset."),
  })
  .refine(
    (value) =>
      value.onsetOffsetBlick === undefined ||
      value.onsetOffsetSeconds === undefined,
    {
      message:
        "onsetOffsetBlick and onsetOffsetSeconds are mutually exclusive.",
    },
  )
  .refine(
    (value) =>
      (value.onsetOffsetBlick ?? 0) !== 0 ||
      (value.onsetOffsetSeconds ?? 0) !== 0 ||
      (value.durationScale ?? 1) !== 1 ||
      (value.durationOffsetBlick ?? 0) !== 0 ||
      (value.pitchOffsetSemitones ?? 0) !== 0,
    { message: "At least one non-identity note transform is required." },
  );

const fingerprintedNoteSchema = z.object({
  noteIndex: indexSchema.describe("Current 1-based note index."),
  fingerprint: fingerprintSchema.describe(
    "Fingerprint from the latest note or selection read.",
  ),
});

const automationPointSchema = z.object({
  position: blickSchema.describe("Group-local position in blicks."),
  value: z.number().finite(),
});

const groupTuningNoteEditSchema = z
  .object({
    noteIndex: indexSchema,
    fingerprint: fingerprintSchema,
    changes: noteChangesSchema.optional(),
    phonemeChanges: phonemePropertyChangesSchema.optional(),
  })
  .refine(
    (value) =>
      value.changes !== undefined || value.phonemeChanges !== undefined,
    { message: "Each tuning note edit must change note or phoneme data." },
  );

const groupTuningAutomationSchema = z
  .object({
    parameter: z.string().min(1).max(200),
    expectedFingerprint: fingerprintSchema,
    clearMode: z.enum(["none", "all", "range"]).default("none"),
    rangeBegin: blickSchema.optional(),
    rangeEnd: blickSchema.optional(),
    points: z.array(automationPointSchema).max(10000).default([]),
  })
  .refine(
    (value) =>
      value.points.length > 0 || value.clearMode !== "none",
    { message: "Each automation update must add points or clear a curve." },
  )
  .refine(
    (value) =>
      value.clearMode === "range"
        ? value.rangeBegin !== undefined && value.rangeEnd !== undefined
        : value.rangeBegin === undefined && value.rangeEnd === undefined,
    {
      message:
        "rangeBegin and rangeEnd are required only when clearMode is range.",
    },
  );

const libraryGroupLocatorShape = {
  libraryIndex: indexSchema.optional(),
  groupUuid: groupUuidSchema.optional(),
  expectedFingerprint: fingerprintSchema.optional(),
};

const pitchControlCurvePointSchema = z.object({
  offset: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  value: z.number().finite().min(-127).max(127),
});

const pitchControlCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("point"),
    position: blickSchema,
    pitch: z.number().finite().min(-127).max(127),
  }),
  z.object({
    kind: z.literal("curve"),
    position: blickSchema,
    pitch: z.number().finite().min(-127).max(127),
    points: z.array(pitchControlCurvePointSchema).max(10000),
  }),
]);

const pitchControlChangesSchema = z
  .object({
    position: blickSchema.optional(),
    pitch: z.number().finite().min(-127).max(127).optional(),
    points: z.array(pitchControlCurvePointSchema).max(10000).optional(),
  })
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    { message: "At least one pitch-control field must be changed." },
  );

const retakeNoteShape = {
  ...groupLocatorShape,
  noteIndex: indexSchema,
};

const editorViewSchema = z.enum(["mainEditor", "arrangement"]);

const convertTimeInputSchema = z
  .object({
    blicks: blickSchema.optional(),
    quarters: z.number().finite().min(0).optional(),
    seconds: z.number().finite().min(0).optional(),
    roundInterval: z.number().int().min(1).optional(),
  })
  .refine(
    (value) =>
      [value.blicks, value.quarters, value.seconds].filter(
        (entry) => entry !== undefined,
      ).length === 1,
    { message: "Supply exactly one of blicks, quarters, or seconds." },
  );

const tempoMarkSchema = z.object({
  position: blickSchema,
  bpm: z.number().finite().min(1).max(1000),
});

const measureMarkSchema = z.object({
  measure: z.number().int().min(0),
  numerator: z.number().int().min(1).max(32),
  denominator: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
    z.literal(64),
  ]),
});

const timeAxisUpdateInputSchema = z
  .object({
    expectedFingerprint: fingerprintSchema.optional(),
    tempoMarks: z.array(tempoMarkSchema).max(1000).optional(),
    removeTempoPositions: z.array(blickSchema).max(1000).optional(),
    measureMarks: z.array(measureMarkSchema).max(1000).optional(),
    removeMeasurePositions: z
      .array(z.number().int().min(0))
      .max(1000)
      .optional(),
  })
  .refine(
    (value) =>
      [
        value.tempoMarks,
        value.removeTempoPositions,
        value.measureMarks,
        value.removeMeasurePositions,
      ].some((entries) => entries !== undefined && entries.length > 0),
    { message: "At least one time-axis operation must be supplied." },
  );

const trackMixerInputSchema = z
  .object({
    ...trackGuardShape,
    gainDecibel: z.number().min(-24).max(24).optional(),
    pan: z.number().min(-1).max(1).optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
  })
  .refine(
    (value: Record<string, unknown>) =>
      ["gainDecibel", "pan", "muted", "solo"].some(
        (field) => value[field] !== undefined,
      ),
    { message: "At least one mixer field must be changed." },
  );

const transactionStepSchema = z.object({
  action: z.enum(TRANSACTION_STEP_ACTIONS),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "Action payload. In forward steps after step 1, any complete field value may be {$result:{step:1,path:['field']}} to use an earlier step result.",
    ),
});

const MAX_LOCAL_SCORE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORTED_SCORE_NOTES = 512;

const localScoreFileSchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine((value) => path.isAbsolute(value), {
    message: "filePath must be an absolute local path.",
  });

const localScoreSelectionShape = {
  partIndex: indexSchema.optional().describe("1-based MusicXML part index."),
  partId: z.string().min(1).max(500).optional(),
  voice: z.string().min(1).max(100).optional(),
  staff: indexSchema.optional(),
  midiTrackIndex: indexSchema
    .optional()
    .describe("1-based SMF track index; this is separate from SynthV trackIndex."),
  midiChannel: z.number().int().min(1).max(16).optional(),
};

const localScoreConversionShape = {
  onsetBlickOffset: blickSchema.default(0),
  transposeSemitones: z.number().int().min(-127).max(127).default(0),
  defaultLyric: z.string().max(400).default("la"),
};

const localScoreReadShape = {
  filePath: localScoreFileSchema,
  maxFileBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(MAX_LOCAL_SCORE_BYTES),
};

interface LocalScoreSelectionInput {
  readonly partIndex?: number | undefined;
  readonly partId?: string | undefined;
  readonly voice?: string | undefined;
  readonly staff?: number | undefined;
  readonly midiTrackIndex?: number | undefined;
  readonly midiChannel?: number | undefined;
}

function scoreSelection(
  inspection: LocalScoreInspection,
  input: LocalScoreSelectionInput,
  requireUnambiguous: boolean,
): MusicXmlSelection | MidiSelection {
  const hasMusicXmlSelection =
    input.partIndex !== undefined ||
    input.partId !== undefined ||
    input.voice !== undefined ||
    input.staff !== undefined;
  const hasMidiSelection =
    input.midiTrackIndex !== undefined || input.midiChannel !== undefined;

  if (inspection.format === "musicxml") {
    if (hasMidiSelection) {
      throw new ScoreImportError(
        "INVALID_SCORE_SELECTION",
        "MusicXML selection cannot use midiTrackIndex or midiChannel.",
      );
    }
    const nonEmptyParts = inspection.parts.filter((part) => part.noteCount > 0);
    if (
      requireUnambiguous &&
      input.partIndex === undefined &&
      input.partId === undefined &&
      nonEmptyParts.length > 1
    ) {
      throw new ScoreImportError(
        "INVALID_SCORE_SELECTION",
        "MusicXML contains multiple non-empty parts; choose partIndex or partId from inspect_score_file.",
        { availableParts: nonEmptyParts.map((part) => ({
          partIndex: part.partIndex,
          partId: part.partId,
          name: part.name,
        })) },
      );
    }
    const fallbackPart = nonEmptyParts[0] ?? inspection.parts[0];
    return {
      ...(input.partIndex === undefined &&
      input.partId === undefined &&
      fallbackPart !== undefined
        ? { partIndex: fallbackPart.partIndex }
        : {}),
      ...(input.partIndex === undefined ? {} : { partIndex: input.partIndex }),
      ...(input.partId === undefined ? {} : { partId: input.partId }),
      ...(input.voice === undefined ? {} : { voice: input.voice }),
      ...(input.staff === undefined ? {} : { staff: input.staff }),
    };
  }

  if (hasMusicXmlSelection) {
    throw new ScoreImportError(
      "INVALID_SCORE_SELECTION",
      "MIDI selection cannot use MusicXML part, voice, or staff fields.",
    );
  }
  const nonEmptyTracks = inspection.tracks.filter((track) => track.noteCount > 0);
  if (
    requireUnambiguous &&
    input.midiTrackIndex === undefined &&
    nonEmptyTracks.length > 1
  ) {
    throw new ScoreImportError(
      "INVALID_SCORE_SELECTION",
      "MIDI contains multiple non-empty tracks; choose midiTrackIndex from inspect_score_file.",
      {
        availableTracks: nonEmptyTracks.map((track) => ({
          midiTrackIndex: track.trackIndex,
          name: track.name,
          noteCount: track.noteCount,
        })),
      },
    );
  }
  const trackIndex =
    input.midiTrackIndex ?? nonEmptyTracks[0]?.trackIndex ?? inspection.tracks[0]?.trackIndex;
  if (trackIndex === undefined) {
    throw new ScoreImportError(
      "NO_NOTES",
      "MIDI file contains no selectable track.",
    );
  }
  const selectedTrack = inspection.tracks.find(
    (track) => track.trackIndex === trackIndex,
  );
  const activeChannels =
    selectedTrack?.channels.filter((channel) => channel.noteCount > 0) ?? [];
  if (
    requireUnambiguous &&
    input.midiChannel === undefined &&
    activeChannels.length > 1
  ) {
    throw new ScoreImportError(
      "INVALID_SCORE_SELECTION",
      "Selected MIDI track contains multiple active channels; choose midiChannel from inspect_score_file.",
      {
        midiTrackIndex: trackIndex,
        availableChannels: activeChannels.map((channel) => channel.channel),
      },
    );
  }
  const channel =
    input.midiChannel ??
    (activeChannels.length === 1 ? activeChannels[0]?.channel : undefined);
  return channel === undefined ? { trackIndex } : { trackIndex, channel };
}

function compactScorePreview(
  preview: ScorePreview,
  noteLimit: number,
): Record<string, unknown> {
  return {
    ...preview,
    notes: preview.notes.slice(0, noteLimit),
    returnedNoteCount: Math.min(preview.noteCount, noteLimit),
    notesTruncated: preview.noteCount > noteLimit,
  };
}

function compactScoreImport(
  imported: LocalScoreImportResult,
  noteLimit: number,
): Record<string, unknown> {
  return {
    format: imported.format,
    sourcePath: imported.sourcePath,
    sourceSize: imported.sourceSize,
    container: imported.container,
    fileFingerprint: imported.fileFingerprint,
    selection: imported.selection,
    preview: compactScorePreview(imported.preview, noteLimit),
    tempoPointCount: imported.tempoMap.length,
    tempoMap: imported.tempoMap.slice(0, 256),
    tempoMapTruncated: imported.tempoMap.length > 256,
    warnings: imported.warnings,
  };
}

function asScoreBridgeError(error: unknown): unknown {
  return error instanceof ScoreImportError
    ? new BridgeError(error.message, error.code, error.details)
    : error;
}

function jsonToolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}

function errorToolResult(error: unknown): CallToolResult {
  const publicError = toPublicError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: publicError }),
      },
    ],
  };
}

async function runTool(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonToolResult(await operation());
  } catch (error) {
    return errorToolResult(error);
  }
}

export function createServer(config: BridgeConfig): McpServer {
  const client = new FileIpcClient(config);
  const guardTokens = new GuardTokenStore();
  const sidebar = new SidebarStatusMonitor(config);
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      websiteUrl: "https://github.com/zhoupengjie/synthv-agent-bridge",
    },
    {
      instructions:
        "Use sv_describe for unfamiliar capabilities. Query only the intended target with contextMode=writeIntent before sv_command. Indices are 1-based. Guards remain private, shared Group content fails closed, and one logical command uses one SynthV Undo boundary. sv_review reports the optional Sidebar runtime status.",
    },
  );
  const actionTools = new Map<string, RegisteredTool>();
  const registerPublicTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    toolConfig: unknown,
    handler: unknown,
  ) => {
    const registered = (
      registerPublicTool as unknown as (
        toolName: string,
        configValue: unknown,
        callback: unknown,
      ) => RegisteredTool
    )(name, toolConfig, handler);
    actionTools.set(name, registered);
    registered.disable();
    return registered;
  }) as McpServer["registerTool"];
  sidebar.start();
  server.server.onclose = () => {
    void sidebar.stop();
  };
  const closeServer = server.close.bind(server);
  let closePromise: Promise<void> | null = null;
  server.close = () => {
    if (closePromise !== null) {
      return closePromise;
    }
    const transportClose = Promise.resolve().then(closeServer);
    const sidebarClose = sidebar.stop();
    closePromise = (async () => {
      const [transportResult, sidebarResult] = await Promise.allSettled([
        transportClose,
        sidebarClose,
      ]);
      if (transportResult.status === "rejected") {
        throw transportResult.reason;
      }
      if (sidebarResult.status === "rejected") {
        throw sidebarResult.reason;
      }
    })();
    return closePromise;
  };

  server.registerTool(
    "bridge_status",
    {
      title: "SynthV Bridge Status",
      description:
        "Check whether the in-editor SynthV bridge script is running and whether its heartbeat is fresh.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => jsonToolResult(await client.getStatus()),
  );

  server.registerTool(
    "sidebar_status",
    {
      title: "Inspect SynthV Sidebar Status",
      description:
        "Read the MCP heartbeat and optional native side-panel runtime status.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => sidebar.getStatus()),
  );

  server.registerTool(
    "ping",
    {
      title: "Ping SynthV",
      description: "Round-trip a request through the SynthV in-editor script.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("ping")),
  );

  server.registerTool(
    "reload_bridge",
    {
      title: "Reload SynthV Bridge",
      description:
        "Hot-reload the installed Bridge Lua file inside the current SynthV script session without UI automation. The response is written before the old polling loop hands control to the reloaded script.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("reload_bridge", {})),
  );

  server.registerTool(
    "get_host_info",
    {
      title: "Get SynthV Host Info",
      description:
        "Read the running SynthV host version, OS, language, project file name, and bridge IPC location.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("get_host_info")),
  );

  server.registerTool(
    "host_clipboard",
    {
      title: "Use SynthV Host Clipboard",
      description:
        "Read text from or write text to the system clipboard through SynthV's official host API.",
      inputSchema: {
        operation: z.enum(["read", "write"]),
        text: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("host_clipboard", input)),
  );

  server.registerTool(
    "show_dialog",
    {
      title: "Show SynthV Dialog",
      description:
        "Show an official SynthV message, input, confirmation, or custom form dialog and return the user's response.",
      inputSchema: {
        kind: z.enum(["message", "input", "okCancel", "yesNoCancel", "custom"]),
        title: z.string().max(500).optional(),
        message: z.string().max(10000).optional(),
        defaultText: z.string().max(10000).optional(),
        form: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("show_dialog", input)),
  );

  server.registerTool(
    "convert_pitch",
    {
      title: "Convert SynthV Pitch",
      description:
        "Convert exactly one MIDI pitch or frequency value and report the corresponding value and keyboard-key type.",
      inputSchema: {
        pitch: z.number().finite().optional(),
        frequency: z.number().finite().positive().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("convert_pitch", input)),
  );

  server.registerTool(
    "get_project_info",
    {
      title: "Get SynthV Project",
      description:
        "Get current project metadata, timing constants, playback status, and current editor location.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("get_project_info")),
  );

  server.registerTool(
    "inspect_score_file",
    {
      title: "Inspect Local MusicXML or MIDI",
      description:
        "Read one explicitly supplied local MusicXML (.xml, .musicxml, or .mxl) or SMF MIDI (.mid or .midi) file without editing SynthV. Returns a SHA-256 file guard, 1-based selectable parts/voices/staves or tracks/channels, and a bounded monophonic note preview. URLs and .svp files are rejected; XML entities are never resolved.",
      inputSchema: {
        ...localScoreReadShape,
        ...localScoreSelectionShape,
        ...localScoreConversionShape,
        previewNoteLimit: z.number().int().min(1).max(512).default(64),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        try {
          const snapshot = await readLocalScoreSnapshot(input.filePath, {
            maxFileBytes: input.maxFileBytes,
          });
          const inspection = inspectScoreSnapshot(snapshot, {
            onsetBlickOffset: input.onsetBlickOffset,
          });
          let selectedPreview: Record<string, unknown> | undefined;
          let previewError: ReturnType<typeof toPublicError> | undefined;
          try {
            const selection = scoreSelection(inspection, input, false);
            const imported = importScoreSnapshotMonophonic(
              snapshot,
              selection,
              snapshot.fileFingerprint,
              {
                onsetBlickOffset: input.onsetBlickOffset,
                transposeSemitones: input.transposeSemitones,
                defaultLyric: input.defaultLyric,
              },
            );
            selectedPreview = compactScoreImport(
              imported,
              input.previewNoteLimit,
            );
          } catch (error) {
            previewError = toPublicError(asScoreBridgeError(error));
          }
          return {
            ...inspection,
            writesProject: false,
            sourceTempoAppliedToProject: false,
            ...(selectedPreview === undefined ? {} : { selectedPreview }),
            ...(previewError === undefined ? {} : { previewError }),
          };
        } catch (error) {
          throw asScoreBridgeError(error);
        }
      }),
  );

  server.registerTool(
    "get_time_axis",
    {
      title: "Get SynthV Time Axis",
      description:
        "Read bounded tempo and time-signature pages plus a full-state fingerprint for safe time-axis edits.",
      inputSchema: {
        tempoOffset: z.number().int().min(0).default(0),
        tempoLimit: z.number().int().min(1).max(1000).default(128),
        measureOffset: z.number().int().min(0).default(0),
        measureLimit: z.number().int().min(1).max(1000).default(128),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_time_axis", input)),
  );

  server.registerTool(
    "convert_time",
    {
      title: "Convert SynthV Time",
      description:
        "Convert exactly one position expressed as blicks, quarter notes, or seconds using the current tempo map, with optional official blick-grid rounding.",
      inputSchema: convertTimeInputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("convert_time", input)),
  );

  server.registerTool(
    "set_time_axis",
    {
      title: "Edit SynthV Time Axis",
      description:
        "Add, replace, or remove tempo and time-signature marks in one undo record. Copy expectedFingerprint from get_time_axis.",
      inputSchema: timeAxisUpdateInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("set_time_axis", input)),
  );

  server.registerTool(
    "list_tracks",
    {
      title: "List SynthV Tracks",
      description:
        "List a bounded page of tracks with 1-based storage indices, display order, group counts, note counts, and mixer state.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(128),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("list_tracks", input)),
  );

  server.registerTool(
    "list_note_groups",
    {
      title: "List SynthV Note-Group Library",
      description:
        "List a bounded page of reusable note groups with UUIDs, fingerprints, note counts, pitch-control counts, and reference counts.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(128),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("list_note_groups", input)),
  );

  server.registerTool(
    "create_note_group",
    {
      title: "Create SynthV Library Note Group",
      description:
        "Create a reusable note group in the project library, optionally populated with notes, as one undo record.",
      inputSchema: {
        name: z.string().min(1).max(200).default("New Group"),
        suggestedIndex: indexSchema.optional(),
        notes: z.array(noteCreateSchema).max(512).default([]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("create_note_group", input)),
  );

  server.registerTool(
    "clone_note_group",
    {
      title: "Clone SynthV Note Group",
      description:
        "Deep-clone either a track group or a library group into the reusable note-group library.",
      inputSchema: {
        ...libraryGroupLocatorShape,
        trackIndex: indexSchema.optional(),
        groupIndex: indexSchema.optional(),
        name: z.string().min(1).max(200).optional(),
        suggestedIndex: indexSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("clone_note_group", input)),
  );

  server.registerTool(
    "delete_note_group",
    {
      title: "Delete SynthV Library Note Group",
      description:
        "Delete one fingerprint-verified library group and all references that point to it.",
      inputSchema: libraryGroupLocatorShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("delete_note_group", input)),
  );

  server.registerTool(
    "add_group_reference",
    {
      title: "Add SynthV Group Reference",
      description:
        "Place a reusable library group on a track with timing, transpose, mute, visible range, and voice settings.",
      inputSchema: {
        ...trackGuardShape,
        targetGroupUuid: groupUuidSchema.optional(),
        targetLibraryIndex: indexSchema.optional(),
        targetFingerprint: fingerprintSchema.optional(),
        timeOffset: blickSchema.optional(),
        pitchOffset: z.number().int().min(-127).max(127).optional(),
        muted: z.boolean().optional(),
        timeRange: z
          .object({ onset: blickSchema, duration: durationSchema })
          .optional(),
        voice: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("add_group_reference", input)),
  );

  server.registerTool(
    "clone_group_reference",
    {
      title: "Clone SynthV Group Reference",
      description:
        "Copy a vocal Group Reference to another Track with explicit linked or isolated ownership.",
      inputSchema: {
        cloneIntent: z.enum(["linked", "isolated"]),
        sourceTrackIndex: indexSchema,
        sourceGroupIndex: indexSchema.default(1),
        sourceGroupUuid: groupUuidSchema.optional(),
        sourceReferenceFingerprint: fingerprintSchema.optional(),
        targetTrackIndex: indexSchema,
        targetTrackFingerprint: fingerprintSchema.optional(),
        name: z.string().min(1).max(200).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("clone_group_reference", input)),
  );

  server.registerTool(
    "get_track_notes",
    {
      title: "Get SynthV Track Notes",
      description:
        "Read one bounded Group/note page from a track, or one explicit Group. Returns private group/note guards for safe edit/delete Contexts.",
      inputSchema: {
        trackIndex: indexSchema.describe("1-based track storage index."),
        groupIndex: indexSchema
          .optional()
          .describe("Optional single 1-based Group page target."),
        groupOffset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Zero-based Group page offset when groupIndex is omitted."),
        groupLimit: z
          .number()
          .int()
          .min(1)
          .max(128)
          .default(1)
          .describe("Maximum Groups returned when groupIndex is omitted."),
        offset: z.number().int().min(0).default(0).describe("Number of notes to skip per group."),
        limit: z.number().int().min(1).max(5000).default(64).describe("Maximum notes returned per Group."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_track_notes", input)),
  );

  server.registerTool(
    "get_group_voice",
    {
      title: "Get SynthV Group Voice",
      description:
        "Read one vocal group's documented voice parameters, Vocal Modes, raw host properties, experimental Unison fields, and current/selected editor context. Omit all locators to use the current piano-roll Group. This does not expose or select the singer database.",
      inputSchema: currentOrGroupLocatorShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_group_voice", input)),
  );

  server.registerTool(
    "get_note_phoneme_data",
    {
      title: "Get SynthV Note Phoneme Data",
      description:
        "Read user phoneme overrides, phoneset and per-phoneme attributes together with computed phonemes and selection state. Prefer responseMode compact with noteIndices or startSeconds/endSeconds for tuning; compact notes return short Guard Tokens.",
      inputSchema: {
        ...groupLocatorShape,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(64),
        noteIndices: z
          .array(indexSchema)
          .min(1)
          .max(512)
          .optional()
          .describe("Optional exact 1-based note indices to return."),
        startSeconds: z
          .number()
          .finite()
          .min(0)
          .optional()
          .describe("Optional absolute range start; supply endSeconds too."),
        endSeconds: z
          .number()
          .finite()
          .min(0)
          .optional()
          .describe("Optional absolute range end; supply startSeconds too."),
        rangeMatch: z
          .enum(["overlap", "onset"])
          .default("overlap")
          .describe(
            "overlap preserves notes sustained across the range start; onset enables a faster binary seek and returns onset-only coverage.",
          ),
        includeComputedPhonemes: z
          .boolean()
          .optional()
          .describe(
            "Defaults true. Set false for a faster guard/override refresh that does not need host-computed phonemes.",
          ),
        includeRawAttributes: z
          .boolean()
          .optional()
          .describe("Defaults true in full mode and false in compact mode."),
        includeComputedAttributes: z
          .boolean()
          .optional()
          .describe("Defaults true in full mode and false in compact mode."),
        responseMode: responseModeSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const result = await client.send("get_note_phoneme_data", input);
        return input.responseMode === "compact"
          ? compactPhonemeGuards(result, guardTokens)
          : result;
      }),
  );

  server.registerTool(
    "get_phrase_context",
    {
      title: "Get Compact SynthV Phrase Context",
      description:
        "Read one compact, write-ready tuning context for a selected phrase or absolute time range: notes with pitch/timing/phonemes and Guard Tokens, Group voice and Vocal Modes, automation summaries with Guard Tokens, bounded phrase diagnostics, and recommendation-only review targets. If trackIndex is omitted, the current piano-roll Group is used.",
      inputSchema: {
        trackIndex: indexSchema
          .optional()
          .describe(
            "Optional 1-based track index. Omit to use the current piano-roll Group.",
          ),
        groupIndex: indexSchema.optional(),
        groupUuid: groupUuidSchema.optional(),
        cursorToken: guardTokenSchema
          .optional()
          .describe(
            "Continue a previous page without repeating its Group locator or numeric offset.",
          ),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(256).default(64),
        noteIndices: z
          .array(indexSchema)
          .min(1)
          .max(256)
          .optional()
          .describe("Optional exact 1-based note indices."),
        startSeconds: z
          .number()
          .finite()
          .min(0)
          .optional()
          .describe("Optional absolute phrase start; supply endSeconds too."),
        endSeconds: z
          .number()
          .finite()
          .min(0)
          .optional()
          .describe("Optional absolute phrase end; supply startSeconds too."),
        ranges: z
          .array(
            z.object({
              startSeconds: z.number().finite().min(0),
              endSeconds: z.number().finite().min(0),
              label: z.string().min(1).max(200).optional(),
            }),
          )
          .min(1)
          .max(32)
          .optional()
          .describe(
            "Optional disjoint absolute ranges analyzed with one bounded Group sweep and one shared note array.",
          ),
        rangeMatch: z
          .enum(["overlap", "onset"])
          .default("overlap")
          .describe(
            "overlap gives complete crossing-sustain coverage; onset enables binary-seek coverage.",
          ),
        preferSelectedNotes: z
          .boolean()
          .default(true)
          .describe(
            "When no explicit notes or time range are supplied, use selected notes in the current target Group.",
          ),
        includeComputedPhonemes: z
          .boolean()
          .default(true)
          .describe(
            "Disable for a faster pitch/rhythm/Guard refresh that does not need host-computed phonemes.",
          ),
        automationParameters: z
          .array(z.string().min(1).max(200))
          .max(8)
          .default(["loudness", "tension", "breathiness"])
          .describe(
            "Automation curves to summarize over the phrase and return as compact Guard Tokens.",
          ),
        pitchAnalysisFrames: z
          .number()
          .int()
          .min(0)
          .max(256)
          .default(0)
          .describe(
            "Optional computed-pitch frames to summarize without returning the raw contour. Zero skips the host pitch computation.",
          ),
        breathGapSeconds: z
          .number()
          .finite()
          .min(0.05)
          .max(2)
          .default(0.18),
        recommendationLimit: z.number().int().min(0).max(32).default(12),
        include: z
          .array(
            z.enum([
              "notes",
              "voice",
              "automation",
              "analysis",
              "recommendations",
              "pitchAnalysis",
              "selection",
              "diagnostics",
            ]),
          )
          .max(8)
          .optional()
          .describe(
            "Optional v3 projection. Omit for the complete phrase response.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const payload = resolvePhraseCursorPayload(input, guardTokens);
        const result = await client.send("get_phrase_context", payload);
        return compactPhraseContextGuards(result, guardTokens);
      }),
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get SynthV Selection",
      description:
        "Get selected groups, notes, Smart Pitch controls, requested automation points, and unfinished-edit state.",
      inputSchema: {
        automationParameters: z.array(z.string().min(1)).max(64).default([]),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_selection", input)),
  );

  server.registerTool(
    "set_selection",
    {
      title: "Set SynthV Selection",
      description:
        "Replace, add, remove, or clear arrangement or piano-roll selections for non-main groups, notes, Smart Pitch controls, or automation points.",
      inputSchema: {
        scope: z.enum(["pianoRoll", "arrangement"]).default("pianoRoll"),
        operation: z.enum(["replace", "add", "remove", "clear"]),
        kind: z.enum(["all", "groups", "notes", "pitchControls", "automationPoints"]),
        trackIndex: indexSchema.optional(),
        groupIndex: indexSchema.optional(),
        groupUuid: groupUuidSchema.optional(),
        groups: z
          .array(
            z.object({
              trackIndex: indexSchema,
              groupIndex: indexSchema.default(1),
              groupUuid: groupUuidSchema.optional(),
            }),
          )
          .max(512)
          .optional(),
        notes: z
          .array(
            z.object({
              noteIndex: indexSchema,
              fingerprint: fingerprintSchema.optional(),
            }),
          )
          .max(512)
          .optional(),
        pitchControls: z
          .array(
            z.object({
              pitchControlIndex: indexSchema,
              fingerprint: fingerprintSchema.optional(),
            }),
          )
          .max(512)
          .optional(),
        parameter: z.string().min(1).optional(),
        positions: z.array(blickSchema).max(10000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("set_selection", input)),
  );

  server.registerTool(
    "get_computed_group_data",
    {
      title: "Get Computed SynthV Group Data",
      description:
        "Read SynthV's computed phoneme/rap attributes and optionally sample the rendered pitch contour for one group. Computation may still be pending.",
      inputSchema: {
        ...groupLocatorShape,
        includeAttributes: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(64)
          .describe(
            "Maximum computed phoneme/attribute entries returned for this page.",
          ),
        pitchSample: z
          .object({
            absoluteStart: blickSchema,
            interval: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            frames: z.number().int().min(1).max(10000),
          })
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_computed_group_data", input)),
  );

  server.registerTool(
    "add_track",
    {
      title: "Add SynthV Track",
      description: "Create a vocal track with a main note group.",
      inputSchema: {
        name: z.string().min(1).max(200).default("New Track"),
        displayColor: displayColorSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("add_track", input)),
  );

  server.registerTool(
    "update_track",
    {
      title: "Update SynthV Track",
      description:
        "Rename or recolor a track, or control whether it is included by the Render Panel.",
      inputSchema: {
        ...trackGuardShape,
        name: z.string().min(1).max(200).optional(),
        displayColor: displayColorSchema.optional(),
        bounced: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("update_track", input)),
  );

  server.registerTool(
    "clone_track",
    {
      title: "Clone SynthV Track",
      description:
        "Create an isolated Track clone whose vocal GroupContent targets are UUID-separated. Non-main vocal Groups require explicit detachment and manual Vocal review because the official API cannot read or verify their Vocal identities.",
      inputSchema: {
        cloneIntent: z.enum(["isolated"]),
        ...trackGuardShape,
        name: z.string().min(1).max(200).optional(),
        displayColor: displayColorSchema.optional(),
        bounced: z.boolean().optional(),
        clearNotes: z.boolean().default(false),
        transposeSemitones: z.number().int().min(-127).max(127).default(0),
        nonMainGroupPolicy: z
          .enum(["reject", "detach"])
          .default("reject")
          .describe(
            "Reject tracks with non-main vocal Groups by default. detach clones their content into independent library Groups, but their Vocal assignments must be reviewed manually.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("clone_track", input)),
  );

  server.registerTool(
    "clone_track_shell",
    {
      title: "Create Vocal Template Track",
      description:
        "Clone only a source track's host-owned main Vocal context into a new empty track. Notes, pitch controls, known automation, and every non-main Group are removed before insertion. The official API cannot reveal the Vocal database identity, so the result reports host-clone inheritance without naming the Vocal.",
      inputSchema: {
        cloneIntent: z.enum(["shell"]),
        ...trackGuardShape,
        name: z.string().min(1).max(200).optional(),
        groupName: z.string().min(1).max(200).optional(),
        displayColor: displayColorSchema.optional(),
        bounced: z.boolean().default(false),
        copyMixer: z
          .boolean()
          .default(false)
          .describe(
            "Copy the source mixer when true; otherwise reset gain, pan, mute, and solo.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("clone_track_shell", input)),
  );

  server.registerTool(
    "delete_track",
    {
      title: "Delete SynthV Track",
      description:
        "Delete one fingerprint-verified track. The bridge refuses to delete the project's final track.",
      inputSchema: trackGuardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("delete_track", input)),
  );

  server.registerTool(
    "update_group",
    {
      title: "Update SynthV Group",
      description:
        "Rename a vocal note group or edit a vocal/instrumental reference's mute, offset, transpose, visible range, and supported voice properties.",
      inputSchema: {
        ...groupLocatorShape,
        referenceFingerprint: fingerprintSchema.optional(),
        name: z.string().min(1).max(200).optional(),
        muted: z.boolean().optional(),
        timeOffset: blickSchema.optional(),
        pitchOffset: z.number().int().min(-127).max(127).optional(),
        timeRange: z
          .object({
            onset: blickSchema,
            duration: durationSchema,
          })
          .optional(),
        voice: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("update_group", input)),
  );

  server.registerTool(
    "set_group_voice",
    {
      title: "Set SynthV Group Voice",
      description:
        "Safely update documented group voice defaults and 0..150 Vocal Mode axes. An empty vocalModes read means no non-default values are stored, not unsupported modes. Use exact names supplied by the user or identified from their panel screenshot, batch them in one call, and do not probe guesses. If VOCAL_MODE_NOT_FOUND is returned, ask once for the current singer's exact names. Experimental Unison fields are accepted only when the host returns and retains them.",
      inputSchema: {
        ...groupLocatorShape,
        referenceFingerprint: fingerprintSchema.describe(
          "Latest reference fingerprint from get_group_voice or get_track_notes.",
        ),
        requireCurrentEditorGroup: z
          .boolean()
          .default(false)
          .describe(
            "Reject unless this target is the current piano-roll group. Use when the user refers to the current or selected singer/group.",
          ),
        parameters: groupVoiceParameterChangesSchema.optional(),
        vocalModes: z.array(vocalModeChangesSchema).min(1).max(64).optional(),
        experimentalUnison: experimentalUnisonChangesSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("set_group_voice", input)),
  );

  server.registerTool(
    "apply_group_tuning",
    {
      title: "Apply SynthV Group Tuning Batch",
      description:
        "Prevalidate and apply one same-Group tuning pass: Group Voice/Vocal Modes, fingerprint-guarded note and phoneme edits, multiple fingerprint-guarded automation curves, and Smart Pitch controls. The Lua host validates the complete batch before creating exactly one SynthV undo record; an unexpected execution failure explicitly requires one SynthV Undo.",
      inputSchema: {
        ...groupLocatorShape,
        summary: z.string().min(1).max(1000),
        referenceFingerprint: fingerprintSchema
          .optional()
          .describe("Required when voice changes are included."),
        requireCurrentEditorGroup: z
          .boolean()
          .default(false)
          .describe(
            "Reject unless this target is the current piano-roll Group.",
          ),
        voice: z
          .object({
            parameters: groupVoiceParameterChangesSchema.optional(),
            vocalModes: z
              .array(vocalModeChangesSchema)
              .min(1)
              .max(64)
              .optional(),
            experimentalUnison: experimentalUnisonChangesSchema.optional(),
          })
          .optional(),
        noteEdits: z
          .array(groupTuningNoteEditSchema)
          .min(1)
          .max(512)
          .optional(),
        automations: z
          .array(groupTuningAutomationSchema)
          .min(1)
          .max(32)
          .optional(),
        pitchControls: z
          .object({
            add: z
              .array(pitchControlCreateSchema)
              .min(1)
              .max(512)
              .optional(),
            edits: z
              .array(
                z.object({
                  pitchControlIndex: indexSchema,
                  fingerprint: fingerprintSchema,
                  changes: pitchControlChangesSchema,
                }),
              )
              .min(1)
              .max(512)
              .optional(),
            deletes: z
              .array(
                z.object({
                  pitchControlIndex: indexSchema,
                  fingerprint: fingerprintSchema,
                }),
              )
              .min(1)
              .max(512)
              .optional(),
          })
          .refine(
            (value) =>
              value.add !== undefined ||
              value.edits !== undefined ||
              value.deletes !== undefined,
            {
              message:
                "Smart Pitch tuning must add, edit, or delete at least one control.",
            },
          )
          .optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("apply_group_tuning", input)),
  );

  server.registerTool(
    "delete_group_reference",
    {
      title: "Delete SynthV Group Reference",
      description:
        "Remove one fingerprint-verified non-main vocal or instrumental group reference. The underlying library group is preserved.",
      inputSchema: {
        ...groupLocatorShape,
        referenceFingerprint: fingerprintSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("delete_group_reference", input)),
  );

  server.registerTool(
    "import_monophonic_score",
    {
      title: "Import Local Monophonic Score",
      description:
        "Convert one inspected, rights-cleared local MusicXML or SMF MIDI lane into Group-local SynthV notes and apply it through the ordinary guarded add_notes path in exactly one undo record. The SHA-256 guard must still match; ambiguous selection, overlap/polyphony, unsafe XML, more than 512 notes, URLs, and .svp files are rejected before any project write. Source tempo is reported but never silently applied to the project.",
      inputSchema: {
        ...groupLocatorShape,
        ...localScoreReadShape,
        ...localScoreSelectionShape,
        ...localScoreConversionShape,
        expectedFileFingerprint: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/u)
          .describe("Fresh fileFingerprint returned by inspect_score_file."),
        rightsConfirmed: z
          .literal(true)
          .describe(
            "Confirm that the user is authorized to import this local score.",
          ),
        grouping: z
          .enum(["target", "ensureNonMain"])
          .default("ensureNonMain")
          .describe(
            "ensureNonMain safely creates an editable non-main Group when the target is the track main Group.",
          ),
        groupName: z.string().min(1).max(200).optional(),
        sharedGroupPolicy: z
          .enum(["reject", "allowAllReferences"])
          .default("reject"),
        expectedReferenceCount: z.number().int().min(1).optional(),
        previewNoteLimit: z.number().int().min(1).max(512).default(64),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        try {
          const snapshot = await readLocalScoreSnapshot(input.filePath, {
            maxFileBytes: input.maxFileBytes,
          });
          const inspection = inspectScoreSnapshot(snapshot, {
            onsetBlickOffset: input.onsetBlickOffset,
          });
          const selection = scoreSelection(inspection, input, true);
          const imported = importScoreSnapshotMonophonic(
            snapshot,
            selection,
            input.expectedFileFingerprint,
            {
              onsetBlickOffset: input.onsetBlickOffset,
              transposeSemitones: input.transposeSemitones,
              defaultLyric: input.defaultLyric,
            },
          );
          if (imported.notes.length > MAX_IMPORTED_SCORE_NOTES) {
            throw new BridgeError(
              `The selected score lane contains ${imported.notes.length} notes; SynthV imports are limited to ${MAX_IMPORTED_SCORE_NOTES} notes per undo record.`,
              "SCORE_NOTE_LIMIT_EXCEEDED",
              {
                noteCount: imported.notes.length,
                maximum: MAX_IMPORTED_SCORE_NOTES,
                requiredAction:
                  "Select a smaller source lane or split the legal source file before importing.",
              },
            );
          }
          const hostResult = await client.send("add_notes", {
            trackIndex: input.trackIndex,
            groupIndex: input.groupIndex,
            ...(input.groupUuid === undefined
              ? {}
              : { groupUuid: input.groupUuid }),
            notes: imported.notes,
            grouping: input.grouping,
            ...(input.groupName === undefined
              ? {}
              : { groupName: input.groupName }),
            sharedGroupPolicy: input.sharedGroupPolicy,
            ...(input.expectedReferenceCount === undefined
              ? {}
              : {
                  expectedReferenceCount: input.expectedReferenceCount,
                }),
          });
          const hostRecord =
            typeof hostResult === "object" &&
            hostResult !== null &&
            !Array.isArray(hostResult)
              ? (hostResult as Record<string, unknown>)
              : { hostResult };
          return {
            ...hostRecord,
            sourceScore: compactScoreImport(
              imported,
              input.previewNoteLimit,
            ),
            sourceTempoAppliedToProject: false,
            undoRecordCount: 1,
          };
        } catch (error) {
          throw asScoreBridgeError(error);
        }
      }),
  );

  server.registerTool(
    "add_notes",
    {
      title: "Add SynthV Notes",
      description:
        "Add notes to a target group. With grouping=ensureNonMain, a main-group target is replaced by a new reusable non-main group/reference so its Voice and Vocal Modes can be edited. Onset and pitch remain target-group-local. The operation is one undo record.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z.array(noteCreateSchema).min(1).max(512),
        grouping: z
          .enum(["target", "ensureNonMain"])
          .optional()
          .describe(
            "target writes to the exact target group. ensureNonMain creates a reusable non-main group/reference when the target is the track main group.",
          ),
        groupName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional name for an automatically created note group."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("add_notes", input)),
  );

  server.registerTool(
    "edit_notes",
    {
      title: "Edit SynthV Notes",
      description:
        "Safely edit notes in one group. Each edit must include the fingerprint returned by the latest get_track_notes or get_selection call.",
      inputSchema: {
        ...groupLocatorShape,
        edits: z
          .array(
            z.object({
              noteIndex: indexSchema.describe("Current 1-based note index inside the target group."),
              fingerprint: fingerprintSchema,
              changes: noteChangesSchema,
            }),
          )
          .min(1)
          .max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("edit_notes", input)),
  );

  server.registerTool(
    "transform_notes",
    {
      title: "Transform SynthV Notes",
      description:
        "Apply one explicit numeric transform to a fingerprint-guarded note batch. The Bridge performs only deterministic onset, duration, and pitch mechanics; the Agent remains responsible for choosing targets and values. With MCP v3, args.target=contextNotes expands every note from a fresh writeIntent contextId without repeating note indices.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z.array(fingerprintedNoteSchema).min(1).max(512),
        transform: noteTransformSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("transform_notes", input)),
  );

  server.registerTool(
    "set_note_phoneme_properties",
    {
      title: "Set SynthV Note Phoneme Properties",
      description:
        "Safely edit fingerprint- or Guard-verified phoneme sequences, language/phoneset overrides, syllable timing, and per-phoneme timing/strength attributes. Compact mode returns only counts and fresh Guard Tokens.",
      inputSchema: {
        ...groupLocatorShape,
        requireCurrentEditorGroup: z
          .boolean()
          .default(false)
          .describe(
            "Reject unless this target is the current piano-roll group.",
          ),
        requireSelectedNotes: z
          .boolean()
          .default(false)
          .describe(
            "Reject unless every edited note is currently selected in the target piano-roll group.",
          ),
        responseMode: responseModeSchema,
        edits: z.array(guardedPhonemeEditSchema).min(1).max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const payload = resolvePhonemeGuardPayload(input, guardTokens);
        const result = await client.send(
          "set_note_phoneme_properties",
          payload,
        );
        return input.responseMode === "compact"
          ? compactPhonemeGuards(result, guardTokens)
          : result;
      }),
  );

  server.registerTool(
    "delete_notes",
    {
      title: "Delete SynthV Notes",
      description:
        "Safely delete notes in one group. Each target must include the fingerprint returned by the latest read.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z
          .array(
            z.object({
              noteIndex: indexSchema,
              fingerprint: fingerprintSchema,
            }),
          )
          .min(1)
          .max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("delete_notes", input)),
  );

  server.registerTool(
    "get_note_retakes",
    {
      title: "Get SynthV Note Retakes",
      description:
        "Read a note's retake count and the take IDs previously generated and tracked by this bridge.",
      inputSchema: retakeNoteShape,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_note_retakes", input)),
  );

  server.registerTool(
    "generate_note_retake",
    {
      title: "Generate SynthV Note Retake",
      description:
        "Generate a fingerprint-verified AI retake with independent duration, pitch, and timbre variation controls.",
      inputSchema: {
        ...retakeNoteShape,
        fingerprint: fingerprintSchema,
        newDuration: z.boolean().default(true),
        newPitch: z.boolean().default(true),
        newTimbre: z.boolean().default(true),
        activate: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("generate_note_retake", input)),
  );

  server.registerTool(
    "activate_note_retake",
    {
      title: "Activate SynthV Note Retake",
      description:
        "Activate the default take or a take ID generated and tracked by this bridge.",
      inputSchema: {
        ...retakeNoteShape,
        fingerprint: fingerprintSchema,
        takeId: z.number().int().min(0),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("activate_note_retake", input)),
  );

  server.registerTool(
    "delete_note_retake",
    {
      title: "Delete SynthV Note Retake",
      description:
        "Delete a non-default take ID generated and tracked by this bridge.",
      inputSchema: {
        ...retakeNoteShape,
        fingerprint: fingerprintSchema,
        takeId: z.number().int().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("delete_note_retake", input)),
  );

  server.registerTool(
    "get_pitch_controls",
    {
      title: "Get SynthV Smart Pitch Controls",
      description:
        "Read a bounded page of point and curve Smart Pitch controls in one vocal group with private safe-write guards.",
      inputSchema: {
        ...groupLocatorShape,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(1000).default(64),
        sampleOffsets: z
          .array(
            z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
          )
          .min(1)
          .max(10000)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_pitch_controls", input)),
  );

  server.registerTool(
    "add_pitch_controls",
    {
      title: "Add SynthV Smart Pitch Controls",
      description:
        "Add point or curve Smart Pitch controls to one vocal group in one undo record.",
      inputSchema: {
        ...groupLocatorShape,
        pitchControls: z.array(pitchControlCreateSchema).min(1).max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("add_pitch_controls", input)),
  );

  server.registerTool(
    "edit_pitch_controls",
    {
      title: "Edit SynthV Smart Pitch Controls",
      description:
        "Edit fingerprint-verified point or curve Smart Pitch controls atomically.",
      inputSchema: {
        ...groupLocatorShape,
        edits: z
          .array(
            z.object({
              pitchControlIndex: indexSchema,
              fingerprint: fingerprintSchema,
              changes: pitchControlChangesSchema,
            }),
          )
          .min(1)
          .max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("edit_pitch_controls", input)),
  );

  server.registerTool(
    "delete_pitch_controls",
    {
      title: "Delete SynthV Smart Pitch Controls",
      description:
        "Delete fingerprint-verified Smart Pitch controls from one group atomically.",
      inputSchema: {
        ...groupLocatorShape,
        pitchControls: z
          .array(
            z.object({
              pitchControlIndex: indexSchema,
              fingerprint: fingerprintSchema,
            }),
          )
          .min(1)
          .max(512),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("delete_pitch_controls", input)),
  );

  server.registerTool(
    "get_automation",
    {
      title: "Get SynthV Automation",
      description:
        "Read the official definition and a compact curve summary, or the control points in one explicit closed range. The private curve fingerprint is retained only for Context/Guard creation.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        rangeBegin: blickSchema.optional(),
        rangeEnd: blickSchema.optional(),
        responseMode: responseModeSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const result = await client.send("get_automation", input);
        return input.responseMode === "compact"
          ? compactAutomationGuard(result, guardTokens)
          : result;
      }),
  );

  server.registerTool(
    "sample_automation",
    {
      title: "Sample SynthV Automation",
      description:
        "Evaluate a group automation curve at requested positions using native or forced-linear interpolation. Compact mode returns a short Guard Token.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        positions: z.array(blickSchema).min(1).max(10000),
        interpolation: z.enum(["native", "linear"]).default("native"),
        responseMode: responseModeSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const result = await client.send("sample_automation", input);
        return input.responseMode === "compact"
          ? compactAutomationGuard(result, guardTokens)
          : result;
      }),
  );

  server.registerTool(
    "simplify_automation",
    {
      title: "Simplify SynthV Automation",
      description:
        "Remove insignificant automation points within a range using SynthV's official curve simplifier.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        expectedFingerprint: fingerprintSchema.optional(),
        beginPosition: blickSchema,
        endPosition: blickSchema,
        threshold: z.number().finite().min(0).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("simplify_automation", input)),
  );

  server.registerTool(
    "set_automation_points",
    {
      title: "Set SynthV Automation Points",
      description:
        "Add or update group-local automation points using an expected fingerprint or compact Guard Token. Optionally clear points first; compact mode omits the full resulting curve.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        expectedFingerprint: fingerprintSchema
          .optional()
          .describe("Latest automation fingerprint from get_automation."),
        expectedGuardToken: guardTokenSchema
          .optional()
          .describe("Short Guard Token returned by a compact automation read."),
        clearMode: z.enum(["none", "all", "range"]).default("none"),
        rangeBegin: blickSchema.optional(),
        rangeEnd: blickSchema.optional(),
        points: z.array(automationPointSchema).min(1).max(10000),
        responseMode: responseModeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const payload = resolveAutomationGuardPayload(input, guardTokens);
        const result = await client.send("set_automation_points", payload);
        return input.responseMode === "compact"
          ? compactAutomationGuard(result, guardTokens)
          : result;
      }),
  );

  server.registerTool(
    "clear_automation",
    {
      title: "Clear SynthV Automation",
      description:
        "Remove all automation points for a group parameter, or only points inside an inclusive blick range.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        expectedFingerprint: fingerprintSchema
          .optional()
          .describe("Latest automation fingerprint from get_automation."),
        rangeBegin: blickSchema.optional(),
        rangeEnd: blickSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("clear_automation", input)),
  );

  server.registerTool(
    "get_editor_view",
    {
      title: "Get SynthV Editor View",
      description:
        "Read the visible time/value ranges and pixel scales of the main editor or arrangement.",
      inputSchema: {
        view: editorViewSchema.default("mainEditor"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_editor_view", input)),
  );

  server.registerTool(
    "set_editor_view",
    {
      title: "Set SynthV Editor View",
      description:
        "Move or scale the visible main-editor or arrangement viewport without changing project data.",
      inputSchema: {
        view: editorViewSchema.default("mainEditor"),
        timeLeft: z.number().finite().optional(),
        timeRight: z.number().finite().optional(),
        timeScale: z.number().finite().positive().optional(),
        valueCenter: z.number().finite().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("set_editor_view", input)),
  );

  server.registerTool(
    "snap_position",
    {
      title: "Snap SynthV Position",
      description:
        "Round a blick position using the selected editor view's current snapping settings.",
      inputSchema: {
        view: editorViewSchema.default("mainEditor"),
        position: z.number().finite(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("snap_position", input)),
  );

  server.registerTool(
    "convert_editor_coordinates",
    {
      title: "Convert SynthV Editor Coordinates",
      description:
        "Convert between musical time/value coordinates and on-screen x/y coordinates for an editor view.",
      inputSchema: {
        view: editorViewSchema.default("mainEditor"),
        time: z.number().finite().optional(),
        x: z.number().finite().optional(),
        value: z.number().finite().optional(),
        y: z.number().finite().optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("convert_editor_coordinates", input)),
  );

  server.registerTool(
    "script_data",
    {
      title: "Use SynthV Bridge Metadata",
      description:
        "List, read, set, or remove JSON metadata on a SynthV object. Keys are restricted to the synthv-agent-bridge namespace.",
      inputSchema: {
        operation: z.enum(["list", "get", "set", "remove"]),
        objectType: z.enum([
          "project",
          "timeAxis",
          "track",
          "mixer",
          "group",
          "reference",
          "note",
          "retakes",
          "automation",
          "pitchControl",
        ]),
        key: z.string().min(1).optional(),
        value: z.unknown().optional(),
        trackIndex: indexSchema.optional(),
        trackFingerprint: fingerprintSchema.optional(),
        groupIndex: indexSchema.optional(),
        groupUuid: groupUuidSchema.optional(),
        referenceFingerprint: fingerprintSchema.optional(),
        noteIndex: indexSchema.optional(),
        fingerprint: fingerprintSchema.optional(),
        parameter: z.string().min(1).optional(),
        expectedFingerprint: fingerprintSchema.optional(),
        pitchControlIndex: indexSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("script_data", input)),
  );

  server.registerTool(
    "get_track_mixer",
    {
      title: "Get SynthV Track Mixer",
      description: "Read gain, pan, mute, and solo state for one track.",
      inputSchema: {
        trackIndex: indexSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("get_track_mixer", input)),
  );

  server.registerTool(
    "set_track_mixer",
    {
      title: "Set SynthV Track Mixer",
      description:
        "Set one or more mixer fields. Gain is limited to -24..24 dB and pan to -1..1. Copy trackFingerprint from the latest track read.",
      inputSchema: trackMixerInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("set_track_mixer", input)),
  );

  server.registerTool(
    "apply_transaction",
    {
      title: "Apply SynthV Transaction",
      description:
        "Preflight all independent project writes, resolve dependent steps from earlier results, and execute the batch in one SynthV undo record. Independent validation failures leave the project unchanged. Dependent validation or host execution can fail after writes begin; the error reports failedStepIndex and whether one SynthV Undo is required. Optional reverse steps are stored for guarded rollback during the current Bridge session.",
      inputSchema: {
        summary: z.string().min(1).max(1000),
        steps: z
          .array(transactionStepSchema)
          .min(1)
          .max(32)
          .describe(
            "Ordered project writes. A step may reference only earlier step results with {$result:{step:N,path:[...]}}. Steps without such references are fully preflighted before the single undo record.",
          ),
        rollbackSteps: z
          .array(transactionStepSchema)
          .max(32)
          .optional()
          .describe(
            "Optional reverse steps. Payload values may use {$result:{step:1,path:['field']}} references to forward results.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => {
        const payload = resolveTransactionGuardPayload(input, guardTokens);
        const result = await client.send("apply_transaction", payload);
        return compactTransactionGuards(payload, result, guardTokens);
      }),
  );

  server.registerTool(
    "rollback_transaction",
    {
      title: "Rollback SynthV Transaction",
      description:
        "Execute the guarded reverse steps stored by apply_transaction. Current fingerprints must still match, and the rollback becomes one new SynthV undo record.",
      inputSchema: {
        transactionId: z.string().min(1).max(300),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("rollback_transaction", input)),
  );

  server.registerTool(
    "create_harmony_track",
    {
      title: "Create SynthV Harmony Track",
      description:
        "Clone a fingerprint-verified vocal track, transpose its notes, keep pitches inside an optional voice range by octave displacement, and set the cloned track mixer in one undo record. Non-main vocal Groups require the same explicit detach-and-review policy as clone_track.",
      inputSchema: {
        sourceTrackIndex: indexSchema,
        sourceTrackFingerprint: fingerprintSchema,
        name: z.string().min(1).max(200).optional(),
        intervalSemitones: z.number().int().min(-36).max(36).refine((v) => v !== 0),
        minimumPitch: midiPitchSchema.default(0),
        maximumPitch: midiPitchSchema.default(127),
        rangePolicy: z.enum(["reject", "octave"]).default("octave"),
        nonMainGroupPolicy: z
          .enum(["reject", "detach"])
          .default("reject"),
        gainDecibel: z.number().finite().min(-24).max(24).optional(),
        pan: z.number().finite().min(-1).max(1).optional(),
        displayColor: displayColorSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("create_harmony_track", input)),
  );

  server.registerTool(
    "humanize_notes",
    {
      title: "Humanize SynthV Note Timing",
      description:
        "Apply deterministic, fingerprint-guarded onset and duration variation to a note set. Chords can share one onset offset so their internal timing remains aligned.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z.array(fingerprintedNoteSchema).min(1).max(512),
        seed: z.number().int().min(0).max(2_147_483_647).default(1),
        maxOnsetOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        maxDurationOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        preserveChords: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("humanize_notes", input)),
  );

  server.registerTool(
    "apply_expression_preset",
    {
      title: "Apply SynthV Expression Preset",
      description:
        "Apply a fingerprint-guarded scoop, falloff, vibrato, crescendo, or breathiness preset using documented note attributes and group automation.",
      inputSchema: {
        ...groupLocatorShape,
        preset: z.enum([
          "scoop",
          "falloff",
          "vibrato",
          "crescendo",
          "breathiness",
        ]),
        notes: z.array(fingerprintedNoteSchema).min(1).max(512).optional(),
        expectedAutomationFingerprint: fingerprintSchema.optional(),
        beginPosition: blickSchema.optional(),
        endPosition: blickSchema.optional(),
        strength: z.number().finite().min(0).max(2).default(1),
        startValue: z.number().finite().optional(),
        endValue: z.number().finite().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("apply_expression_preset", input)),
  );

  server.registerTool(
    "fit_lyrics",
    {
      title: "Fit Lyrics to SynthV Notes",
      description:
        "Assign one supplied lyric syllable and optional phoneme sequence to each fingerprint-verified note in one undo record.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z.array(fingerprintedNoteSchema).min(1).max(512),
        syllables: z.array(z.string().max(1000)).min(1).max(512),
        phonemes: z.array(z.string().max(4000)).max(512).optional(),
        fillRemainder: z.enum(["reject", "keep", "hyphen"]).default("reject"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("fit_lyrics", input)),
  );

  server.registerTool(
    "playback",
    {
      title: "Control SynthV Playback",
      description:
        "Play, pause, stop, seek, loop, or read the current playback state. Times are in seconds.",
      inputSchema: {
        operation: z.enum(["status", "play", "pause", "stop", "seek", "loop"]),
        timeSeconds: z.number().finite().min(0).optional(),
        endSeconds: z.number().finite().min(0).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("playback", input)),
  );

  assertV3CommandPolicyCatalog(actionTools);

  registerV3Facade(
    registerPublicTool,
    actionTools,
    guardTokens,
    async () => (await client.getStatus()).status?.sessionToken,
    async () => sidebar.getRuntimeBuildIdentity(),
  );

  return server;
}

export async function runStdioServer(config: BridgeConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
