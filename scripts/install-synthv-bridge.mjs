#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readComponentBuildIdentity } from "./component-build-identity.mjs";

function usage() {
  console.error(
    "Usage: npm run install:synthv -- --target <SynthV scripts directory> [--no-reload] [--without-sidebar]\n" +
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

async function pathExists(filePath) {
  return stat(filePath).then(() => true).catch(() => false);
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function installScriptsAtomically(
  sourceDirectory,
  destinationDirectory,
  installedFiles,
  preparedFiles = {},
) {
  const transactionId = randomUUID();
  const stagingDirectory = path.join(
    destinationDirectory,
    `.v3-install-staging-${transactionId}`,
  );
  const backupDirectory = path.join(
    destinationDirectory,
    `.v3-install-backup-${transactionId}`,
  );
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });

  const expectedHashes = {};
  const backedUp = [];
  const activated = [];
  let preserveBackup = false;
  try {
    for (const fileName of installedFiles) {
      const sourceFile = path.join(sourceDirectory, fileName);
      const stagedFile = path.join(stagingDirectory, fileName);
      const sourceText =
        preparedFiles[fileName] ?? await readFile(sourceFile, "utf8");
      expectedHashes[fileName] = sha256(sourceText);
      await writeFile(stagedFile, sourceText, "utf8");
      const stagedText = await readFile(stagedFile, "utf8");
      if (sha256(stagedText) !== expectedHashes[fileName]) {
        throw new Error(`Staged install verification failed for ${fileName}`);
      }
    }

    for (const fileName of installedFiles) {
      const destinationFile = path.join(destinationDirectory, fileName);
      const backupFile = path.join(backupDirectory, fileName);
      if (await pathExists(destinationFile)) {
        await rename(destinationFile, backupFile);
        backedUp.push(fileName);
      }
      await rename(path.join(stagingDirectory, fileName), destinationFile);
      activated.push(fileName);
      if (
        process.env.NODE_ENV === "test" &&
        process.env.SYNTHV_AGENT_INSTALL_TEST_FAIL_AFTER_ACTIVATION ===
          String(activated.length)
      ) {
        throw new Error(
          `Injected install failure after activating ${activated.length} file(s)`,
        );
      }
    }
    for (const fileName of installedFiles) {
      const installedText = await readFile(
        path.join(destinationDirectory, fileName),
        "utf8",
      );
      if (sha256(installedText) !== expectedHashes[fileName]) {
        throw new Error(`Installed file verification failed for ${fileName}`);
      }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const fileName of activated.reverse()) {
      await rm(path.join(destinationDirectory, fileName), {
        force: true,
      }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    for (const fileName of backedUp.reverse()) {
      await rename(
        path.join(backupDirectory, fileName),
        path.join(destinationDirectory, fileName),
      ).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      preserveBackup = true;
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Install failed and rollback was incomplete; recovery files remain at ${backupDirectory}`,
      );
    }
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (!preserveBackup) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
  return expectedHashes;
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
    return "offline";
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
      return "reloaded";
    }
  }
  console.warn(
    "Hot reload was requested but not confirmed. If this Bridge predates hot-reload support, restart it manually once.",
  );
  return "unconfirmed";
}

async function writeInstallManifest(scriptFile, buildIdentity) {
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
        schemaVersion: 2,
        scriptFile,
        ...buildIdentity,
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
const installSidebar = !argumentsList.includes("--without-sidebar");
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
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const componentIdentity =
    await readComponentBuildIdentity(repositoryRoot, { includeSidebar: installSidebar });
  const sourceDirectory = path.join(repositoryRoot, "synthv");
  const destinationDirectory = path.resolve(suppliedTarget, "SynthV Agent Bridge");
  const destinationBridgeFile = path.join(
    destinationDirectory,
    "SynthVAgentBridge.lua",
  );
  const sourceBridge = componentIdentity.prepareExecutorSource();
  const installedBridgeBefore =
    await readOptionalText(destinationBridgeFile);
  const bridgeChanged =
    installedBridgeBefore !== sourceBridge;
  let sidebarChanged = false;
  let sourceSidebar;
  if (installSidebar) {
    const destinationSidebarFile = path.join(
      destinationDirectory,
      "SynthVAgentSidebar.lua",
    );
    sourceSidebar = componentIdentity.prepareSidebarSource();
    const installedSidebarBefore =
      await readOptionalText(destinationSidebarFile);
    sidebarChanged =
      installedSidebarBefore !== sourceSidebar;
  }

  const installedFiles = [
    "SynthVAgentBridge.lua",
    "StopSynthVAgentBridge.lua",
    ...(installSidebar ? ["SynthVAgentSidebar.lua"] : []),
  ];
  await mkdir(destinationDirectory, { recursive: true });
  const installedHashes = await installScriptsAtomically(
    sourceDirectory,
    destinationDirectory,
    installedFiles,
    {
      "SynthVAgentBridge.lua": sourceBridge,
      ...(installSidebar
        ? { "SynthVAgentSidebar.lua": sourceSidebar }
        : {}),
    },
  );
  await writeInstallManifest(
    path.join(destinationDirectory, "SynthVAgentBridge.lua"),
    {
      packageVersion: packageManifest.version,
      protocolVersion: 3,
      executorBuildId: componentIdentity.executorBuildId,
      sidebarBuildId: installSidebar
        ? componentIdentity.sidebarBuildId
        : null,
      executorSourceFingerprint:
        componentIdentity.executorSourceFingerprint,
      sidebarSourceFingerprint: installSidebar
        ? componentIdentity.sidebarSourceFingerprint
        : null,
      installedFiles: installedHashes,
    },
  );
  console.log(`Installed SynthV Agent Bridge scripts to ${destinationDirectory}`);
  const reloadResult = reloadEnabled
    ? await requestHotReload()
    : "disabled";
  if (bridgeChanged) {
    console.log(
      reloadResult === "reloaded"
        ? "The Bridge runtime changed. Hot reload updated the current session, but SynthV may reuse cached menu-script code after a project or app restart. Before the next manual start, choose Scripts → Rescan, then start SynthV Agent Bridge once."
        : "The Bridge runtime changed. Choose Scripts → Rescan, then start SynthV Agent Bridge once so SynthV does not reuse cached menu-script code.",
    );
  }
  if (!installSidebar) {
    console.log(
      "Skipped the optional side-panel script. An existing installed sidebar, if any, was left unchanged.",
    );
  } else if (sidebarChanged) {
    console.log(
      "The side-panel script changed. Choose Scripts → Rescan in SynthV; Rescan stops persistent scripts, so then run Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge once.",
    );
  } else {
    console.log(
      "The installed side-panel script is unchanged.",
    );
  }
}
