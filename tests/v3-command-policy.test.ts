import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
  commandPolicyActionNames,
  commandPolicyFor,
} from "../src/v3-command-policy.js";

function toolJson(result: unknown): Record<string, unknown> {
  const root = result as {
    readonly content?: readonly {
      readonly type: string;
      readonly text?: string;
    }[];
  };
  const text = root.content?.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as Record<string, unknown>;
}

test("v3 command policy classifies every command with the required safety dimensions", () => {
  for (const action of commandPolicyActionNames()) {
    const policy = commandPolicyFor(action);
    assert.ok(policy.targetAggregate, `${action} has a target aggregate`);
    assert.ok(Array.isArray(policy.contextKinds), `${action} has Context kinds`);
    assert.ok(policy.ownershipPolicy, `${action} has an ownership policy`);
    assert.ok(policy.expectedEffectPolicy, `${action} has an expected-effect policy`);
    assert.ok(policy.postconditionStrategy, `${action} has a postcondition strategy`);
    assert.ok(
      policy.transactionEligibility,
      `${action} has transaction eligibility`,
    );
  }
  assert.throws(
    () => commandPolicyFor("unclassified_live_write"),
    /No v3 command policy/u,
  );
});

test("v3 command policy registry exactly matches the live non-read sv_describe catalog", async (context) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-command-policy-catalog-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "v3-command-policy-catalog-test",
    version: "1.0.0",
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  context.after(async () => {
    await client.close();
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const described = toolJson(
    await client.callTool({ name: "sv_describe", arguments: {} }),
  );
  const categories = described.categories as Record<string, readonly string[]>;
  const liveActions = [
    ...(categories.edit ?? []),
    ...(categories.delete ?? []),
    ...(categories.transaction ?? []),
    ...(categories.ui ?? []),
  ];
  assert.deepEqual(
    [...commandPolicyActionNames()].sort(),
    [...liveActions].sort(),
  );
  for (const action of liveActions) {
    assert.equal(commandPolicyFor(action).category, Object.entries(categories)
      .find(([, names]) => names.includes(action))?.[0]);
  }
});
