# Repository guidance

## Scope

This repository contains a TypeScript MCP stdio server and a persistent Synthesizer V Studio Lua executor connected by versioned file IPC.

## Invariants

- Keep the MCP server network-free by default.
- Keep track, group, and note indices 1-based at the protocol boundary.
- Validate complete write requests before calling `Project:newUndoRecord()`.
- Require current fingerprints for note edits and deletes.
- Do not parse or mutate `.svp` files directly.
- Do not log project lyrics or note data to stderr unless explicitly requested for debugging.
- Keep protocol v1 backward compatible; add a new protocol version for breaking envelope changes.
- Before the first tuning write in a conversation, the Agent must ask the user
  to select the intended Note Group in SynthV, select or assign the intended
  Vocal (singer/voice database) for that Group, and then either attach a
  screenshot of its complete Vocal Mode panel or type every Vocal Mode name
  exactly as shown, preserving spelling and capitalization. A singer must be
  selected before its Vocal Mode names can appear. Do not guess Vocal Mode names
  or proceed with a tuning write until the user provides this information.
  After the user changes Vocals, require a new complete-panel screenshot or
  every singing-style name for the new Vocal; never reuse the previous Vocal's
  list. Explain that this is required because SynthV's official scripting API
  cannot read the current Vocal identity or enumerate untouched default-only
  Vocal Mode names and parameters. If no suitable Note Group exists or the
  Vocal Modes are not visible yet, the user or Agent may create one temporary
  note in one temporary non-main Note Group at a harmless location solely to
  make the singing-style parameters available. The user must then select that
  Note Group and select or assign its Vocal. This bootstrap edit is the only
  exception to the no-tuning-write-before-onboarding rule. Stop after the
  parameters appear and ask the user to screenshot the complete panel or type
  every singing-style name before any further tuning write.
- Before that first tuning write, present one concise **How to use** and one
  **Preflight checklist**. Cover saving a working copy, selecting the Vocal,
  providing its singing styles because of the official API limitation,
  selecting a short lyric phrase, stating the intended style and preserved
  content, fresh-read/plan/review behavior, confirming phrase-level style before
  word-level pronunciation/timing/pitch-transition/pitch-curve/expression work,
  avoiding concurrent edits to the same target, and SynthV undo guidance. Do
  not display a second checklist after publishing the preview, and do not repeat
  the onboarding later in the same conversation.

## Checks

Run:

```bash
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
```

Actual SynthV integration still requires manual testing inside Synthesizer V Studio 2 Pro.
