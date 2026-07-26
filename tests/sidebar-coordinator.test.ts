import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type { FileIpcClient } from "../src/ipc/file-ipc-client.js";
import { SidebarCoordinator } from "../src/sidebar-coordinator.js";

interface CleanupContext {
  after(callback: () => void | Promise<void>): void;
}

async function createFixture(context: CleanupContext) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-sidebar-test-"),
  );
  context.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "100",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "200",
    },
    directory,
  );
  const calls: Array<{
    action: string;
    payload: Record<string, unknown>;
  }> = [];
  const client = {
    async send(action: string, payload: Record<string, unknown>) {
      calls.push({ action, payload });
      return { ok: true };
    },
  } as unknown as FileIpcClient;
  return {
    config,
    calls,
    coordinator: new SidebarCoordinator(config, client),
  };
}

async function writeCommand(
  filePath: string,
  operation: "apply" | "dismiss",
  planId: string,
): Promise<void> {
  await fs.writeFile(
    filePath,
    [
      "synthv-agent-bridge-sidebar-command-v1",
      `operation=${operation}`,
      `planId=${planId}`,
      `createdAtEpochMs=${Date.now()}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

test("sidebar request can be read and acknowledged by publishing a preview", async (context) => {
  const fixture = await createFixture(context);
  const requestText = [
    "synthv-agent-bridge-sidebar-request-v1",
    "requestId=request-1",
    `createdAtEpochMs=${Date.now()}`,
    "context-begin",
    "Track 1",
    "context-end",
    "instruction-begin",
    "Transpose the selection.",
    "",
  ].join("\n");
  await fs.writeFile(
    fixture.config.paths.sidebarInstructionFile,
    requestText,
    "utf8",
  );

  const instruction = await fixture.coordinator.getInstruction();
  assert.equal(instruction.pending, true);
  assert.equal(instruction.requestId, "request-1");
  assert.match(instruction.text ?? "", /Transpose the selection/u);

  const preview = await fixture.coordinator.publishPreview({
    requestId: "request-1",
    summary: "Transpose two selected notes down three semitones.",
    details: "Only the selected notes will change.",
    action: "edit_notes",
    payload: {
      trackIndex: 1,
      groupIndex: 1,
      edits: [],
    },
  });
  assert.equal(preview.status, "pending");
  await assert.rejects(
    fs.access(fixture.config.paths.sidebarInstructionFile),
    /ENOENT/u,
  );
  const panelText = await fs.readFile(
    fixture.config.paths.sidebarPreviewTextFile,
    "utf8",
  );
  assert.match(panelText, new RegExp(`planId=${preview.planId}`, "u"));
  assert.match(panelText, /status=pending/u);
  assert.match(panelText, /Transpose two selected notes/u);
});

test("sidebar applies a confirmed preview through the existing IPC client", async (context) => {
  const fixture = await createFixture(context);
  const preview = await fixture.coordinator.publishPreview({
    summary: "Set track 1 gain to -3 dB.",
    action: "set_track_mixer",
    payload: {
      trackIndex: 1,
      trackFingerprint: "main-group:uuid",
      gainDecibel: -3,
    },
  });
  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "apply",
    preview.planId,
  );

  await fixture.coordinator.pollOnce();

  assert.deepEqual(fixture.calls, [
    {
      action: "set_track_mixer",
      payload: {
        trackIndex: 1,
        trackFingerprint: "main-group:uuid",
        gainDecibel: -3,
      },
    },
  ]);
  await assert.rejects(
    fs.access(fixture.config.paths.sidebarPreviewFile),
    /ENOENT/u,
  );
  const activity = await fs.readFile(
    fixture.config.paths.sidebarActivityFile,
    "utf8",
  );
  assert.match(activity, /status=success/u);
  assert.match(activity, /Ctrl\+Z/u);
  assert.match(activity, /编辑 → 撤销/u);
});

test("sidebar dismisses a matching preview without calling SynthV", async (context) => {
  const fixture = await createFixture(context);
  const preview = await fixture.coordinator.publishPreview({
    summary: "Delete one selected note.",
    action: "delete_notes",
    payload: {
      trackIndex: 1,
      groupIndex: 1,
      notes: [],
    },
  });
  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "dismiss",
    preview.planId,
  );

  await fixture.coordinator.pollOnce();

  assert.equal(fixture.calls.length, 0);
  const activity = await fs.readFile(
    fixture.config.paths.sidebarActivityFile,
    "utf8",
  );
  assert.match(activity, /status=dismissed/u);
});

test("sidebar keeps a failed preview visible with a public error", async (context) => {
  const fixture = await createFixture(context);
  const failingClient = {
    async send() {
      throw new Error("simulated failure");
    },
  } as unknown as FileIpcClient;
  const coordinator = new SidebarCoordinator(fixture.config, failingClient);
  const preview = await coordinator.publishPreview({
    summary: "Apply a guarded edit.",
    action: "edit_notes",
    payload: { trackIndex: 1, groupIndex: 1, edits: [] },
  });
  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "apply",
    preview.planId,
  );

  await coordinator.pollOnce();

  const panelText = await fs.readFile(
    fixture.config.paths.sidebarPreviewTextFile,
    "utf8",
  );
  assert.match(panelText, /status=error/u);
  assert.match(panelText, /simulated failure/u);
});
