# Changelog

All notable changes will be documented in this file.

## 0.1.1 - 2026-07-26

### Added

- Complete tempo/time-signature map reads, tempo-aware position conversion, and fingerprint-guarded time-axis edits.
- Track update, deep clone, and delete tools. Track cloning can preserve the source singer/database while clearing or transposing cloned notes.
- Group reference update and removal tools for names, mute state, offsets, visible range, and voice-expression properties.
- Computed phoneme/rap attribute reads and optional computed-pitch sampling.
- Per-note language override, sing/rap type, pitch-auto mode, rap accent, and retake-count serialization.
- Track and automation fingerprints for optional optimistic-concurrency checks.

### Changed

- `add_track` now returns its main Group locator and UUID in addition to the backward-compatible track summary.
- The mock SynthV integration harness now verifies every new handler, stale-write rejection, advanced note fields, singer-preserving track clone behavior, and exactly one undo record per successful write.

## 0.1.0 - 2026-07-26

### Added

- MCP stdio server for project, track, note, selection, automation, mixer, and playback operations.
- Persistent SynthV Lua executor with versioned, correlated file IPC.
- Atomic request publication, a single-writer lock, heartbeat, session replacement, and stale-file recovery.
- Group UUID and note-fingerprint optimistic concurrency checks.
- One SynthV undo record per successful write operation.
- Windows/macOS SynthV script installer, tests, CI, protocol documentation, security guidance, and roadmap.
