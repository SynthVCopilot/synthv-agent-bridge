import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import {
  PROTOCOL_VERSION,
  SERVER_VERSION,
  type BridgeConfig,
} from "./config.js";
import {
  EXECUTOR_BUILD_ID,
  SERVER_BUILD_FINGERPRINT,
  SERVER_CAPABILITY_FINGERPRINT,
  SIDEBAR_BUILD_ID,
} from "./build-info.js";
import { BridgeError, toPublicError } from "./errors.js";
import type { FileIpcClient } from "./ipc/file-ipc-client.js";
import type { BridgeAction } from "./protocol.js";

const SIDEBAR_REQUEST_MARKER = "synthv-agent-bridge-sidebar-request-v1";
const SIDEBAR_PREVIEW_MARKER = "synthv-agent-bridge-sidebar-preview-v1";
const SIDEBAR_COMMAND_MARKER = "synthv-agent-bridge-sidebar-command-v1";
const SIDEBAR_ACTIVITY_MARKER = "synthv-agent-bridge-sidebar-activity-v1";
const SIDEBAR_STATE_MARKER = "synthv-agent-bridge-sidebar-state-v1";
const MAX_SIDEBAR_TEXT_BYTES = 64 * 1024;
const MAX_SIDEBAR_PLAN_BYTES = 1024 * 1024;
const MAX_HISTORY_ENTRIES = 20;
const STALE_INSTRUCTION_MS = 5 * 60 * 1000;

export const TRANSACTION_STEP_ACTIONS = [
  "set_time_axis",
  "create_note_group",
  "clone_note_group",
  "delete_note_group",
  "add_group_reference",
  "clone_group_reference",
  "add_track",
  "update_track",
  "clone_track",
  "clone_track_shell",
  "delete_track",
  "update_group",
  "set_group_voice",
  "apply_group_tuning",
  "delete_group_reference",
  "add_notes",
  "edit_notes",
  "transform_notes",
  "set_note_phoneme_properties",
  "delete_notes",
  "generate_note_retake",
  "activate_note_retake",
  "delete_note_retake",
  "add_pitch_controls",
  "edit_pitch_controls",
  "delete_pitch_controls",
  "simplify_automation",
  "set_automation_points",
  "clear_automation",
  "set_track_mixer",
  "create_harmony_track",
  "humanize_notes",
  "apply_expression_preset",
  "fit_lyrics",
] as const satisfies readonly BridgeAction[];

export const SIDEBAR_PREVIEW_ACTIONS = [
  ...TRANSACTION_STEP_ACTIONS,
  "apply_transaction",
  "rollback_transaction",
] as const satisfies readonly BridgeAction[];

export type SidebarPreviewAction = (typeof SIDEBAR_PREVIEW_ACTIONS)[number];

export interface SidebarInstructionSnapshot {
  readonly pending: boolean;
  readonly requestId?: string;
  readonly text?: string;
  readonly updatedAtEpochMs?: number;
}

export interface PublishSidebarPreviewInput {
  readonly requestId?: string;
  readonly summary: string;
  readonly details?: string;
  readonly changes?: readonly SidebarPreviewChange[];
  readonly risks?: readonly string[];
  readonly action: SidebarPreviewAction;
  readonly payload: Record<string, unknown>;
  readonly replace?: boolean;
}

export interface SidebarPreviewChange {
  readonly label: string;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly count?: number | undefined;
}

export type SidebarTaskStatus =
  | "idle"
  | "queued"
  | "claimed"
  | "stale"
  | "awaiting_confirmation"
  | "applying"
  | "success"
  | "error"
  | "dismissed"
  | "cancelled";

export interface SidebarHistoryEntry {
  readonly id: string;
  readonly status: "success" | "error" | "dismissed" | "cancelled";
  readonly action: string;
  readonly summary: string;
  readonly message?: string;
  readonly updatedAtEpochMs: number;
}

interface SidebarPlan {
  readonly version: 1;
  readonly planId: string;
  readonly requestId?: string;
  readonly createdAtEpochMs: number;
  readonly summary: string;
  readonly details: string;
  readonly changes: readonly SidebarPreviewChange[];
  readonly risks: readonly string[];
  readonly action: SidebarPreviewAction;
  readonly payload: Record<string, unknown>;
  readonly status: "pending" | "applying" | "error";
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface SidebarCommand {
  readonly operation:
    | "apply"
    | "dismiss"
    | "cancel_request"
    | "clear_history";
  readonly planId?: string;
  readonly requestId?: string;
}

const PREVIEW_ACTION_SET = new Set<string>(SIDEBAR_PREVIEW_ACTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readLimitedText(
  filePath: string,
  maximumBytes: number,
): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath);
    if (content.byteLength > maximumBytes) {
      throw new BridgeError(
        "A SynthV sidebar IPC file exceeds its size limit.",
        "SIDEBAR_FILE_TOO_LARGE",
        { filePath, maximumBytes },
      );
    }
    return content.toString("utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function writeTextAtomically(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    await removeIfExists(filePath);
    await fs.rename(temporary, filePath);
  } finally {
    await removeIfExists(temporary).catch(() => undefined);
  }
}

function lineValue(text: string, key: string): string | undefined {
  const prefix = `${key}=`;
  for (const line of text.split(/\r?\n/u).slice(0, 8)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  return undefined;
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 2000);
}

function parsePreviewChanges(value: unknown): readonly SidebarPreviewChange[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new BridgeError(
      "The pending SynthV sidebar preview has invalid changes.",
      "SIDEBAR_PREVIEW_INVALID",
    );
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.label !== "string" || entry.label === "") {
      throw new BridgeError(
        "The pending SynthV sidebar preview has an invalid change entry.",
        "SIDEBAR_PREVIEW_INVALID",
      );
    }
    const { before, after, count } = entry;
    if (
      (before !== undefined && typeof before !== "string") ||
      (after !== undefined && typeof after !== "string") ||
      (count !== undefined &&
        (typeof count !== "number" || !Number.isInteger(count) || count < 0))
    ) {
      throw new BridgeError(
        "The pending SynthV sidebar preview has an invalid change entry.",
        "SIDEBAR_PREVIEW_INVALID",
      );
    }
    return {
      label: entry.label,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(count === undefined ? {} : { count }),
    };
  });
}

function parseRisks(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new BridgeError(
      "The pending SynthV sidebar preview has invalid risks.",
      "SIDEBAR_PREVIEW_INVALID",
    );
  }
  return value as string[];
}

function parsePlan(value: unknown): SidebarPlan {
  if (!isRecord(value) || value.version !== 1) {
    throw new BridgeError(
      "The pending SynthV sidebar preview is invalid.",
      "SIDEBAR_PREVIEW_INVALID",
    );
  }

  const {
    planId,
    requestId,
    createdAtEpochMs,
    summary,
    details,
    changes,
    risks,
    action,
    payload,
    status,
    errorCode,
    errorMessage,
  } = value;
  if (
    typeof planId !== "string" ||
    planId.length === 0 ||
    (requestId !== undefined && typeof requestId !== "string") ||
    typeof createdAtEpochMs !== "number" ||
    !Number.isFinite(createdAtEpochMs) ||
    typeof summary !== "string" ||
    typeof details !== "string" ||
    typeof action !== "string" ||
    !PREVIEW_ACTION_SET.has(action) ||
    !isRecord(payload) ||
    (status !== "pending" && status !== "applying" && status !== "error") ||
    (errorCode !== undefined && typeof errorCode !== "string") ||
    (errorMessage !== undefined && typeof errorMessage !== "string")
  ) {
    throw new BridgeError(
      "The pending SynthV sidebar preview has invalid fields.",
      "SIDEBAR_PREVIEW_INVALID",
    );
  }

  return {
    version: 1,
    planId,
    ...(requestId === undefined ? {} : { requestId }),
    createdAtEpochMs,
    summary,
    details,
    changes: parsePreviewChanges(changes),
    risks: parseRisks(risks),
    action: action as SidebarPreviewAction,
    payload,
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function renderPreview(plan: SidebarPlan): string {
  const statusText =
    plan.status === "pending"
      ? "等待确认"
      : plan.status === "applying"
        ? "正在应用"
        : `应用失败${plan.errorCode ? `（${plan.errorCode}）` : ""}`;
  const sections = [
    SIDEBAR_PREVIEW_MARKER,
    `planId=${plan.planId}`,
    `status=${plan.status}`,
    statusText,
    plan.summary,
  ];
  if (plan.details.trim() !== "") {
    sections.push("", plan.details);
  }
  if (plan.changes.length > 0) {
    sections.push("", "变更明细：");
    for (const change of plan.changes) {
      const transition =
        change.before !== undefined || change.after !== undefined
          ? `：${change.before ?? "—"} → ${change.after ?? "—"}`
          : "";
      const count =
        change.count === undefined ? "" : `（${change.count} 项）`;
      sections.push(`• ${change.label}${transition}${count}`);
    }
  }
  if (plan.risks.length > 0) {
    sections.push("", "风险与约束：");
    for (const risk of plan.risks) {
      sections.push(`⚠ ${risk}`);
    }
  }
  if (plan.errorMessage) {
    sections.push("", plan.errorMessage);
  }
  return `${sections.join("\n")}\n`;
}

function renderActivity(entries: readonly SidebarHistoryEntry[]): string {
  const latest = entries.at(-1);
  if (latest === undefined) {
    return `${SIDEBAR_ACTIVITY_MARKER}\nstatus=empty\naction=none\nupdatedAtEpochMs=${Date.now()}\n尚无操作记录。\n`;
  }
  const heading = {
    success: "最近操作：已完成",
    error: "最近操作：失败",
    dismissed: "最近操作：已放弃预览",
    cancelled: "最近操作：已取消请求",
  }[latest.status];
  const sections = [
    SIDEBAR_ACTIVITY_MARKER,
    `status=${latest.status}`,
    `action=${latest.action}`,
    `updatedAtEpochMs=${latest.updatedAtEpochMs}`,
    heading,
    latest.summary,
  ];
  if (latest.message) {
    sections.push(latest.message);
  }
  if (latest.status === "success") {
    sections.push(
      "撤销：先点击 SynthV 主编辑区，再按 Ctrl+Z；也可使用“编辑 → 撤销”。",
    );
  }
  const previous = entries.slice(Math.max(0, entries.length - 6), -1).reverse();
  if (previous.length > 0) {
    sections.push("", "历史：");
    for (const entry of previous) {
      const time = new Date(entry.updatedAtEpochMs).toLocaleTimeString("zh-CN", {
        hour12: false,
      });
      const icon =
        entry.status === "success"
          ? "✓"
          : entry.status === "error"
            ? "!"
            : "○";
      sections.push(`${icon} ${time} ${entry.summary}`);
    }
  }
  return `${sections.join("\n")}\n`;
}

function parseCommand(text: string): SidebarCommand {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== SIDEBAR_COMMAND_MARKER) {
    throw new BridgeError(
      "The SynthV sidebar command has an invalid marker.",
      "SIDEBAR_COMMAND_INVALID",
    );
  }
  const operation = lineValue(text, "operation");
  const planId = lineValue(text, "planId");
  const requestId = lineValue(text, "requestId");
  if (
    operation !== "apply" &&
    operation !== "dismiss" &&
    operation !== "cancel_request" &&
    operation !== "clear_history"
  ) {
    throw new BridgeError(
      "The SynthV sidebar command has invalid fields.",
      "SIDEBAR_COMMAND_INVALID",
    );
  }
  if (
    (operation === "apply" || operation === "dismiss") &&
    (typeof planId !== "string" || planId.length === 0)
  ) {
    throw new BridgeError(
      "The SynthV sidebar command has no preview plan ID.",
      "SIDEBAR_COMMAND_INVALID",
    );
  }
  return {
    operation,
    ...(planId === undefined ? {} : { planId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export class SidebarCoordinator {
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastHeartbeatAt = 0;
  private lastError: { readonly code: string; readonly message: string } | null =
    null;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly client: FileIpcClient,
  ) {}

  public start(): void {
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch(async (error: unknown) => {
        this.lastError = toPublicError(error);
        await this.writeClientStatus("running").catch(() => undefined);
      });
    }, Math.max(100, this.config.pollIntervalMs));
    this.pollTimer.unref();
    this.lastHeartbeatAt = Date.now();
    void this.writeClientStatus("running").catch(() => undefined);
  }

  public stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    void this.writeClientStatus("stopped").catch(() => undefined);
  }

  public async getInstruction(): Promise<SidebarInstructionSnapshot> {
    const text = await readLimitedText(
      this.config.paths.sidebarInstructionFile,
      MAX_SIDEBAR_TEXT_BYTES,
    );
    if (text === null) {
      return { pending: false };
    }
    if (!text.startsWith(`${SIDEBAR_REQUEST_MARKER}\n`)) {
      throw new BridgeError(
        "The pending SynthV sidebar request has an invalid marker.",
        "SIDEBAR_REQUEST_INVALID",
      );
    }
    const requestId = lineValue(text, "requestId");
    if (!requestId) {
      throw new BridgeError(
        "The pending SynthV sidebar request has no request ID.",
        "SIDEBAR_REQUEST_INVALID",
      );
    }
    const stat = await fs.stat(this.config.paths.sidebarInstructionFile);
    const ageMs = Date.now() - stat.mtimeMs;
    await this.writeTaskState(
      ageMs > STALE_INSTRUCTION_MS ? "stale" : "claimed",
      {
        requestId,
        message:
          ageMs > STALE_INSTRUCTION_MS
            ? "请求等待时间较长；请确认当前选区后再生成预览。"
            : "Codex 已读取请求，正在准备变更预览。",
      },
    );
    return {
      pending: true,
      requestId,
      text,
      updatedAtEpochMs: stat.mtimeMs,
    };
  }

  public async publishPreview(
    input: PublishSidebarPreviewInput,
  ): Promise<{
    readonly planId: string;
    readonly status: "pending";
    readonly action: SidebarPreviewAction;
  }> {
    await fs.mkdir(this.config.paths.directory, { recursive: true });
    const current = await this.readPlan();
    if (current?.status === "applying") {
      throw new BridgeError(
        "The current SynthV sidebar preview is already being applied.",
        "SIDEBAR_PREVIEW_APPLYING",
        { planId: current.planId },
      );
    }
    if (
      current !== null &&
      current.status === "pending" &&
      input.replace !== true
    ) {
      throw new BridgeError(
        "A SynthV sidebar preview is already awaiting confirmation.",
        "SIDEBAR_PREVIEW_PENDING",
        { planId: current.planId, status: current.status },
      );
    }

    const plan: SidebarPlan = {
      version: 1,
      planId: randomUUID(),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      createdAtEpochMs: Date.now(),
      summary: input.summary,
      details: input.details ?? "",
      changes: input.changes ?? [],
      risks: input.risks ?? [],
      action: input.action,
      payload: input.payload,
      status: "pending",
    };
    const encoded = `${JSON.stringify(plan, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_SIDEBAR_PLAN_BYTES) {
      throw new BridgeError(
        "The SynthV sidebar preview exceeds its size limit.",
        "SIDEBAR_PREVIEW_TOO_LARGE",
      );
    }
    await writeTextAtomically(this.config.paths.sidebarPreviewFile, encoded);
    await writeTextAtomically(
      this.config.paths.sidebarPreviewTextFile,
      renderPreview(plan),
    );
    await this.writeTaskState("awaiting_confirmation", {
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      planId: plan.planId,
      message: "预览已生成，等待在 SynthV 中确认。",
    });
    await this.removeMatchingInstruction(input.requestId);
    return { planId: plan.planId, status: "pending", action: plan.action };
  }

  public async getDiagnostics(): Promise<Record<string, unknown>> {
    const [bridgeStatusRaw, clientStatusRaw, runtimeStatusRaw, taskStateRaw, history] =
      await Promise.all([
        readLimitedText(this.config.paths.statusFile, MAX_SIDEBAR_TEXT_BYTES),
        readLimitedText(
          this.config.paths.sidebarClientStatusFile,
          MAX_SIDEBAR_TEXT_BYTES,
        ),
        readLimitedText(
          this.config.paths.sidebarRuntimeStatusFile,
          MAX_SIDEBAR_TEXT_BYTES,
        ),
        readLimitedText(this.config.paths.sidebarStateFile, MAX_SIDEBAR_TEXT_BYTES),
        this.readHistory(),
      ]);
    let bridgeStatus: unknown = null;
    if (bridgeStatusRaw !== null) {
      try {
        bridgeStatus = JSON.parse(bridgeStatusRaw) as unknown;
      } catch {
        bridgeStatus = { invalid: true };
      }
    }
    return {
      version: SERVER_VERSION,
      ipcDirectory: this.config.paths.directory,
      bridgeStatus,
      clientStatus: clientStatusRaw,
      runtimeStatus: runtimeStatusRaw,
      taskState: taskStateRaw,
      history,
      lastError: this.lastError,
    };
  }

  public async getRuntimeBuildIdentity(): Promise<{
    readonly state: "absent" | "stale" | "matched" | "mismatch";
    readonly buildId?: string;
    readonly ageMs?: number;
  }> {
    const raw = await readLimitedText(
      this.config.paths.sidebarRuntimeStatusFile,
      MAX_SIDEBAR_TEXT_BYTES,
    );
    if (raw === null) {
      return { state: "absent" };
    }
    const updatedAtEpochMs = Number(lineValue(raw, "updatedAtEpochMs"));
    const ageMs = Number.isFinite(updatedAtEpochMs)
      ? Math.max(0, Date.now() - updatedAtEpochMs)
      : Number.POSITIVE_INFINITY;
    const buildId = lineValue(raw, "buildId");
    if (ageMs > Math.max(5_000, this.config.statusStaleMs * 2)) {
      return {
        state: "stale",
        ...(buildId === undefined ? {} : { buildId }),
        ageMs,
      };
    }
    return {
      state: buildId === SIDEBAR_BUILD_ID ? "matched" : "mismatch",
      ...(buildId === undefined ? {} : { buildId }),
      ageMs,
    };
  }

  public async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      if (Date.now() - this.lastHeartbeatAt >= 1000) {
        await this.writeClientStatus("running");
      }
      await this.refreshQueuedState();
      await this.recoverStaleCommand();
      let claimed = false;
      try {
        await fs.rename(
          this.config.paths.sidebarCommandFile,
          this.config.paths.sidebarCommandProcessingFile,
        );
        claimed = true;
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
      if (!claimed) {
        return;
      }

      try {
        const text = await readLimitedText(
          this.config.paths.sidebarCommandProcessingFile,
          MAX_SIDEBAR_TEXT_BYTES,
        );
        if (text !== null) {
          await this.processCommand(parseCommand(text));
        }
      } finally {
        await removeIfExists(
          this.config.paths.sidebarCommandProcessingFile,
        ).catch(() => undefined);
      }
    } finally {
      this.polling = false;
    }
  }

  private async readPlan(): Promise<SidebarPlan | null> {
    const raw = await readLimitedText(
      this.config.paths.sidebarPreviewFile,
      MAX_SIDEBAR_PLAN_BYTES,
    );
    if (raw === null) {
      return null;
    }
    try {
      return parsePlan(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "The pending SynthV sidebar preview is not valid JSON.",
        "SIDEBAR_PREVIEW_INVALID",
      );
    }
  }

  private async processCommand(command: SidebarCommand): Promise<void> {
    if (command.operation === "clear_history") {
      await this.clearHistory();
      this.lastError = null;
      return;
    }

    if (command.operation === "cancel_request") {
      const instruction = await readLimitedText(
        this.config.paths.sidebarInstructionFile,
        MAX_SIDEBAR_TEXT_BYTES,
      );
      const currentRequestId =
        instruction === null ? undefined : lineValue(instruction, "requestId");
      if (
        command.requestId !== undefined &&
        currentRequestId !== undefined &&
        command.requestId !== currentRequestId
      ) {
        await this.writeTaskState("queued", {
          requestId: currentRequestId,
          message:
            "已忽略过期的取消命令；当前较新的请求仍在等待 Codex 读取。",
        });
        return;
      }
      if (
        command.requestId === undefined ||
        currentRequestId === undefined ||
        command.requestId === currentRequestId
      ) {
        await removeIfExists(this.config.paths.sidebarInstructionFile);
      }
      await this.appendHistory({
        id: randomUUID(),
        status: "cancelled",
        action: "sidebar_request",
        summary: "已取消侧边栏请求。",
        updatedAtEpochMs: Date.now(),
      });
      await this.writeTaskState("cancelled", {
        ...(currentRequestId === undefined
          ? {}
          : { requestId: currentRequestId }),
        message: "请求已取消；可以修改指令后重新排队。",
      });
      this.lastError = null;
      return;
    }

    const plan = await this.readPlan();
    if (plan === null || plan.planId !== command.planId) {
      this.lastError = {
        code: "SIDEBAR_PREVIEW_STALE",
        message: "预览已经过期或已被替换，请让 Codex 重新生成。",
      };
      await this.appendHistory({
        id: randomUUID(),
        status: "error",
        action: "preview",
        summary: "无法处理侧边栏预览。",
        message: "预览已经过期或已被替换，请让 Codex 重新生成。",
        updatedAtEpochMs: Date.now(),
      });
      await this.writeTaskState("error", {
        message: "预览已经过期或已被替换。",
      });
      return;
    }

    if (command.operation === "dismiss") {
      await removeIfExists(this.config.paths.sidebarPreviewFile);
      await removeIfExists(this.config.paths.sidebarPreviewTextFile);
      await this.appendHistory({
        id: plan.planId,
        status: "dismissed",
        action: plan.action,
        summary: plan.summary,
        updatedAtEpochMs: Date.now(),
      });
      await this.writeTaskState("dismissed", {
        ...(plan.requestId === undefined ? {} : { requestId: plan.requestId }),
        planId: plan.planId,
        message: "预览已放弃；工程未修改。",
      });
      this.lastError = null;
      return;
    }

    if (plan.status !== "pending") {
      return;
    }
    const applyingPlan: SidebarPlan = { ...plan, status: "applying" };
    await writeTextAtomically(
      this.config.paths.sidebarPreviewFile,
      `${JSON.stringify(applyingPlan, null, 2)}\n`,
    );
    await writeTextAtomically(
      this.config.paths.sidebarPreviewTextFile,
      renderPreview(applyingPlan),
    );
    await this.writeTaskState("applying", {
      ...(plan.requestId === undefined ? {} : { requestId: plan.requestId }),
      planId: plan.planId,
      message: "正在通过 Bridge 应用变更。",
    });

    try {
      const sidebarBuild = await this.getRuntimeBuildIdentity();
      if (sidebarBuild.state === "mismatch") {
        throw new BridgeError(
          "The active SynthV Sidebar build does not match the MCP server; the preview was not applied.",
          "BUILD_MISMATCH",
          {
            expectedSidebarBuildId: SIDEBAR_BUILD_ID,
            actualSidebarBuildId: sidebarBuild.buildId ?? null,
            requiredAction: "reinstall_or_reload_sidebar",
          },
        );
      }
      await this.client.send(plan.action, {
        ...plan.payload,
        _sidebarPlanId: plan.planId,
      });
      await removeIfExists(this.config.paths.sidebarPreviewFile);
      await removeIfExists(this.config.paths.sidebarPreviewTextFile);
      await this.appendHistory({
        id: plan.planId,
        status: "success",
        action: plan.action,
        summary: plan.summary,
        updatedAtEpochMs: Date.now(),
      });
      await this.writeTaskState("success", {
        ...(plan.requestId === undefined ? {} : { requestId: plan.requestId }),
        planId: plan.planId,
        message: "变更已应用；可在主编辑区使用 Ctrl+Z 撤销。",
      });
      this.lastError = null;
    } catch (error) {
      const publicError = toPublicError(error);
      this.lastError = publicError;
      const failedPlan: SidebarPlan = {
        ...plan,
        status: "error",
        errorCode: publicError.code,
        errorMessage: publicError.message,
      };
      await writeTextAtomically(
        this.config.paths.sidebarPreviewFile,
        `${JSON.stringify(failedPlan, null, 2)}\n`,
      );
      await writeTextAtomically(
        this.config.paths.sidebarPreviewTextFile,
        renderPreview(failedPlan),
      );
      await this.appendHistory({
        id: plan.planId,
        status: "error",
        action: plan.action,
        summary: plan.summary,
        message: `${publicError.code}: ${publicError.message}`,
        updatedAtEpochMs: Date.now(),
      });
      await this.writeTaskState("error", {
        ...(plan.requestId === undefined ? {} : { requestId: plan.requestId }),
        planId: plan.planId,
        message: `${publicError.code}: ${publicError.message}`,
      });
    }
  }

  private async removeMatchingInstruction(
    requestId: string | undefined,
  ): Promise<void> {
    if (!requestId) {
      return;
    }
    const current = await readLimitedText(
      this.config.paths.sidebarInstructionFile,
      MAX_SIDEBAR_TEXT_BYTES,
    );
    if (current !== null && lineValue(current, "requestId") === requestId) {
      await removeIfExists(this.config.paths.sidebarInstructionFile);
    }
  }

  private async readHistory(): Promise<SidebarHistoryEntry[]> {
    const raw = await readLimitedText(
      this.config.paths.sidebarHistoryFile,
      MAX_SIDEBAR_PLAN_BYTES,
    );
    if (raw === null) {
      return [];
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) {
        return [];
      }
      return value
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .flatMap((entry) => {
          const { id, status, action, summary, message, updatedAtEpochMs } =
            entry;
          if (
            typeof id !== "string" ||
            (status !== "success" &&
              status !== "error" &&
              status !== "dismissed" &&
              status !== "cancelled") ||
            typeof action !== "string" ||
            typeof summary !== "string" ||
            (message !== undefined && typeof message !== "string") ||
            typeof updatedAtEpochMs !== "number" ||
            !Number.isFinite(updatedAtEpochMs)
          ) {
            return [];
          }
          const validStatus: SidebarHistoryEntry["status"] = status;
          return [
            {
              id,
              status: validStatus,
              action,
              summary,
              ...(message === undefined ? {} : { message }),
              updatedAtEpochMs,
            },
          ];
        })
        .slice(-MAX_HISTORY_ENTRIES);
    } catch {
      return [];
    }
  }

  private async appendHistory(entry: SidebarHistoryEntry): Promise<void> {
    const history = await this.readHistory();
    history.push(entry);
    const bounded = history.slice(-MAX_HISTORY_ENTRIES);
    await writeTextAtomically(
      this.config.paths.sidebarHistoryFile,
      `${JSON.stringify(bounded, null, 2)}\n`,
    );
    await writeTextAtomically(
      this.config.paths.sidebarActivityFile,
      renderActivity(bounded),
    );
  }

  private async clearHistory(): Promise<void> {
    await removeIfExists(this.config.paths.sidebarHistoryFile);
    await writeTextAtomically(
      this.config.paths.sidebarActivityFile,
      renderActivity([]),
    );
  }

  private async refreshQueuedState(): Promise<void> {
    const stat = await fs
      .stat(this.config.paths.sidebarInstructionFile)
      .catch(() => null);
    if (stat === null) {
      return;
    }
    const raw = await readLimitedText(
      this.config.paths.sidebarInstructionFile,
      MAX_SIDEBAR_TEXT_BYTES,
    );
    const requestId = raw === null ? undefined : lineValue(raw, "requestId");
    const stale = Date.now() - stat.mtimeMs > STALE_INSTRUCTION_MS;
    const currentState = await readLimitedText(
      this.config.paths.sidebarStateFile,
      MAX_SIDEBAR_TEXT_BYTES,
    );
    if (
      !stale &&
      currentState !== null &&
      lineValue(currentState, "requestId") === requestId &&
      lineValue(currentState, "status") === "claimed"
    ) {
      return;
    }
    await this.writeTaskState(stale ? "stale" : "queued", {
      ...(requestId === undefined ? {} : { requestId }),
      message: stale
        ? "请求等待超过 5 分钟；继续前请重新确认当前选区。"
        : "请求已排队，等待 Codex 读取。",
    });
  }

  private async writeTaskState(
    status: SidebarTaskStatus,
    fields: {
      readonly requestId?: string;
      readonly planId?: string;
      readonly message?: string;
    } = {},
  ): Promise<void> {
    const lines = [
      SIDEBAR_STATE_MARKER,
      `status=${status}`,
      `updatedAtEpochMs=${Date.now()}`,
    ];
    if (fields.requestId !== undefined) {
      lines.push(`requestId=${sanitizeLine(fields.requestId)}`);
    }
    if (fields.planId !== undefined) {
      lines.push(`planId=${sanitizeLine(fields.planId)}`);
    }
    if (fields.message !== undefined) {
      lines.push(`message=${sanitizeLine(fields.message)}`);
    }
    lines.push("");
    await writeTextAtomically(
      this.config.paths.sidebarStateFile,
      lines.join("\n"),
    );
  }

  private async recoverStaleCommand(): Promise<void> {
    const stat = await fs
      .stat(this.config.paths.sidebarCommandProcessingFile)
      .catch(() => null);
    if (
      stat === null ||
      Date.now() - stat.mtimeMs <= this.config.staleRequestMs
    ) {
      return;
    }
    const pending = await fs
      .stat(this.config.paths.sidebarCommandFile)
      .then(() => true)
      .catch(() => false);
    if (pending) {
      await removeIfExists(this.config.paths.sidebarCommandProcessingFile);
      return;
    }
    await fs.rename(
      this.config.paths.sidebarCommandProcessingFile,
      this.config.paths.sidebarCommandFile,
    );
  }

  private async writeClientStatus(state: "running" | "stopped"): Promise<void> {
    const now = Date.now();
    const lines = [
      "synthv-agent-bridge-sidebar-client-status-v1",
      `state=${state}`,
      `version=${SERVER_VERSION}`,
      `protocolVersion=${PROTOCOL_VERSION}`,
      `expectedExecutorBuildId=${EXECUTOR_BUILD_ID}`,
      `buildFingerprint=${SERVER_BUILD_FINGERPRINT}`,
      `capabilityFingerprint=${SERVER_CAPABILITY_FINGERPRINT}`,
      `updatedAtEpochMs=${now}`,
      `ipcDirectory=${sanitizeLine(this.config.paths.directory)}`,
    ];
    if (this.lastError !== null) {
      lines.push(`lastErrorCode=${sanitizeLine(this.lastError.code)}`);
      lines.push(`lastErrorMessage=${sanitizeLine(this.lastError.message)}`);
    }
    lines.push("");
    await writeTextAtomically(
      this.config.paths.sidebarClientStatusFile,
      lines.join("\n"),
    );
    this.lastHeartbeatAt = now;
  }
}
