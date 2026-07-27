# Roadmap

## v0.1–v0.1.3 — reliable control foundation

- Project, track, group, note, selection, mixer, automation, and playback reads.
- Track creation/update/clone/delete and note add/edit/delete.
- Group metadata/reference updates and non-main reference removal.
- Automation and mixer writes.
- Full time-axis reads, conversion, and writes.
- Computed phoneme/rap data and pitch sampling.
- Request correlation, heartbeat, stale-file recovery, and single-writer locking.
- Group UUID plus note, track, automation, and time-axis concurrency guards.
- SynthV undo integration.

## v0.1.4 — side panel, transactions, and semantic helpers

- Persistent SynthV side-panel connection and current-selection summaries.
- Network-free instruction queue with clipboard handoff to Codex.
- Structured write/transaction preview with task states, Apply/Dismiss/Cancel,
  recent summaries, diagnostics, and native Ctrl+Z guidance.
- MCP tools for reading queued requests, publishing guarded previews, and
  inspecting panel diagnostics.
- Complete preflight of up to 32 independent write steps followed by one undo
  record, plus in-session guarded rollback.
- Range-constrained harmony tracks, deterministic note humanization, expression
  presets, and lyrics-to-note fitting.
- A read-only doctor for installed versions, heartbeats, IPC state, and Codex
  configuration.

## Current — official API coverage expansion

- Reusable note-group library and linked/deep reference operations.
- Vocal and instrumental Group-reference updates and removal.
- Point/curve Smart Pitch CRUD with fingerprints.
- Bridge-tracked AI Retake generation, activation, and deletion.
- Automation sampling and simplification.
- Full selection reads/writes for groups, notes, Smart Pitch, and automation.
- Main-editor and arrangement viewport navigation, snapping, and coordinates.
- Host information, clipboard, dialogs, pitch/frequency helpers, and namespaced
  object metadata.
- Typed Group voice and Vocal Mode settings, dedicated phoneme properties, and
  host-validated experimental Unison access.
- Compact tuning reads/writes, note/time-range filtering, short MCP-local Guard
  Tokens, response-size budgets, and verified phoneme-property retention.
- Low-latency IPC polling, note-page/index projections, early-ending time-range
  scans, reusable attribute snapshots, and optional computed-phoneme omission.
- One-request selected/ranged phrase context with write-ready note/automation
  Guards, compact voice/Vocal Modes, aggregate pitch/rhythm diagnostics, and
  recommendation-only review targets.

## Next — transaction depth and advanced music analysis

- Dependency-aware transactions that can safely pass newly created object
  locators into later forward steps.
- Durable rollback metadata with explicit project-revision checks.
- Selected-range helpers and richer cross-object batch operations.
- Harmony voicing beyond fixed intervals, pronunciation diagnostics, and
  configurable humanization/expression profiles.

## Later

- Render-and-analyze feedback loops.
- Optional remote transport with authentication.
- Adapters for Remy and non-MCP clients.
