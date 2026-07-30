import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, SERVER_VERSION } from "./config.js";
import { GENERATED_BUILD_METADATA } from "./generated-build-metadata.js";
import { BRIDGE_ACTIONS } from "./protocol.js";

export const PUBLIC_MCP_TOOL_NAMES = [
  "sv_status",
  "sv_describe",
  "sv_query",
  "sv_command",
  "sv_ui",
  "sv_review",
] as const;

export const EXECUTOR_BUILD_ID = "sv3-lua-0.2.0-alpha.1-6";
export const SIDEBAR_BUILD_ID = "sv3-sidebar-0.2.0-alpha.1-3";

export const SERVER_CAPABILITY_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      bridgeActions: BRIDGE_ACTIONS,
      publicTools: PUBLIC_MCP_TOOL_NAMES,
    }),
  )
  .digest("hex");

function collectRuntimeFiles(directory: string, extension: ".js" | ".ts"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectRuntimeFiles(entryPath, extension));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(extension) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

const currentModulePath = fileURLToPath(import.meta.url);
const runtimeDirectory = path.dirname(currentModulePath);
const runtimeExtension = currentModulePath.endsWith(".ts") ? ".ts" : ".js";
const runtimeFiles = collectRuntimeFiles(runtimeDirectory, runtimeExtension).sort();
const buildHash = createHash("sha256");
for (const filePath of runtimeFiles) {
  buildHash.update(path.relative(runtimeDirectory, filePath).replaceAll("\\", "/"));
  buildHash.update("\0");
  buildHash.update(readFileSync(filePath));
  buildHash.update("\0");
}

export const SERVER_BUILD_FINGERPRINT = buildHash.digest("hex");

function hashFile(filePath: string): string | undefined {
  return existsSync(filePath)
    ? createHash("sha256").update(readFileSync(filePath)).digest("hex")
    : undefined;
}

const sourceRootCandidate =
  path.basename(path.dirname(runtimeDirectory)) === "dist"
    ? path.dirname(path.dirname(runtimeDirectory))
    : path.dirname(runtimeDirectory);

export const BUILD_IDENTITY = {
  version: SERVER_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  gitCommit: GENERATED_BUILD_METADATA.gitCommit,
  github:
    GENERATED_BUILD_METADATA.githubRunId === null
      ? undefined
      : {
          runId: GENERATED_BUILD_METADATA.githubRunId,
          runNumber: GENERATED_BUILD_METADATA.githubRunNumber ?? "unknown",
          runAttempt: GENERATED_BUILD_METADATA.githubRunAttempt ?? "unknown",
        },
  node: {
    buildFingerprint: SERVER_BUILD_FINGERPRINT,
    capabilityFingerprint: SERVER_CAPABILITY_FINGERPRINT,
  },
  executor: {
    buildId: EXECUTOR_BUILD_ID,
    sourceFingerprint: hashFile(
      path.join(sourceRootCandidate, "synthv", "SynthVAgentBridge.lua"),
    ),
  },
  sidebar: {
    buildId: SIDEBAR_BUILD_ID,
    sourceFingerprint: hashFile(
      path.join(sourceRootCandidate, "synthv", "SynthVAgentSidebar.lua"),
    ),
  },
} as const;
