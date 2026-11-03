# Synthesizer V scripting API reference

Source: https://resource.dreamtonics.com/scripting/
Target: SV Studio 2 Pro, Lua 5.4

The bridge calls this API on your behalf. You do not write Lua. This reference
exists so you can reason about what an action can and cannot do, and why some
information is unavailable.

Lua is 1-based and uses `Object:Method(...)`. The bridge keeps indices 1-based
at its own protocol boundary for the same reason.

**1 quarter note = 705,600,000 blicks.** Pitch is a MIDI integer, 60 = C4.

---

## Global `SV`

Conversions: `blick2Quarter`, `blick2Seconds`, `quarter2Blick`, `seconds2Blick`,
`blickRoundDiv`, `blickRoundTo`, `freq2Pitch`, `pitch2freq`, `blackKey`. Real
hosts expose `pitch2freq` as `pitch2Freq`.

Undocumented in 2.3.0: `SV:scaleNotes()` (12 roots, sharps only),
`SV:scaleTypes()` (15 scale names such as `Major`, `NaturalMinor`, `Dorian`),
`SV:parameterTypes()` and the `SV.QUARTER` constant.

Access: `getProject`, `getMainEditor`, `getArrangement`, `getPlayback`,
`getHostInfo`, `getHostClipboard`, `setHostClipboard`.

Computed data: `getComputedAttributesForGroup`, `getComputedPitchForGroup`,
`getPhonemesForGroup`. These are asynchronous — the host may return nothing on
the first call, which is why `get_computed_group_data` can report pending state
rather than an error.

Dialogs (`showMessageBox`, `showOkCancelBox`, `showInputBox`,
`showCustomDialog`) block the script. The bridge exposes them only through
`sv_ui show_dialog`.

---

## Project

`getFileName`, `getDuration`, `getTimeAxis`, `newUndoRecord`,
`getNumTracks`, `getTrack(i)`, `addTrack`, `removeTrack`,
`getNumNoteGroupsInLibrary`, `getNoteGroup(i)`, `addNoteGroup`,
`removeNoteGroup`, `getScriptData`, `setScriptData`, `hasScriptData`,
`clearScriptData`.

`newUndoRecord` is what makes one bridge command equal one SynthV Undo.

## Track

`getName`, `setName`, `getNumGroups`, `getGroupReference(i)`,
`addGroupReference`, `removeGroupReference`, `getMixer`, `getDuration`,
`getDisplayColor`, `setDisplayColor`, `getDisplayOrder`, `isBounced`,
`setBounced`, `clone`.

`getGroupReference(1)` is the main Group reference.

## NoteGroupReference

A placed instance of a NoteGroup, with its own offsets and voice.

`getTarget`, `setTarget`, `getOnset`, `getDuration`, `setTimeRange`,
`getTimeOffset`, `setTimeOffset`, `getPitchOffset`, `setPitchOffset`,
`getVoice`, `setVoice`, `isMuted`, `setMuted`, `isMain`, `isInstrumental`.

Several References can target one NoteGroup. Editing that Group's content
changes every one of them — the origin of `SHARED_GROUP_WRITE`.

## NoteGroup

`getName`, `setName`, `getUUID`, `getNumNotes`, `getNote(i)`, `addNote`,
`removeNote`, `getParameter(id)`, `getNumPitchControls`, `getPitchControl(i)`,
`addPitchControl`, `removePitchControl`, `clone`.

SynthV 2.3.0 adds undocumented `getScale`/`setScale` with a `{root, type}`
table. `setScale` silently ignores unknown values, so the bridge checks them
against `SV:scaleNotes()`/`SV:scaleTypes()` first. On 2.3.0, `addNote` rejects
a Track's main Group.

Parameter ids: `pitchDelta`, `vibratoEnv`, `loudness`, `tension`,
`breathiness`, `voicing`, `gender`, `toneShift`, `mouthOpening`,
`rapIntonation`.

## Note

`getOnset`, `setOnset`, `getDuration`, `setDuration`, `setTimeRange`, `getEnd`,
`getPitch`, `setPitch`, `getLyrics`, `setLyrics`, `getPhonemes`, `setPhonemes`,
`getDetune`, `setDetune`, `getMusicalType`, `setMusicalType`,
`getLanguageOverride`, `setLanguageOverride`, `getPitchAutoMode`,
`setPitchAutoMode`, `getRapAccent`, `setRapAccent`, `getAttributes`,
`setAttributes`, `getRetakes`, `clone`, `getScriptData`, `setScriptData`.

Runtime differences:

- `setPitchAutoMode` is documented but missing on some hosts, including 2.3.0.
- `setLanguageOverride` stores any string without validation, so the bridge
  accepts only known language identifiers.
- On 2.3.0, the `phonesetOverride` attribute is reported as `phoneset`.

## Automation

`getDefinition`, `getType`, `getInterpolationMethod`, `getAllPoints`,
`getPoints(from, to)`, `get(blick)`, `getLinear(blick)`, `add(blick, value)`,
`remove(blick)`, `removeAll`, `simplify(threshold)`, `clone`.

`getAllPoints` returns a flat `[blick, value, ...]` array. The bridge reshapes it
into `[{position, value}]`; `getDefinition` supplies the `range` you should read
before writing values.

`getInterpolationMethod` returns lowercase `linear`, `cosine` or `cubic` on
2.3.0, which also adds an undocumented `setInterpolationMethod`. Unknown names
silently become `linear`.

## TimeAxis

`getAllTempoMarks`, `getTempoMarkAt`, `addTempoMark`, `removeTempoMark`,
`getAllMeasureMarks`, `getMeasureMarkAt`, `getMeasureMarkAtBlick`,
`addMeasureMark`, `removeMeasureMark`, `getSecondsFromBlick`,
`getBlickFromSeconds`, `getMeasureAt`.

Second-valued positions depend on the current tempo map. Convert against a fresh
timeline, never a remembered one.

## TrackMixer

`getGainDecibel`, `setGainDecibel`, `getPan`, `setPan`, `isMuted`, `setMuted`,
`isSolo`, `setSolo`.

SynthV 2.3.0 adds undocumented `getFxParams`/`setFxParams` for the compressor,
EQ, reverb and room. The bridge only reads them; their ranges are undocumented.

## PlaybackControl

`getStatus`, `getPlayhead`, `play`, `pause`, `stop`, `seek`, `loop`.

## Views and selection

`MainEditorView`: `getCurrentGroup`, `getCurrentTrack`, `getNavigation`,
`getSelection`. SynthV 2.3.0 also has undocumented `setCurrentTrack` and
`setCurrentGroup`. The bridge never calls them, because
`setCurrentTrack(currentTrack)` crashed the host in 2 of 2 runs.

Selection state: `getSelectedNotes`, `selectNote`, `unselectNote`, `clearNotes`,
`getSelectedGroups`, `hasSelectedContent`, `hasUnfinishedEdits`.

---

## Limits that shape the bridge

- **No Vocal identity.** The API cannot report which singer a Group uses, and
  cannot enumerate singing styles still holding default values. This is why
  Vocal Mode work needs the user to supply exact names.
- **Computed data is asynchronous.** Pitch, phonemes, and attributes may be
  pending on the first read.
- **No `.svp` access.** Everything goes through the live project object graph.
- **Native crash risk.** SynthV 2.2.1 terminates on some clone and transaction
  paths, which is why those actions are disabled. SynthV 2.3.0 also crashed
  intermittently during script edits in testing.
- **Undocumented 2.3.0 members.** The official index has not changed since
  2025-10-09. The bridge's API coverage document records what 2.3.0 adds or
  behaves differently at runtime.
- **Modal dialogs block.** They must not be called from a polling loop.
