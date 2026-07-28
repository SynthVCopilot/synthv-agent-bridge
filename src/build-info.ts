import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "./config.js";
import { BRIDGE_ACTIONS } from "./protocol.js";

export const PUBLIC_MCP_TOOL_NAMES = [
  "sv_status",
  "sv_describe",
  "sv_read",
  "sv_edit",
  "sv_delete",
  "sv_transaction",
  "sv_ui",
  "sv_sidebar",
] as const;

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
