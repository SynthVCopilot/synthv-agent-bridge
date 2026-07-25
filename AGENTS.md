# Repository guidance

## Scope

This repository contains a TypeScript MCP stdio server and a persistent Synthesizer V Studio Lua executor connected by versioned file IPC.

## Invariants

- Keep the MCP server network-free by default.
- Keep track, group, and note indices 1-based at the protocol boundary.
- Validate complete write requests before calling `Project:newUndoRecord()`.
- Require current fingerprints for note edits and deletes.
- Do not parse or mutate `.svp` files directly.
- Do not log project lyrics or note data to stderr unless explicitly requested for debugging.
- Keep protocol v1 backward compatible; add a new protocol version for breaking envelope changes.

## Checks

Run:

```bash
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
```

Actual SynthV integration still requires manual testing inside Synthesizer V Studio 2 Pro.
