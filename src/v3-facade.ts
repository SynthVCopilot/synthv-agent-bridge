import type {
  McpServer,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  BUILD_IDENTITY,
  EXECUTOR_BUILD_ID,
} from "./build-info.js";
import { BridgeError, BridgeProtocolError } from "./errors.js";
import type { GuardTokenStore } from "./guard-token-store.js";
import {
  failedOutcome,
  runWithTrace,
  traceDiagnostics,
  traceStage,
  traceIdForCurrentOperation,
} from "./v3-command-kernel.js";
import {
  registerV3Surface,
  type ActionToolDefinitions,
} from "./v3-surface.js";

type JsonRecord = Record<string, unknown>;
type RegisterTool = McpServer["registerTool"];

interface CollectedTool {
  readonly config: unknown;
  readonly handler: (
    input: unknown,
    extra?: unknown,
  ) => CallToolResult | Promise<CallToolResult>;
}

interface SidebarBuildIdentity {
  readonly state: "absent" | "stale" | "matched" | "mismatch";
  readonly buildId?: string;
  readonly ageMs?: number;
}

const DELETE_ACTIONS = new Set([
  "clear_automation",
  "delete_group_reference",
  "delete_note_group",
  "delete_note_retake",
  "delete_notes",
  "delete_pitch_controls",
  "delete_track",
]);

const TRANSACTION_ACTIONS = new Set([
  "apply_transaction",
  "rollback_transaction",
]);

function asRecord(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeProtocolError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function readJsonResult(result: CallToolResult): unknown {
  const text = result.content.find(
    (value) => value.type === "text" && typeof value.text === "string",
  );
  if (text?.type !== "text") {
    throw new BridgeProtocolError("Internal SynthV action returned no JSON");
  }
  return JSON.parse(text.text) as unknown;
}

function withTraceId(value: unknown): unknown {
  const root = asRecord(value, "result");
  return root.traceId === undefined
    ? { traceId: traceIdForCurrentOperation(), ...root }
    : root;
}

function executorBuildIdFromStatus(value: unknown): string | undefined {
  const root = asRecord(value, "status result");
  const status =
    typeof root.status === "object" &&
    root.status !== null &&
    !Array.isArray(root.status)
      ? (root.status as JsonRecord)
      : root;
  return typeof status.executorBuildId === "string"
    ? status.executorBuildId
    : undefined;
}

function withBuildIdentity(
  value: unknown,
  sidebar: SidebarBuildIdentity,
): JsonRecord {
  const root = asRecord(value, "status result");
  const executorBuildId = executorBuildIdFromStatus(root);
  const executorMatched = executorBuildId === EXECUTOR_BUILD_ID;
  const sidebarMatchedOrInactive = sidebar.state !== "mismatch";
  return {
    traceId: traceIdForCurrentOperation(),
    ...root,
    build: BUILD_IDENTITY,
    coherence: {
      state:
        !sidebarMatchedOrInactive
          ? "mismatch"
          : executorBuildId === undefined
          ? "unknown"
          : executorMatched
            ? "matched"
            : "mismatch",
      expectedExecutorBuildId: EXECUTOR_BUILD_ID,
      actualExecutorBuildId: executorBuildId ?? null,
      sidebar,
      writesAllowed: executorMatched && sidebarMatchedOrInactive,
    },
  };
}

async function assertCoherentExecutor(
  internals: ReadonlyMap<string, CollectedTool>,
  getSidebarBuildIdentity: () => Promise<SidebarBuildIdentity>,
): Promise<void> {
  const statusResult = await invokeCollected(
    internals,
    "sv_status",
    { operation: "bridge" },
    "freshRead",
  );
  if (statusResult.isError) {
    throw new BridgeError(
      "Cannot verify the installed SynthV executor build.",
      "BUILD_COHERENCE_UNKNOWN",
      { requiredAction: "reinstall_or_reload_bridge" },
    );
  }
  const actual = executorBuildIdFromStatus(readJsonResult(statusResult));
  if (actual !== EXECUTOR_BUILD_ID) {
    throw new BridgeError(
      "Node and SynthV executor builds do not match; project writes are blocked.",
      "BUILD_MISMATCH",
      {
        expectedExecutorBuildId: EXECUTOR_BUILD_ID,
        actualExecutorBuildId: actual ?? null,
        requiredAction: "reinstall_or_reload_bridge",
      },
    );
  }
  const sidebar = await getSidebarBuildIdentity();
  if (sidebar.state === "mismatch") {
    throw new BridgeError(
      "The active SynthV Sidebar build does not match the MCP server; project writes are blocked.",
      "BUILD_MISMATCH",
      {
        expectedSidebarBuildId: BUILD_IDENTITY.sidebar.buildId,
        actualSidebarBuildId: sidebar.buildId ?? null,
        requiredAction: "reinstall_or_reload_sidebar",
      },
    );
  }
}

function failurePhaseForCode(
  code: string,
  fallbackPhase: string,
  details: unknown,
): string {
  if (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details)
  ) {
    const declared = (details as JsonRecord).failurePhase;
    if (typeof declared === "string" && declared.length > 0) {
      return declared;
    }
    if (
      (details as JsonRecord).undoRequired === true ||
      (details as JsonRecord).partialWritePossible === true
    ) {
      return "mutated";
    }
  }
  if (code === "HOST_POSTCONDITION_FAILED") {
    return "verified";
  }
  if (
    code.startsWith("STALE_") ||
    code === "SHARED_GROUP_WRITE" ||
    code === "STALE_GROUP_REFERENCE_COUNT"
  ) {
    return "guarded";
  }
  if (
    code.startsWith("CONTEXT_") ||
    code === "SYNTHV_SESSION_CHANGED"
  ) {
    return "resolved";
  }
  if (
    code.startsWith("BUILD_") ||
    code === "BRIDGE_NOT_CONNECTED" ||
    code === "PROTOCOL_MISMATCH"
  ) {
    return "freshRead";
  }
  if (
    code === "INVALID_ARGUMENT" ||
    code === "INVALID_ACTION" ||
    code === "UNKNOWN_ACTION" ||
    code.startsWith("UNSUPPORTED_")
  ) {
    return "preflighted";
  }
  return fallbackPhase;
}

function normalizeFailure(result: CallToolResult, phase: string): CallToolResult {
  let error: unknown = new BridgeError(
    "The internal SynthV action failed",
    "INTERNAL_ACTION_FAILED",
  );
  let failurePhase = phase;
  try {
    const root = asRecord(readJsonResult(result), "result");
    const publicError = asRecord(root.error, "result.error");
    const code =
      typeof publicError.code === "string"
        ? publicError.code
        : "INTERNAL_ACTION_FAILED";
    failurePhase = failurePhaseForCode(
      code,
      phase,
      publicError.details,
    );
    error = new BridgeError(
      typeof publicError.message === "string"
        ? publicError.message
        : "The internal SynthV action failed",
      code,
      publicError.details,
    );
  } catch {
    // Preserve the bounded generic error when an internal result is malformed.
  }
  return jsonResult(failedOutcome(error, failurePhase), true);
}

async function invokeCollected(
  tools: ReadonlyMap<string, CollectedTool>,
  name: string,
  input: unknown,
  phase: string,
): Promise<CallToolResult> {
  const tool = tools.get(name);
  if (tool === undefined) {
    return jsonResult(
      failedOutcome(
        new BridgeProtocolError(`Internal v3 adapter tool is missing: ${name}`),
        "accepted",
      ),
      true,
    );
  }
  try {
    traceStage("resolved", { tool: name });
    const result = await tool.handler(input);
    traceStage(result.isError ? "failed" : phase, { tool: name });
    return result.isError ? normalizeFailure(result, phase) : result;
  } catch (error) {
    return jsonResult(failedOutcome(error, phase), true);
  }
}

function collectV3Internals(
  definitions: ActionToolDefinitions,
  guardTokens: GuardTokenStore,
  getSessionToken?: () => Promise<string | undefined>,
): ReadonlyMap<string, CollectedTool> {
  const tools = new Map<string, CollectedTool>();
  const collect = ((
    name: string,
    config: unknown,
    handler: CollectedTool["handler"],
  ): RegisteredTool => {
    tools.set(name, { config, handler });
    return {} as RegisteredTool;
  }) as RegisterTool;
  registerV3Surface(collect, definitions, guardTokens, getSessionToken);
  return tools;
}

export function registerV3Facade(
  registerTool: RegisterTool,
  definitions: ActionToolDefinitions,
  guardTokens: GuardTokenStore,
  getSessionToken?: () => Promise<string | undefined>,
  getSidebarBuildIdentity: () => Promise<SidebarBuildIdentity> = async () => ({
    state: "absent",
  }),
): void {
  const internals = collectV3Internals(
    definitions,
    guardTokens,
    getSessionToken,
  );
  const argsSchema = z.record(z.string(), z.unknown()).default({});
  const actionSchema = z.string().min(1).max(100);
  const contextIdSchema = z.string().min(20).max(128).optional();

  registerTool(
    "sv_status",
    {
      title: "SynthV Status",
      description:
        "Read connection, session, host and build-coherence status, export bounded diagnostics, ping, or reload the local executor.",
      inputSchema: {
        operation: z
          .enum(["bridge", "host", "ping", "reload", "diagnostics"])
          .default("bridge"),
        level: z.enum(["support", "debug"]).default("support"),
        traceId: z.string().min(8).max(64).optional(),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        if (input.operation === "diagnostics") {
          return jsonResult({
            traceId: traceIdForCurrentOperation(),
            build: BUILD_IDENTITY,
            observability: traceDiagnostics({
              level: input.level,
              ...(input.traceId === undefined
                ? {}
                : { traceId: input.traceId }),
              limit: input.limit,
            }),
          });
        }
        const result = await invokeCollected(
          internals,
          "sv_status",
          input,
          "freshRead",
        );
        return result.isError
          ? result
          : jsonResult(
              withBuildIdentity(
                readJsonResult(result),
                await getSidebarBuildIdentity(),
              ),
            );
      }),
  );

  registerTool(
    "sv_describe",
    {
      title: "Describe SynthV Capabilities",
      description:
        "List compact v3 query/command capabilities or return one just-in-time action schema.",
      inputSchema: {
        action: actionSchema.optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        const result = await invokeCollected(
          internals,
          "sv_describe",
          { actions: input.action === undefined ? [] : [input.action] },
          "accepted",
        );
        return result.isError
          ? result
          : jsonResult(withTraceId(readJsonResult(result)));
      }),
  );

  registerTool(
    "sv_query",
    {
      title: "Query SynthV",
      description:
        "Run one bounded read. readOnly contexts cannot authorize writes; writeIntent always reaches the current SynthV host.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
        contextMode: z
          .enum(["readOnly", "writeIntent"])
          .default("readOnly"),
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
          .optional(),
        fields: z.array(z.string().min(1).max(100)).max(64).optional(),
        dense: z.enum(["auto", "never", "always"]).default("auto"),
        debug: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        const result = await invokeCollected(
          internals,
          "sv_read",
          input,
          "freshRead",
        );
        return result.isError
          ? result
          : jsonResult(withTraceId(readJsonResult(result)));
      }),
  );

  registerTool(
    "sv_command",
    {
      title: "Command SynthV",
      description:
        "Apply one guarded semantic command or bounded transaction through fresh host validation, one Undo boundary and postcondition verification.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
        expectedEffect: z
          .enum(["allowAlreadySatisfied", "mustChange"])
          .default("allowAlreadySatisfied"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        try {
          await assertCoherentExecutor(internals, getSidebarBuildIdentity);
        } catch (error) {
          return jsonResult(failedOutcome(error, "freshRead"), true);
        }
        const internalName = TRANSACTION_ACTIONS.has(input.action)
          ? "sv_transaction"
          : DELETE_ACTIONS.has(input.action)
            ? "sv_delete"
            : "sv_edit";
        const result = await invokeCollected(
          internals,
          internalName,
          internalName === "sv_transaction"
            ? {
                action: input.action,
                args: input.args,
                response: "minimal",
              }
            : {
                action: input.action,
                args: input.args,
                contextId: input.contextId,
                response: "minimal",
              },
          "verified",
        );
        if (result.isError) {
          return result;
        }
        const root = asRecord(readJsonResult(result), "result");
        if (
          input.expectedEffect === "mustChange" &&
          root.outcome === "alreadySatisfied"
        ) {
          return jsonResult(
            failedOutcome(
              new BridgeError(
                "The command was expected to change SynthV state but the target was already satisfied.",
                "HOST_POSTCONDITION_FAILED",
                {
                  action: input.action,
                  partialWritePossible: false,
                  undoRequired: false,
                },
              ),
              "verified",
            ),
            true,
          );
        }
        return jsonResult(root);
      }),
  );

  registerTool(
    "sv_ui",
    {
      title: "Control SynthV UI",
      description:
        "Read or change selection, viewport, clipboard, dialogs, snapping, coordinates, or playback and return observed host state.",
      inputSchema: {
        action: actionSchema,
        args: argsSchema,
        contextId: contextIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        const result = await invokeCollected(
          internals,
          "sv_ui",
          input,
          "verified",
        );
        return result.isError
          ? result
          : jsonResult(withTraceId(readJsonResult(result)));
      }),
  );

  registerTool(
    "sv_review",
    {
      title: "Review SynthV Change",
      description:
        "Read review state or publish one guarded Sidebar preview. User confirmation remains inside SynthV.",
      inputSchema: {
        operation: z.enum(["get", "status", "publish"]),
        args: argsSchema,
        contextId: contextIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runWithTrace(async () => {
        if (input.operation === "publish") {
          try {
            await assertCoherentExecutor(
              internals,
              getSidebarBuildIdentity,
            );
          } catch (error) {
            return jsonResult(failedOutcome(error, "freshRead"), true);
          }
        }
        const result = await invokeCollected(
          internals,
          "sv_sidebar",
          input,
          "projected",
        );
        return result.isError
          ? result
          : jsonResult(withTraceId(readJsonResult(result)));
      }),
  );
}
