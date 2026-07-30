# Synthesizer V Studio 2 API Coverage Matrix

Status: coverage classification baseline for `0.2.0-alpha`

Source baseline: the
[official scripting index](https://resource.dreamtonics.com/scripting/index.html)
generated 2025-10-09. Every official class is classified below. `Semantic`
means an Agent-facing capability
behind the six v3 tools; `Internal` means Bridge runtime infrastructure;
`Hidden` means deliberately not exposed; `Gap` means a useful semantic
capability still awaiting a supported action or real-host certification.

This matrix records intended coverage, not a claim that every alpha action has
completed real SynthV acceptance.

| Official class | Semantic methods/capabilities | Internal or deliberately hidden | Alpha gaps/notes |
|---|---|---|---|
| `ArrangementSelectionState` | read/clear/select/unselect Groups | callbacks, parent/index, memory methods | Real-host selection callback behavior remains advisory |
| `ArrangementView` | arrangement selection and navigation | parent/index/memory methods | None at class boundary |
| `Automation` | add/get/getAllPoints/getPoints/remove/removeAll/simplify, definition and interpolation reads | clone and script-data methods | Closed-range removal is verified point-by-point |
| `CoordinateSystem` | read view ranges; set time/value viewport; coordinate conversions and snap | parent/index/memory methods | Value-axis coverage is host-capability gated |
| `GroupSelection` | read/clear/select/unselect Groups | legacy selection abstraction plumbing | Prefer concrete arrangement/main-editor states |
| `MainEditorView` | current Track/Group, selection, navigation | parent/index/memory methods | None at class boundary |
| `NestedObject` | none | parent/index/memory lifecycle only | Never crosses IPC |
| `Note` | read/write lyrics, phonemes, pitch, detune, onset/duration/range, language, musical type, rap accent, pitch mode, attributes, Retakes | clone and script-data methods | V1-only or voice-specific attributes fail closed |
| `NoteGroup` | add/remove/read Notes; add/remove/read Pitch Controls; parameters; UUID/name; isolated clone | script-data methods | All content writes enforce fresh sharing policy |
| `NoteGroupReference` | target, time/pitch offset, mute, range, Voice/Vocal Modes, main/instrumental state | clone used only inside explicit strategy; script-data methods | Official API cannot identify the Vocal by name |
| `PitchControlCurve` | read/write position, pitch and points; value sampling | clone and script-data methods | Write verification required |
| `PitchControlPoint` | read/write position and pitch | clone and script-data methods | Write verification required |
| `PlaybackControl` | play/pause/stop/seek/loop plus actual status/playhead readback | parent/index/memory methods | None at class boundary |
| `Project` | Tracks, library Groups, duration/file metadata, timeline; add/remove Track/Group | `newUndoRecord` is Command Kernel infrastructure; script-data methods hidden | Save/export/render are not provided by this API |
| `RetakeList` | count, generate, delete, set active Take | script-data methods | API has no active-Take getter or Take-content enumeration |
| `SV` | host/project/view/playback access; time/pitch conversion; computed pitch/phonemes/attributes; clipboard and dialogs | `create`, `finish`, `setTimeout`, `print`, localization and Sidebar refresh infrastructure | Async computed results are Reference-bound and short-lived |
| `ScriptableNestedObject` | none directly | common script-data and lifecycle methods | Project content is never used as Bridge metadata storage |
| `SelectionStateBase` | read/clear selection state | callbacks are dirty hints only | No callback is treated as a project change feed |
| `TimeAxis` | tempo/meter reads and edits; blick/seconds conversion | clone and script-data methods | All edits use a fresh time-axis Guard |
| `Track` | metadata, color, bounced state, duration, mixer, references; add/remove reference; explicit clone strategies | raw `clone` hidden behind linked/isolated/shell strategies; script-data methods | Display order has no official setter |
| `TrackInnerSelectionState` | read/clear/select/unselect Notes, Groups, Pitch Controls and points | callbacks, parent/index/memory methods | Real-host multi-kind selection acceptance remains sampled |
| `TrackMixer` | gain, pan, mute, solo read/write | script-data and lifecycle methods | First common Command Kernel write slice |
| `WidgetValue` | none through normal MCP | Sidebar widget state and callbacks | Sidebar remains optional |

## Methods intentionally not mirrored one-for-one

- `getParent`, `getIndexInParent`, and memory-management methods are used only
  while resolving a current host object.
- `clone()` is never exposed as a generic command because Reference clone and
  Note Group clone have different ownership semantics.
- `get/set/clear/removeScriptData` are not public Agent storage. The Bridge does
  not write protocol metadata into user projects.
- callback registration, `setTimeout`, `finish`, and Sidebar widget callbacks
  are runtime mechanics, not user editing capabilities.

## Official API omissions

The Bridge cannot safely expose what the official API does not provide:

- current Vocal display name or database identity;
- enumeration of untouched default Vocal Mode names;
- current active Retake getter or Retake internals;
- Track effect-chain objects and parameters;
- instrumental source file path;
- project save, audio render/export, and several GUI-only features.

These remain explicit user/UI handoffs. The Bridge does not parse `.svp` to
fill the gaps.

## Completion rule

Each Semantic entry is considered stable only after it has:

1. a v3 action schema;
2. a fresh-read/preflight/Undo/postcondition implementation when mutating;
3. a Fake Host or contract test;
4. a recorded real SynthV working-copy acceptance result.
