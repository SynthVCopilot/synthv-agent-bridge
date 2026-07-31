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
- Complete preflight of independent write steps followed by one undo record,
  plus in-session guarded rollback.
- Range-constrained harmony tracks, deterministic note humanization, expression
  presets, and lyrics-to-note fitting.
- A read-only doctor for installed versions, heartbeats, IPC state, and Codex
  configuration.

## Completed — official API coverage expansion and v3 migration

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
- Explicit complete-overlap or binary onset-only range scans, guarded phrase
  page cursors, and one-sweep multi-range phrase analysis with shared notes.
- Six-tool MCP v3 Facade with just-in-time action schemas, range-scoped
  `contextId` guards, phrase field projection, minimal write acknowledgements,
  and Dense rows for large note sets. The legacy v2 surface is removed.
- v3 note insertion automatically creates a reusable non-main group when the
  requested target is a track main group, preserving Voice/Vocal Mode editing
  for newly inserted notes.
- Deterministic guarded note transforms apply one explicit onset, duration, or
  semitone operation to an entire fresh Context without repeating note guards.
- Shared Note Group content writes fail closed by default. An intentional edit
  of every linked occurrence requires `allowAllReferences` plus a fresh expected
  reference count.
- Track cloning rejects non-main vocal Groups by default. Explicit detachment
  makes Group content independent while reporting that non-main Vocal identity
  needs manual review. `clone_track_shell` provides a verified-empty,
  host-cloned main-Vocal template workflow.
- Context handles are target-typed and scope-bound. Incompatible actions,
  conflicting explicit locators/guards, and locator-only attempts to mint
  write Contexts fail closed.
- Forward transaction steps can consume earlier `$result` fields. Independent
  steps are fully preflighted, dependent steps are preflighted just in time,
  and `atomicity: "singleUndoRecord"` describes a one-Undo recovery boundary
  rather than automatic rollback.
- Network-free local MusicXML/MIDI inspection and rights-confirmed monophonic
  import use SHA-256 file guards, reject unsafe/ambiguous/polyphonic sources,
  cap one import at 512 notes, and leave project tempo unchanged.
- UI controls return the selection, navigation, or playback state observed
  from SynthV after the request rather than only echoing requested values.
- Agent, TypeScript MCP, Lua executor, SynthV, and user responsibility
  boundaries are explicit and enforced by the write architecture.
- The complete default MCP tool catalog is kept below 12 KB; the current build
  is below 6 KB while all file-protocol actions remain available.

The native side panel remains an optional compact review console. Future work
is limited to stability, compatibility, and interaction fixes; it is not a
performance roadmap or a second SynthV editing interface.

## Current — v0.2.0 reduced-stable maintenance

- Keep the completed six-tool migration and 64/64 Action coverage checks from
  drifting after the reduced-stable release.
- Preserve the completed Vocal onboarding, 31 verified write Actions, and
  passed human listening result for the integrated tuning scenario.
- Keep the seven native-risk clone/transaction/harmony paths explicitly
  experimental and disabled until a future repetition matrix proves them safe.
- Preserve the completed Stage 3 read/reload/concurrency, reduced-capability,
  tracing A/B, write/Undo, listening, and one-hour functional-soak evidence.
- Re-run the fixed settled-resource monitor as follow-up hardening; the user
  explicitly waived it for v0.2.0, so no resource PASS is claimed.
- Keep Snapshot LRU disabled until traces prove repeated read projection is a
  significant cost.
- Revisit the seven experimental paths only with new host versions and a fresh
  crash-safe repetition matrix.

See [v3 development plan](v3-development-plan.md).

## Later — durable recovery and advanced music analysis

- Durable rollback metadata with explicit project-revision checks.
- Shared-value/override compression and richer cross-object batch operations.
- Harmony voicing beyond fixed intervals, pronunciation diagnostics, and
  configurable humanization/expression profiles.

## Longer term

- Render-and-analyze feedback loops.
- Optional remote transport with authentication.
- Adapters for Remy and non-MCP clients.
