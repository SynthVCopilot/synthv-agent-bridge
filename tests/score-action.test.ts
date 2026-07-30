import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { BridgeConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { parseBridgeRequest } from "../src/protocol.js";
import { createServer } from "../src/server.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

async function serveOneBridgeRequest(
  config: BridgeConfig,
  inspect: (request: ReturnType<typeof parseBridgeRequest>) => unknown,
): Promise<void> {
  while (true) {
    try {
      await fs.rename(config.paths.requestFile, config.paths.processingFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await sleep(5);
    }
  }
  const request = parseBridgeRequest(
    JSON.parse(await fs.readFile(config.paths.processingFile, "utf8")),
  );
  await writeJsonAtomically(config.paths.responseFile, {
    v: 2,
    id: request.requestId,
    r: inspect(request),
  });
  await fs.rm(config.paths.processingFile, { force: true });
}

function readToolJson(result: unknown): Record<string, unknown> {
  const root = result as {
    readonly content?: readonly {
      readonly type: string;
      readonly text?: string;
    }[];
  };
  assert.ok(Array.isArray(root.content));
  const text = root.content?.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") {
    throw new TypeError("Tool result did not contain JSON text.");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

test("local score actions inspect in Node and import through one guarded add_notes request", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-score-action-test-"),
  );
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const scorePath = path.join(directory, "lead.musicxml");
  await fs.writeFile(
    scorePath,
    `<score-partwise>
      <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
      <part id="P1"><measure number="1">
        <attributes><divisions>4</divisions></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
          <lyric><text>la</text></lyric>
        </note>
      </measure></part>
    </score-partwise>`,
    "utf8",
  );

  const config = loadConfig(
    {
      SYNTHV_AGENT_BRIDGE_DIR: directory,
      SYNTHV_AGENT_BRIDGE_TIMEOUT_MS: "2000",
      SYNTHV_AGENT_BRIDGE_POLL_MS: "5",
      SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS: "3000",
    },
    directory,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(config);
  const client = new Client({ name: "score-action-test", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const inspected = readToolJson(
    await client.callTool({
      name: "sv_read",
      arguments: {
        action: "inspect_score_file",
        args: { filePath: scorePath },
      },
    }),
  );
  assert.match(String(inspected.fileFingerprint), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(inspected.writesProject, false);
  assert.equal(inspected.sourceTempoAppliedToProject, false);

  const rightsRejectedResult = await client.callTool({
    name: "sv_edit",
    arguments: {
      action: "import_monophonic_score",
      response: "full",
      args: {
        trackIndex: 2,
        groupIndex: 1,
        filePath: scorePath,
        expectedFileFingerprint: inspected.fileFingerprint,
        rightsConfirmed: false,
      },
    },
  });
  const rightsRejected = readToolJson(rightsRejectedResult);
  const rightsError = rightsRejected.error as Record<string, unknown>;
  const rightsDetails = rightsError.details as Record<string, unknown>;
  const rightsIssues = rightsDetails.issues as Record<string, unknown>[];
  assert.equal(rightsRejectedResult.isError, true);
  assert.equal(rightsError.code, "INVALID_ARGUMENT");
  assert.equal(rightsDetails.action, "import_monophonic_score");
  assert.deepEqual(rightsIssues[0]?.path, ["rightsConfirmed"]);
  await assert.rejects(fs.access(config.paths.requestFile), { code: "ENOENT" });
  await assert.rejects(fs.access(config.paths.processingFile), {
    code: "ENOENT",
  });

  let observedAddNotes: ReturnType<typeof parseBridgeRequest> | undefined;
  const bridge = serveOneBridgeRequest(config, (request) => {
    observedAddNotes = request;
    return {
      trackIndex: 2,
      groupIndex: 3,
      groupUuid: "imported-group",
      grouping: "createdNonMain",
      createdGroup: true,
      libraryIndex: 1,
      addedCount: 1,
      notes: [],
    };
  });
  const imported = readToolJson(
    await client.callTool({
      name: "sv_edit",
      arguments: {
        action: "import_monophonic_score",
        response: "full",
        args: {
          trackIndex: 2,
          groupIndex: 1,
          filePath: scorePath,
          expectedFileFingerprint: inspected.fileFingerprint,
          rightsConfirmed: true,
          onsetBlickOffset: 705_600_000,
        },
      },
    }),
  );
  await bridge;

  assert.equal(observedAddNotes?.action, "add_notes");
  assert.equal(observedAddNotes?.payload["trackIndex"], 2);
  assert.equal(observedAddNotes?.payload["grouping"], "ensureNonMain");
  assert.deepEqual(observedAddNotes?.payload["notes"], [
    {
      onset: 705_600_000,
      duration: 705_600_000,
      pitch: 60,
      lyrics: "la",
    },
  ]);
  assert.equal(imported.addedCount, 1);
  assert.equal(imported.undoRecordCount, 1);
  assert.equal(
    (imported.sourceScore as Record<string, unknown>)["fileFingerprint"],
    inspected.fileFingerprint,
  );
});
