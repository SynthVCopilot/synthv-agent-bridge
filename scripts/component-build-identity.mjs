import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const EXECUTOR_BUILD_ID_MARKER =
  "__SYNTHV_AGENT_EXECUTOR_BUILD_ID__";
export const SIDEBAR_BUILD_ID_MARKER =
  "__SYNTHV_AGENT_SIDEBAR_BUILD_ID__";

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function requireExactlyOneMarker(source, marker, component) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(
      `${component} source must contain exactly one ${marker} marker`,
    );
  }
}

function injectMarker(source, marker, value, component) {
  requireExactlyOneMarker(source, marker, component);
  return source.replace(marker, value);
}

export async function readComponentBuildIdentity(
  repositoryRoot,
  { includeSidebar = true } = {},
) {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const executorSource = await readFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentBridge.lua"),
    "utf8",
  );
  requireExactlyOneMarker(
    executorSource,
    EXECUTOR_BUILD_ID_MARKER,
    "Executor",
  );
  const executorSourceFingerprint = sha256(executorSource);
  const executorBuildId =
    `sv3-lua-${packageManifest.version}-${executorSourceFingerprint}`;
  return {
    version: packageManifest.version,
    executorBuildId,
    executorSourceFingerprint,
    prepareExecutorSource() {
      return injectMarker(
        executorSource,
        EXECUTOR_BUILD_ID_MARKER,
        executorBuildId,
        "Executor",
      );
    },
    ...(includeSidebar
      ? await readSidebarBuildIdentity(
          repositoryRoot,
          packageManifest.version,
        )
      : {}),
  };
}

async function readSidebarBuildIdentity(repositoryRoot, version) {
  const sidebarSource = await readFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentSidebar.lua"),
    "utf8",
  );
  requireExactlyOneMarker(
    sidebarSource,
    SIDEBAR_BUILD_ID_MARKER,
    "Sidebar",
  );
  const sidebarSourceFingerprint = sha256(sidebarSource);
  const sidebarBuildId =
    `sv3-sidebar-${version}-${sidebarSourceFingerprint}`;
  return {
    sidebarBuildId,
    sidebarSourceFingerprint,
    prepareSidebarSource() {
      return injectMarker(
        sidebarSource,
        SIDEBAR_BUILD_ID_MARKER,
        sidebarBuildId,
        "Sidebar",
      );
    },
  };
}
