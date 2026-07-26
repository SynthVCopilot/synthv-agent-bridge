# Native side panel

Version 0.1.4 adds `SynthVAgentSidebar.lua`, a Synthesizer V Studio 2 Pro
`SidePanelSection`. It is a local review surface, not an AI client and not a
second project executor.

## Responsibilities

The panel:

- shows compact fresh/stale Bridge (`B`) and MCP-client (`M`) heartbeats;
- summarizes the current track, Group, selected-note count, rendered pitch
  range, time range, selected Groups, and selected Smart Pitch controls;
- writes one instruction plus that summary to a local queue;
- copies a Codex handoff prompt to SynthV's host clipboard;
- displays one pending guarded Bridge write;
- writes Apply or Dismiss commands for the Node coordinator; and
- displays the latest successful Bridge write or preview error.

The panel does not call an AI API, open a socket, parse `.svp` files, or mutate
SynthV project objects.

## Request and preview flow

```text
SynthV selection + typed instruction
                 │ Copy & queue
                 ▼
       sidebar.instruction.txt
                 │ sidebar_get_request
                 ▼
        Codex reads fresh state
                 │ sidebar_publish_preview
                 ▼
 sidebar.preview.json + preview.txt
                 │ user clicks Apply
                 ▼
        sidebar.command.txt
                 │ Node coordinator
                 ▼
 serialized FileIpcClient → protocol v1 → Lua Bridge
```

`sidebar.preview.json` contains the complete Bridge action and payload. The
panel reads only `sidebar.preview.txt`, which contains the generated plan ID,
status, and human-readable description. On Apply, the coordinator verifies the
plan ID and sends the stored payload; it does not accept a payload from the
panel command file.

## Safety properties

- Only project-write actions are accepted as panel previews.
- The preview payload must already contain every UUID and fingerprint required
  by the selected Bridge action.
- Only one pending or applying preview is allowed unless Codex explicitly
  replaces it.
- The existing `FileIpcClient` lock and serialization remain authoritative.
- Failed and stale writes stay visible and are not automatically retried.
- Successful writes remain one native SynthV undo record.

SynthV's public scripting API exposes `Project:newUndoRecord()` but no Undo
operation. The panel therefore provides undo guidance rather than simulating
keyboard input. Click the main editor before pressing **Ctrl+Z** so a focused
side-panel text field does not consume the shortcut; **Edit > Undo** is the
focus-independent fallback.

## Current limitations

- One Bridge write can be previewed at a time.
- The user must paste the copied handoff prompt into Codex; an MCP server cannot
  initiate a model turn.
- Preview history is limited to the current preview and latest activity.
- Full multi-tool preview/commit and rollback belong to the planned v0.2
  transaction layer.
