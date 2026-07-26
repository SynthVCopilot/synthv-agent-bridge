import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  SERVER_NAME,
  SERVER_VERSION,
  type BridgeConfig,
} from "./config.js";
import { toPublicError } from "./errors.js";
import { FileIpcClient } from "./ipc/file-ipc-client.js";

const indexSchema = z.number().int().min(1);
const blickSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const durationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const midiPitchSchema = z.number().int().min(0).max(127);
const fingerprintSchema = z.string().min(1);
const groupUuidSchema = z.string().min(1);
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

const groupLocatorShape = {
  trackIndex: indexSchema.describe("1-based track storage index."),
  groupIndex: indexSchema
    .default(1)
    .describe("1-based group index. Group 1 is always the track's main group."),
  groupUuid: groupUuidSchema
    .optional()
    .describe("Optional group UUID. When present, the bridge verifies that it matches groupIndex."),
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

const automationPointSchema = z.object({
  position: blickSchema.describe("Group-local position in blicks."),
  value: z.number().finite(),
});

const convertTimeInputSchema = z
  .object({
    blicks: blickSchema.optional(),
    quarters: z.number().finite().min(0).optional(),
    seconds: z.number().finite().min(0).optional(),
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

function jsonToolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
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
        text: JSON.stringify({ ok: false, error: publicError }, null, 2),
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
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      websiteUrl: "https://github.com/zhoupengjie/synthv-agent-bridge",
    },
    {
      instructions:
        "Control Synthesizer V Studio through the local bridge. Read the current project, time axis, track, group, automation, or selection immediately before writing. All indices are 1-based. Copy groupUuid, trackFingerprint, automation fingerprint, and note fingerprints from the latest applicable read; never invent fingerprints or UUIDs. Each write call becomes one SynthV undo record. Prefer small, reviewable edits.",
    },
  );

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
    "get_time_axis",
    {
      title: "Get SynthV Time Axis",
      description:
        "Read every tempo and time-signature mark plus a fingerprint for safe time-axis edits.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("get_time_axis")),
  );

  server.registerTool(
    "convert_time",
    {
      title: "Convert SynthV Time",
      description:
        "Convert exactly one position expressed as blicks, quarter notes, or seconds using the current tempo map.",
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
        "List tracks with 1-based storage indices, display order, group counts, note counts, and mixer state.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("list_tracks")),
  );

  server.registerTool(
    "get_track_notes",
    {
      title: "Get SynthV Track Notes",
      description:
        "Read a track's groups and notes. Returns group UUIDs plus note fingerprints required by safe edit/delete tools.",
      inputSchema: {
        trackIndex: indexSchema.describe("1-based track storage index."),
        offset: z.number().int().min(0).default(0).describe("Number of notes to skip per group."),
        limit: z.number().int().min(1).max(5000).default(1000).describe("Maximum notes returned per group."),
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
    "get_selection",
    {
      title: "Get SynthV Selection",
      description:
        "Get the current piano-roll track, group, selected notes, and their safe-write fingerprints.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => runTool(async () => client.send("get_selection")),
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
        "Deep-clone a track so its singer/database, groups, notes, automation, and mixer settings are inherited. Optionally clear notes or transpose all cloned vocal notes atomically.",
      inputSchema: {
        ...trackGuardShape,
        name: z.string().min(1).max(200).optional(),
        displayColor: displayColorSchema.optional(),
        bounced: z.boolean().optional(),
        clearNotes: z.boolean().default(false),
        transposeSemitones: z.number().int().min(-127).max(127).default(0),
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
        "Rename a note group or edit its reference mute, offset, visible time range, and default voice-expression properties.",
      inputSchema: {
        ...groupLocatorShape,
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
    "delete_group_reference",
    {
      title: "Delete SynthV Group Reference",
      description:
        "Remove one non-main group reference from a track. The underlying library group is preserved.",
      inputSchema: groupLocatorShape,
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
    "add_notes",
    {
      title: "Add SynthV Notes",
      description:
        "Add notes to a specific note group. Onset and pitch are group-local. The operation is one undo record.",
      inputSchema: {
        ...groupLocatorShape,
        notes: z.array(noteCreateSchema).min(1).max(512),
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
    "get_automation",
    {
      title: "Get SynthV Automation",
      description:
        "Read all control points and the official definition for a group parameter such as pitchDelta, loudness, tension, breathiness, voicing, gender, vibratoEnv, or vocalMode_<Name>.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) => runTool(async () => client.send("get_automation", input)),
  );

  server.registerTool(
    "set_automation_points",
    {
      title: "Set SynthV Automation Points",
      description:
        "Add or update group-local automation points. Optionally clear all points or a range first. Values are validated against SynthV's parameter definition.",
      inputSchema: {
        ...groupLocatorShape,
        parameter: z.string().min(1),
        expectedFingerprint: fingerprintSchema
          .optional()
          .describe("Latest automation fingerprint from get_automation."),
        clearMode: z.enum(["none", "all", "range"]).default("none"),
        rangeBegin: blickSchema.optional(),
        rangeEnd: blickSchema.optional(),
        points: z.array(automationPointSchema).min(1).max(10000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runTool(async () => client.send("set_automation_points", input)),
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

  return server;
}

export async function runStdioServer(config: BridgeConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
