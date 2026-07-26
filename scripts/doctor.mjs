#!/usr/bin/env node

import { access, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "synthv-agent-bridge";
const argumentsList = process.argv.slice(2);
const jsonOutput = argumentsList.includes("--json");
const targetFlagIndex = argumentsList.indexOf("--target");
const suppliedTarget =
  targetFlagIndex >= 0
    ? argumentsList[targetFlagIndex + 1]
    : process.env.SYNTHV_SCRIPTS_DIR;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const expectedVersion = packageManifest.version;
const ipcDirectory = path.resolve(
  process.env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || os.tmpdir(),
);
const prefix = path.join(ipcDirectory, SERVER_NAME);

const checks = [];
function record(name, status, message, details = undefined) {
  checks.push({
    name,
    status,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJson(filePath) {
  const text = await readText(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { invalid: true };
  }
}

function lineValue(text, key) {
  if (typeof text !== "string") return undefined;
  const prefixText = `${key}=`;
  return text
    .split(/\r?\n/u)
    .slice(0, 12)
    .find((line) => line.startsWith(prefixText))
    ?.slice(prefixText.length);
}

function fresh(updatedAtEpochMs, maximumAgeMs = 5_000) {
  return (
    typeof updatedAtEpochMs === "number" &&
    Math.max(0, Date.now() - updatedAtEpochMs) <= maximumAgeMs
  );
}

function sha256(content) {
  return typeof content === "string"
    ? createHash("sha256").update(content, "utf8").digest("hex")
    : null;
}

record(
  "package-version",
  expectedVersion === "0.1.4" ? "ok" : "error",
  `Package version is ${expectedVersion}; this feature line must remain 0.1.4.`,
);

const sourceBridge = await readText(
  path.join(repositoryRoot, "synthv", "SynthVAgentBridge.lua"),
);
const sourceSidebar = await readText(
  path.join(repositoryRoot, "synthv", "SynthVAgentSidebar.lua"),
);
const sourceBridgeVersion = sourceBridge?.match(
  /BRIDGE_VERSION\s*=\s*"([^"]+)"/u,
)?.[1];
const sourceSidebarVersion = sourceSidebar?.match(
  /SIDEBAR_VERSION\s*=\s*"([^"]+)"/u,
)?.[1];
record(
  "source-versions",
  sourceBridgeVersion === expectedVersion &&
    sourceSidebarVersion === expectedVersion
    ? "ok"
    : "error",
  `Source versions: Bridge ${sourceBridgeVersion ?? "missing"}, sidebar ${
    sourceSidebarVersion ?? "missing"
  }.`,
);

const bridgeStatus = await readJson(`${prefix}.status.json`);
const bridgeAgeMs =
  typeof bridgeStatus?.updatedAtEpochMs === "number"
    ? Math.max(0, Date.now() - bridgeStatus.updatedAtEpochMs)
    : null;
record(
  "bridge-heartbeat",
  bridgeStatus?.state === "running" &&
    fresh(bridgeStatus.updatedAtEpochMs)
    ? "ok"
    : "warning",
  bridgeStatus?.state === "running" && bridgeAgeMs !== null
    ? `Bridge ${bridgeStatus.bridgeVersion ?? "?"} heartbeat age ${bridgeAgeMs} ms.`
    : "Bridge is offline. Run Scripts > SynthV Agent Bridge > Start SynthV Agent Bridge.",
  { ipcDirectory },
);

const clientStatus = await readText(`${prefix}.sidebar.client-status.txt`);
const clientUpdatedAt = Number(lineValue(clientStatus, "updatedAtEpochMs"));
record(
  "mcp-heartbeat",
  lineValue(clientStatus, "state") === "running" &&
    fresh(clientUpdatedAt)
    ? "ok"
    : "warning",
  clientStatus === null
    ? "MCP sidebar heartbeat is missing; restart or reconnect the Codex MCP server."
    : `MCP ${lineValue(clientStatus, "version") ?? "?"}, state ${
        lineValue(clientStatus, "state") ?? "unknown"
      }.`,
);

const residualFiles = [];
for (const suffix of [
  ".processing.json",
  ".sidebar.command.processing.txt",
  ".reload",
  ".stop",
]) {
  const filePath = `${prefix}${suffix}`;
  try {
    const fileStat = await stat(filePath);
    residualFiles.push({
      file: path.basename(filePath),
      ageMs: Math.max(0, Date.now() - fileStat.mtimeMs),
    });
  } catch {
    // Missing is healthy.
  }
}
record(
  "ipc-residuals",
  residualFiles.length === 0 ? "ok" : "warning",
  residualFiles.length === 0
    ? "No stale processing/control files were found."
    : "Processing/control files exist; inspect their age before removing them.",
  residualFiles,
);

if (suppliedTarget) {
  const installedDirectory = path.resolve(
    suppliedTarget,
    "SynthV Agent Bridge",
  );
  const installedBridge = await readText(
    path.join(installedDirectory, "SynthVAgentBridge.lua"),
  );
  const installedSidebar = await readText(
    path.join(installedDirectory, "SynthVAgentSidebar.lua"),
  );
  const installedBridgeVersion = installedBridge?.match(
    /BRIDGE_VERSION\s*=\s*"([^"]+)"/u,
  )?.[1];
  const installedSidebarVersion = installedSidebar?.match(
    /SIDEBAR_VERSION\s*=\s*"([^"]+)"/u,
  )?.[1];
  const bridgeContentMatches =
    sourceBridge !== null &&
    installedBridge !== null &&
    sha256(installedBridge) === sha256(sourceBridge);
  const sidebarContentMatches =
    sourceSidebar !== null &&
    installedSidebar !== null &&
    sha256(installedSidebar) === sha256(sourceSidebar);
  const installedScriptsMatch =
    installedBridgeVersion === expectedVersion &&
    installedSidebarVersion === expectedVersion &&
    bridgeContentMatches &&
    sidebarContentMatches;
  record(
    "installed-scripts",
    installedScriptsMatch ? "ok" : "error",
    installedScriptsMatch
      ? `Installed Bridge and sidebar match the ${expectedVersion} source files.`
      : `Installed versions: Bridge ${installedBridgeVersion ?? "missing"}, sidebar ${
          installedSidebarVersion ?? "missing"
        }; content match: Bridge ${bridgeContentMatches}, sidebar ${sidebarContentMatches}.`,
    {
      installedDirectory,
      bridgeContentMatches,
      sidebarContentMatches,
    },
  );
} else {
  record(
    "installed-scripts",
    "warning",
    "Pass --target or set SYNTHV_SCRIPTS_DIR to verify installed script versions.",
  );
}

const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
const codexConfig = await readText(codexConfigPath);
record(
  "codex-config",
  codexConfig?.includes(SERVER_NAME) ? "ok" : "warning",
  codexConfig?.includes(SERVER_NAME)
    ? "Codex config contains a synthv-agent-bridge entry."
    : `No synthv-agent-bridge entry was found in ${codexConfigPath}.`,
);

try {
  await access(ipcDirectory);
  record("ipc-directory", "ok", `IPC directory is accessible: ${ipcDirectory}`);
} catch {
  record(
    "ipc-directory",
    "error",
    `IPC directory is not accessible: ${ipcDirectory}`,
  );
}

if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify(
      {
        version: expectedVersion,
        ok: !checks.some((check) => check.status === "error"),
        checks,
      },
      null,
      2,
    )}\n`,
  );
} else {
  for (const check of checks) {
    const icon =
      check.status === "ok" ? "OK" : check.status === "warning" ? "WARN" : "ERROR";
    console.log(`[${icon}] ${check.name}: ${check.message}`);
  }
}

if (checks.some((check) => check.status === "error")) {
  process.exitCode = 1;
}
