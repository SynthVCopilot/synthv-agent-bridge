# Roadmap

## v0.1–v0.1.2 — reliable control foundation

- Project, track, group, note, selection, mixer, automation, and playback reads.
- Track creation/update/clone/delete and note add/edit/delete.
- Group metadata/reference updates and non-main reference removal.
- Automation and mixer writes.
- Full time-axis reads, conversion, and writes.
- Computed phoneme/rap data and pitch sampling.
- Request correlation, heartbeat, stale-file recovery, and single-writer locking.
- Group UUID plus note, track, automation, and time-axis concurrency guards.
- SynthV undo integration.

## v0.2 — preview and transaction layer

- Dry-run change plans and human-readable diffs.
- Snapshot/commit workflow for multi-tool edits.
- Explicit rollback records and project-revision checks.
- Selected-range helpers and cross-object batch operations.

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
