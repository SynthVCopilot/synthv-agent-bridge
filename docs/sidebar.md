# Native connection side panel

`SynthVAgentSidebar.lua` is an optional Synthesizer V Studio 2 Pro
`SidePanelSection`. It is a small connection monitor, not an AI client and not
a project editor. A core-only installation may omit it with
`--without-sidebar`.

The panel deliberately exposes only:

- the latest verified Bridge (`B`) heartbeat;
- the MCP process (`M`) heartbeat; and
- **Restart Bridge**, which hot-reloads a confirmed-online Bridge.

Instructions, selection summaries, task state, previews, Apply/Dismiss,
history, and Undo controls belong outside this panel. The Agent conversation is
the review surface; confirmed writes use `sv_command` and retain the same fresh
Context, Guard, preflight, one-Undo, and host postcondition checks.

## Connection states

The panel does not trust a status file merely because its timestamp is recent.
After the panel loads it shows `B checking` until it observes a later heartbeat
or a replacement Session. If no new heartbeat arrives within three seconds it
shows `B offline`. This prevents Rescan from briefly presenting a cached
heartbeat as a live Bridge.

`M` is online while the local MCP status monitor continues writing its
heartbeat. `sv_review` is read-only and returns these MCP/panel runtime facts;
`sv_status` remains the authoritative Bridge connection and build-coherence
tool.

## Restart and recovery

**Restart Bridge** is enabled only after a live Bridge handshake. It writes the
existing local reload signal, waits for a new Bridge Session, and then restores
the online badge. It cannot start an offline SynthV menu script. When `B` is
offline, run:

```text
Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge
```

**Rescan** reloads script definitions and stops persistent scripts; it never
starts the Bridge. Start the Bridge once after every Rescan.
When the installed side-panel layout itself changes, close and reopen SynthV;
in real-host testing, Rescan left the already-rendered panel layout unchanged.

The panel always warns that after SynthV's **Stop All Running Scripts**, status
remains at its last result and is not reliable. That command also stops the
side-panel callback that repaints the panel, so the already-rendered controls
can remain visible but are frozen. Prefer the dedicated **Stop SynthV Agent
Bridge** command when the panel should remain alive and show `B offline`.
Reopen SynthV after Stop All to restore the panel.

The panel uses only local file heartbeats and the existing reload signal. It
does not open a socket, call an AI API, parse `.svp`, or access project objects.
