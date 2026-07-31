#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadConfig } from "../dist/src/config.js";
import { createServer } from "../dist/src/server.js";
import {
  commandPolicyFor,
  optionalCommandPolicy,
} from "../dist/src/v3-command-policy.js";
import { describeV3CapabilityStability } from "../dist/src/v3-capability-stability.js";

const INVENTORY_PATTERN =
  /<!-- SV2_API_INVENTORY_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- SV2_API_INVENTORY_END -->/u;
const METHOD_CLASSES = [
  "semantic",
  "internal",
  "intentionallyUnexposed",
];
const REAL_HOST_STATES = new Set([
  "verified",
  "unsupported",
  "experimental",
  "sampled",
  "pending",
  "notApplicable",
]);
const PUBLIC_TOOLS = new Set([
  "sv_status",
  "sv_describe",
  "sv_query",
  "sv_command",
  "sv_ui",
  "sv_review",
]);

function asObject(value, label, errors) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value;
}

function asStringArray(value, label, errors) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    errors.push(`${label} must be an array of non-empty strings`);
    return [];
  }
  return value;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function readToolJson(result) {
  const text = result.content.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  );
  if (text?.type !== "text") {
    throw new Error("sv_describe returned no JSON text");
  }
  return JSON.parse(text.text);
}

async function liveActionCatalog() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "synthv-v3-api-coverage-"),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(loadConfig({}, directory));
  const client = new Client({
    name: "synthv-v3-api-coverage",
    version: "0.2.0-alpha.1",
  });
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = readToolJson(
      await client.callTool({
        name: "sv_describe",
        arguments: {},
      }),
    );
    return asObject(result.categories, "sv_describe.categories", []);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
    await rm(directory, { recursive: true, force: true });
  }
}

const documentText = await readFile(
  path.resolve("docs", "sv2-api-coverage-v3.md"),
  "utf8",
);
const match = INVENTORY_PATTERN.exec(documentText);
if (match?.[1] === undefined) {
  throw new Error("SV2 API coverage document has no machine inventory block");
}
const inventory = JSON.parse(match[1]);
const errors = [];

const classes = Array.isArray(inventory.classes) ? inventory.classes : [];
if (!Array.isArray(inventory.classes)) {
  errors.push("classes must be an array");
}
const classNames = [];
const semanticMethodsByClass = new Map();
let officialMethodCount = 0;
for (const [classIndex, rawClass] of classes.entries()) {
  const classEntry = asObject(rawClass, `classes[${classIndex}]`, errors);
  const name =
    typeof classEntry.name === "string" && classEntry.name.length > 0
      ? classEntry.name
      : "";
  if (name.length === 0) {
    errors.push(`classes[${classIndex}].name must be non-empty`);
  }
  classNames.push(name);
  const methods = [];
  const semanticMethods = asStringArray(
    classEntry.semantic,
    `${name}.semantic`,
    errors,
  );
  semanticMethodsByClass.set(name, semanticMethods);
  for (const classification of METHOD_CLASSES) {
    methods.push(...(
      classification === "semantic"
        ? semanticMethods
        : asStringArray(
            classEntry[classification],
            `${name}.${classification}`,
            errors,
          )
    ));
  }
  officialMethodCount += methods.length;
  for (const duplicate of duplicateValues(methods)) {
    errors.push(`${name}.${duplicate} has duplicate classifications`);
  }
  if (methods.length === 0) {
    errors.push(`${name} has no classified methods`);
  }
}
for (const duplicate of duplicateValues(classNames)) {
  errors.push(`duplicate official class: ${duplicate}`);
}

const unavailableCapabilities = asStringArray(
  inventory.unavailableCapabilities,
  "unavailableCapabilities",
  errors,
);
if (unavailableCapabilities.length === 0) {
  errors.push("unavailableCapabilities must not be empty");
}

const liveCategories = await liveActionCatalog();
const liveByCategory = {};
const liveActions = [];
for (const category of ["read", "edit", "delete", "ui", "transaction"]) {
  const names = asStringArray(
    liveCategories[category],
    `live.${category}`,
    errors,
  );
  liveByCategory[category] = new Set(names);
  liveActions.push(...names);
}
for (const duplicate of duplicateValues(liveActions)) {
  errors.push(`live Action appears in multiple categories: ${duplicate}`);
}

const semanticEvidence = Array.isArray(inventory.semanticEvidence)
  ? inventory.semanticEvidence
  : [];
if (!Array.isArray(inventory.semanticEvidence)) {
  errors.push("semanticEvidence must be an array");
}
const semanticMethodEvidence = new Set();
for (const [index, rawEvidence] of semanticEvidence.entries()) {
  const evidence = asObject(
    rawEvidence,
    `semanticEvidence[${index}]`,
    errors,
  );
  const className =
    typeof evidence.class === "string" ? evidence.class : "";
  const officialSemanticMethods = semanticMethodsByClass.get(className);
  if (officialSemanticMethods === undefined) {
    errors.push(`semanticEvidence[${index}].class is not official: ${className}`);
    continue;
  }
  if (evidence.methods !== "allSemantic") {
    errors.push(`${className}.methods must declare allSemantic`);
  }
  const publicTools = asStringArray(
    evidence.publicTools,
    `${className}.publicTools`,
    errors,
  );
  for (const tool of publicTools) {
    if (!PUBLIC_TOOLS.has(tool)) {
      errors.push(`${className} names unknown public tool: ${tool}`);
    }
  }
  const evidenceActions = asStringArray(
    evidence.actions,
    `${className}.actions`,
    errors,
  );
  for (const action of evidenceActions) {
    if (!liveActions.includes(action)) {
      errors.push(`${className} evidence names non-live Action: ${action}`);
    }
  }
  const methodGroups = Array.isArray(evidence.methodGroups)
    ? evidence.methodGroups
    : [];
  if (!Array.isArray(evidence.methodGroups) || methodGroups.length === 0) {
    errors.push(`${className}.methodGroups must be a non-empty array`);
  }
  for (const [groupIndex, rawGroup] of methodGroups.entries()) {
    const group = asObject(
      rawGroup,
      `${className}.methodGroups[${groupIndex}]`,
      errors,
    );
    const methods = asStringArray(
      group.methods,
      `${className}.methodGroups[${groupIndex}].methods`,
      errors,
    );
    const actions = asStringArray(
      group.actions,
      `${className}.methodGroups[${groupIndex}].actions`,
      errors,
    );
    for (const action of actions) {
      if (!evidenceActions.includes(action)) {
        errors.push(
          `${className}.methodGroups[${groupIndex}] action is absent from the class Action union: ${action}`,
        );
      }
    }
    for (const method of methods) {
      if (!officialSemanticMethods.includes(method)) {
        errors.push(`${className}.${method} is not a semantic official method`);
        continue;
      }
      const key = `${className}.${method}`;
      if (semanticMethodEvidence.has(key)) {
        errors.push(`${key} has duplicate semantic evidence`);
      }
      semanticMethodEvidence.add(key);
    }
  }
  for (const field of [
    "hostAdapter",
    "preflight",
    "postcondition",
    "automated",
  ]) {
    if (
      typeof evidence[field] !== "string" ||
      evidence[field].trim().length === 0
    ) {
      errors.push(`${className}.${field} must be non-empty`);
    }
  }
  if (!REAL_HOST_STATES.has(evidence.realHost)) {
    errors.push(`${className}.realHost has an unknown status`);
  }
}
for (const [className, methods] of semanticMethodsByClass.entries()) {
  for (const method of methods) {
    const key = `${className}.${method}`;
    if (!semanticMethodEvidence.has(key)) {
      errors.push(`${key} has no semantic evidence mapping`);
    }
  }
}

const actionGroups = asObject(
  inventory.actionGroups,
  "actionGroups",
  errors,
);
const verifiedReads = asStringArray(
  actionGroups.verifiedReads,
  "actionGroups.verifiedReads",
  errors,
);
const verifiedUi = asStringArray(
  actionGroups.verifiedUi,
  "actionGroups.verifiedUi",
  errors,
);
const writes = Array.isArray(actionGroups.writes) ? actionGroups.writes : [];
if (!Array.isArray(actionGroups.writes)) {
  errors.push("actionGroups.writes must be an array");
}

const classifiedActions = [...verifiedReads, ...verifiedUi];
for (const action of verifiedReads) {
  if (!liveByCategory.read?.has(action)) {
    errors.push(`classified read is not live: ${action}`);
  }
}
for (const action of verifiedUi) {
  if (!liveByCategory.ui?.has(action)) {
    errors.push(`classified UI Action is not live: ${action}`);
  }
}

let semanticWriteCount = 0;
for (const [index, rawWrite] of writes.entries()) {
  const write = asObject(rawWrite, `writes[${index}]`, errors);
  const action =
    typeof write.action === "string" && write.action.length > 0
      ? write.action
      : "";
  if (action.length === 0) {
    errors.push(`writes[${index}].action must be non-empty`);
    continue;
  }
  classifiedActions.push(action);
  semanticWriteCount += 1;
  const policy = optionalCommandPolicy(action);
  if (policy === undefined) {
    errors.push(`semantic write has no V3CommandPolicy: ${action}`);
    continue;
  }
  if (
    !["edit", "delete", "transaction"].some(
      (category) => liveByCategory[category]?.has(action),
    )
  ) {
    errors.push(`semantic write is not a live write Action: ${action}`);
  }
  const aggregates = asStringArray(
    write.aggregates,
    `${action}.aggregates`,
    errors,
  );
  if (JSON.stringify(aggregates) !== JSON.stringify(policy.targetAggregates)) {
    errors.push(
      `${action}.aggregates do not match V3CommandPolicy: ` +
        `${JSON.stringify(aggregates)} != ${JSON.stringify(policy.targetAggregates)}`,
    );
  }
  for (const field of ["preflight", "automated"]) {
    if (typeof write[field] !== "string" || write[field].trim().length === 0) {
      errors.push(`${action}.${field} must be non-empty`);
    }
  }
  if (write.postcondition !== policy.postconditionStrategy) {
    errors.push(
      `${action}.postcondition does not match V3CommandPolicy: ` +
        `${String(write.postcondition)} != ${policy.postconditionStrategy}`,
    );
  }
  if (!REAL_HOST_STATES.has(write.realHost)) {
    errors.push(`${action}.realHost has an unknown status`);
  }
  const stability = describeV3CapabilityStability(action);
  if (
    stability?.classification === "experimental" &&
    write.realHost !== "experimental"
  ) {
    errors.push(
      `${action}.realHost must be experimental while the live capability registry classifies it as experimental`,
    );
  }
  if (
    write.realHost === "experimental" &&
    stability?.classification !== "experimental"
  ) {
    errors.push(
      `${action}.realHost is experimental without a matching live capability classification`,
    );
  }
  // This call deliberately proves the policy is total and throws on drift.
  commandPolicyFor(action);
}

for (const duplicate of duplicateValues(classifiedActions)) {
  errors.push(`Action has duplicate coverage entries: ${duplicate}`);
}
const classifiedSet = new Set(classifiedActions);
for (const action of liveActions) {
  if (!classifiedSet.has(action)) {
    errors.push(`live Action has no coverage entry: ${action}`);
  }
}
for (const action of classifiedSet) {
  if (!liveActions.includes(action)) {
    errors.push(`coverage entry has no live Action: ${action}`);
  }
}

const result = {
  officialClassCount: classes.length,
  officialMethodCount,
  semanticMethodEvidenceCount: semanticMethodEvidence.size,
  unavailableCapabilityCount: unavailableCapabilities.length,
  liveActionCount: liveActions.length,
  classifiedActionCount: classifiedSet.size,
  semanticWriteCount,
  errors,
};

process.stdout.write(
  process.argv.includes("--json")
    ? `${JSON.stringify(result)}\n`
    : `${JSON.stringify(result, null, 2)}\n`,
);
if (errors.length > 0) {
  process.exitCode = 1;
}
