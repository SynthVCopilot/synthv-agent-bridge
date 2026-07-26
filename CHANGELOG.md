# Changelog

All notable changes will be documented in this file.

## Unreleased

### Security

- Override the MCP SDK's vulnerable transitive `@hono/node-server` dependency
  with `2.0.12`, and fail CI on moderate-or-higher production dependency
  vulnerabilities.

## 0.1.3 - 2026-07-26

### Added

- Reusable note-group library creation, cloning, listing, deletion, and
  linked/deep Group-reference placement.
- Vocal and instrumental Group-reference fingerprints plus safe update/delete
  support.
- Full point/curve Smart Pitch CRUD with per-object fingerprints.
- AI Retake reads plus generation, activation, and deletion for Bridge-tracked
  Take IDs.
- Automation curve sampling and official range simplification.
- Expanded selection reads and writes for Groups, notes, Smart Pitch controls,
  and automation points.
- Main-editor and arrangement viewport reads/writes, snapping, and coordinate
  conversion.
- Host info, clipboard, dialogs, pitch/frequency conversion, and namespaced
  SynthV object metadata.
- Computed phoneme output alongside computed attributes and pitch samples.

### Changed

- Expanded the additive protocol-v1 action set from 24 to 50 Lua actions and
  the MCP surface from 25 to 51 tools without changing the envelope.
- Raised the minimum SynthV editor version from 2.1.1 to 2.1.2 for the official
  Smart Pitch selection API.
- Added SynthV 2.2.1 compatibility handling for Lua object proxies, unavailable
  `pitch2freq`, and the host restriction against selecting main groups.
- Extended the mock SynthV integration harness to cover the new official API
  surface and one-undo-per-write invariant.

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
