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

const groupLocatorShape = {
  trackIndex: indexSchema.describe("1-based track storage index."),
  groupIndex: indexSchema
    .default(1)
    .describe("1-based group index. Group 1 is always the track's main group."),
  groupUuid: groupUuidSchema
    .optional()
    .describe("Optional group UUID. When present, the bridge verifies that it matches groupIndex."),
};

const noteCreateSchema = z.object({
  onset: blickSchema.describe("Group-local onset in blicks."),
  duration: durationSchema.describe("Duration in blicks."),
  pitch: midiPitchSchema.describe("Group-local MIDI pitch."),
  lyrics: z.string().default("la"),
  phonemes: z.string().optional(),
  detune: z.number().finite().optional().describe("Detune in cents."),
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
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value: Record<string, unknown>) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one note property must be changed.",
  });

const automationPointSchema = z.object({
  position: blickSchema.describe("Group-local position in blicks."),
  value: z.number().finite(),
});

const trackMixerInputSchema = z
  .object({
    trackIndex: indexSchema,
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
        "Control Synthesizer V Studio through the local bridge. Read the current project, track, group, or selection immediately before writing. All indices are 1-based. For edit_notes and delete_notes, copy each note fingerprint from the latest read; never invent fingerprints or UUIDs. Each write call becomes one SynthV undo record. Prefer small, reviewable edits.",
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
    "add_track",
    {
      title: "Add SynthV Track",
      description: "Create a vocal track with a main note group.",
      inputSchema: {
        name: z.string().min(1).max(200).default("New Track"),
        displayColor: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional()
          .describe("Optional #RRGGBB track color."),
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
        "Set one or more mixer fields. Gain is limited to -24..24 dB and pan to -1..1.",
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
