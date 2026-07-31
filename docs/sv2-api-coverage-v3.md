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

## Machine-checkable inventory

The JSON block below freezes every class and method listed by the official
index generated on 2025-10-09. Methods are grouped as `semantic`, `internal`,
or `intentionallyUnexposed`. API omissions are capabilities rather than
methods, so they are listed separately. The coverage checker joins every
semantic write to its live `V3CommandPolicy` and rejects missing/duplicate
methods, missing Actions, aggregate mismatches, blank evidence, or unknown
real-host status.

<!-- SV2_API_INVENTORY_START -->
```json
{
  "officialBaseline": "https://resource.dreamtonics.com/scripting/index.html (generated 2025-10-09)",
  "classes": [
    {
      "name": "ArrangementSelectionState",
      "semantic": ["clearAll", "clearGroups", "getSelectedGroups", "hasSelectedContent", "hasSelectedGroups", "hasUnfinishedEdits", "selectGroup", "unselectGroup"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged", "registerClearCallback", "registerSelectionCallback"],
      "intentionallyUnexposed": []
    },
    {
      "name": "ArrangementView",
      "semantic": ["getNavigation", "getSelection"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": []
    },
    {
      "name": "Automation",
      "semantic": ["add", "get", "getAllPoints", "getDefinition", "getInterpolationMethod", "getLinear", "getPoints", "getType", "remove", "removeAll", "simplify"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "CoordinateSystem",
      "semantic": ["getTimePxPerUnit", "getTimeViewRange", "getValuePxPerUnit", "getValueViewRange", "setTimeLeft", "setTimeRight", "setTimeScale", "setValueCenter", "snap", "t2x", "v2y", "x2t", "y2v"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": []
    },
    {
      "name": "GroupSelection",
      "semantic": ["clearGroups", "getSelectedGroups", "hasSelectedGroups", "selectGroup", "unselectGroup"],
      "internal": [],
      "intentionallyUnexposed": []
    },
    {
      "name": "MainEditorView",
      "semantic": ["getCurrentGroup", "getCurrentTrack", "getNavigation", "getSelection"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": []
    },
    {
      "name": "NestedObject",
      "semantic": [],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": []
    },
    {
      "name": "Note",
      "semantic": ["getAttributes", "getDetune", "getDuration", "getEnd", "getLanguageOverride", "getLyrics", "getMusicalType", "getOnset", "getPhonemes", "getPitch", "getPitchAutoMode", "getRapAccent", "getRetakes", "setAttributes", "setDetune", "setDuration", "setLanguageOverride", "setLyrics", "setMusicalType", "setOnset", "setPhonemes", "setPitch", "setPitchAutoMode", "setRapAccent", "setTimeRange"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "NoteGroup",
      "semantic": ["addNote", "addPitchControl", "getName", "getNote", "getNumNotes", "getNumPitchControls", "getParameter", "getPitchControl", "getUUID", "removeNote", "removePitchControl", "setName"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "NoteGroupReference",
      "semantic": ["getDuration", "getEnd", "getOnset", "getPitchOffset", "getTarget", "getTimeOffset", "getVoice", "isInstrumental", "isMain", "isMuted", "setMuted", "setPitchOffset", "setTarget", "setTimeOffset", "setTimeRange", "setVoice"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "PitchControlCurve",
      "semantic": ["getPitch", "getPoints", "getPosition", "getValueAt", "setPitch", "setPoints", "setPosition"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "PitchControlPoint",
      "semantic": ["getPitch", "getPosition", "setPitch", "setPosition"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "PlaybackControl",
      "semantic": ["getPlayhead", "getStatus", "loop", "pause", "play", "seek", "stop"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": []
    },
    {
      "name": "Project",
      "semantic": ["addNoteGroup", "addTrack", "getDuration", "getFileName", "getNoteGroup", "getNumNoteGroupsInLibrary", "getNumTracks", "getTimeAxis", "getTrack", "removeNoteGroup", "removeTrack"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged", "newUndoRecord"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "RetakeList",
      "semantic": ["deleteTake", "generateTake", "getNumTakes", "setActiveTake"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "SV",
      "semantic": ["blackKey", "blick2Quarter", "blick2Seconds", "blickRoundDiv", "blickRoundTo", "freq2Pitch", "getArrangement", "getComputedAttributesForGroup", "getComputedPitchForGroup", "getHostClipboard", "getHostInfo", "getMainEditor", "getPhonemesForGroup", "getPlayback", "getProject", "pitch2freq", "quarter2Blick", "seconds2Blick", "setHostClipboard", "showCustomDialog", "showCustomDialogAsync", "showInputBox", "showInputBoxAsync", "showMessageBox", "showMessageBoxAsync", "showOkCancelBox", "showOkCancelBoxAsync", "showYesNoCancelBox", "showYesNoCancelBoxAsync"],
      "internal": ["T", "create", "finish", "print", "refreshSidePanel", "setTimeout"],
      "intentionallyUnexposed": []
    },
    {
      "name": "ScriptableNestedObject",
      "semantic": [],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "SelectionStateBase",
      "semantic": ["clearAll", "hasSelectedContent", "hasUnfinishedEdits"],
      "internal": ["registerClearCallback", "registerSelectionCallback"],
      "intentionallyUnexposed": []
    },
    {
      "name": "TimeAxis",
      "semantic": ["addMeasureMark", "addTempoMark", "getAllMeasureMarks", "getAllTempoMarks", "getBlickFromSeconds", "getMeasureAt", "getMeasureMarkAt", "getMeasureMarkAtBlick", "getSecondsFromBlick", "getTempoMarkAt", "removeMeasureMark", "removeTempoMark"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "Track",
      "semantic": ["addGroupReference", "getDisplayColor", "getDisplayOrder", "getDuration", "getGroupReference", "getMixer", "getName", "getNumGroups", "isBounced", "removeGroupReference", "setBounced", "setDisplayColor", "setName"],
      "internal": ["clone", "getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "TrackInnerSelectionState",
      "semantic": ["clearAll", "clearGroups", "clearNotes", "clearPitchControls", "getSelectedGroups", "getSelectedNotes", "getSelectedPitchControls", "getSelectedPoints", "hasSelectedContent", "hasSelectedGroups", "hasSelectedNotes", "hasSelectedPitchControls", "hasUnfinishedEdits", "selectGroup", "selectNote", "selectPitchControls", "selectPoints", "unselectGroup", "unselectNote", "unselectPitchControls", "unselectPoints"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged", "registerClearCallback", "registerSelectionCallback"],
      "intentionallyUnexposed": []
    },
    {
      "name": "TrackMixer",
      "semantic": ["getGainDecibel", "getPan", "isMuted", "isSolo", "setGainDecibel", "setMuted", "setPan", "setSolo"],
      "internal": ["getIndexInParent", "getParent", "isMemoryManaged"],
      "intentionallyUnexposed": ["clearScriptData", "getScriptData", "getScriptDataKeys", "hasScriptData", "removeScriptData", "setScriptData"]
    },
    {
      "name": "WidgetValue",
      "semantic": [],
      "internal": ["getEnabled", "getValue", "setEnabled", "setValue", "setValueChangeCallback"],
      "intentionallyUnexposed": []
    }
  ],
  "unavailableCapabilities": [
    "current Vocal display name or database identity",
    "enumeration of untouched default Vocal Mode names",
    "active Retake getter and Take content enumeration",
    "Track effect-chain objects and parameters",
    "instrumental source file path",
    "project save and audio render/export"
  ],
  "actionGroups": {
    "verifiedReads": ["convert_pitch", "get_project_info", "inspect_score_file", "get_time_axis", "convert_time", "list_tracks", "list_note_groups", "get_track_notes", "get_group_voice", "get_note_phoneme_data", "get_phrase_context", "get_computed_group_data", "get_note_retakes", "get_pitch_controls", "get_automation", "sample_automation", "get_track_mixer"],
    "sampledUi": ["host_clipboard", "show_dialog", "get_selection", "set_selection", "get_editor_view", "set_editor_view", "snap_position", "convert_editor_coordinates", "playback"],
    "writes": [
      {"action":"set_time_axis","aggregates":["ProjectTimeline"],"preflight":"fresh time-axis Guard and complete mark validation","postcondition":"hostReadback","automated":"policy, protocol and Fake Host","realHost":"pending"},
      {"action":"create_note_group","aggregates":["GroupContent"],"preflight":"complete note/control payload and host capability validation","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"sampled"},
      {"action":"clone_note_group","aggregates":["GroupContent"],"preflight":"fresh source snapshot and clone capability validation","postcondition":"hostReadback","automated":"clone ownership Fake Host","realHost":"sampled"},
      {"action":"delete_note_group","aggregates":["GroupContent"],"preflight":"fresh library Guard and shared-reference policy","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"pending"},
      {"action":"add_group_reference","aggregates":["GroupReference"],"preflight":"fresh Track and library Group guards","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"sampled"},
      {"action":"clone_group_reference","aggregates":["GroupContent","GroupReference"],"preflight":"explicit linked or isolated intent and source snapshot","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"verified"},
      {"action":"add_track","aggregates":["TrackShell"],"preflight":"complete Track payload","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"sampled"},
      {"action":"update_track","aggregates":["TrackShell"],"preflight":"fresh Track Guard","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"sampled"},
      {"action":"clone_track","aggregates":["GroupContent","GroupReference","TrackShell"],"preflight":"fresh Track Guard, explicit isolated policy and source snapshots","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"verified"},
      {"action":"clone_track_shell","aggregates":["TrackShell"],"preflight":"fresh Track Guard and empty-shell plan","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"verified"},
      {"action":"delete_track","aggregates":["TrackShell"],"preflight":"fresh Track Guard and final-Track refusal","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"update_group","aggregates":["GroupContent","GroupReference"],"preflight":"fresh content/reference guards and sharing policy","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"sampled"},
      {"action":"set_group_voice","aggregates":["GroupReference"],"preflight":"fresh Reference Guard and dynamic range validation","postcondition":"hostReadback","automated":"range and Fake Host","realHost":"sampled"},
      {"action":"apply_group_tuning","aggregates":["GroupContent","GroupReference"],"preflight":"one complete Voice/note/Automation/Smart Pitch effect plan","postcondition":"hostReadback","automated":"aggregate Fake Host matrix","realHost":"verified"},
      {"action":"delete_group_reference","aggregates":["GroupReference"],"preflight":"fresh Reference Guard","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"pending"},
      {"action":"import_monophonic_score","aggregates":["GroupContent"],"preflight":"bounded local snapshot, rights confirmation and shared policy","postcondition":"hostReadback","automated":"score import contracts and Fake Host","realHost":"pending"},
      {"action":"add_notes","aggregates":["GroupContent"],"preflight":"complete bounded note plan and shared policy","postcondition":"hostReadback","automated":"note Fake Host matrix","realHost":"verified"},
      {"action":"edit_notes","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and shared policy","postcondition":"hostReadback","automated":"guarded note Fake Host matrix","realHost":"verified"},
      {"action":"transform_notes","aggregates":["GroupContent"],"preflight":"fresh scoped note Guards, time axis and geometry validation","postcondition":"hostReadback","automated":"transform Fake Host matrix","realHost":"verified"},
      {"action":"set_note_phoneme_properties","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and phoneme ranges","postcondition":"hostReadback","automated":"phoneme contract and Fake Host","realHost":"pending"},
      {"action":"generate_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and host capability","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"pending"},
      {"action":"activate_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and Take bounds","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"pending"},
      {"action":"add_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh shared policy and complete bounded controls","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"edit_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh per-control Guards and shared policy","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"simplify_automation","aggregates":["GroupContent"],"preflight":"fresh curve Guard, host definition range and shared policy","postcondition":"hostReadback","automated":"Automation Fake Host matrix","realHost":"verified"},
      {"action":"set_automation_points","aggregates":["GroupContent"],"preflight":"fresh curve Guard, host definition range and complete point plan","postcondition":"hostReadback","automated":"Automation Fake Host matrix","realHost":"verified"},
      {"action":"script_data","aggregates":["Metadata"],"preflight":"fresh target resolution and explicit metadata operation","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"pending"},
      {"action":"set_track_mixer","aggregates":["TrackShell"],"preflight":"fresh Track Guard and mixer ranges","postcondition":"hostReadback","automated":"Command Kernel and Fake Host","realHost":"verified"},
      {"action":"create_harmony_track","aggregates":["TrackShell"],"preflight":"fresh source Track and bounded harmony plan","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"pending"},
      {"action":"humanize_notes","aggregates":["GroupContent"],"preflight":"fresh note Guards and deterministic bounded transform","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"pending"},
      {"action":"apply_expression_preset","aggregates":["GroupContent"],"preflight":"fresh note/curve Guards and host ranges","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"pending"},
      {"action":"fit_lyrics","aggregates":["GroupContent"],"preflight":"fresh note Guards and exact lyric count","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"pending"},
      {"action":"delete_notes","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and shared policy","postcondition":"hostReadback","automated":"guarded delete Fake Host matrix","realHost":"verified"},
      {"action":"delete_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and Take bounds","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"pending"},
      {"action":"delete_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh per-control Guards and shared policy","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"clear_automation","aggregates":["GroupContent"],"preflight":"fresh curve Guard, closed range and shared policy","postcondition":"hostReadback","automated":"Automation endpoint Fake Host matrix","realHost":"verified"},
      {"action":"apply_transaction","aggregates":["Transaction"],"preflight":"all independent steps before Undo and dependent steps just in time","postcondition":"transactionSummary","automated":"transaction Fake Host matrix","realHost":"pending"},
      {"action":"rollback_transaction","aggregates":["Transaction"],"preflight":"stored reverse plan with fresh per-step guards","postcondition":"transactionSummary","automated":"transaction Fake Host matrix","realHost":"pending"}
    ]
  }
}
```
<!-- SV2_API_INVENTORY_END -->

## v3 Query action coverage

The Query policy registry is checked against the live `sv_describe` read
catalog. Adding or removing a public read Action without classifying it fails
the repository test suite.

| Query action | Projection strategy | Default bound / coverage |
|---|---|---|
| `convert_pitch` | fixed | Scalar conversion only |
| `get_project_info` | fixed | Compact project/current-editor summary |
| `inspect_score_file` | explicit bounded | Local preview limits and lane selection |
| `get_time_axis` | offset page | 128 tempo marks and 128 measure marks |
| `convert_time` | fixed | One supplied time value |
| `list_tracks` | offset page | 128 Tracks |
| `list_note_groups` | offset page | 128 library Groups |
| `get_track_notes` | offset page | 1 Group × 64 notes; explicit Group/Group page available |
| `get_group_voice` | fixed | One Group Reference |
| `get_note_phoneme_data` | offset page | 64 notes or explicit note/time scope |
| `get_phrase_context` | cursor page | 64 notes, opaque cursor, or explicit notes/ranges |
| `get_computed_group_data` | offset page | 64 note-derived entries; pitch frames are explicit |
| `get_note_retakes` | fixed | One note's bounded Retake metadata |
| `get_pitch_controls` | offset page | 64 Smart Pitch controls |
| `get_automation` | range summary | Point-free summary, or one explicit closed range |
| `sample_automation` | explicit bounded | Caller-supplied positions |
| `get_track_mixer` | fixed | One Track Mixer |

Every path performs one authoritative host read. Paging changes only the public
collection; full-state fingerprints required for OCC are computed before
projection and retained server-side. The shared projector measures every
public result and rejects an oversized unscoped default without echoing its
content.

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
