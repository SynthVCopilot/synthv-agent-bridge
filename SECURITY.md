# Security

This project controls a local Synthesizer V Studio session and can modify the open project. Treat every connected MCP host as trusted.

## Defaults

- The MCP transport is local stdio.
- The bridge does not listen on a TCP port.
- The bridge does not upload project data or call external APIs.
- Note edits and deletes require fresh fingerprints.
- Each write creates an undo record in SynthV.

## Operational guidance

- Save or duplicate important projects before testing automation.
- Do not place the IPC directory on a shared or remotely writable filesystem.
- Do not expose this server through an unauthenticated remote MCP proxy.
- Review tool calls that delete notes or replace automation curves.

Report a suspected vulnerability privately to the repository owner rather than opening a public issue with exploit details.
