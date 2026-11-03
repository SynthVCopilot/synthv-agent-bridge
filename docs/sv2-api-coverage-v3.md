# Synthesizer V Studio 2 API Coverage Matrix

Status: coverage classification baseline for `0.2.0-alpha`, with a SynthV 2.3.0
runtime delta recorded on 2026-11-03

Source baseline: the
[official scripting index](https://resource.dreamtonics.com/scripting/index.html)
generated 2025-10-09. Every official class is classified below. `Semantic`
means an Agent-facing capability
behind the six v3 tools; `Internal` means Bridge runtime infrastructure;
`Hidden` means deliberately not exposed; `Gap` means a useful semantic
capability still awaiting a supported action or real-host certification.

This matrix records intended coverage, not a claim that every alpha action has
completed real SynthV acceptance.

## SynthV 2.3.0 runtime delta

SynthV Studio 2 Pro 2.3.0 (2026-11-02) did not update the official scripting
index: it is still the 2025-10-09 build and the release notes list no
scripting changes. Lua introspection of the 2.3.0 host on 2026-11-03 still
found new and changed members. They are recorded in `runtimeAdditions` and
`runtimeDeviations` below, separate from the frozen official baseline.

Runtime handling added for 2.3.0:

- `languageOverride` accepts `korean`, `spanish`, `french`, `german`, `italian`
  and `portuguese`, the identifiers used by SynthV's own 2.3.0 phoneme
  reference and voice catalog. The host stores any string, so this list is
  the only guard. The four languages new in 2.3.0 fail closed on older hosts.
- `phonesetOverride` reads and writes the 2.3.0 `phoneset` attribute key.
  Before this change, 2.3.0 reads returned `null` and writes failed preflight.
- `update_group` accepts `scale: {root, type}`, validated against
  `SV:scaleNotes()`/`SV:scaleTypes()` because `setScale` ignores bad input
  silently. Group reads include `scale`.
- `set_automation_points` accepts `interpolationMethod`
  (`linear`/`cosine`/`cubic`) in the same Undo record, with read-back.
- `get_track_mixer` returns read-only `fx` parameters.
- `add_notes` with `grouping=target` on a main Group is rejected before Undo,
  because 2.3.0 no longer allows notes in a Track's main Group.

Live acceptance on an untitled scratch project (no voice database loaded,
because the installed v201 voices were not listed by 2.3.0):

- Every Query and UI read worked.
- These writes all verified: note, phoneme, Automation, Group, Track, mixer,
  tempo, selection, viewport, playback loop and seek.
- `vf` and X-SAMPA phoneme strings are stored verbatim.
- Automation ranges now come from the host: `tension`, `breathiness` and
  `gender` are ±2, `loudness` is −48…24 and `toneShift` is ±800. They are read
  fresh from `getDefinition().range`, so no Runtime change was needed.
- Voice-dependent features (computed phonemes, Retakes, the language and
  X-SAMPA pickers) still need a v205 voice for acceptance.

Host stability on 2.3.0:

- `MainEditorView:setCurrentTrack(currentTrack)` crashed the host in 2 of 2
  runs (`0xc0000005`).
- The same access-violation offset also appeared once during a Bridge
  `add_notes` and once during `set_automation_points`. Three later complete
  write batteries (about 90 verified writes, with and without the Sidebar and
  with editor panels open) did not reproduce it. Treat it as an intermittent
  2.3.0 host fault.
- Scripts → Rescan stops a running Bridge. Restart it afterwards.
- 2.3.0 runs side-panel script timers only while the Scripts panel is
  visible, so a hidden Sidebar reports `stale`. Writes do not depend on it.

## Machine-checkable inventory

The JSON block below freezes every class and method listed by the official
index generated on 2025-10-09. Methods are grouped as `semantic`, `internal`,
or `intentionallyUnexposed`. API omissions are capabilities rather than
methods, so they are listed separately. Each `semanticEvidence.methodGroups`
entry lists exact official methods and their exact live Action mappings; the
checker requires their union to equal that class's `allSemantic` declaration.
The coverage checker joins every semantic write to its live
`V3CommandPolicy` and rejects missing/duplicate method evidence, missing
Actions, aggregate mismatches, blank evidence, or unknown real-host status.

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
  "semanticEvidence": [
    {
      "class": "ArrangementSelectionState",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["clearAll","clearGroups","selectGroup","unselectGroup"],"actions":["set_selection"]},
        {"methods":["getSelectedGroups","hasSelectedContent","hasSelectedGroups","hasUnfinishedEdits"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_selection", "set_selection"],
      "hostAdapter": "Lua Arrangement selection adapter",
      "preflight": "selection shape and current host view",
      "postcondition": "host selection reread",
      "automated": "UI schema and state-reread contracts",
      "realHost": "sampled"
    },
    {
      "class": "ArrangementView",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getNavigation"],"actions":["get_editor_view"]},
        {"methods":["getSelection"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_editor_view", "get_selection"],
      "hostAdapter": "Lua Arrangement view adapter",
      "preflight": "current host view resolution",
      "postcondition": "authoritative navigation or selection projection",
      "automated": "UI projection contracts",
      "realHost": "sampled"
    },
    {
      "class": "Automation",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["get","getAllPoints","getDefinition","getInterpolationMethod","getLinear","getPoints","getType"],"actions":["get_automation","sample_automation"]},
        {"methods":["add"],"actions":["set_automation_points","apply_group_tuning","apply_expression_preset"]},
        {"methods":["remove","removeAll"],"actions":["set_automation_points","clear_automation","apply_group_tuning","apply_expression_preset"]},
        {"methods":["simplify"],"actions":["simplify_automation"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_automation", "sample_automation", "set_automation_points", "clear_automation", "simplify_automation", "apply_group_tuning", "apply_expression_preset"],
      "hostAdapter": "Lua Automation definition/range adapter",
      "preflight": "fresh curve Guard, shared ownership and current definition.range",
      "postcondition": "closed-range point-by-point host reread",
      "automated": "Automation endpoint, no-op, range and aggregate Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "CoordinateSystem",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getTimePxPerUnit","getTimeViewRange","getValuePxPerUnit","getValueViewRange"],"actions":["get_editor_view"]},
        {"methods":["setTimeLeft","setTimeRight","setTimeScale","setValueCenter"],"actions":["set_editor_view"]},
        {"methods":["snap"],"actions":["snap_position"]},
        {"methods":["t2x","v2y","x2t","y2v"],"actions":["convert_editor_coordinates"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_editor_view", "set_editor_view", "snap_position", "convert_editor_coordinates"],
      "hostAdapter": "Lua coordinate-system adapter",
      "preflight": "finite coordinate and view arguments",
      "postcondition": "resulting navigation or converted scalar projection",
      "automated": "UI coordinate schema and projection contracts",
      "realHost": "sampled"
    },
    {
      "class": "GroupSelection",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["clearGroups","selectGroup","unselectGroup"],"actions":["set_selection"]},
        {"methods":["getSelectedGroups","hasSelectedGroups"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_selection", "set_selection"],
      "hostAdapter": "Lua Group selection adapter",
      "preflight": "bounded target locators",
      "postcondition": "host selection reread",
      "automated": "selection state contracts",
      "realHost": "sampled"
    },
    {
      "class": "MainEditorView",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getCurrentGroup","getCurrentTrack"],"actions":["get_project_info"]},
        {"methods":["getNavigation"],"actions":["get_editor_view"]},
        {"methods":["getSelection"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_query", "sv_ui"],
      "actions": ["get_project_info", "get_editor_view", "get_selection"],
      "hostAdapter": "Lua main-editor adapter",
      "preflight": "current editor availability",
      "postcondition": "authoritative current Group, Track, navigation or selection projection",
      "automated": "project/editor projection contracts",
      "realHost": "sampled"
    },
    {
      "class": "Note",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getAttributes","getDetune","getDuration","getEnd","getLanguageOverride","getLyrics","getMusicalType","getOnset","getPhonemes","getPitch","getPitchAutoMode","getRapAccent"],"actions":["get_track_notes","get_note_phoneme_data","get_phrase_context","get_computed_group_data"]},
        {"methods":["getRetakes"],"actions":["get_note_retakes"]},
        {"methods":["setAttributes","setDetune","setDuration","setLanguageOverride","setLyrics","setMusicalType","setOnset","setPhonemes","setPitch","setPitchAutoMode","setRapAccent","setTimeRange"],"actions":["add_notes","edit_notes","transform_notes","set_note_phoneme_properties","humanize_notes","fit_lyrics","apply_group_tuning"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_track_notes", "get_note_phoneme_data", "get_phrase_context", "get_computed_group_data", "get_note_retakes", "add_notes", "edit_notes", "transform_notes", "set_note_phoneme_properties", "generate_note_retake", "activate_note_retake", "delete_note_retake", "delete_notes", "humanize_notes", "fit_lyrics", "apply_group_tuning"],
      "hostAdapter": "Lua guarded Note adapter",
      "preflight": "fresh per-note Guard, ranges, geometry and shared ownership",
      "postcondition": "complete ordered Group note-content reread",
      "automated": "guarded note, transform, deletion-order and aggregate Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "NoteGroup",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getName","getNote","getNumNotes","getNumPitchControls","getParameter","getPitchControl","getUUID"],"actions":["list_note_groups","get_track_notes","get_pitch_controls","get_automation"]},
        {"methods":["addNote","removeNote"],"actions":["create_note_group","clone_note_group","add_notes","delete_notes","apply_group_tuning"]},
        {"methods":["addPitchControl","removePitchControl"],"actions":["create_note_group","add_pitch_controls","edit_pitch_controls","delete_pitch_controls","apply_group_tuning"]},
        {"methods":["setName"],"actions":["create_note_group","update_group"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["list_note_groups", "get_track_notes", "get_pitch_controls", "get_automation", "create_note_group", "clone_note_group", "delete_note_group", "update_group", "add_notes", "delete_notes", "add_pitch_controls", "edit_pitch_controls", "delete_pitch_controls", "apply_group_tuning"],
      "hostAdapter": "Lua GroupContent ownership adapter",
      "preflight": "fresh Group UUID, reference count, Guards and clone intent",
      "postcondition": "Group UUID, content and source-unchanged host reread",
      "automated": "CLN, shared-ownership, note, Automation and Smart Pitch Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "NoteGroupReference",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getDuration","getEnd","getOnset","getPitchOffset","getTarget","getTimeOffset","getVoice","isInstrumental","isMain","isMuted"],"actions":["list_tracks","get_group_voice","get_phrase_context","copy_group_voice"]},
        {"methods":["setMuted","setPitchOffset","setTarget","setTimeOffset","setTimeRange","setVoice"],"actions":["add_group_reference","clone_group_reference","update_group","set_group_voice","copy_group_voice","apply_group_tuning"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["list_tracks", "get_group_voice", "get_phrase_context", "add_group_reference", "clone_group_reference", "delete_group_reference", "update_group", "set_group_voice", "copy_group_voice", "apply_group_tuning"],
      "hostAdapter": "Lua GroupReference adapter",
      "preflight": "fresh Reference Guard and explicit linked/isolated ownership",
      "postcondition": "target association and reference-local state host reread",
      "automated": "reference policy and CLN Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "PitchControlCurve",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getPitch","getPoints","getPosition","getValueAt"],"actions":["get_pitch_controls"]},
        {"methods":["setPitch","setPoints","setPosition"],"actions":["add_pitch_controls","edit_pitch_controls","apply_group_tuning"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_pitch_controls", "add_pitch_controls", "edit_pitch_controls", "delete_pitch_controls", "apply_group_tuning"],
      "hostAdapter": "Lua Smart Pitch curve adapter",
      "preflight": "fresh per-control Guard and complete bounded curve",
      "postcondition": "complete Group Smart Pitch content reread",
      "automated": "Smart Pitch no-op, mutation and aggregate Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "PitchControlPoint",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getPitch","getPosition"],"actions":["get_pitch_controls"]},
        {"methods":["setPitch","setPosition"],"actions":["add_pitch_controls","edit_pitch_controls","apply_group_tuning"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_pitch_controls", "add_pitch_controls", "edit_pitch_controls", "delete_pitch_controls", "apply_group_tuning"],
      "hostAdapter": "Lua Smart Pitch point adapter",
      "preflight": "fresh per-control Guard and bounded point values",
      "postcondition": "complete Group Smart Pitch content reread",
      "automated": "Smart Pitch no-op, mutation and aggregate Fake Host matrix",
      "realHost": "sampled"
    },
    {
      "class": "PlaybackControl",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getPlayhead","getStatus"],"actions":["playback"]},
        {"methods":["loop","pause","play","seek","stop"],"actions":["playback"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["playback"],
      "hostAdapter": "Lua playback adapter",
      "preflight": "finite playhead and loop arguments",
      "postcondition": "current status and playhead reread",
      "automated": "playback schema and state contracts",
      "realHost": "sampled"
    },
    {
      "class": "Project",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getDuration","getFileName"],"actions":["get_project_info"]},
        {"methods":["getNoteGroup","getNumNoteGroupsInLibrary"],"actions":["list_note_groups"]},
        {"methods":["getNumTracks","getTrack"],"actions":["list_tracks"]},
        {"methods":["getTimeAxis"],"actions":["get_time_axis","convert_time"]},
        {"methods":["addNoteGroup","removeNoteGroup"],"actions":["create_note_group","delete_note_group"]},
        {"methods":["addTrack","removeTrack"],"actions":["add_track","delete_track"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_project_info", "get_time_axis", "convert_time", "list_tracks", "list_note_groups", "set_time_axis", "create_note_group", "delete_note_group", "add_track", "delete_track"],
      "hostAdapter": "Lua Project aggregate adapter",
      "preflight": "fresh project/session, collection Guards and final-Track safety",
      "postcondition": "authoritative collection, timeline or target reread",
      "automated": "project collections, session invalidation and destructive command contracts",
      "realHost": "sampled"
    },
    {
      "class": "RetakeList",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getNumTakes"],"actions":["get_note_retakes"]},
        {"methods":["generateTake"],"actions":["generate_note_retake"]},
        {"methods":["setActiveTake"],"actions":["activate_note_retake"]},
        {"methods":["deleteTake"],"actions":["delete_note_retake"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_note_retakes", "generate_note_retake", "activate_note_retake", "delete_note_retake"],
      "hostAdapter": "Lua Retake capability adapter",
      "preflight": "fresh note Guard, capability and Take bounds",
      "postcondition": "available Retake metadata reread",
      "automated": "Retake schema, capability and Fake Host contracts",
      "realHost": "sampled"
    },
    {
      "class": "SV",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["blackKey","freq2Pitch","pitch2freq"],"actions":["convert_pitch"]},
        {"methods":["blick2Quarter","blick2Seconds","blickRoundDiv","blickRoundTo","quarter2Blick","seconds2Blick"],"actions":["convert_time"]},
        {"methods":["getArrangement","getMainEditor","getProject"],"actions":["get_project_info","get_selection","get_editor_view"]},
        {"methods":["getComputedAttributesForGroup","getComputedPitchForGroup"],"actions":["get_computed_group_data","get_phrase_context"]},
        {"methods":["getPhonemesForGroup"],"actions":["get_note_phoneme_data","get_phrase_context"]},
        {"methods":["getHostClipboard","setHostClipboard"],"actions":["host_clipboard"]},
        {"methods":["getHostInfo"],"actions":["get_project_info"]},
        {"methods":["getPlayback"],"actions":["playback"]},
        {"methods":["showCustomDialog","showCustomDialogAsync","showInputBox","showInputBoxAsync","showMessageBox","showMessageBoxAsync","showOkCancelBox","showOkCancelBoxAsync","showYesNoCancelBox","showYesNoCancelBoxAsync"],"actions":["show_dialog"]}
      ],
      "publicTools": ["sv_status", "sv_query", "sv_ui"],
      "actions": ["convert_pitch", "convert_time", "get_project_info", "get_computed_group_data", "get_note_phoneme_data", "get_phrase_context", "host_clipboard", "show_dialog", "get_selection", "get_editor_view", "playback"],
      "hostAdapter": "Lua SV runtime anti-corruption adapter",
      "preflight": "host capability, finite scalar and current Reference dependencies",
      "postcondition": "authoritative scalar, computed result or UI state projection",
      "automated": "conversion, computed-data retry, status and UI contracts",
      "realHost": "sampled"
    },
    {
      "class": "SelectionStateBase",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["clearAll"],"actions":["set_selection"]},
        {"methods":["hasSelectedContent","hasUnfinishedEdits"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_selection", "set_selection"],
      "hostAdapter": "Lua selection-state adapter",
      "preflight": "current view and bounded selection target",
      "postcondition": "host selection reread",
      "automated": "selection contracts; callbacks remain internal dirty hints",
      "realHost": "sampled"
    },
    {
      "class": "TimeAxis",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getAllMeasureMarks","getAllTempoMarks","getMeasureAt","getMeasureMarkAt","getMeasureMarkAtBlick","getTempoMarkAt"],"actions":["get_time_axis"]},
        {"methods":["getBlickFromSeconds","getSecondsFromBlick"],"actions":["convert_time","transform_notes"]},
        {"methods":["addMeasureMark","addTempoMark","removeMeasureMark","removeTempoMark"],"actions":["set_time_axis"]}
      ],
      "publicTools": ["sv_query", "sv_command", "sv_ui"],
      "actions": ["get_time_axis", "convert_time", "set_time_axis", "transform_notes", "snap_position"],
      "hostAdapter": "Lua ProjectTimeline adapter",
      "preflight": "fresh time-axis Guard and complete mark/range validation",
      "postcondition": "tempo/measure mark or conversion host reread",
      "automated": "time-axis pagination, conversion and policy contracts",
      "realHost": "sampled"
    },
    {
      "class": "Track",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getDisplayColor","getDisplayOrder","getDuration","getGroupReference","getName","getNumGroups","isBounced"],"actions":["list_tracks","get_track_notes"]},
        {"methods":["getMixer"],"actions":["get_track_mixer"]},
        {"methods":["addGroupReference","removeGroupReference"],"actions":["add_group_reference","delete_group_reference","clone_group_reference"]},
        {"methods":["setBounced","setDisplayColor","setName"],"actions":["add_track","update_track","clone_track","clone_track_shell"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["list_tracks", "get_track_notes", "get_track_mixer", "add_track", "update_track", "clone_track", "clone_track_shell", "delete_track", "add_group_reference", "clone_group_reference", "delete_group_reference", "set_track_mixer"],
      "hostAdapter": "Lua TrackShell adapter",
      "preflight": "fresh Track Guard, explicit clone mode and source snapshots",
      "postcondition": "Track summary, reference order and source-unchanged reread",
      "automated": "Track collection, CLN and mixer Command Kernel matrix",
      "realHost": "sampled"
    },
    {
      "class": "TrackInnerSelectionState",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["clearAll","clearGroups","clearNotes","clearPitchControls","selectGroup","selectNote","selectPitchControls","selectPoints","unselectGroup","unselectNote","unselectPitchControls","unselectPoints"],"actions":["set_selection"]},
        {"methods":["getSelectedGroups","getSelectedNotes","getSelectedPitchControls","getSelectedPoints","hasSelectedContent","hasSelectedGroups","hasSelectedNotes","hasSelectedPitchControls","hasUnfinishedEdits"],"actions":["get_selection"]}
      ],
      "publicTools": ["sv_ui"],
      "actions": ["get_selection", "set_selection"],
      "hostAdapter": "Lua track-inner selection adapter",
      "preflight": "bounded Group, Note, point and Pitch Control locators",
      "postcondition": "host selection reread",
      "automated": "selection schema and state-reread contracts",
      "realHost": "sampled"
    },
    {
      "class": "TrackMixer",
      "methods": "allSemantic",
      "methodGroups": [
        {"methods":["getGainDecibel","getPan","isMuted","isSolo"],"actions":["get_track_mixer"]},
        {"methods":["setGainDecibel","setMuted","setPan","setSolo"],"actions":["set_track_mixer"]}
      ],
      "publicTools": ["sv_query", "sv_command"],
      "actions": ["get_track_mixer", "set_track_mixer"],
      "hostAdapter": "Lua Track Mixer adapter",
      "preflight": "fresh Track Guard and mixer range validation",
      "postcondition": "complete mixer host reread",
      "automated": "Command Kernel no-op, stage, failure and budget matrix",
      "realHost": "sampled"
    }
  ],
  "unavailableCapabilities": [
    "current Vocal display name or database identity",
    "enumeration of untouched default Vocal Mode names",
    "active Retake getter and Take content enumeration",
    "documented Track effect parameter ranges (2.3.0 exposes undocumented getFxParams/setFxParams only)",
    "instrumental source file path",
    "project save and audio render/export"
  ],
  "runtimeBaseline": "Synthesizer V Studio 2 Pro 2.3.0 (hostVersionNumber 131840), Lua runtime introspection on 2026-11-03",
  "runtimeAdditions": [
    {"class":"NoteGroup","member":"getScale","classification":"semantic","observed":"returns {root, type}, for example {root=\"C\", type=\"Major\"}","actions":["get_track_notes","list_note_groups","update_group"]},
    {"class":"NoteGroup","member":"setScale","classification":"semantic","observed":"takes one {root, type} table; silently ignores unknown roots/types and may apply only the root","actions":["update_group"]},
    {"class":"Automation","member":"setInterpolationMethod","classification":"semantic","observed":"accepts linear, cosine and cubic; any other name silently becomes linear","actions":["set_automation_points"]},
    {"class":"TrackMixer","member":"getFxParams","classification":"semantic","observed":"returns compressor, postRoomEq (low shelf plus three filters), reverb and room parameter tables","actions":["get_track_mixer"]},
    {"class":"TrackMixer","member":"setFxParams","classification":"intentionallyUnexposed","observed":"takes one table shaped like getFxParams()","reason":"no documented parameter ranges or reverb type list; the Runtime does not invent mixing values"},
    {"class":"MainEditorView","member":"setCurrentTrack","classification":"intentionallyUnexposed","observed":"present at runtime","reason":"setCurrentTrack(currentTrack) crashed SynthV 2.3.0 with an access violation in 2 of 2 runs"},
    {"class":"MainEditorView","member":"setCurrentGroup","classification":"intentionallyUnexposed","observed":"present at runtime","reason":"shares the editor-switch path of setCurrentTrack; not exercised to avoid crashing the host"},
    {"class":"SV","member":"scaleNotes","classification":"internal","observed":"SV:scaleNotes() returns C, C#, D, D#, E, F, F#, G, G#, A, A#, B","actions":["update_group"]},
    {"class":"SV","member":"scaleTypes","classification":"internal","observed":"SV:scaleTypes() returns 15 names from Major through Octatonic","actions":["update_group"]},
    {"class":"SV","member":"parameterTypes","classification":"internal","observed":"SV:parameterTypes() lists nine Automation types; rapIntonation is absent from the list but still readable through getParameter"},
    {"class":"SV","member":"pitch2Freq","classification":"internal","observed":"replaces the documented pitch2freq spelling","actions":["convert_pitch"]},
    {"class":"SV","member":"QUARTER","classification":"internal","observed":"constant 705600000 blicks per quarter note"},
    {"class":"PitchControlPoint","member":"isTemporary","classification":"intentionallyUnexposed","observed":"returns false for a detached point","reason":"undocumented meaning"},
    {"class":"PitchControlPoint","member":"type","classification":"internal","observed":"class-name string field"},
    {"class":"PitchControlCurve","member":"type","classification":"internal","observed":"class-name string field"},
    {"class":"TrackMixer","member":"type","classification":"internal","observed":"class-name string field"}
  ],
  "runtimeDeviations": [
    {"class":"Note","member":"getAttributes().phonesetOverride","observed":"2.3.0 reports the documented phonesetOverride attribute as phoneset","handling":"reads either key and writes the key the host reports; the public field stays phonesetOverride"},
    {"class":"Note","member":"setLanguageOverride","observed":"stores any string without validation; 2.3.0 adds french, german, italian and portuguese next to korean and spanish","handling":"executor and schema accept only the identifiers from SynthV's 2.3.0 phoneme reference; the four 2.3.0 languages fail closed on older hosts"},
    {"class":"Note","member":"setPitchAutoMode","observed":"documented but absent at runtime","handling":"pitchAutoMode writes fail closed with UNSUPPORTED_HOST_CAPABILITY"},
    {"class":"NoteGroup","member":"addNote","observed":"2.3.0 raises 'notes cannot be added to a track's main group'","handling":"add_notes rejects grouping=target on a main Group before Undo; ensureNonMain remains the v3 default"},
    {"class":"Automation","member":"getInterpolationMethod","observed":"returns lowercase linear/cosine/cubic instead of the documented Linear/Cosine/Cubic","handling":"interpolation comparisons are case-insensitive"},
    {"class":"SV","member":"pitch2freq","observed":"absent; exposed as pitch2Freq","handling":"convert_pitch falls back to pitch2Freq"},
    {"class":"NestedObject","member":"getIndexInParent","observed":"absent on Project, TimeAxis, MainEditorView, ArrangementView, CoordinateSystem, PlaybackControl and both selection states","handling":"the Runtime calls it only on nested project objects"},
    {"class":"NestedObject","member":"method values","observed":"host methods are callable userdata, so type(method) is not \"function\"","handling":"capability probes check presence (~= nil) instead of type"}
  ],
  "actionGroups": {
    "verifiedReads": ["convert_pitch", "get_project_info", "inspect_score_file", "get_time_axis", "convert_time", "list_tracks", "list_note_groups", "get_track_notes", "get_group_voice", "get_note_phoneme_data", "get_phrase_context", "get_computed_group_data", "get_note_retakes", "get_pitch_controls", "get_automation", "sample_automation", "get_track_mixer"],
    "verifiedUi": ["host_clipboard", "show_dialog", "get_selection", "set_selection", "get_editor_view", "set_editor_view", "snap_position", "convert_editor_coordinates", "playback"],
    "writes": [
      {"action":"set_time_axis","aggregates":["ProjectTimeline"],"preflight":"fresh time-axis Guard and complete mark validation","postcondition":"hostReadback","automated":"policy, protocol and Fake Host","realHost":"verified"},
      {"action":"create_note_group","aggregates":["GroupContent"],"preflight":"complete note/control payload and host capability validation","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"clone_note_group","aggregates":["GroupContent"],"preflight":"fresh source snapshot and clone capability validation","postcondition":"hostReadback","automated":"clone ownership Fake Host","realHost":"experimental"},
      {"action":"delete_note_group","aggregates":["GroupContent"],"preflight":"fresh library Guard and shared-reference policy","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"add_group_reference","aggregates":["GroupReference"],"preflight":"fresh Track and library Group guards","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"clone_group_reference","aggregates":["GroupContent","GroupReference"],"preflight":"explicit linked or isolated intent and source snapshot","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"experimental"},
      {"action":"add_track","aggregates":["TrackShell"],"preflight":"complete Track payload","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"update_track","aggregates":["TrackShell"],"preflight":"fresh Track Guard","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"clone_track","aggregates":["GroupContent","GroupReference","TrackShell"],"preflight":"fresh Track Guard, explicit isolated policy and source snapshots","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"experimental"},
      {"action":"clone_track_shell","aggregates":["TrackShell"],"preflight":"fresh Track Guard and empty-shell plan","postcondition":"hostReadback","automated":"CLN Fake Host matrix","realHost":"experimental"},
      {"action":"delete_track","aggregates":["TrackShell"],"preflight":"fresh Track Guard and final-Track refusal","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"update_group","aggregates":["GroupContent","GroupReference"],"preflight":"fresh content/reference guards and sharing policy","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"set_group_voice","aggregates":["GroupReference"],"preflight":"fresh Reference Guard and dynamic range validation","postcondition":"hostReadback","automated":"range and Fake Host","realHost":"verified"},
      {"action":"copy_group_voice","aggregates":["GroupReference"],"preflight":"fresh source and target Group locators plus readable source Voice","postcondition":"hostReadback","automated":"voice-copy Fake Host matrix","realHost":"experimental"},
      {"action":"apply_group_tuning","aggregates":["GroupContent","GroupReference"],"preflight":"one complete Voice/note/Automation/Smart Pitch effect plan","postcondition":"hostReadback","automated":"aggregate Fake Host matrix","realHost":"verified"},
      {"action":"delete_group_reference","aggregates":["GroupReference"],"preflight":"fresh Reference Guard","postcondition":"hostReadback","automated":"policy and Fake Host","realHost":"verified"},
      {"action":"import_monophonic_score","aggregates":["GroupContent"],"preflight":"bounded local snapshot, rights confirmation and shared policy","postcondition":"hostReadback","automated":"score import contracts and Fake Host","realHost":"verified"},
      {"action":"add_notes","aggregates":["GroupContent"],"preflight":"complete bounded note plan and shared policy","postcondition":"hostReadback","automated":"note Fake Host matrix","realHost":"verified"},
      {"action":"edit_notes","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and shared policy","postcondition":"hostReadback","automated":"guarded note Fake Host matrix","realHost":"verified"},
      {"action":"transform_notes","aggregates":["GroupContent"],"preflight":"fresh scoped note Guards, time axis and geometry validation","postcondition":"hostReadback","automated":"transform Fake Host matrix","realHost":"verified"},
      {"action":"set_note_phoneme_properties","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and phoneme ranges","postcondition":"hostReadback","automated":"phoneme contract and Fake Host","realHost":"verified"},
      {"action":"generate_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and host capability","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"verified"},
      {"action":"activate_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and Take bounds","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"verified"},
      {"action":"add_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh shared policy and complete bounded controls","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"edit_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh per-control Guards and shared policy","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"simplify_automation","aggregates":["GroupContent"],"preflight":"fresh curve Guard, host definition range and shared policy","postcondition":"hostReadback","automated":"Automation Fake Host matrix","realHost":"verified"},
      {"action":"set_automation_points","aggregates":["GroupContent"],"preflight":"fresh curve Guard, host definition range and complete point plan","postcondition":"hostReadback","automated":"Automation Fake Host matrix","realHost":"verified"},
      {"action":"script_data","aggregates":["Metadata"],"preflight":"fresh target resolution and explicit metadata operation","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"set_track_mixer","aggregates":["TrackShell"],"preflight":"fresh Track Guard and mixer ranges","postcondition":"hostReadback","automated":"Command Kernel and Fake Host","realHost":"verified"},
      {"action":"create_harmony_track","aggregates":["TrackShell"],"preflight":"fresh source Track and bounded harmony plan","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"experimental"},
      {"action":"humanize_notes","aggregates":["GroupContent"],"preflight":"fresh note Guards and deterministic bounded transform","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"apply_expression_preset","aggregates":["GroupContent"],"preflight":"fresh note/curve Guards and host ranges","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"fit_lyrics","aggregates":["GroupContent"],"preflight":"fresh note Guards and exact lyric count","postcondition":"hostReadback","automated":"schema and Fake Host","realHost":"verified"},
      {"action":"delete_notes","aggregates":["GroupContent"],"preflight":"fresh per-note Guards and shared policy","postcondition":"hostReadback","automated":"guarded delete Fake Host matrix","realHost":"verified"},
      {"action":"delete_note_retake","aggregates":["GroupContent"],"preflight":"fresh note/Retake Guard and Take bounds","postcondition":"hostReadback","automated":"Retake contracts and Fake Host","realHost":"verified"},
      {"action":"delete_pitch_controls","aggregates":["GroupContent"],"preflight":"fresh per-control Guards and shared policy","postcondition":"hostReadback","automated":"Smart Pitch Fake Host matrix","realHost":"verified"},
      {"action":"clear_automation","aggregates":["GroupContent"],"preflight":"fresh curve Guard, closed range and shared policy","postcondition":"hostReadback","automated":"Automation endpoint Fake Host matrix","realHost":"verified"},
      {"action":"apply_transaction","aggregates":["Transaction"],"preflight":"all independent steps before Undo and dependent steps just in time","postcondition":"transactionSummary","automated":"transaction Fake Host matrix plus redacted crash breadcrumbs","realHost":"experimental"},
      {"action":"rollback_transaction","aggregates":["Transaction"],"preflight":"stored reverse plan with fresh per-step guards","postcondition":"transactionSummary","automated":"transaction Fake Host matrix","realHost":"experimental"}
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
| `Automation` | add/get/getAllPoints/getPoints/remove/removeAll/simplify, definition and interpolation reads; 2.3.0 interpolation writes | clone and script-data methods | Closed-range removal is verified point-by-point; the 2.3.0 setter silently maps unknown names to linear |
| `CoordinateSystem` | read view ranges; set time/value viewport; coordinate conversions and snap | parent/index/memory methods | Value-axis coverage is host-capability gated |
| `GroupSelection` | read/clear/select/unselect Groups | legacy selection abstraction plumbing | Prefer concrete arrangement/main-editor states |
| `MainEditorView` | current Track/Group, selection, navigation | parent/index/memory methods; 2.3.0 `setCurrentTrack`/`setCurrentGroup` | `setCurrentTrack(currentTrack)` crashed 2.3.0 in 2 of 2 runs |
| `NestedObject` | none | parent/index/memory lifecycle only | Never crosses IPC |
| `Note` | read/write lyrics, phonemes, pitch, detune, onset/duration/range, language, musical type, rap accent, pitch mode, attributes, Retakes | clone and script-data methods | V1-only or voice-specific attributes fail closed |
| `NoteGroup` | add/remove/read Notes; add/remove/read Pitch Controls; parameters; UUID/name; 2.3.0 scale; isolated clone | script-data methods | All content writes, including scale, enforce fresh sharing policy |
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
| `TrackMixer` | gain, pan, mute, solo read/write; 2.3.0 FX parameter reads | script-data and lifecycle methods; 2.3.0 `setFxParams` | FX writes wait for documented ranges |
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
- documented Track effect parameter ranges (2.3.0 adds undocumented
  `getFxParams`/`setFxParams`; the Bridge reads FX but does not write it);
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
