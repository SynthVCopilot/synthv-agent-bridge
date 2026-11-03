#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readComponentBuildIdentity } from "./component-build-identity.mjs";

const SERVER_NAME = "synthv-agent-bridge";
const EXPECTED_PROTOCOL_VERSION = 3;
const argumentsList = process.argv.slice(2);
const jsonOutput = argumentsList.includes("--json");
const targetFlagIndex = argumentsList.indexOf("--target");
const hostFlagIndex = argumentsList.indexOf("--host");
const selectedHost = hostFlagIndex >= 0 ? argumentsList[hostFlagIndex + 1] : "core";
const supportedHosts = new Set(["core", "profiles", "all"]);
if (!supportedHosts.has(selectedHost)) {
  process.stderr.write(
    `Unsupported --host value ${JSON.stringify(selectedHost)}; use core, profiles, or all.\n`,
  );
  process.exit(2);
}
const suppliedTarget =
  targetFlagIndex >= 0
    ? argumentsList[targetFlagIndex + 1]
    : process.env.SYNTHV_SCRIPTS_DIR;
// Doctor stays offline unless the user asks for an update check.
const checkUpdates = argumentsList.includes("--check-updates");
const updateSourceFlagIndex = argumentsList.indexOf("--update-source");

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

const CANONICAL_ENTRY = "dist/src/cli.js";
const SKIPPED_PROFILE_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
]);

// Project profiles are discovered, never enumerated by client brand: a new MCP
// client is onboarded by adding its own config file, with no change here. Only
// the launch contract is validated; every other key belongs to that client.
async function discoverProjectProfiles() {
  const profiles = [];
  const addProfile = async (relativePath, format) => {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content =
      format === "json"
        ? await readJson(absolutePath)
        : await readText(absolutePath);
    if (content === null) return;
    profiles.push({
      id: relativePath.split(path.sep).join("/"),
      format,
      content,
    });
  };

  await addProfile(".mcp.json", "json");

  let rootEntries = [];
  try {
    rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || SKIPPED_PROFILE_DIRECTORIES.has(entry.name)) {
      continue;
    }
    await addProfile(path.join(entry.name, "config.toml"), "toml");
    await addProfile(path.join(entry.name, "mcp.json"), "json");
  }

  return profiles.sort((left, right) => left.id.localeCompare(right.id));
}

function profileLaunchesCanonicalEntry(profile) {
  if (profile.format === "json") {
    const servers = profile.content?.mcpServers;
    const server = servers?.[SERVER_NAME];
    return (
      server?.command === "node" &&
      Array.isArray(server.args) &&
      server.args.includes(CANONICAL_ENTRY)
    );
  }
  return (
    typeof profile.content === "string" &&
    profile.content.includes(SERVER_NAME) &&
    profile.content.includes(CANONICAL_ENTRY)
  );
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

async function collectFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, predicate)));
    } else if (entry.isFile() && predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function newestMtimeMs(files) {
  const mtimes = await Promise.all(
    files.map((filePath) => stat(filePath).then((value) => value.mtimeMs)),
  );
  return mtimes.length === 0 ? null : Math.max(...mtimes);
}

record(
  "package-version",
  expectedVersion === "0.3.2" ? "ok" : "error",
  `Package version is ${expectedVersion}; this release line must remain 0.3.2.`,
);

const componentBuildIdentity = await readComponentBuildIdentity(repositoryRoot);
const sourceBridge = componentBuildIdentity.prepareExecutorSource();
const sourceSidebar = componentBuildIdentity.prepareSidebarSource();
const sourceBridgeVersion = sourceBridge?.match(
  /BRIDGE_VERSION\s*=\s*"([^"]+)"/u,
)?.[1];
const sourceProtocolVersion = Number(
  sourceBridge?.match(/PROTOCOL_VERSION\s*=\s*(\d+)/u)?.[1],
);
const sourceSidebarVersion = sourceSidebar?.match(
  /SIDEBAR_VERSION\s*=\s*"([^"]+)"/u,
)?.[1];
const sourceExecutorBuildId = componentBuildIdentity.executorBuildId;
const sourceSidebarBuildId = componentBuildIdentity.sidebarBuildId;
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

record(
  "source-protocol",
  sourceProtocolVersion === EXPECTED_PROTOCOL_VERSION ? "ok" : "error",
  `Source file IPC protocol is ${
    Number.isFinite(sourceProtocolVersion) ? sourceProtocolVersion : "missing"
  }; expected ${EXPECTED_PROTOCOL_VERSION}.`,
);

const runtimeSourceFiles = await collectFiles(
  path.join(repositoryRoot, "src"),
  (filePath) => filePath.endsWith(".ts"),
);
const buildInputs = [
  ...runtimeSourceFiles,
  path.join(repositoryRoot, "package.json"),
  path.join(repositoryRoot, "tsconfig.json"),
];
const buildInfoFile = path.join(repositoryRoot, "dist", "src", "build-info.js");
const [newestBuildInputMtimeMs, buildInfoStat] = await Promise.all([
  newestMtimeMs(buildInputs),
  stat(buildInfoFile).catch(() => null),
]);
const buildFresh =
  newestBuildInputMtimeMs !== null &&
  buildInfoStat !== null &&
  buildInfoStat.mtimeMs + 1_000 >= newestBuildInputMtimeMs;
record(
  "mcp-build",
  buildFresh ? "ok" : "error",
  buildFresh
    ? "Compiled MCP build is present and newer than its runtime source inputs."
    : "Compiled MCP build is missing or stale; run npm run build, then restart or reconnect the MCP host.",
  {
    buildInfoFile,
    buildMtimeMs: buildInfoStat?.mtimeMs ?? null,
    newestBuildInputMtimeMs,
  },
);

let expectedCapabilityFingerprint = null;
let expectedBuildFingerprint = null;
if (buildInfoStat !== null) {
  try {
    const buildInfo = await import(pathToFileURL(buildInfoFile).href);
    expectedBuildFingerprint =
      typeof buildInfo.SERVER_BUILD_FINGERPRINT === "string"
        ? buildInfo.SERVER_BUILD_FINGERPRINT
        : null;
    expectedCapabilityFingerprint =
      typeof buildInfo.SERVER_CAPABILITY_FINGERPRINT === "string"
        ? buildInfo.SERVER_CAPABILITY_FINGERPRINT
        : null;
  } catch {
    // The build check above already reports a missing or unreadable build.
  }
}

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

const bridgeProtocolVersions = bridgeStatus?.protocolVersions;
const bridgeProtocolMatches =
  bridgeStatus?.protocolVersion === EXPECTED_PROTOCOL_VERSION &&
  bridgeStatus?.preferredProtocolVersion === EXPECTED_PROTOCOL_VERSION &&
  Array.isArray(bridgeProtocolVersions) &&
  bridgeProtocolVersions.length === 1 &&
  bridgeProtocolVersions[0] === EXPECTED_PROTOCOL_VERSION;
record(
  "bridge-protocol",
  bridgeStatus === null
    ? "warning"
    : bridgeProtocolMatches
      ? "ok"
      : "error",
  bridgeStatus === null
    ? "Bridge protocol is unavailable until the Bridge is running."
    : bridgeProtocolMatches
      ? `Bridge advertises only file IPC protocol ${EXPECTED_PROTOCOL_VERSION}.`
      : `Bridge protocol advertisement is incompatible; reinstall and restart the Bridge. Expected only ${EXPECTED_PROTOCOL_VERSION}.`,
  bridgeStatus === null
    ? undefined
    : {
        protocolVersion: bridgeStatus.protocolVersion,
        protocolVersions: bridgeProtocolVersions,
        preferredProtocolVersion: bridgeStatus.preferredProtocolVersion,
      },
);

const runningExecutorBuildId = bridgeStatus?.executorBuildId;
record(
  "executor-build",
  bridgeStatus === null
    ? "warning"
    : runningExecutorBuildId === sourceExecutorBuildId
      ? "ok"
      : "error",
  bridgeStatus === null
    ? "The executor build cannot be verified until the Bridge is running."
    : runningExecutorBuildId === sourceExecutorBuildId
      ? `Running executor build matches ${sourceExecutorBuildId}.`
      : "Running executor build differs from source; reinstall and reload the Bridge before writing.",
  {
    expected: sourceExecutorBuildId ?? null,
    actual: runningExecutorBuildId ?? null,
  },
);

const sidebarRuntimeStatus = await readText(
  `${prefix}.sidebar.runtime-status.txt`,
);
const sidebarRuntimeUpdatedAt = Number(
  lineValue(sidebarRuntimeStatus, "updatedAtEpochMs"),
);
const sidebarRuntimeFresh =
  sidebarRuntimeStatus !== null && fresh(sidebarRuntimeUpdatedAt, 10_000);
const runningSidebarBuildId = lineValue(sidebarRuntimeStatus, "buildId");
record(
  "sidebar-build",
  !sidebarRuntimeFresh
    ? "warning"
    : runningSidebarBuildId === sourceSidebarBuildId
      ? "ok"
      : "error",
  !sidebarRuntimeFresh
    ? "The optional Sidebar is absent or inactive; no active Sidebar build needs verification."
    : runningSidebarBuildId === sourceSidebarBuildId
      ? `Active Sidebar build matches ${sourceSidebarBuildId}.`
      : "The active Sidebar build differs from source; reinstall and reopen or rescan the Sidebar.",
  {
    expected: sourceSidebarBuildId ?? null,
    actual: runningSidebarBuildId ?? null,
  },
);

const clientStatus = await readText(`${prefix}.sidebar.client-status.txt`);
const clientUpdatedAt = Number(lineValue(clientStatus, "updatedAtEpochMs"));
const clientRunningAndFresh =
  lineValue(clientStatus, "state") === "running" && fresh(clientUpdatedAt);
record(
  "mcp-heartbeat",
  clientRunningAndFresh ? "ok" : "warning",
  clientStatus === null
    ? "MCP sidebar heartbeat is missing; restart or reconnect the MCP host."
    : `MCP ${lineValue(clientStatus, "version") ?? "?"}, state ${
        lineValue(clientStatus, "state") ?? "unknown"
  }.`,
);

const runningCapabilityFingerprint = lineValue(
  clientStatus,
  "capabilityFingerprint",
);
const runningBuildFingerprint = lineValue(clientStatus, "buildFingerprint");
const capabilityMatches =
  expectedCapabilityFingerprint !== null &&
  runningCapabilityFingerprint === expectedCapabilityFingerprint;
const runningBuildMatches =
  expectedBuildFingerprint !== null &&
  runningBuildFingerprint === expectedBuildFingerprint;
record(
  "mcp-capabilities",
  !clientRunningAndFresh
    ? "warning"
    : capabilityMatches && runningBuildMatches
      ? "ok"
      : "error",
  !clientRunningAndFresh
    ? "A fresh running MCP process is required to verify its capability fingerprint."
    : capabilityMatches && runningBuildMatches
      ? "Running MCP build and capabilities match the current compiled build."
      : "Running MCP build or capabilities are stale or unknown; restart or reconnect the MCP host.",
  {
    expectedBuildFingerprint,
    runningBuildFingerprint: runningBuildFingerprint ?? null,
    expectedCapabilityFingerprint,
    runningCapabilityFingerprint:
      runningCapabilityFingerprint ?? null,
  },
);

const residualFiles = [];
for (const suffix of [
  ".processing.json",
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
  const installedCoreMatches =
    installedBridgeVersion === expectedVersion &&
    bridgeContentMatches;
  record(
    "installed-scripts",
    installedCoreMatches ? "ok" : "error",
    installedCoreMatches
      ? `Installed Bridge matches the ${expectedVersion} source file; the sidebar is optional.`
      : `Installed Bridge ${installedBridgeVersion ?? "missing"} does not match the ${expectedVersion} source file.`,
    {
      installedDirectory,
      bridgeContentMatches,
    },
  );
  const optionalSidebarMatches =
    installedSidebar === null ||
    (installedSidebarVersion === expectedVersion && sidebarContentMatches);
  record(
    "optional-sidebar",
    optionalSidebarMatches ? "ok" : "warning",
    installedSidebar === null
      ? "The optional SynthV side panel is not installed; core Bridge and MCP operation is unaffected."
      : optionalSidebarMatches
        ? `Optional sidebar matches the ${expectedVersion} source file.`
        : `Optional sidebar ${installedSidebarVersion ?? "unknown"} differs from source; reinstall it only if the panel is used.`,
    {
      installed: installedSidebar !== null,
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

if (selectedHost === "profiles" || selectedHost === "all") {
  for (const profile of await discoverProjectProfiles()) {
    const launches = profileLaunchesCanonicalEntry(profile);
    record(
      `project-profile:${profile.id}`,
      launches ? "ok" : "warning",
      launches
        ? `Project profile ${profile.id} launches the canonical ${SERVER_NAME} entry point.`
        : `No usable project-scoped ${SERVER_NAME} entry was found in ${profile.id}.`,
    );
  }
}

function parseReleaseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  return match === null ? null : match.slice(1).map(Number);
}

function compareReleaseVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function resolveUpdateSource() {
  if (updateSourceFlagIndex >= 0) return argumentsList[updateSourceFlagIndex + 1];
  const origin = spawnSync(
    "git",
    ["-C", repositoryRoot, "remote", "get-url", "origin"],
    { encoding: "utf8", timeout: 5_000 },
  );
  const originUrl = origin.status === 0 ? origin.stdout.trim() : "";
  const repository = packageManifest.repository;
  return originUrl ||
    (typeof repository === "string" ? repository : repository?.url);
}

// The only Doctor path that may use the network: it lists release tags through
// git and never fetches into, or changes, this checkout.
function recordUpdateCheck() {
  const source = resolveUpdateSource();
  if (!source) {
    record(
      "update-check",
      "warning",
      "No update source is known; pass --update-source with the repository URL.",
    );
    return;
  }
  const result = spawnSync(
    "git",
    ["ls-remote", "--tags", "--refs", source],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    record(
      "update-check",
      "warning",
      `Could not read release tags from ${source}; check the network or git installation.`,
      {
        source,
        cause: (result.error?.message ?? result.stderr ?? "").trim().slice(0, 300),
      },
    );
    return;
  }
  const releases = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//u, ""))
    .filter((tag) => tag !== undefined)
    .map((tag) => ({ tag, version: parseReleaseVersion(tag) }))
    .filter((release) => release.version !== null)
    .sort((left, right) => compareReleaseVersions(right.version, left.version));
  const currentVersion = parseReleaseVersion(expectedVersion);
  if (releases.length === 0 || currentVersion === null) {
    record(
      "update-check",
      "warning",
      `No release tags were found at ${source}.`,
      { source },
    );
    return;
  }
  const latest = releases[0];
  const difference = compareReleaseVersions(latest.version, currentVersion);
  record(
    "update-check",
    difference > 0 ? "warning" : "ok",
    difference > 0
      ? `Release ${latest.tag} is available; this checkout is ${expectedVersion}. Run npm run update.`
      : difference === 0
        ? `${expectedVersion} is the latest release.`
        : `${expectedVersion} is newer than the latest release ${latest.tag}.`,
    { source, latest: latest.tag },
  );
}

if (checkUpdates) {
  recordUpdateCheck();
}

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
        host: selectedHost,
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
