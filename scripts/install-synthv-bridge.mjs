#!/usr/bin/env node

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(
    "Usage: npm run install:synthv -- --target <SynthV scripts directory> [--no-reload]\n" +
      "Alternatively set SYNTHV_SCRIPTS_DIR. Use SynthV's Scripts → Open Scripts Folder command to find the correct directory.",
  );
}

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readBridgeStatus(statusFile) {
  try {
    return JSON.parse(await readFile(statusFile, "utf8"));
  } catch {
    return null;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function requestHotReload() {
  const ipcDirectory = path.resolve(
    process.env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || os.tmpdir(),
  );
  const prefix = path.join(ipcDirectory, "synthv-agent-bridge");
  const statusFile = `${prefix}.status.json`;
  const reloadFile = `${prefix}.reload`;
  const status = await readBridgeStatus(statusFile);
  const statusStaleMs =
    Number.parseInt(process.env.SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS ?? "", 10) ||
    5_000;
  const ageMs =
    typeof status?.updatedAtEpochMs === "number"
      ? Math.max(0, Date.now() - status.updatedAtEpochMs)
      : Number.POSITIVE_INFINITY;
  const recoverableStaleSession =
    status?.state === "running" &&
    ageMs <= Math.max(60_000, statusStaleMs * 12);
  if (status?.state !== "running" || (!recoverableStaleSession && ageMs > statusStaleMs)) {
    console.log(
      "Bridge is not currently connected. Run Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge once.",
    );
    console.log(
      "Use npm run doctor -- --target <SynthV scripts directory> for a full local diagnosis.",
    );
    return;
  }
  if (ageMs > statusStaleMs) {
    console.log(
      `Bridge heartbeat is ${Math.round(ageMs)} ms old; attempting a recovery reload before requiring manual startup.`,
    );
  }

  const previousSessionToken = status.sessionToken;
  await writeFile(reloadFile, "reload\n", "utf8");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(100);
    const updated = await readBridgeStatus(statusFile);
    if (
      updated?.state === "running" &&
      typeof updated.sessionToken === "string" &&
      updated.sessionToken !== previousSessionToken
    ) {
      console.log("Running SynthV Agent Bridge hot-reloaded successfully.");
      return;
    }
  }
  console.warn(
    "Hot reload was requested but not confirmed. If this Bridge predates hot-reload support, restart it manually once.",
  );
}

async function writeInstallManifest(scriptFile) {
  const ipcDirectory = path.resolve(
    process.env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || os.tmpdir(),
  );
  await mkdir(ipcDirectory, { recursive: true });
  const installFile = path.join(
    ipcDirectory,
    "synthv-agent-bridge.install.json",
  );
  await writeFile(
    installFile,
    `${JSON.stringify(
      {
        protocolVersion: 1,
        scriptFile,
        writtenAtEpochMs: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const argumentsList = process.argv.slice(2);
const targetFlagIndex = argumentsList.indexOf("--target");
const reloadEnabled = !argumentsList.includes("--no-reload");
if (targetFlagIndex >= 0 && !argumentsList[targetFlagIndex + 1]) {
  usage();
  process.exit(2);
}

const suppliedTarget =
  targetFlagIndex >= 0
    ? argumentsList[targetFlagIndex + 1]
    : process.env.SYNTHV_SCRIPTS_DIR;

if (!suppliedTarget) {
  usage();
  process.exitCode = 2;
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceDirectory = path.join(repositoryRoot, "synthv");
  const destinationDirectory = path.resolve(suppliedTarget, "SynthV Agent Bridge");
  const sourceSidebarFile = path.join(
    sourceDirectory,
    "SynthVAgentSidebar.lua",
  );
  const destinationSidebarFile = path.join(
    destinationDirectory,
    "SynthVAgentSidebar.lua",
  );
  const [sourceSidebar, installedSidebarBefore] = await Promise.all([
    readOptionalText(sourceSidebarFile),
    readOptionalText(destinationSidebarFile),
  ]);
  const rescanRequired =
    sourceSidebar === null || installedSidebarBefore !== sourceSidebar;

  await mkdir(destinationDirectory, { recursive: true });
  for (const fileName of [
    "SynthVAgentBridge.lua",
    "StopSynthVAgentBridge.lua",
    "SynthVAgentSidebar.lua",
  ]) {
    await cp(
      path.join(sourceDirectory, fileName),
      path.join(destinationDirectory, fileName),
    );
  }
  await writeInstallManifest(
    path.join(destinationDirectory, "SynthVAgentBridge.lua"),
  );
  console.log(`Installed SynthV Agent Bridge scripts to ${destinationDirectory}`);
  if (reloadEnabled) {
    await requestHotReload();
  }
  if (rescanRequired) {
    console.log(
      "The side-panel script changed. Choose Scripts → Rescan in SynthV; Rescan stops persistent scripts, so then run Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge once.",
    );
  } else {
    console.log(
      "The installed side-panel script is unchanged; no SynthV script rescan is required.",
    );
  }
}
