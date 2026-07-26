# Changelog

All notable changes will be documented in this file.

## 0.1.2 - 2026-07-26

### Fixed

- Normalize track colors from the public `#RRGGBB` form to the opaque `AARRGGBB` form retained by SynthV, verify color writes, and expose normalized RGB/ARGB read fields.
- Replace occupied tempo and time-signature positions with an explicit remove/add sequence and verify time-axis postconditions so a silent host no-op is never reported as applied.
- Treat `pitchAutoMode` writes as an optional host capability. Requests that already match the current value do not require a setter; unsupported changes now fail before an undo record with `UNSUPPORTED_HOST_CAPABILITY`.

### Changed

- The Lua mock now reproduces the SynthV 2.2.1 behaviors found during live testing, including strict ARGB track colors and occupied time-axis positions that require removal before replacement.
- The Lua integration smoke test is now required to pass in CI.
- Playback smoke coverage now verifies that `pause` reports `stopped` while preserving a non-zero playhead.

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
