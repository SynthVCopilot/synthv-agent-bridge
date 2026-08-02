# Repository guidance

## Scope

This repository contains a TypeScript MCP stdio server and a persistent Synthesizer V Studio Lua executor connected by versioned file IPC.

## Invariants

- Keep the MCP server network-free by default.
- Keep track, group, and note indices 1-based at the protocol boundary.
- Validate every ordinary write and every independent transaction step before
  calling `Project:newUndoRecord()`. A forward transaction step that explicitly
  depends on an earlier `$result` must resolve and preflight immediately before
  its own mutation; report the single Undo recovery requirement if that
  just-in-time check fails after earlier steps wrote.
- Require current fingerprints for note edits and deletes.
- Do not parse or mutate `.svp` files directly.
- Local score support may parse only an explicitly supplied absolute local
  `.xml`, `.musicxml`, `.mxl`, `.mid`, or `.midi` path in the Node process.
  Reject URLs, `.svp`, XML `DOCTYPE`/`ENTITY`, changed SHA-256 guards,
  ambiguous or polyphonic lanes, and imports above 512 notes. Require
  `rightsConfirmed: true`; return source tempo for review but never apply it to
  the project implicitly.
- Do not log project lyrics or note data to stderr unless explicitly requested for debugging.
- Keep file IPC protocol v3 as the sole request/response envelope. Reject
  protocol v1 and v2 with `PROTOCOL_MISMATCH`; add a new version for any future
  breaking envelope change.
- Keep the public MCP surface limited to the six compact v3 tools:
  `sv_status`, `sv_describe`, `sv_query`, `sv_command`, `sv_ui`, and
  `sv_review`. Detailed
  SynthV action handlers are internal definitions exposed just in time through
  `sv_describe`; do not expose them as standalone MCP tools.
- Keep the optional native Sidebar connection-only: it may display Bridge/MCP
  status and request an online Bridge reload, but it must not collect editing
  instructions, publish previews, apply/dismiss writes, show task history, or
  mutate project objects. Keep `sv_review` read-only and limited to Sidebar
  runtime status; user review stays in the Agent conversation and confirmed
  project writes go through `sv_command`.
- Keep the responsibility boundary enforceable in code:
  - The Agent and user own intent, lyric/emotion/style interpretation, target
    choice, Vocal/Vocal Mode onboarding, and the requested musical values.
  - The TypeScript MCP layer owns schemas, action routing, compact projections,
    target-typed/scope-bound `contextId`/Guard expansion, session invalidation,
    minimal acknowledgements, and bounded Node-local score inspection/
    conversion. Incompatible Context kinds and conflicting explicit locators or
    guards must fail closed; locator-only reads must not mint write-capable
    Contexts. It must not invent musical values or decide score-import rights.
  - The Lua executor owns authoritative SynthV reads, host capability and
    dynamic-range checks, deterministic batch expansion, complete preflight,
    one undo boundary, and postcondition verification. It must not infer
    emotion, style, singer identity, or which notes deserve emphasis.
  - SynthV remains the project-state authority; the user remains the final
    listening and artistic authority.
- When communicating with the user in Chinese, introduce the UI term as
  `唱法（Vocal Mode）` on first mention and use `唱法` afterward. Do not use a
  bare `Vocal Mode` in user-facing Chinese unless quoting an exact SynthV label
  is necessary.
- Treat Note Group content as shared across every reference. Group-content
  writes default to `sharedGroupPolicy=reject`; when the fresh reference count
  is greater than one, require the caller to explicitly choose
  `allowAllReferences` and supply the matching `expectedReferenceCount`.
  Reference-local fields such as offset and mute remain reference-local.
- `clone_track` must reject tracks containing non-main vocal Groups by default.
  `nonMainGroupPolicy=detach` must produce independent Group content without
  claiming that the official API preserved or verified those non-main Vocal
  identities; require manual Vocal review. Prefer `clone_track_shell` when the
  goal is one verified-empty track that inherits the host-cloned main Vocal
  context. Never claim that the API can read or name that Vocal.
- Forward transaction `$result` references may target earlier 1-based step
  results only and must occupy the complete field value. Fully preflight
  independent steps, preflight dependent steps just in time, and describe
  `atomicity: "singleUndoRecord"` as a recovery boundary rather than automatic
  rollback.
  When execution reports `undoRequired`, require one SynthV Undo before reread
  or retry.
- UI control actions must return the actual state reported by the host after
  the request: selection writes reread selection, viewport writes serialize the
  resulting navigation state, and playback returns current status/playhead.
- Do not probe tuning ranges at startup or at the start of each conversation.
  Treat Group Voice loudness as `-48..12`, Group Voice
  tension/breathiness/gender/tone shift as `-1..1`, Vocal Mode
  pitch/timbre/pronunciation axes as `0..150`, phoneme position/activity as
  `0..1`, and phoneme strength as `-1..1`. Phoneme `leftOffset` is a finite
  number of seconds without a Bridge-imposed bound. For automation, use the
  `definition.range` returned by the same fresh curve/phrase read instead of a
  fixed table because SynthV host and voice versions can expose different
  ranges.
- Prefer `apply_group_tuning` when one tuning pass changes Voice/Vocal Modes,
  notes or phonemes, and one or more automation curves in the same Group. It
  validates the complete batch and creates one SynthV undo record.
- Prefer `transform_notes` when every note in one freshly read scope receives
  the same explicit mechanical onset, duration, or semitone transform. With
  MCP v3, use `target: "contextNotes"` and the fresh `contextId` instead of
  repeating note indices. The Agent chooses the exact target scope and numeric
  transform; the Bridge only expands and verifies it. A seconds onset offset
  uses the fresh SynthV time axis and preserves note durations in blicks.
- Keep consecutive notes inside one lyric phrase exactly connected unless the
  user or the intended performance explicitly calls for a rest or detached
  articulation: the earlier note's end must equal the following note's onset.
  Never create tiny positive gaps to shape pronunciation or articulation,
  because they can prevent SynthV from rendering usable vocals. Use phoneme
  timing/strength and Voice or automation parameters for articulation instead.
  After duration or onset edits, reread the phrase and account for every
  remaining gap as an intentional phrase boundary or artistic rest.
- Apply that automatic note-connection rule only to notes the Agent created in
  the current task. Treat pre-existing notes, lyrics, onsets, durations, gaps,
  and rests as user-owned score structure: preserve them unless the user
  explicitly requests that specific structural change. If note provenance is
  uncertain, treat the material as user-owned. A general request to tune a
  performance authorizes the requested tuning parameters, not silent
  normalization of the user's note geometry.
- If an MCP v3 call returns `SYNTHV_SESSION_CHANGED`, do not retry its old
  `contextId` or Guard Tokens. The server has already cleared them; read the
  intended target again and build the write from the fresh context.
- On the first successful MCP/Bridge connection notice in a conversation,
  offer the optional bundled demo in one sentence: the user can reply
  `Run the Twinkle Star demo.` or `运行《小星星》Demo。` The Agent must not
  create anything until the user explicitly opts in, and it must not repeat
  the offer later in the same conversation.
- When the user starts that demo, read all of
  `examples/twinkle-star-demo.json` before acting and use it as the score,
  tuning, safety, and verification source of truth. Do not add a public MCP
  tool or move its musical decisions into TypeScript or Lua. Before each stage,
  print the matching short localized heading from `progressHeadings`, followed
  by at most one concise status sentence; do not expose raw MCP payloads:
  `Demo 1/5` checks the connection and safe location, `Demo 2/5` creates the
  isolated Note Group, `Demo 3/5` pauses for Vocal and singing-style
  onboarding, `Demo 4/5` applies full-song tuning and pitch curves, and
  `Demo 5/5` rereads, verifies, and starts playback.
- The demo may create and tune only its new non-main Group, positioned after
  existing project content. It must not alter user-owned tracks, Groups,
  notes, lyrics, geometry, automation, or mixer state. After score creation,
  stop and ask the user to select the Demo Group, select or assign its Vocal,
  and provide the complete Vocal Mode panel or every exact singing-style name.
  Continue automatically only after that handoff. Use a fresh Demo-Group read,
  passing the template's projection through the top-level `sv_query.include`
  field so `automation` and `pitchAnalysis` Guards are retained; do not put
  that projection only inside the internal action args. Use the current
  Automation `definition.range` values, one
  `apply_group_tuning` batch, an independent verification read, and loop
  playback. Account for exactly the five declared inter-phrase gaps and no
  within-phrase gap or overlap.
- Only when the requested tuning will use or modify Vocal Modes, ask the user
  before the first such write to select the intended Note Group in SynthV,
  select or assign its intended Vocal (singer/voice database), and then either
  attach a screenshot of the complete Vocal Mode panel or type every Vocal Mode
  name exactly as shown, preserving spelling and capitalization. Do not require
  this handoff for explicit mechanical edits that do not depend on singing
  styles. A singer must be selected before its Vocal Mode names can appear. Do
  not guess Vocal Mode names or perform a Vocal-Mode-dependent write until the
  user provides this information. After the user changes Vocals, require a new
  complete-panel screenshot or every singing-style name before another
  Vocal-Mode-dependent write; never reuse the previous Vocal's list. Explain the
  official API limitation in at most one concise sentence. If no suitable Note
  Group exists or the Vocal Modes are not visible yet, the user or Agent may
  create one temporary note in one temporary non-main Note Group at a harmless
  location solely to make the singing-style parameters available. The user must
  then select that Note Group and select or assign its Vocal. This bootstrap edit
  is the only exception for an ordinary Vocal-Mode-dependent request. Explicitly
  requested bundled Demo score creation is a separate opt-in construction
  workflow, but it must also stop after creating its isolated Group and ask the
  user to screenshot the complete panel or type every singing-style name before
  any tuning write.
- Do not present a fixed **How to use** section or **Preflight checklist**.
  Before a write, request only user-owned information that is still missing for
  the current request: the intended target and effect, anything that must remain
  unchanged, and the Vocal Mode handoff above when applicable. Suggest saving a
  working copy in one short sentence if the user has not already acknowledged
  it. Keep fresh reads, guards, preflight, protected writes, and independent
  verification as internal behavior; show the user only a small reviewable
  preview. Mention concurrent-edit safety only while a write is pending or
  running. Offer phrase-level-before-word-level tuning as optional advice only
  when it is relevant. Show SynthV Undo guidance only after an execution result
  actually reports `undoRequired: true`, and do not repeat resolved onboarding
  later in the same conversation.
- If the user explicitly requests token-saving mode, omit a separate
  Agent-level post-write `sv_query` after an ordinary `sv_command` succeeds
  with `verified: true`, unless a later operation needs fresh state. This mode
  skips only the redundant independent reread. It must not disable the fresh
  target read, Context/Guard checks, TypeScript validation, Lua preflight or
  host postcondition verification, UI actions' required actual-state results,
  the bundled Demo's declared final verification, or recovery reads after
  stale/session-change errors or `undoRequired`. Describe it as skipping the
  extra independent post-write reread, never as disabling verification.

## Checks

Run:

```bash
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
```

Actual SynthV integration still requires manual testing inside Synthesizer V Studio 2 Pro.
