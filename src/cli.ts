#!/usr/bin/env node

import { loadConfig, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { runStdioServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} using IPC directory ${config.paths.directory}`,
  );
  await runStdioServer(config);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
