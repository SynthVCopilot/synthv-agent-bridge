---
name: synthv-bridge
description: Inspect and edit the project open in Synthesizer V Studio 2 Pro through the SynthV Agent Bridge MCP server. Use when a request involves reading or changing SynthV notes, lyrics, phonemes, pitch curves, automation, Vocal Modes, tracks, Note Groups, selection, or playback.
---

# SynthV Agent Bridge

The bridge is a local stdio MCP server that drives the project currently open in
**Synthesizer V Studio 2 Pro** through its official Lua scripting API. It does
not parse `.svp` files and never touches project data on disk.

SynthV is the only live authority on project state. Every write must be built
from a read taken moments earlier, in the same session.

## 1. The six tools

| Tool | Use |
|---|---|
| `sv_status` | Connection, session, host, build coherence, ping, reload, diagnostics |
| `sv_describe` | List capabilities, or fetch one action's schema just in time |
| `sv_query` | One bounded read; returns data plus a `contextId` |
| `sv_command` | One guarded write inside one SynthV Undo boundary |
| `sv_ui` | Selection, viewport, clipboard, dialogs, snapping, coordinates, playback |
| `sv_review` | Optional native side-panel runtime status (read-only) |

`sv_query` and `sv_command` take `action` + `args`. Action names are listed in
`references/actions.md`; call `sv_describe` for an unfamiliar one rather than
guessing its arguments.

## 2. The read → write loop

```
sv_query { action: "get_phrase_context", args: {...}, contextMode: "writeIntent" }
        → data + contextId
sv_command { action: "edit_notes", args: {...}, contextId }
        → outcome
```

Rules that matter:

- Query **only the target you intend to write**, with
  `contextMode: "writeIntent"`. A `readOnly` context cannot authorize a write.
- Reuse the `contextId` from that read. Do not carry one across turns.
- Indices are **1-based** at the protocol boundary.
- On any `STALE_*` or `UNKNOWN_CONTEXT` result, read again deliberately. Never
  auto-retry the old payload.
- One logical command produces one SynthV Undo record. Only act on undo when a
  result reports `undoRequired: true`.

## 3. Data structures

Time is in **blicks**: 1 quarter note = 705,600,000. Pitch is a MIDI integer
(60 = C4).

A note:

| Field | Type | Meaning |
|---|---|---|
| `onset` | int (blick) | Start, local to its Group |
| `duration` | int (blick) | Length |
| `pitch` | int | MIDI note |
| `lyrics` | string | Lyric text |
| `phonemes` | string | Phoneme override; empty means automatic |
| `detune` | int | Fine tune in cents |
| `musicalType` | string | `singing` or `rap` |
| `noteIndex` | int | 1-based position in the Group |
| `fingerprint` | string | Guard value; required for edits and deletes |
| `absoluteOnset` / `absolutePitch` | int | Same values with the Reference's offsets applied |

An automation curve:

```json
{
  "parameter": "pitchDelta",
  "interpolation": "cubic",
  "points": [{ "position": 3528000000, "value": -0.5 }]
}
```

Parameter names are `pitchDelta`, `vibratoEnv`, `loudness`, `tension`,
`breathiness`, `voicing`, `gender`, `toneShift`. Read `definition.range` from
`get_automation` before writing values; ranges differ per parameter.

These names and units match the SV Harmony API's `.svp`-mirroring export. Only
the point representation differs — see [harmony-alignment](../../docs/harmony-alignment.md)
for the conversion.

## 4. Vocal Modes need a human handoff

The official scripting API cannot read the current Vocal identity, and cannot
enumerate singing styles that still hold only their default values. An empty
Vocal Mode result does not mean the singer has none.

Before any Vocal Mode work, ask the user to select the Note Group, select or
assign its Vocal, and then either send a screenshot of the complete singing
style panel or type every style name exactly as shown. Do not guess names. Ask
again after the Vocal changes; a previous Vocal's list does not carry over.

The API also cannot select or read the voice/database identity itself. Ask the
user to choose the voicebank in SynthV. Once it is selected, `copy_group_voice`
can copy documented Voice parameters and Vocal Modes from another Group, but it
does not change or name the voicebank.

## 5. Disabled capabilities

These fail with `EXPERIMENTAL_CAPABILITY_DISABLED` after reproducible SynthV
2.2.1 native crashes. Do not plan around them:

- `clone_note_group`, `clone_track`, `clone_track_shell`, `create_harmony_track`
- `apply_transaction`, `rollback_transaction`
- `clone_group_reference` with `cloneIntent: "isolated"` — linked clone works

## 6. Errors

| Result | What it means | Do |
|---|---|---|
| `STALE_*` | The target changed since the read | Read that target again |
| `SYNTHV_SESSION_CHANGED`, `CONTEXT_NOT_FOUND` | Contexts were cleared | Read again; never reuse the old context |
| `SHARED_GROUP_WRITE` | The Group content is shared by several References | Get explicit all-reference intent, or isolate first |
| `QUERY_RESPONSE_BUDGET_EXCEEDED` | The read was too large | Narrower range, smaller page, or fewer `include` fields |
| `HOST_POSTCONDITION_FAILED` | The host did not keep the requested change | If `undoRequired`, one Undo, then read again |
| `BUILD_MISMATCH`, `PROTOCOL_MISMATCH` | Node and Lua components disagree | Reinstall the whole component set and restart the Bridge |

## 7. Working with the user

- Ask only for what the current request is missing: the target, the intended
  effect, anything that must not change, and Vocal Mode names when relevant.
- Suggest saving a working copy before the first write of a session.
- Show a small, reviewable plan before writing. Do not print raw MCP payloads.
- Do not modify anything outside the stated target — not lyrics, not points
  outside the range, not other Groups.
- Artistic intent belongs to the user. The bridge applies explicit values; it
  does not decide how a phrase should sound.

## References

- `references/actions.md` — the full action catalog by tool
- `references/sv-api.md` — Synthesizer V scripting API reference
