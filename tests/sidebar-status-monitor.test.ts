import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SIDEBAR_BUILD_ID } from "../src/build-info.js";
import { loadConfig } from "../src/config.js";
import {
  SidebarStatusMonitor,
  sidebarStatusMonitorTesting,
} from "../src/sidebar-status-monitor.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface CleanupContext {
  after(callback: () => void | Promise<void>): void;
}

async function createFixture(context: CleanupContext) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-sidebar-status-test-"),
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
  return {
    config,
    monitor: new SidebarStatusMonitor(config),
  };
}

test("sidebar status monitor stops after its in-flight heartbeat", async (context) => {
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
  fixture.monitor.pollOnce = async () => {
    pollCount += 1;
    reportPollStarted();
    await pollReleased;
  };
  fixture.monitor.start();
  await Promise.race([
    pollStarted,
    sleep(1_000).then(() => {
      throw new Error("Sidebar heartbeat did not start within the deadline.");
    }),
  ]);

  const stopped = fixture.monitor.stop();
  assert.strictEqual(stopped, fixture.monitor.stop());
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

test("sidebar status writes survive transient Windows file contention", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-sidebar-status-contention-"),
  );
  context.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  const statusFile = path.join(directory, "client-status.txt");
  await fs.writeFile(statusFile, "old", "utf8");
  let targetUnlinkAttempts = 0;
  let renameAttempts = 0;
  const operations = {
    writeFile: fs.writeFile,
    async unlink(filePath: string) {
      if (filePath === statusFile && targetUnlinkAttempts++ === 0) {
        const error = new Error(
          "simulated Windows file contention",
        ) as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return fs.unlink(filePath);
    },
    async rename(source: string, destination: string) {
      if (renameAttempts++ === 0) {
        await fs.writeFile(destination, "competing writer", "utf8");
        const error = new Error(
          "simulated Windows rename contention",
        ) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return fs.rename(source, destination);
    },
  };

  await sidebarStatusMonitorTesting.writeTextAtomically(
    statusFile,
    "new",
    operations,
  );

  assert.equal(targetUnlinkAttempts, 2);
  assert.equal(renameAttempts, 2);
  assert.equal(await fs.readFile(statusFile, "utf8"), "new");
});

test("sidebar status reports only MCP and panel runtime health", async (context) => {
  const fixture = await createFixture(context);
  await fixture.monitor.pollOnce();
  await fs.writeFile(
    fixture.config.paths.sidebarRuntimeStatusFile,
    [
      "synthv-agent-bridge-sidebar-runtime-v3",
      "state=running",
      "version=0.3.0",
      `buildId=${SIDEBAR_BUILD_ID}`,
      `updatedAtEpochMs=${Date.now()}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const status = await fixture.monitor.getStatus();
  assert.deepEqual(Object.keys(status).sort(), [
    "client",
    "ipcDirectory",
    "lastError",
    "sidebar",
    "version",
  ]);
  assert.equal((status.client as { fresh: boolean }).fresh, true);
  assert.equal((status.sidebar as { fresh: boolean }).fresh, true);
  assert.equal(
    (await fixture.monitor.getRuntimeBuildIdentity()).state,
    "matched",
  );
});
