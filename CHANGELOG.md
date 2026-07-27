# Changelog

All notable changes will be documented in this file.

## Unreleased

### Added

- V2 `add_notes` now defaults to `grouping=ensureNonMain`. Notes aimed at a
  track main group are inserted into a newly created reusable non-main group
  and reference, with the main Voice/Vocal Modes copied so the new notes remain
  directly tunable. Explicit non-main groups are reused, and
  `grouping=target` preserves exact-target insertion.
- A compact `get_phrase_context` read that resolves the current piano-roll
  Group or an explicit note/time scope and returns write-ready note and
  automation Guard Tokens, Group voice/Vocal Modes, bounded rhythm/pitch
  diagnostics, and recommendation-only review targets in one IPC round trip.
- Optional computed-pitch summaries that retain only aggregate contour metrics
  instead of returning every sampled frame.
- Explicit `overlap` versus binary-seek `onset` range coverage with diagnostics
  that disclose when earlier crossing sustains may be omitted.
- Opaque, fingerprint-guarded phrase page cursors that continue without
  rescanning skipped pages and fail closed when their boundary note changes.
- Up to 32 phrase ranges in one request, using one Group sweep, one shared
  unique-note serialization, per-range diagnostics, and automation curves
  fingerprinted only once.

### Changed

- The native side panel is explicitly optional, starts in a compact layout,
  surfaces pending confirmations automatically, and can be omitted at install
  time with `--without-sidebar`. Core Bridge/MCP operation remains complete.
- Side-panel scope is limited to stability and interaction maintenance rather
  than performance work or duplicating SynthV editing controls.
- Phrase context automatically prefers selected notes, includes the pitch and
  timing fields needed for tuning, caps notes/recommendations/automation
  parameters, and never uses a cross-request cache that could become stale
  after an editor change.
- Phrase notes round seconds to 0.1 ms and omit repeated default-valued phoneme,
  detune, and selection fields while retaining every non-default override.
- The default overlap behavior remains backward compatible. Faster onset-only
  seeking and multi-range reads are explicit opt-ins; protocol v1 is unchanged.

### Fixed

- Empty `vocalModeParams` maps are no longer mistaken for an unsupported
  singer. `set_group_voice` can initialize multiple previously omitted modes
  in one request, clone-probes the complete batch, retains all requested values,
  and still rejects genuinely unsupported names before creating an undo
  record. Agents no longer need per-mode discovery interactions. A genuine
  name failure now returns structured instructions to stop guessing and ask
  the user for the exact Vocal Mode names displayed for the current singer.
- The installer now distinguishes a successful in-session hot reload from
  SynthV's cached menu-script source. When the Bridge runtime changed, it asks
  for one script rescan before the next project/app restart and manual launch,
  preventing a cached older handler from reclaiming the session.

## 0.1.5 - 2026-07-27

### Added

- Optional `compact` responses for phoneme and automation tuning workflows,
  including note-index/absolute-seconds filters and compact write
  acknowledgements.
- MCP-local short Guard Tokens that replace verbose note and automation
  fingerprints in compact responses while preserving protocol-v1 stale-write
  validation inside SynthV.
- Clone-first and project-write postcondition checks for phoneme properties,
  plus a read-only Group voice capability probe for phoneme-strength retention.
- Response-size regression coverage that keeps a representative 21-note compact
  tuning context below 4 KB.
- Projection diagnostics and an `includeComputedPhonemes` switch for
  guard/override refreshes that do not require whole-Group host computation.

### Changed

- MCP text results now use minified JSON to reduce transport and model-context
  overhead. Full response mode remains the backward-compatible default.
- Guard Tokens are resolved consistently for direct writes, transaction steps,
  and sidebar previews; compact transaction results return replacement tokens.
- Exact-index and ordinary paginated phoneme reads fetch only the returned page;
  time filters convert their boundaries once and stop after the range, and note
  attributes are snapshotted once per returned note.
- Default response polling is reduced from 50 ms to 10 ms, with the Lua request
  loop reduced from 100 ms to 25 ms while retaining one-second heartbeats and
  bounded session ownership checks.

## 0.1.4 - 2026-07-26

### Added

- A native SynthV 2.1.2+ `SidePanelSection` with Bridge/MCP status,
  current-selection summaries, an instruction queue, guarded change previews,
  Apply/Dismiss controls, and latest-operation/undo guidance.
- `sidebar_get_request` and `sidebar_publish_preview` MCP tools plus a
  network-free TypeScript coordinator that executes confirmed previews through
  the existing serialized file IPC client.
- Typed Group voice reads/writes for documented base parameters and per-axis
  Vocal Mode settings, guarded by Group-reference fingerprints and clone-first
  host validation. Vocal Mode axes accept non-negative finite values rather
  than imposing a stale fixed ceiling. Sparse preflight detects when SynthV
  would clamp unrequested legacy values such as 180 or 220; both those unsafe
  partial updates and directly clamped values are rejected before an undo
  record is created.
- Experimental Unison `singers` and `spacing` access that is enabled only when
  the current SynthV host returns and retains those fields.
- Dedicated phoneme reads and fingerprint-verified writes for language and
  phoneset overrides, syllable timing, and per-phoneme timing/strength
  attributes.
- In-session Bridge hot reload through `reload_bridge` and the installer. Once
  this version has been started manually, later installs can reload the Lua
  executor without mouse automation, hooks, or another manual script launch.
- Group voice and phoneme reads now report current/selected editor context.
  Their write tools offer opt-in guards for the current piano-roll Group and
  selected notes while retaining explicit unselected-object automation.
- Side-panel diagnostics, explicit task states, structured before/after/risk
  previews, cancellation, and a clearable 20-entry privacy-limited history.
- `sidebar_status` plus a read-only `npm run doctor` command for versions,
  Bridge/MCP heartbeats, IPC state, installed scripts, and Codex configuration.
- Full-preflight `apply_transaction` batches of up to 32 independent writes in
  one undo record, with optional guarded reverse steps for current-session
  `rollback_transaction`.
- Range-constrained harmony-track creation, deterministic fingerprint-guarded
  timing humanization, lyrics-to-note fitting, and scoop, falloff, vibrato,
  crescendo, and breathiness expression presets.

### Fixed

- Keep both Bridge and MCP heartbeat indicators visible in the narrow native
  side panel, and clarify that project Undo requires main-editor focus or
  **Edit > Undo** when a side-panel text field has focus.
- Detect whether the installed side-panel file actually changed, avoid
  unnecessary rescans, and explain that a required SynthV rescan stops the
  persistent Bridge and must be followed by one manual Bridge start.
- Keep the real SynthV 2.2.1 `Project` object during transaction preflight and
  intercept only the shared undo-record boundary, avoiding invalidated Lua
  object proxies on the live host.

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
