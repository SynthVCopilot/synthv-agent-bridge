#!/usr/bin/env node

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function usage() {
  console.error(
    "Usage: npm run install:synthv -- --target <SynthV scripts directory>\n" +
      "Alternatively set SYNTHV_SCRIPTS_DIR. Use SynthV's Scripts → Open Scripts Folder command to find the correct directory.",
  );
}

const argumentsList = process.argv.slice(2);
const targetFlagIndex = argumentsList.indexOf("--target");
if (targetFlagIndex >= 0 && !argumentsList[targetFlagIndex + 1]) {
  usage();
  process.exit(2);
}

const suppliedTarget =
  targetFlagIndex >= 0
    ? argumentsList[targetFlagIndex + 1]
    : process.env.SYNTHV_SCRIPTS_DIR;

if (!suppliedTarget) {
  usage();
  process.exitCode = 2;
} else {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceDirectory = path.join(repositoryRoot, "synthv");
  const destinationDirectory = path.resolve(suppliedTarget, "SynthV Agent Bridge");

  await mkdir(destinationDirectory, { recursive: true });
  for (const fileName of ["SynthVAgentBridge.lua", "StopSynthVAgentBridge.lua"]) {
    await cp(
      path.join(sourceDirectory, fileName),
      path.join(destinationDirectory, fileName),
    );
  }
  console.log(`Installed SynthV Agent Bridge scripts to ${destinationDirectory}`);
}
