import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import { SERVER_VERSION, type BridgeConfig } from "./config.js";
import { BridgeError, toPublicError } from "./errors.js";
import type { FileIpcClient } from "./ipc/file-ipc-client.js";
import type { BridgeAction } from "./protocol.js";

const SIDEBAR_REQUEST_MARKER = "synthv-agent-bridge-sidebar-request-v1";
const SIDEBAR_PREVIEW_MARKER = "synthv-agent-bridge-sidebar-preview-v1";
const SIDEBAR_COMMAND_MARKER = "synthv-agent-bridge-sidebar-command-v1";
const SIDEBAR_ACTIVITY_MARKER = "synthv-agent-bridge-sidebar-activity-v1";
const MAX_SIDEBAR_TEXT_BYTES = 64 * 1024;
const MAX_SIDEBAR_PLAN_BYTES = 1024 * 1024;

export const SIDEBAR_PREVIEW_ACTIONS = [
  "set_time_axis",
  "create_note_group",
  "clone_note_group",
  "delete_note_group",
  "add_group_reference",
  "clone_group_reference",
  "add_track",
  "update_track",
  "clone_track",
  "delete_track",
  "update_group",
  "set_group_voice",
  "delete_group_reference",
  "add_notes",
  "edit_notes",
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
  readonly action: SidebarPreviewAction;
  readonly payload: Record<string, unknown>;
  readonly replace?: boolean;
}

interface SidebarPlan {
  readonly version: 1;
  readonly planId: string;
  readonly requestId?: string;
  readonly createdAtEpochMs: number;
  readonly summary: string;
  readonly details: string;
  readonly action: SidebarPreviewAction;
  readonly payload: Record<string, unknown>;
  readonly status: "pending" | "applying" | "error";
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface SidebarCommand {
  readonly operation: "apply" | "dismiss";
  readonly planId: string;
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
  if (plan.errorMessage) {
    sections.push("", plan.errorMessage);
  }
  return `${sections.join("\n")}\n`;
}

function renderActivity(
  status: "success" | "error" | "dismissed",
  action: string,
  summary: string,
  message?: string,
): string {
  const heading =
    status === "success"
      ? "最近操作：已完成"
      : status === "dismissed"
        ? "最近操作：已放弃预览"
        : "最近操作：失败";
  const sections = [
    SIDEBAR_ACTIVITY_MARKER,
    `status=${status}`,
    `action=${action}`,
    `updatedAtEpochMs=${Date.now()}`,
    heading,
    summary,
  ];
  if (message) {
    sections.push(message);
  }
  if (status === "success") {
    sections.push(
      "撤销：先点击 SynthV 主编辑区，再按 Ctrl+Z；也可使用“编辑 → 撤销”。",
    );
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
  if (
    (operation !== "apply" && operation !== "dismiss") ||
    typeof planId !== "string" ||
    planId.length === 0
  ) {
    throw new BridgeError(
      "The SynthV sidebar command has invalid fields.",
      "SIDEBAR_COMMAND_INVALID",
    );
  }
  return { operation, planId };
}

export class SidebarCoordinator {
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastHeartbeatAt = 0;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly client: FileIpcClient,
  ) {}

  public start(): void {
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
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
    await this.removeMatchingInstruction(input.requestId);
    return { planId: plan.planId, status: "pending", action: plan.action };
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
    const plan = await this.readPlan();
    if (plan === null || plan.planId !== command.planId) {
      await writeTextAtomically(
        this.config.paths.sidebarActivityFile,
        renderActivity(
          "error",
          "preview",
          "无法处理侧边栏预览。",
          "预览已经过期或已被替换，请让 Codex 重新生成。",
        ),
      );
      return;
    }

    if (command.operation === "dismiss") {
      await removeIfExists(this.config.paths.sidebarPreviewFile);
      await removeIfExists(this.config.paths.sidebarPreviewTextFile);
      await writeTextAtomically(
        this.config.paths.sidebarActivityFile,
        renderActivity("dismissed", plan.action, plan.summary),
      );
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

    try {
      await this.client.send(plan.action, plan.payload);
      await removeIfExists(this.config.paths.sidebarPreviewFile);
      await removeIfExists(this.config.paths.sidebarPreviewTextFile);
      await writeTextAtomically(
        this.config.paths.sidebarActivityFile,
        renderActivity("success", plan.action, plan.summary),
      );
    } catch (error) {
      const publicError = toPublicError(error);
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
      await writeTextAtomically(
        this.config.paths.sidebarActivityFile,
        renderActivity(
          "error",
          plan.action,
          plan.summary,
          `${publicError.code}: ${publicError.message}`,
        ),
      );
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
    await writeTextAtomically(
      this.config.paths.sidebarClientStatusFile,
      [
        "synthv-agent-bridge-sidebar-client-status-v1",
        `state=${state}`,
        `version=${SERVER_VERSION}`,
        `updatedAtEpochMs=${now}`,
        "",
      ].join("\n"),
    );
    this.lastHeartbeatAt = now;
  }
}
