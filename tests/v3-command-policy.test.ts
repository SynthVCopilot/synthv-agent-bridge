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
  SIDEBAR_PREVIEW_ACTIONS,
  TRANSACTION_STEP_ACTIONS,
} from "../src/sidebar-coordinator.js";
import {
  assertV3CommandPolicyCatalog,
  commandPolicyActionNames,
  commandPolicyFor,
  isV3InfrastructureAction,
  transactionEligibleActionNames,
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
    assert.ok(policy.targetAggregates.length > 0, `${action} has a target aggregate`);
    assert.ok(Array.isArray(policy.contextKinds), `${action} has Context kinds`);
    assert.ok(policy.ownershipPolicies.length > 0, `${action} has an ownership policy`);
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

test("v3 command policy explicitly classifies runtime and review-state mutations", () => {
  assert.deepEqual(commandPolicyFor("reload_bridge"), {
    category: "runtime",
    targetAggregates: ["RuntimeState"],
    contextKinds: [],
    ownershipPolicies: ["runtimeState"],
    expectedEffectPolicy: "notApplicable",
    postconditionStrategy: "sessionTokenChange",
    transactionEligibility: "notEligible",
  });
  assert.deepEqual(commandPolicyFor("sidebar_publish_preview"), {
    category: "review",
    targetAggregates: ["ReviewState"],
    contextKinds: [],
    ownershipPolicies: ["reviewState"],
    expectedEffectPolicy: "notApplicable",
    postconditionStrategy: "reviewStateSnapshot",
    transactionEligibility: "notEligible",
  });
});

test("v3 command catalog rejects a mutation even when it is misannotated read-only", () => {
  const definitions: Array<
    readonly [string, { readonly annotations: { readonly readOnlyHint: boolean } }]
  > = commandPolicyActionNames().map((action) => [
    action,
    { annotations: { readOnlyHint: false } },
  ]);
  definitions.push([
    "misannotated_mutation",
    { annotations: { readOnlyHint: true } },
  ]);
  assert.throws(
    () => assertV3CommandPolicyCatalog(definitions),
    /No v3 command policy for misannotated_mutation/u,
  );
});

test("mixed Group commands declare every aggregate and ownership boundary", () => {
  const expected = {
    targetAggregates: ["GroupContent", "GroupReference"],
    ownershipPolicies: ["sharedGroupContent", "referenceLocal"],
  };
  for (const action of ["update_group", "apply_group_tuning"]) {
    const policy = commandPolicyFor(action);
    assert.deepEqual(
      {
        targetAggregates: policy.targetAggregates,
        ownershipPolicies: policy.ownershipPolicies,
      },
      expected,
    );
  }
});

test("Sidebar transaction admission is derived from command policy eligibility", () => {
  const eligible = transactionEligibleActionNames();
  assert.deepEqual(TRANSACTION_STEP_ACTIONS, eligible);
  assert.deepEqual(SIDEBAR_PREVIEW_ACTIONS, [
    ...eligible,
    "apply_transaction",
    "rollback_transaction",
  ]);
  const eligibleSet = new Set<string>(eligible);
  assert.ok(eligibleSet.has("set_track_mixer"));
  assert.equal(eligibleSet.has("import_monophonic_score"), false);
  assert.equal(eligibleSet.has("reload_bridge"), false);
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
    commandPolicyActionNames()
      .filter((action) => !isV3InfrastructureAction(action))
      .sort(),
    [...liveActions].sort(),
  );
  for (const action of liveActions) {
    assert.equal(commandPolicyFor(action).category, Object.entries(categories)
      .find(([, names]) => names.includes(action))?.[0]);
  }
});
