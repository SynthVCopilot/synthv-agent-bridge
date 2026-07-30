# Native side panel

Version 0.1.4 adds the optional `SynthVAgentSidebar.lua`, a Synthesizer V Studio
2 Pro `SidePanelSection`. It is a local review surface, not an AI client, not a
second project executor, and not a dependency of the Bridge or ordinary MCP
tools. A core-only installation may omit it with `--without-sidebar`.

The panel starts in compact mode with Bridge/MCP status, task state,
diagnostics, and a **Show details** control. Detailed context, request entry,
and history stay hidden until requested. Pending confirmation is always
surfaced with Apply/Dismiss controls, including while compact.

## Responsibilities

The panel:

- shows compact fresh/stale Bridge (`B`) and MCP-client (`M`) heartbeats;
- summarizes the current track, Group, selected-note count, rendered pitch
  range, time range, selected Groups, and selected Smart Pitch controls;
- writes one instruction plus that summary to a local queue;
- copies a Codex handoff prompt to SynthV's host clipboard;
- displays one pending guarded Bridge write or transaction with structured
  before/after/count rows and risk warnings;
- shows `queued`, `claimed`, `awaiting_confirmation`, `applying`, and terminal
  task states;
- writes Apply, Dismiss, or Cancel commands for the Node coordinator;
- shows Bridge/MCP versions, heartbeat ages, IPC path, and the latest error in
  a diagnostics dialog; and
- keeps up to 20 privacy-limited operation summaries that can be cleared.

The panel does not call an AI API, open a socket, parse `.svp` files, or mutate
SynthV project objects.

The panel is maintained as a small stability and interaction surface. It is
not a performance-optimization target and will not duplicate SynthV's piano
roll, waveform, note editor, or voice-parameter controls.

## Request and preview flow

```text
SynthV selection + typed instruction
                 │ Copy & queue
                 ▼
       sidebar.instruction.txt
                 │ sidebar_get_request
                 ▼
        Codex claims request and reads fresh state
                 │ sidebar_publish_preview
                 ▼
 sidebar.preview.json + preview.txt
                 │ user clicks Apply
                 ▼
        sidebar.command.txt
                 │ Node coordinator
                 ▼
 serialized FileIpcClient → protocol v3 → Lua Bridge
```

`sidebar.preview.json` contains the complete Bridge action and payload. The
panel reads only `sidebar.preview.txt`, which contains the generated plan ID,
status, human-readable description, structured changes, and risks. On Apply,
the coordinator verifies the plan ID and sends the stored payload; it does not
accept a payload from the panel command file.

`sidebar.state.txt` records the current task state. `sidebar.history.json`
stores at most 20 summaries with timestamps, results, affected action, and
safe error details. The history deliberately excludes complete lyrics, note
payloads, and preview bodies. `sidebar.activity.txt` is the display-oriented
view of those summaries.

## Safety properties

- Only project-write actions, `apply_transaction`, and guarded rollback are
  accepted as panel previews.
- The preview payload must already contain every UUID and fingerprint required
  by independent work. A dependent transaction field may instead contain a
  valid `$result` reference to an earlier step whose result will supply that
  locator or guard.
- Only one pending or applying preview is allowed unless Codex explicitly
  replaces it.
- The existing `FileIpcClient` lock and serialization remain authoritative.
- Failed and stale writes stay visible and are not automatically retried.
- A successful write or transaction remains one native SynthV undo record.
  For transactions this is a single-Undo recovery boundary, not automatic
  rollback. Independent steps are fully preflighted; a step that consumes an
  earlier `$result` is resolved and checked immediately before it executes.
- If a dependent validation or host execution failure occurs after writes
  begin, the reported `undoRequired` state remains visible and directs the user
  to invoke SynthV Undo once before retrying.
- Cancel removes a queued request or unapplied preview; it does not interrupt a
  write that the Lua host has already started.

SynthV's public scripting API exposes `Project:newUndoRecord()` but no Undo
operation. The panel therefore provides undo guidance rather than simulating
keyboard input. Click the main editor before pressing **Ctrl+Z** so a focused
side-panel text field does not consume the shortcut; **Edit > Undo** is the
focus-independent fallback.

## Recovery and diagnosis

The panel's **Diagnostics** button and the read-only `sidebar_status` MCP tool
show the same core facts: Bridge/MCP version and freshness, IPC directory,
current task state, recent summaries, and last coordinator error. The recovery
message distinguishes these cases:

- Rescan scripts when the panel or installed version is missing.
- Start **SynthV Agent Bridge** when the Lua heartbeat is offline.
- Restart/reconnect the MCP host when only the MCP heartbeat is offline.

`npm run doctor -- --target "<SynthV scripts directory>"` performs equivalent
read-only checks outside SynthV.

## Current limitations

- One preview can be pending at a time, although it may contain a transaction
  of up to 32 write steps. Later steps may reference earlier results; those
  dependent steps cannot be fully preflighted until their result-derived
  locators exist.
- The user must paste the copied handoff prompt into Codex; an MCP server cannot
  initiate a model turn.
- History contains summaries only and is intentionally capped at 20 entries.
- Stored rollback plans survive only for the current Bridge process and
  project session.
- The SynthV side-panel API does not provide a way for this script to make
  buttons sticky during host scrolling or to define arbitrary status colors,
  so the panel uses compact symbols, dedicated status rows, and visible action
  rows instead.
