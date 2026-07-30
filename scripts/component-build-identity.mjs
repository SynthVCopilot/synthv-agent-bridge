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

function injectMarker(source, marker, value, component) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(
      `${component} source must contain exactly one ${marker} marker`,
    );
  }
  return source.replace(marker, value);
}

export async function readComponentBuildIdentity(repositoryRoot) {
  const packageManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const executorSource = await readFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentBridge.lua"),
    "utf8",
  );
  const sidebarSource = await readFile(
    path.join(repositoryRoot, "synthv", "SynthVAgentSidebar.lua"),
    "utf8",
  );
  if (!executorSource.includes(EXECUTOR_BUILD_ID_MARKER)) {
    throw new Error("Executor source is missing its build-ID marker");
  }
  if (!sidebarSource.includes(SIDEBAR_BUILD_ID_MARKER)) {
    throw new Error("Sidebar source is missing its build-ID marker");
  }
  const executorSourceFingerprint = sha256(executorSource);
  const sidebarSourceFingerprint = sha256(sidebarSource);
  const executorBuildId =
    `sv3-lua-${packageManifest.version}-${executorSourceFingerprint.slice(0, 12)}`;
  const sidebarBuildId =
    `sv3-sidebar-${packageManifest.version}-${sidebarSourceFingerprint.slice(0, 12)}`;
  return {
    version: packageManifest.version,
    executorBuildId,
    executorSourceFingerprint,
    sidebarBuildId,
    sidebarSourceFingerprint,
    prepareExecutorSource() {
      return injectMarker(
        executorSource,
        EXECUTOR_BUILD_ID_MARKER,
        executorBuildId,
        "Executor",
      );
    },
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
