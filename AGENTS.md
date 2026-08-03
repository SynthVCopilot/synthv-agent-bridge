# Repository guidance

## Scope

This repository is a host-neutral Runtime: a TypeScript MCP stdio server and a
persistent Synthesizer V Studio Lua executor connected by versioned file IPC.
Agent skills, demos, and artistic workflow instructions live in the separate
`SynthVCopilot/SKILLS` repository.

## Runtime invariants

- Keep the MCP server network-free by default. Do not call an AI API or open a
  listening network port.
- Do not parse or mutate `.svp` files. Bounded score inspection may read only an
  explicitly supplied absolute local `.xml`, `.musicxml`, `.mxl`, `.mid`, or
  `.midi` path in Node. Reject URLs, XML `DOCTYPE`/`ENTITY`, changed SHA-256
  guards, ambiguous/polyphonic lanes, and imports above 512 notes. Require
  `rightsConfirmed: true`; never apply source tempo implicitly.
- Keep file IPC protocol v3 as the sole request/response envelope. Reject v1 and
  v2 with `PROTOCOL_MISMATCH`; use a new protocol version for a breaking envelope
  change.
- Keep the public MCP surface limited to exactly six tools: `sv_status`,
  `sv_describe`, `sv_query`, `sv_command`, `sv_ui`, and `sv_review`. Detailed
  SynthV actions remain internal and are described just in time.
- Keep track, group, note, transaction-step, and other SynthV-facing indices
  1-based at the protocol boundary.
- Require current fingerprints for note edits/deletes. Keep `contextId` and Guard
  Tokens target-typed and scope-bound; conflicting locators or guards fail
  closed. A read-only Context must never authorize a write.
- On a SynthV/Bridge Session change, clear all Context and Guard state. Return
  `SYNTHV_SESSION_CHANGED`; never reuse stale capabilities.
- Validate every ordinary write and every independent transaction step before
  `Project:newUndoRecord()`. Resolve and preflight an explicit forward `$result`
  dependency immediately before that step. `atomicity: "singleUndoRecord"` is a
  recovery boundary, not automatic rollback; accurately report `undoRequired`.
- Treat Note Group contents as shared by all references. Default Group-content
  writes to `sharedGroupPolicy=reject`; require explicit `allowAllReferences`
  with a matching fresh `expectedReferenceCount` when more than one reference
  exists.
- `clone_track` rejects non-main vocal Groups by default. A detach path may make
  content independent but must not claim the official API preserved or verified
  non-main Vocal identity. Never claim that the API can read or name a Vocal.
- UI actions return actual host state after execution: selection is reread,
  viewport state is serialized, and playback returns status/playhead.
- Do not probe tuning ranges at startup. Validate Group Voice, Vocal Mode,
  phoneme, and automation values against the documented or same-fresh-read host
  ranges. Do not invent musical or artistic values in Runtime code.
- Keep consecutive notes created by one request connected inside a phrase unless
  the caller explicitly supplies a rest/detached articulation. Preserve all
  pre-existing note geometry unless the caller explicitly requests that exact
  structural change.
- Keep the optional Sidebar connection-only. It may show Bridge/MCP status and
  request a Bridge reload, but must not collect edit instructions, apply writes,
  or become a second Agent UI.
- Do not log project lyrics or note data to stderr unless explicitly requested
  for debugging.

## Responsibility boundary

- The Agent and user own intent, target choice, score/lyric interpretation,
  singer/Vocal Mode onboarding, and numeric musical decisions.
- TypeScript owns schemas, routing, compact projections, Context/Guard expansion,
  session invalidation, bounded local score conversion, and fail-closed policy.
- Lua owns authoritative SynthV reads, host capability/range checks, deterministic
  batch expansion, complete preflight, one undo boundary, and postconditions.
- SynthV is the project-state authority; the user is the final artistic authority.

## Compatibility boundary

- Runtime behavior must not branch on an Agent brand.
- Project profiles may adapt stdio registration for Codex and Claude Code, but
  they must launch the same `dist/src/cli.js` Runtime.
- Do not write user-global host configuration during build, install, or Doctor.
- `npm run doctor` checks core Runtime state by default. Host profile checks must
  be opt-in via `--host codex`, `--host claude`, or `--host all`.

## Checks

Run:

```bash
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
node --check scripts/doctor.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
```

Actual SynthV integration still requires manual testing inside Synthesizer V
Studio 2 Pro. Claude Code publication additionally requires a clean authenticated
Claude Code session because the CLI is not part of this repository.
