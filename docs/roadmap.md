# Roadmap

## v0.1 — reliable control foundation

- Project, track, group, note, selection, mixer, automation, and playback reads.
- Track creation and note add/edit/delete.
- Automation and mixer writes.
- Request correlation, heartbeat, stale-file recovery, and single-writer locking.
- Group UUID and note-fingerprint concurrency guards.
- SynthV undo integration.

## v0.2 — preview and transaction layer

- Dry-run change plans and human-readable diffs.
- Snapshot/commit workflow for multi-tool edits.
- Explicit rollback records and project-revision checks.
- Selected-range helpers and time-axis conversion tools.

## v0.3 — musical semantic tools

- Harmony generation with voice-range constraints.
- Phrase timing humanization.
- Pitch scoop, falloff, vibrato, crescendo, and breathiness presets.
- Lyrics-to-note fitting and pronunciation helpers.

## Later

- Side-panel UI for preview/apply/undo.
- Render-and-analyze feedback loops.
- Optional remote transport with authentication.
- Adapters for Remy and non-MCP clients.
