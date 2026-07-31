import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import type { FileIpcClient } from "../src/ipc/file-ipc-client.js";
import { SidebarCoordinator } from "../src/sidebar-coordinator.js";
import { recentTraceSummaries } from "../src/v3-command-kernel.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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
  operation: "apply" | "dismiss" | "cancel_request" | "clear_history",
  planId?: string,
  requestId?: string,
): Promise<void> {
  const lines = [
    "synthv-agent-bridge-sidebar-command-v1",
    `operation=${operation}`,
    `createdAtEpochMs=${Date.now()}`,
  ];
  if (planId !== undefined) {
    lines.push(`planId=${planId}`);
  }
  if (requestId !== undefined) {
    lines.push(`requestId=${requestId}`);
  }
  lines.push("");
  await fs.writeFile(
    filePath,
    lines.join("\n"),
    "utf8",
  );
}

test("sidebar stop drains in-flight polling once and remains stopped", async (context) => {
  const fixture = await createFixture(context);
  let releasePoll: () => void = () => undefined;
  const pollReleased = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let reportPollStarted: () => void = () => undefined;
  const pollStarted = new Promise<void>((resolve) => {
    reportPollStarted = resolve;
  });
  let pollCount = 0;
  fixture.coordinator.pollOnce = async () => {
    pollCount += 1;
    reportPollStarted();
    await pollReleased;
  };
  fixture.coordinator.start();
  await Promise.race([
    pollStarted,
    sleep(1_000).then(() => {
      throw new Error("Sidebar poll did not start within the test deadline.");
    }),
  ]);

  const stopped = fixture.coordinator.stop();
  const repeatedStop = fixture.coordinator.stop();

  assert.strictEqual(stopped, repeatedStop);
  assert.ok(stopped instanceof Promise);
  let settled = false;
  void stopped.then(() => {
    settled = true;
  });
  await sleep(10);
  assert.equal(settled, false);
  releasePoll();
  await stopped;
  const status = await fs.readFile(
    fixture.config.paths.sidebarClientStatusFile,
    "utf8",
  );
  assert.match(status, /state=stopped/u);
  await sleep(150);
  assert.equal(pollCount, 1);
});

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
    changes: [
      { label: "Pitch", before: "C4, G4", after: "A3, E4", count: 2 },
    ],
    risks: ["Current note fingerprints must still match."],
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
  assert.match(panelText, /C4, G4 → A3, E4/u);
  assert.match(panelText, /Current note fingerprints/u);
  const stateText = await fs.readFile(
    fixture.config.paths.sidebarStateFile,
    "utf8",
  );
  assert.match(stateText, /status=awaiting_confirmation/u);
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

  assert.deepEqual(
    recentTraceSummaries(1)[0]?.stages.filter((stage) =>
      ["contextResolved", "verified"].includes(stage),
    ),
    ["contextResolved", "verified"],
  );
  assert.deepEqual(fixture.calls, [
    {
      action: "set_track_mixer",
      payload: {
        trackIndex: 1,
        trackFingerprint: "main-group:uuid",
        gainDecibel: -3,
        _sidebarPlanId: preview.planId,
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
  const history = JSON.parse(
    await fs.readFile(fixture.config.paths.sidebarHistoryFile, "utf8"),
  ) as Array<{ status: string }>;
  assert.equal(history.at(-1)?.status, "success");
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
  const diagnostics = await coordinator.getDiagnostics();
  assert.deepEqual(diagnostics.lastError, {
    code: "INTERNAL_ERROR",
    message: "simulated failure",
  });
});

test("sidebar build mismatch blocks an approved preview before project IPC", async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(
    fixture.config.paths.sidebarRuntimeStatusFile,
    [
      "synthv-agent-bridge-sidebar-runtime-v3",
      "buildId=old-sidebar-build",
      `updatedAtEpochMs=${Date.now()}`,
      "",
    ].join("\n"),
    "utf8",
  );
  const preview = await fixture.coordinator.publishPreview({
    summary: "Set track gain.",
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

  assert.equal(fixture.calls.length, 0);
  const panelText = await fs.readFile(
    fixture.config.paths.sidebarPreviewTextFile,
    "utf8",
  );
  assert.match(panelText, /status=error/u);
  assert.match(panelText, /BUILD_MISMATCH/u);
});

test("sidebar can cancel a queued request and clear bounded history", async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(
    fixture.config.paths.sidebarInstructionFile,
    [
      "synthv-agent-bridge-sidebar-request-v1",
      "requestId=request-cancel",
      `createdAtEpochMs=${Date.now()}`,
      "instruction-begin",
      "Cancel me",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "cancel_request",
    undefined,
    "request-cancel",
  );
  await fixture.coordinator.pollOnce();
  await assert.rejects(
    fs.access(fixture.config.paths.sidebarInstructionFile),
    /ENOENT/u,
  );
  const cancelledState = await fs.readFile(
    fixture.config.paths.sidebarStateFile,
    "utf8",
  );
  assert.match(cancelledState, /status=cancelled/u);

  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "clear_history",
  );
  await fixture.coordinator.pollOnce();
  await assert.rejects(
    fs.access(fixture.config.paths.sidebarHistoryFile),
    /ENOENT/u,
  );
  const activity = await fs.readFile(
    fixture.config.paths.sidebarActivityFile,
    "utf8",
  );
  assert.match(activity, /status=empty/u);
});

test("sidebar ignores an outdated cancel command for a newer request", async (context) => {
  const fixture = await createFixture(context);
  await fs.writeFile(
    fixture.config.paths.sidebarInstructionFile,
    [
      "synthv-agent-bridge-sidebar-request-v1",
      "requestId=request-new",
      `createdAtEpochMs=${Date.now()}`,
      "instruction-begin",
      "Keep me",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeCommand(
    fixture.config.paths.sidebarCommandFile,
    "cancel_request",
    undefined,
    "request-old",
  );

  await fixture.coordinator.pollOnce();

  const instruction = await fs.readFile(
    fixture.config.paths.sidebarInstructionFile,
    "utf8",
  );
  assert.match(instruction, /requestId=request-new/u);
  const state = await fs.readFile(
    fixture.config.paths.sidebarStateFile,
    "utf8",
  );
  assert.match(state, /status=queued/u);
  assert.match(state, /requestId=request-new/u);
});
