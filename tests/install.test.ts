import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXECUTOR_BUILD_ID,
  SIDEBAR_BUILD_ID,
} from "../src/build-info.js";

const componentBuildIdentity = await import(
  new URL("../../scripts/component-build-identity.mjs", import.meta.url).href,
);

async function writeIdentityFixture(
  fixture: string,
  sources: {
    readonly executorSource: string;
    readonly sidebarSource: string;
  },
) {
  const repositoryRoot = path.join(fixture, "repository");
  await mkdir(path.join(repositoryRoot, "synthv"), { recursive: true });
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify({ version: "0.2.0-test" })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentBridge.lua"),
    sources.executorSource,
    "utf8",
  );
  await writeFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentSidebar.lua"),
    sources.sidebarSource,
    "utf8",
  );
  return repositoryRoot;
}

async function writeInstallerFixture(
  fixture: string,
  sidebarSource: string,
) {
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const repositoryRoot = path.join(fixture, "repository");
  await mkdir(path.join(repositoryRoot, "scripts"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "synthv"), { recursive: true });
  await Promise.all([
    cp(
      path.join(sourceRoot, "package.json"),
      path.join(repositoryRoot, "package.json"),
    ),
    cp(
      path.join(sourceRoot, "scripts", "component-build-identity.mjs"),
      path.join(repositoryRoot, "scripts", "component-build-identity.mjs"),
    ),
    cp(
      path.join(sourceRoot, "scripts", "install-synthv-bridge.mjs"),
      path.join(repositoryRoot, "scripts", "install-synthv-bridge.mjs"),
    ),
    cp(
      path.join(sourceRoot, "synthv", "SynthVAgentBridge.lua"),
      path.join(repositoryRoot, "synthv", "SynthVAgentBridge.lua"),
    ),
    cp(
      path.join(sourceRoot, "synthv", "StopSynthVAgentBridge.lua"),
      path.join(repositoryRoot, "synthv", "StopSynthVAgentBridge.lua"),
    ),
  ]);
  await writeFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentSidebar.lua"),
    sidebarSource,
    "utf8",
  );
  return repositoryRoot;
}

test("component build identity rejects missing and duplicate executor and sidebar markers", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-identity-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const executorMarker = "__SYNTHV_AGENT_EXECUTOR_BUILD_ID__";
  const sidebarMarker = "__SYNTHV_AGENT_SIDEBAR_BUILD_ID__";
  const cases = [
    {
      name: "missing executor marker",
      executorSource: "EXECUTOR_BUILD_ID = \"missing\"\n",
      sidebarSource: `SIDEBAR_BUILD_ID = \"${sidebarMarker}\"\n`,
    },
    {
      name: "duplicate executor marker",
      executorSource:
        `EXECUTOR_BUILD_ID = \"${executorMarker}\"\n` +
        `-- ${executorMarker}\n`,
      sidebarSource: `SIDEBAR_BUILD_ID = \"${sidebarMarker}\"\n`,
    },
    {
      name: "missing sidebar marker",
      executorSource: `EXECUTOR_BUILD_ID = \"${executorMarker}\"\n`,
      sidebarSource: "SIDEBAR_BUILD_ID = \"missing\"\n",
    },
    {
      name: "duplicate sidebar marker",
      executorSource: `EXECUTOR_BUILD_ID = \"${executorMarker}\"\n`,
      sidebarSource:
        `SIDEBAR_BUILD_ID = \"${sidebarMarker}\"\n` +
        `-- ${sidebarMarker}\n`,
    },
  ];

  for (const fixtureCase of cases) {
    const repositoryRoot = await writeIdentityFixture(
      path.join(fixture, fixtureCase.name.replaceAll(" ", "-")),
      fixtureCase,
    );
    await assert.rejects(
      componentBuildIdentity.readComponentBuildIdentity(repositoryRoot),
      fixtureCase.name,
    );
  }
});

test("core-only installation ignores a sidebar source without a build-ID marker", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const repositoryRoot = await writeInstallerFixture(
    fixture,
    "SIDEBAR_BUILD_ID = \"missing\"\n",
  );
  const target = path.join(fixture, "scripts");
  const ipcDirectory = path.join(fixture, "ipc");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "install-synthv-bridge.mjs"),
      "--target",
      target,
      "--no-reload",
      "--without-sidebar",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const installedDirectory = path.join(target, "SynthV Agent Bridge");
  await access(path.join(installedDirectory, "SynthVAgentBridge.lua"));
  await assert.rejects(
    access(path.join(installedDirectory, "SynthVAgentSidebar.lua")),
    { code: "ENOENT" },
  );
  const installManifest = JSON.parse(
    await readFile(
      path.join(ipcDirectory, "synthv-agent-bridge.install.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(installManifest.sidebarBuildId, null);
  assert.equal(installManifest.sidebarSourceFingerprint, null);
  assert.match(result.stdout, /Skipped the optional side-panel script/u);
});

test("core-only installation omits the optional sidebar without deleting one", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, "scripts");
  const ipcDirectory = path.join(fixture, "ipc");
  const installer = fileURLToPath(
    new URL("../../scripts/install-synthv-bridge.mjs", import.meta.url),
  );
  const runInstaller = () =>
    spawnSync(
      process.execPath,
      [
        installer,
        "--target",
        target,
        "--no-reload",
        "--without-sidebar",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SYNTHV_AGENT_BRIDGE_DIR: ipcDirectory,
        },
      },
    );

  const first = runInstaller();
  assert.equal(first.status, 0, first.stderr);
  const installedDirectory = path.join(target, "SynthV Agent Bridge");
  await access(path.join(installedDirectory, "SynthVAgentBridge.lua"));
  await access(path.join(installedDirectory, "StopSynthVAgentBridge.lua"));
  const installManifest = JSON.parse(
    await readFile(
      path.join(ipcDirectory, "synthv-agent-bridge.install.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(installManifest.schemaVersion, 2);
  assert.equal(installManifest.protocolVersion, 3);
  assert.equal(installManifest.packageVersion, "0.2.0-alpha.1");
  assert.equal(
    installManifest.executorBuildId,
    EXECUTOR_BUILD_ID,
  );
  assert.equal(installManifest.sidebarBuildId, null);
  assert.equal(typeof installManifest.installedFiles, "object");
  assert.deepEqual(
    (await readdir(installedDirectory)).filter((name) =>
      name.startsWith(".v3-install-"),
    ),
    [],
  );
  await assert.rejects(
    access(path.join(installedDirectory, "SynthVAgentSidebar.lua")),
    { code: "ENOENT" },
  );
  assert.match(first.stdout, /Skipped the optional side-panel script/u);
  assert.match(first.stdout, /The Bridge runtime changed/u);
  assert.match(first.stdout, /Scripts → Rescan/u);

  const sidebarPath = path.join(
    installedDirectory,
    "SynthVAgentSidebar.lua",
  );
  await writeFile(sidebarPath, "existing optional sidebar\n", "utf8");
  const second = runInstaller();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await readFile(sidebarPath, "utf8"),
    "existing optional sidebar\n",
  );
  assert.doesNotMatch(second.stdout, /The Bridge runtime changed/u);
});

test("offline installation never claims that hot reload succeeded", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const installer = fileURLToPath(
    new URL("../../scripts/install-synthv-bridge.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [installer, "--target", path.join(fixture, "scripts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SYNTHV_AGENT_BRIDGE_DIR: path.join(fixture, "ipc"),
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bridge is not currently connected/u);
  assert.doesNotMatch(result.stdout, /Hot reload updated the current session/u);
  assert.match(result.stdout, /Choose Scripts → Rescan/u);
  const installedDirectory = path.join(
    fixture,
    "scripts",
    "SynthV Agent Bridge",
  );
  const installedBridge = await readFile(
    path.join(installedDirectory, "SynthVAgentBridge.lua"),
    "utf8",
  );
  const installedSidebar = await readFile(
    path.join(installedDirectory, "SynthVAgentSidebar.lua"),
    "utf8",
  );
  assert.match(
    installedBridge,
    new RegExp(
      `EXECUTOR_BUILD_ID\\s*=\\s*"${EXECUTOR_BUILD_ID.replaceAll(".", "\\.")}"`,
      "u",
    ),
  );
  assert.match(
    installedSidebar,
    new RegExp(
      `SIDEBAR_BUILD_ID\\s*=\\s*"${SIDEBAR_BUILD_ID.replaceAll(".", "\\.")}"`,
      "u",
    ),
  );
  assert.doesNotMatch(
    installedBridge,
    /__SYNTHV_AGENT_EXECUTOR_BUILD_ID__/u,
  );
  assert.doesNotMatch(
    installedSidebar,
    /__SYNTHV_AGENT_SIDEBAR_BUILD_ID__/u,
  );
});

test("an existing three-component installation upgrades atomically to the current build", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, "scripts");
  const installedDirectory = path.join(target, "SynthV Agent Bridge");
  await mkdir(installedDirectory, { recursive: true });
  const priorMarker = "prior installed component\n";
  await Promise.all(
    [
      "SynthVAgentBridge.lua",
      "StopSynthVAgentBridge.lua",
      "SynthVAgentSidebar.lua",
    ].map((name) =>
      writeFile(path.join(installedDirectory, name), priorMarker, "utf8"),
    ),
  );
  const installer = fileURLToPath(
    new URL("../../scripts/install-synthv-bridge.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [installer, "--target", target, "--no-reload"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SYNTHV_AGENT_BRIDGE_DIR: path.join(fixture, "ipc"),
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const installedBridge = await readFile(
    path.join(installedDirectory, "SynthVAgentBridge.lua"),
    "utf8",
  );
  const installedStop = await readFile(
    path.join(installedDirectory, "StopSynthVAgentBridge.lua"),
    "utf8",
  );
  const installedSidebar = await readFile(
    path.join(installedDirectory, "SynthVAgentSidebar.lua"),
    "utf8",
  );
  assert.doesNotMatch(installedBridge, /prior installed component/u);
  assert.doesNotMatch(installedStop, /prior installed component/u);
  assert.doesNotMatch(installedSidebar, /prior installed component/u);
  assert.match(installedBridge, new RegExp(EXECUTOR_BUILD_ID, "u"));
  assert.match(installedSidebar, new RegExp(SIDEBAR_BUILD_ID, "u"));
  assert.deepEqual(
    (await readdir(installedDirectory)).filter((name) =>
      name.startsWith(".v3-install-"),
    ),
    [],
  );
});

test("an interrupted component replacement restores the complete prior set", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "synthv-install-test-"));
  context.after(async () => rm(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, "scripts");
  const installedDirectory = path.join(target, "SynthV Agent Bridge");
  await mkdir(installedDirectory, { recursive: true });
  const priorFiles = {
    "SynthVAgentBridge.lua": "prior bridge\n",
    "StopSynthVAgentBridge.lua": "prior stop\n",
    "SynthVAgentSidebar.lua": "prior sidebar\n",
  } as const;
  await Promise.all(
    Object.entries(priorFiles).map(([name, content]) =>
      writeFile(path.join(installedDirectory, name), content, "utf8"),
    ),
  );
  const installer = fileURLToPath(
    new URL("../../scripts/install-synthv-bridge.mjs", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [installer, "--target", target, "--no-reload"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        SYNTHV_AGENT_BRIDGE_DIR: path.join(fixture, "ipc"),
        SYNTHV_AGENT_INSTALL_TEST_FAIL_AFTER_ACTIVATION: "1",
      },
    },
  );

  assert.notEqual(result.status, 0);
  for (const [name, content] of Object.entries(priorFiles)) {
    assert.equal(
      await readFile(path.join(installedDirectory, name), "utf8"),
      content,
    );
  }
  assert.deepEqual(
    (await readdir(installedDirectory)).filter((name) =>
      name.startsWith(".v3-install-"),
    ),
    [],
  );
});
