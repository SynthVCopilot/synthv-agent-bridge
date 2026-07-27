import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = 1 as const;
export const CURRENT_PROTOCOL_VERSION = 2 as const;
export const SERVER_NAME = "synthv-agent-bridge";
export const SERVER_VERSION = "0.1.5";

export interface BridgePaths {
  readonly directory: string;
  readonly requestFile: string;
  readonly processingFile: string;
  readonly responseFile: string;
  readonly statusFile: string;
  readonly stopFile: string;
  readonly reloadFile: string;
  readonly installFile: string;
  readonly lockFile: string;
  readonly sessionFile: string;
  readonly sidebarInstructionFile: string;
  readonly sidebarPreviewFile: string;
  readonly sidebarPreviewTextFile: string;
  readonly sidebarCommandFile: string;
  readonly sidebarCommandProcessingFile: string;
  readonly sidebarActivityFile: string;
  readonly sidebarHistoryFile: string;
  readonly sidebarStateFile: string;
  readonly sidebarClientStatusFile: string;
}

export interface BridgeConfig {
  readonly paths: BridgePaths;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly staleRequestMs: number;
  readonly statusStaleMs: number;
  readonly mcpSurface?: "v2" | "legacy";
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${variableName} must be a positive integer; received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function mcpSurface(value: string | undefined): "v2" | "legacy" {
  const normalized = value?.trim().toLowerCase() || "v2";
  if (normalized !== "v2" && normalized !== "legacy") {
    throw new Error(
      "SYNTHV_AGENT_BRIDGE_MCP_SURFACE must be v2 or legacy; received " +
        JSON.stringify(value),
    );
  }
  return normalized;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  systemTempDirectory: string = os.tmpdir(),
): BridgeConfig {
  const directory = path.resolve(
    env.SYNTHV_AGENT_BRIDGE_DIR?.trim() || systemTempDirectory,
  );
  const prefix = path.join(directory, SERVER_NAME);

  const timeoutMs = positiveInteger(
    env.SYNTHV_AGENT_BRIDGE_TIMEOUT_MS,
    15_000,
    "SYNTHV_AGENT_BRIDGE_TIMEOUT_MS",
  );
  const pollIntervalMs = positiveInteger(
    env.SYNTHV_AGENT_BRIDGE_POLL_MS,
    10,
    "SYNTHV_AGENT_BRIDGE_POLL_MS",
  );
  const staleRequestMs = positiveInteger(
    env.SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS,
    30_000,
    "SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS",
  );
  const statusStaleMs = positiveInteger(
    env.SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS,
    5_000,
    "SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS",
  );

  if (staleRequestMs <= timeoutMs) {
    throw new Error(
      "SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS must be greater than " +
        "SYNTHV_AGENT_BRIDGE_TIMEOUT_MS so an active request cannot be recovered as stale.",
    );
  }

  return {
    paths: {
      directory,
      requestFile: `${prefix}.request.json`,
      processingFile: `${prefix}.processing.json`,
      responseFile: `${prefix}.response.json`,
      statusFile: `${prefix}.status.json`,
      stopFile: `${prefix}.stop`,
      reloadFile: `${prefix}.reload`,
      installFile: `${prefix}.install.json`,
      lockFile: `${prefix}.lock`,
      sessionFile: `${prefix}.session.json`,
      sidebarInstructionFile: `${prefix}.sidebar.instruction.txt`,
      sidebarPreviewFile: `${prefix}.sidebar.preview.json`,
      sidebarPreviewTextFile: `${prefix}.sidebar.preview.txt`,
      sidebarCommandFile: `${prefix}.sidebar.command.txt`,
      sidebarCommandProcessingFile: `${prefix}.sidebar.command.processing.txt`,
      sidebarActivityFile: `${prefix}.sidebar.activity.txt`,
      sidebarHistoryFile: `${prefix}.sidebar.history.json`,
      sidebarStateFile: `${prefix}.sidebar.state.txt`,
      sidebarClientStatusFile: `${prefix}.sidebar.client-status.txt`,
    },
    timeoutMs,
    pollIntervalMs,
    staleRequestMs,
    statusStaleMs,
    mcpSurface: mcpSurface(env.SYNTHV_AGENT_BRIDGE_MCP_SURFACE),
  };
}
