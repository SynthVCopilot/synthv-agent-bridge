# Architecture

## Components

```text
MCP client (Codex / compatible local stdio host)
                 │ stdio MCP
                 ▼
       TypeScript MCP server
                 │ request/response JSON files
                 ▼
  SynthVAgentBridge.lua (persistent script)
                 │ Synthesizer V scripting API
                 ▼
       Current SynthV project and UI
```

The TypeScript process never parses or rewrites `.svp` files. All project mutations run inside Synthesizer V through its public scripting object model.

## Why file IPC

SynthV scripts expose filesystem access through Lua, while a stable socket API is not documented. File IPC is slower than a local socket but is portable, inspectable, and easy to recover after a crash. Version 0.1 deliberately prioritizes correctness over throughput.

The channel contains a single in-flight transaction:

- `synthv-agent-bridge.request.json`
- `synthv-agent-bridge.processing.json`
- `synthv-agent-bridge.response.json`
- `synthv-agent-bridge.status.json`
- `synthv-agent-bridge.lock`
- `synthv-agent-bridge.session.json`
- `synthv-agent-bridge.stop`

The Node side serializes calls and owns the lock. It writes requests using a temporary file plus rename. The Lua side claims a request by renaming it to the processing filename, executes it on SynthV's script thread, and publishes one correlated response.

## Safety model

Every destructive note operation uses optimistic concurrency:

1. Read notes with `get_track_notes` or `get_selection`.
2. Receive a `groupUuid` and a fingerprint for each note.
3. Send those values back with `edit_notes` or `delete_notes`.
4. The Lua bridge rechecks the current note before changing anything.
5. If the note moved, changed, or was reordered, the entire operation is rejected as `STALE_NOTE`.

All inputs are validated before an undo record is created. Each successful write tool creates one SynthV undo record, so the user can undo the operation in the editor.

## Trust boundary

The MCP server is intentionally local and uses stdio. It does not open a network listener, upload projects, or call an AI API. The connected MCP host decides which model sees tool results.

## Timeout semantics

After SynthV renames a request to the processing filename, that file is owned by the Lua host. The Node client does not delete it when a request times out, which prevents another write from overlapping a still-running editor operation. A timeout does not prove that the edit failed: SynthV may complete after the MCP caller stops waiting. Clients must read the affected state before retrying a write. A stale processing marker can be recovered after the configured stale-request interval if the host crashed.

The stale-request interval must be greater than the response timeout. The Node configuration loader enforces this invariant so a live operation cannot be reclaimed as stale while its original caller is still waiting.
