# Agent / MCP Responsibility Boundaries

[English](responsibility-boundaries.md) |
[简体中文](responsibility-boundaries_cn.md)

The Bridge separates musical judgment from deterministic execution. The Agent
decides **why, where, and how much** to change. The MCP and Lua layers make that
explicit decision compact, current, validated, and undoable. SynthV stores the
result, and the user makes the final listening decision.

## Responsibility table

| Work | Owner | Reason |
|---|---|---|
| Understand user intent, lyric emotion, and singing style | Agent | Requires language and musical-semantic judgment |
| Decide which words to strengthen, soften, lengthen, or connect with pitch transitions | Agent | This is an artistic decision |
| Ask for the current Vocal and every Vocal Mode name | Agent + user | The official API cannot read Vocal identity or enumerate untouched default-only Vocal Modes |
| Decide whether to tune a short phrase or a larger scope | Agent | Depends on the goal, review cost, and token budget |
| Convert terms such as warm, restrained, or bright into explicit parameters | Agent | The Bridge must not interpret artistic language |
| Choose a fresh target scope and explicit numeric batch transform | Agent | Target selection and musical values belong to the current task |
| Provide current Group, note, Voice, and automation data | Lua Bridge | SynthV's live object model is authoritative |
| Cache and expand `contextId` and Guard data | TypeScript MCP | Avoids repeating large fingerprints while preserving stale-write protection |
| Project compact reads and minimal write acknowledgements | TypeScript MCP | Keeps irrelevant host data out of the model context |
| Detect SynthV restart or Bridge reload | TypeScript MCP | Old Context and Guard data must be invalidated before another write |
| Validate request structure, routing, indices, and stable protocol ranges | TypeScript MCP | Rejects malformed work before file IPC |
| Read the current Automation `definition.range` | Lua Bridge | The range can vary with the host, voice, and parameter |
| Expand deterministic note transforms and other batch mechanics | Lua Bridge | Mechanical calculations should be centralized and reproducible |
| Validate fingerprints and the complete prepared batch | Lua Bridge | Prevents overwriting user edits or partially applying invalid work |
| Create one undo record and verify host postconditions | Lua Bridge + SynthV | Provides one recovery boundary and avoids false success |
| Save, audition, undo, and approve the final result | User + SynthV | The user is the final artistic authority |

## Enforced layer boundaries

### Agent

The Agent may analyze lyrics, propose phrasing, choose exact note/phoneme/
automation targets, and provide explicit values. It must not guess a Vocal or
untouched Vocal Mode names. It reads only the intended target, prefers one
related batch, and rereads after stale-state or session-change errors.

### TypeScript MCP

The MCP layer owns schemas, action categories, compact projections,
`contextId`/Guard expansion, session invalidation, and minimal acknowledgements.
It does not choose notes, infer emotion, generate Vocal Mode names, or silently
adjust requested musical values.

### Lua executor

The Lua layer reads authoritative SynthV objects, uses current host capability
data, expands deterministic operations, validates every target and resulting
value, and reaches `Project:newUndoRecord()` only after complete preflight.
Automation point writes fail closed if the same fresh read does not expose a
valid `definition.range`. The executor verifies supported postconditions after
the write.

### SynthV and user

SynthV is the project-state authority. The user selects the intended Group and
Vocal, provides otherwise unreadable Vocal Mode names, listens to previews,
decides whether the result fits the song, and uses SynthV Undo when needed.

## Batch-operation rule

Add a batch action only when its behavior is mechanical, deterministic,
bounded, previewable, and completely validatable before one undo record.
`transform_notes` qualifies because it applies explicit numeric onset,
duration, and semitone operations. Commands such as `make_emotional` or
`tune_whole_song` do not qualify: they hide artistic decisions and make
failures difficult to review.

For a fresh phrase Context, MCP v2 can apply the same deterministic transform
without repeating every note index:

```json
{
  "action": "transform_notes",
  "contextId": "<fresh phrase context>",
  "args": {
    "target": "contextNotes",
    "transform": {
      "onsetOffsetSeconds": 2
    }
  }
}
```

The TypeScript layer expands exactly the guarded notes from that Context. Lua
then converts through SynthV's current time axis, validates every result,
applies one undo record, and verifies the retained note values. Note durations
remain in blicks when only `onsetOffsetSeconds` is supplied.
