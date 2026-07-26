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

  SynthVAgentSidebar.lua (native panel)
                 │ instruction/preview/command text sideband
                 └──────── TypeScript sidebar coordinator
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

The optional v0.1.4 side panel uses a separate local sideband:

- `synthv-agent-bridge.sidebar.instruction.txt`
- `synthv-agent-bridge.sidebar.preview.json` (Node-private structured plan)
- `synthv-agent-bridge.sidebar.preview.txt` (display-only panel text)
- `synthv-agent-bridge.sidebar.command.txt`
- `synthv-agent-bridge.sidebar.activity.txt`
- `synthv-agent-bridge.sidebar.client-status.txt`
- `synthv-agent-bridge.sidebar.state.txt`
- `synthv-agent-bridge.sidebar.history.json`

The panel never writes the project. An Apply click creates a sideband command;
the TypeScript coordinator claims it and submits the stored action through the
same serialized `FileIpcClient` and v1 request channel as a normal MCP call.

The Node side serializes calls and owns the lock. It writes requests using a temporary file plus rename. The Lua side claims a request by renaming it to the processing filename, executes it on SynthV's script thread, and publishes one correlated response.

## Transaction layer

`apply_transaction` accepts up to 32 existing project-write actions. Before
creating an undo record, the Lua executor runs every step in validation mode.
A shared undo-record helper intercepts each step at its normal
`Project:newUndoRecord()` boundary while keeping the real SynthV `Project`
object intact. This occurs after that handler has completed its input,
fingerprint, clone, and host-capability checks. If every step passes, the
executor creates one real undo record and reruns the steps while suppressing
their nested undo calls.

The generic engine conservatively rejects multiple forward steps that mutate
the same guarded scope. This avoids making a later step's preflight depend on
an earlier mutation. Index-shifting track and library-group deletes are
exclusive single-step transactions. Common dependent operations are
implemented as dedicated single-write actions such as
`create_harmony_track`.

Optional reverse steps are resolved from forward results and retained only in
Bridge memory, associated with the current project/session. A later
`rollback_transaction` revalidates those steps and applies them in one new undo
record. A Bridge reload intentionally discards this volatile rollback state.

## Safety model

Destructive note, Smart Pitch, Group reference, library Group, track,
automation, and time-axis operations use optimistic concurrency:

1. Read notes with `get_track_notes` or `get_selection`.
2. Receive the applicable UUID and object fingerprint.
3. Send those guards back with the write request.
4. The Lua bridge rechecks every target and validates detached clones or
   complete prepared inputs before changing anything.
5. If any target changed, the complete request is rejected with the applicable
   `STALE_*` error.

All inputs are validated before an undo record is created. Each successful
write tool or transaction creates one SynthV undo record, so the user can undo
the operation in the editor. If an unexpected host exception occurs only after
transaction execution begins, the single undo record is the recovery boundary;
the Bridge reports the failure and directs the user to **Edit > Undo**.

Selection, viewport, clipboard, dialog, and playback controls change host UI
state rather than project model data and therefore do not create undo records.
Bridge metadata is restricted to the `synthv-agent-bridge.` script-data
namespace so other scripts' stored data is never enumerated or cleared.

## Trust boundary

The MCP server is intentionally local and uses stdio. It does not open a network listener, upload projects, or call an AI API. The connected MCP host decides which model sees tool results.

## Timeout semantics

After SynthV renames a request to the processing filename, that file is owned by the Lua host. The Node client does not delete it when a request times out, which prevents another write from overlapping a still-running editor operation. A timeout does not prove that the edit failed: SynthV may complete after the MCP caller stops waiting. Clients must read the affected state before retrying a write. A stale processing marker can be recovered after the configured stale-request interval if the host crashed.

The stale-request interval must be greater than the response timeout. The Node configuration loader enforces this invariant so a live operation cannot be reclaimed as stale while its original caller is still waiting.
