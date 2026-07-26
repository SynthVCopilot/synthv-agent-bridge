# Security

This project controls a local Synthesizer V Studio session and can modify the open project. Treat every connected MCP host as trusted.

## Defaults

- The MCP transport is local stdio.
- The bridge does not listen on a TCP port.
- The bridge does not upload project data or call external APIs.
- Note and Smart Pitch edits/deletes require fresh fingerprints; track,
  reference, library-group, automation, and time-axis writes support matching
  optimistic-concurrency guards.
- Script data is restricted to the `synthv-agent-bridge.` namespace.
- Each write or preflighted transaction creates one undo record in SynthV.
- The side panel exchanges instructions, human-readable previews, and one
  structured pending write or transaction only through files in the
  configured local IPC directory. It does not call an AI API or write project
  objects directly.
- Side-panel history is capped at 20 summaries and excludes complete lyrics,
  note payloads, and preview bodies.

## Operational guidance

- Save or duplicate important projects before testing automation.
- Do not place the IPC directory on a shared or remotely writable filesystem.
- Do not expose this server through an unauthenticated remote MCP proxy.
- Review tool calls that delete notes, Groups, references, Retakes, or
  automation points.
- `host_clipboard` can read or replace local clipboard text, and `show_dialog`
  can display a modal SynthV dialog. Only grant these tools to a trusted MCP
  host.
- Side-panel request and preview files may contain user instructions and
  project locators. Keep the IPC directory private to the local user and do not
  place it in a synchronized or shared folder.
- Rollback steps are volatile Bridge-process memory. They are fingerprint
  guarded, tied to the current project/session, and are discarded on reload.

Report a suspected vulnerability privately to the repository owner rather than opening a public issue with exploit details.
