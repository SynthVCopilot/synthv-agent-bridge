import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import {
  EXECUTOR_BUILD_ID,
  SERVER_BUILD_FINGERPRINT,
  SERVER_CAPABILITY_FINGERPRINT,
  SIDEBAR_BUILD_ID,
} from "./build-info.js";
import {
  PROTOCOL_VERSION,
  SERVER_VERSION,
  type BridgeConfig,
} from "./config.js";
import { toPublicError } from "./errors.js";

const MAX_STATUS_BYTES = 64 * 1024;
const FILE_CONTENTION_RETRY_DELAYS_MS = [5, 10, 20] as const;

interface AtomicTextFileOperations {
  writeFile(
    filePath: string,
    content: string,
    encoding: BufferEncoding,
  ): Promise<unknown>;
  unlink(filePath: string): Promise<unknown>;
  rename(source: string, destination: string): Promise<unknown>;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isTransientFileContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

async function retryTransientFileContention<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (const delayMs of FILE_CONTENTION_RETRY_DELAYS_MS) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileContention(error)) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return operation();
}

async function removeIfExistsWith(
  operations: AtomicTextFileOperations,
  filePath: string,
): Promise<void> {
  try {
    await retryTransientFileContention(() => operations.unlink(filePath));
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function writeTextAtomically(
  filePath: string,
  content: string,
  operations: AtomicTextFileOperations = fs,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await operations.writeFile(temporary, content, "utf8");
    await removeIfExistsWith(operations, filePath);
    await retryTransientFileContention(() =>
      operations.rename(temporary, filePath),
    );
  } finally {
    await removeIfExistsWith(operations, temporary).catch(() => undefined);
  }
}

async function readLimitedText(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_STATUS_BYTES) {
      return null;
    }
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

function lineValue(text: string | null, key: string): string | undefined {
  if (text === null) {
    return undefined;
  }
  const prefix = `${key}=`;
  for (const line of text.split(/\r?\n/u).slice(0, 12)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length);
    }
  }
  return undefined;
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 2000);
}

function statusSummary(
  raw: string | null,
  staleAfterMs: number,
): Record<string, unknown> {
  if (raw === null) {
    return { state: "absent", fresh: false };
  }
  const updatedAtEpochMs = Number(lineValue(raw, "updatedAtEpochMs"));
  const ageMs = Number.isFinite(updatedAtEpochMs)
    ? Math.max(0, Date.now() - updatedAtEpochMs)
    : Number.POSITIVE_INFINITY;
  const reportedState = lineValue(raw, "state") ?? "unknown";
  return {
    state: reportedState,
    fresh: reportedState === "running" && ageMs <= staleAfterMs,
    ageMs,
    version: lineValue(raw, "version") ?? null,
    buildId: lineValue(raw, "buildId") ?? null,
  };
}

export const sidebarStatusMonitorTesting = {
  writeTextAtomically,
};

export class SidebarStatusMonitor {
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lastHeartbeatAt = 0;
  private lastError: { readonly code: string; readonly message: string } | null =
    null;

  public constructor(private readonly config: BridgeConfig) {}

  public start(): void {
    if (this.pollTimer !== null || this.stopPromise !== null) {
      return;
    }
    const runPoll = () => {
      if (this.pollInFlight !== null) {
        return;
      }
      this.pollInFlight = this.pollOnce()
        .catch((error: unknown) => {
          this.lastError = toPublicError(error);
        })
        .finally(() => {
          this.pollInFlight = null;
        });
    };
    this.pollTimer = setInterval(
      runPoll,
      Math.max(100, this.config.pollIntervalMs),
    );
    this.pollTimer.unref();
    runPoll();
  }

  public stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.stopPromise = (async () => {
      await this.pollInFlight?.catch(() => undefined);
      await this.writeClientStatus("stopped").catch(() => undefined);
    })();
    return this.stopPromise;
  }

  public async pollOnce(): Promise<void> {
    if (Date.now() - this.lastHeartbeatAt < 1000) {
      return;
    }
    await this.writeClientStatus("running");
  }

  public async getStatus(): Promise<Record<string, unknown>> {
    const [clientRaw, runtimeRaw] = await Promise.all([
      readLimitedText(this.config.paths.sidebarClientStatusFile),
      readLimitedText(this.config.paths.sidebarRuntimeStatusFile),
    ]);
    return {
      version: SERVER_VERSION,
      ipcDirectory: this.config.paths.directory,
      client: statusSummary(clientRaw, this.config.statusStaleMs),
      sidebar: statusSummary(
        runtimeRaw,
        Math.max(5_000, this.config.statusStaleMs * 2),
      ),
      lastError: this.lastError,
    };
  }

  public async getRuntimeBuildIdentity(): Promise<{
    readonly state: "absent" | "stale" | "matched" | "mismatch";
    readonly buildId?: string;
    readonly ageMs?: number;
  }> {
    const raw = await readLimitedText(
      this.config.paths.sidebarRuntimeStatusFile,
    );
    if (raw === null) {
      return { state: "absent" };
    }
    const updatedAtEpochMs = Number(lineValue(raw, "updatedAtEpochMs"));
    const ageMs = Number.isFinite(updatedAtEpochMs)
      ? Math.max(0, Date.now() - updatedAtEpochMs)
      : Number.POSITIVE_INFINITY;
    const buildId = lineValue(raw, "buildId");
    if (ageMs > Math.max(5_000, this.config.statusStaleMs * 2)) {
      return {
        state: "stale",
        ...(buildId === undefined ? {} : { buildId }),
        ageMs,
      };
    }
    return {
      state: buildId === SIDEBAR_BUILD_ID ? "matched" : "mismatch",
      ...(buildId === undefined ? {} : { buildId }),
      ageMs,
    };
  }

  private async writeClientStatus(state: "running" | "stopped"): Promise<void> {
    const now = Date.now();
    const lines = [
      "synthv-agent-bridge-sidebar-client-status-v1",
      `state=${state}`,
      `version=${SERVER_VERSION}`,
      `protocolVersion=${PROTOCOL_VERSION}`,
      `expectedExecutorBuildId=${EXECUTOR_BUILD_ID}`,
      `buildFingerprint=${SERVER_BUILD_FINGERPRINT}`,
      `capabilityFingerprint=${SERVER_CAPABILITY_FINGERPRINT}`,
      `updatedAtEpochMs=${now}`,
      `processId=${process.pid}`,
      `ipcDirectory=${sanitizeLine(this.config.paths.directory)}`,
      "",
    ];
    await writeTextAtomically(
      this.config.paths.sidebarClientStatusFile,
      lines.join("\n"),
    );
    this.lastHeartbeatAt = now;
  }
}
