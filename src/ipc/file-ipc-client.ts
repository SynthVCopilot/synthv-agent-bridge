import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import type { BridgeConfig } from "../config.js";
import { PROTOCOL_VERSION } from "../config.js";
import { EXECUTOR_BUILD_ID } from "../build-info.js";
import {
  BridgeBusyError,
  BridgeProtocolError,
  BridgeRemoteError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "../errors.js";
import {
  parseBridgeRequest,
  parseBridgeResponse,
  parseBridgeStatus,
  ProtocolValidationError,
  safeParseBridgeRequest,
  type BridgeAction,
  type BridgeRequest,
  type BridgeStatus,
} from "../protocol.js";
import {
  currentTraceId,
  traceStage,
} from "../v3-command-kernel.js";
import { SerialExecutor } from "./serial-executor.js";

export interface BridgeStatusSnapshot {
  readonly connected: boolean;
  readonly fresh: boolean;
  readonly ageMs: number | null;
  readonly status: BridgeStatus | null;
  readonly ipcDirectory: string;
  readonly reason?: string;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function fileAgeMs(filePath: string): Promise<number | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat === null ? null : Math.max(0, Date.now() - stat.mtimeMs);
}

export class FileIpcClient {
  private readonly serialExecutor = new SerialExecutor();

  public constructor(private readonly config: BridgeConfig) {}

  public get paths(): BridgeConfig["paths"] {
    return this.config.paths;
  }

  public async getStatus(): Promise<BridgeStatusSnapshot> {
    try {
      const raw = await fs.readFile(this.config.paths.statusFile, "utf8");
      const parsedJson: unknown = JSON.parse(raw);
      const status = parseBridgeStatus(parsedJson);
      const ageMs = Math.max(0, Date.now() - status.updatedAtEpochMs);
      const fresh = ageMs <= this.config.statusStaleMs;
      const connected = fresh && status.state === "running";

      const base = {
        connected,
        fresh,
        ageMs,
        status,
        ipcDirectory: this.config.paths.directory,
      };

      if (connected) {
        return base;
      }

      return {
        ...base,
        reason: fresh
          ? `SynthV bridge reports state ${JSON.stringify(status.state)}.`
          : `SynthV bridge heartbeat is stale (${ageMs} ms old).`,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        connected: false,
        fresh: false,
        ageMs: null,
        status: null,
        ipcDirectory: this.config.paths.directory,
        reason:
          code === "ENOENT"
            ? "No bridge heartbeat was found. Run SynthVAgentBridge.lua inside Synthesizer V Studio."
            : `Bridge heartbeat is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public send<T = unknown>(
    action: BridgeAction,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    return this.serialExecutor.run(async () => this.sendSerial<T>(action, payload));
  }

  private async sendSerial<T>(
    action: BridgeAction,
    payload: Record<string, unknown>,
  ): Promise<T> {
    traceStage("ipcQueued", { action });
    await fs.mkdir(this.config.paths.directory, { recursive: true });

    const requestId = randomBytes(12).toString("base64url");
    await this.acquireLock(requestId);

    try {
      await this.prepareChannel();

      const envelope = {
        v: PROTOCOL_VERSION,
        id: requestId,
        t:
          currentTraceId() ??
          `tr_${randomBytes(12).toString("base64url")}`,
        b: EXECUTOR_BUILD_ID,
        a: action,
        p: payload,
      } as const;
      const request = parseBridgeRequest(envelope) satisfies BridgeRequest;

      await this.writeJsonAtomically(this.config.paths.requestFile, envelope);
      traceStage("ipcPublished", {
        action,
        requestBytes: JSON.stringify(envelope).length,
      });
      return await this.waitForResponse<T>(request);
    } finally {
      await this.removeOwnRequest(requestId).catch(() => undefined);
      // Once SynthV claims a request, the processing file belongs to the Lua host.
      // Leaving it in place on timeout prevents another write from overlapping the
      // still-running editor operation. The Lua host removes it after completion;
      // stale recovery handles host crashes.
      await this.removeOwnLock(requestId).catch(() => undefined);
    }
  }

  private async acquireLock(requestId: string): Promise<void> {
    const lockData = JSON.stringify({
      requestId,
      pid: process.pid,
      createdAtEpochMs: Date.now(),
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.config.paths.lockFile, "wx");
        try {
          await handle.writeFile(lockData, "utf8");
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BridgeUnavailableError("Unable to acquire the bridge IPC lock.", {
            cause: error instanceof Error ? error.message : String(error),
            lockFile: this.config.paths.lockFile,
          });
        }

        const ageMs = (await fileAgeMs(this.config.paths.lockFile)) ?? 0;
        if (ageMs > this.config.staleRequestMs && attempt === 0) {
          await removeIfExists(this.config.paths.lockFile);
          continue;
        }

        throw new BridgeBusyError(
          "Another SynthV Agent Bridge request is already in progress.",
          { lockFile: this.config.paths.lockFile, ageMs },
        );
      }
    }

    throw new BridgeBusyError("Unable to acquire the bridge IPC lock.");
  }

  private async prepareChannel(): Promise<void> {
    await this.recoverStaleFile(
      this.config.paths.requestFile,
      "A pending SynthV bridge request already exists.",
    );
    await this.recoverStaleFile(
      this.config.paths.processingFile,
      "SynthV is still processing another request.",
    );
    await removeIfExists(this.config.paths.responseFile);
  }

  private async recoverStaleFile(filePath: string, busyMessage: string): Promise<void> {
    if (!(await exists(filePath))) {
      return;
    }

    const ageMs = (await fileAgeMs(filePath)) ?? 0;
    if (ageMs <= this.config.staleRequestMs) {
      throw new BridgeBusyError(busyMessage, { filePath, ageMs });
    }
    await removeIfExists(filePath);
  }

  private async writeJsonAtomically(
    destination: string,
    value: unknown,
  ): Promise<void> {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, destination);
    } catch (error) {
      await removeIfExists(temporary).catch(() => undefined);
      throw new BridgeUnavailableError("Unable to publish an IPC request.", {
        destination,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async waitForResponse<T>(request: BridgeRequest): Promise<T> {
    const deadline = Date.now() + this.config.timeoutMs;

    while (Date.now() < deadline) {
      try {
        const raw = await fs.readFile(this.config.paths.responseFile, "utf8");
        const parsedJson: unknown = JSON.parse(raw);
        const response = parseBridgeResponse(parsedJson);
        if (response.telemetry !== undefined) {
          for (const stage of response.telemetry.stages) {
            traceStage(`lua${stage.stage[0]?.toUpperCase() ?? ""}${stage.stage.slice(1)}`, {
              action: request.action,
              durationMs: stage.durationMs,
            });
          }
          traceStage("luaCompleted", {
            action: request.action,
            luaTotalMs: response.telemetry.totalMs,
          });
        }
        traceStage("ipcResponded", {
          action: request.action,
          responseBytes: raw.length,
        });

        await removeIfExists(this.config.paths.responseFile);

        if (response.requestId !== request.requestId) {
          await sleep(this.config.pollIntervalMs);
          continue;
        }
        if (response.traceId !== request.traceId) {
          throw new BridgeProtocolError(
            "SynthV bridge returned a mismatched trace identifier.",
            {
              expectedTraceId: request.traceId,
              actualTraceId: response.traceId,
            },
          );
        }
        if (response.executorBuildId !== EXECUTOR_BUILD_ID) {
          throw new BridgeProtocolError(
            "SynthV executor build does not match the MCP server build.",
            {
              expectedExecutorBuildId: EXECUTOR_BUILD_ID,
              actualExecutorBuildId: response.executorBuildId,
              requiredAction: "reinstall_or_reload_bridge",
            },
          );
        }

        // A correlated response means the Lua host has completed the editor
        // operation. The processing marker is now safe to remove even if the
        // host has not yet completed its best-effort cleanup.
        await this.removeOwnProcessingFile(request.requestId);

        if (!response.ok) {
          throw new BridgeRemoteError(
            response.error.code,
            response.error.message,
            response.error.details,
          );
        }

        return response.result as T;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          await sleep(this.config.pollIntervalMs);
          continue;
        }

        if (error instanceof BridgeRemoteError) {
          throw error;
        }

        if (error instanceof SyntaxError || error instanceof ProtocolValidationError) {
          throw new BridgeProtocolError("SynthV bridge returned an invalid response.", {
            cause: error.message,
            responseFile: this.config.paths.responseFile,
          });
        }

        throw error;
      }
    }

    const status = await this.getStatus();
    throw new BridgeTimeoutError(
      `Timed out after ${this.config.timeoutMs} ms waiting for Synthesizer V Studio.`,
      {
        action: request.action,
        requestId: request.requestId,
        requestFile: this.config.paths.requestFile,
        responseFile: this.config.paths.responseFile,
        bridgeStatus: status,
      },
    );
  }

  private async removeOwnRequest(requestId: string): Promise<void> {
    await this.removeOwnEnvelope(this.config.paths.requestFile, requestId);
  }

  private async removeOwnProcessingFile(requestId: string): Promise<void> {
    await this.removeOwnEnvelope(this.config.paths.processingFile, requestId);
  }

  private async removeOwnEnvelope(filePath: string, requestId: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = safeParseBridgeRequest(JSON.parse(raw));
      if (parsed.success && parsed.data.requestId === requestId) {
        await removeIfExists(filePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async removeOwnLock(requestId: string): Promise<void> {
    try {
      const raw = await fs.readFile(this.config.paths.lockFile, "utf8");
      const parsed = JSON.parse(raw) as { requestId?: unknown };
      if (parsed.requestId === requestId) {
        await removeIfExists(this.config.paths.lockFile);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
