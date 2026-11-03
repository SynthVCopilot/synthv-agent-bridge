# Action reference

[English](actions.md) | [简体中文](actions_cn.md)

The MCP server registers six tools. Every SynthV action below runs through one
of them; none is a standalone MCP tool. Ask `sv_describe` with an `action` name
for its current schema instead of copying schemas into a prompt.

| Tool | Runs |
|---|---|
| `sv_status` | `operation`: `bridge`, `host`, `ping`, `reload` or `diagnostics`. |
| `sv_describe` | No arguments for the catalog, or `action` for one schema. |
| `sv_query` | Read actions. |
| `sv_command` | Edit, delete and transaction actions. |
| `sv_ui` | UI actions. |
| `sv_review` | `operation: "status"` for the optional side panel. |

Conventions:

- Track, Group, note, Pitch Control and transaction-step indices are
  **1-based**.
- Note and Automation positions are Group-local **blicks** (705,600,000 per
  quarter note) unless a field name says `absolute`.
- Playback and `*Seconds` fields are seconds.

## Catalog

Two labels mark actions that are not fully verified:

- **Disabled:** the current build rejects these 7 actions before they reach
  SynthV because they crashed SynthV 2.2.1. Their schemas remain for
  diagnosis.
- **Experimental:** the action works but has not yet passed its own real-host
  acceptance.

### Read (`sv_query`)

| Action | Purpose |
|---|---|
| `get_project_info` | Project file, timing, playback, host and current editor location. |
| `list_tracks` | A page of Track summaries with Group and note counts and mixer state. |
| `list_note_groups` | A page of library Note Groups with reference counts and, on SynthV 2.3.0+, `scale`. |
| `get_track_notes` | Group and note pages for one Track, with attributes, offsets and, on 2.3.0+, Group `scale`. |
| `get_group_voice` | Group Voice parameters, Vocal Modes and experimental Unison fields. |
| `get_note_phoneme_data` | User and computed phonemes, phoneset overrides and per-phoneme attributes. |
| `get_phrase_context` | One compact, write-ready phrase: notes, Voice, Automation summaries and diagnostics. |
| `get_computed_group_data` | Computed phonemes, rap attributes and optional pitch samples. |
| `get_note_retakes` | Take count and Bridge-tracked Take IDs. |
| `get_pitch_controls` | Smart Pitch points and curves. |
| `get_automation` | A parameter's definition, interpolation and a summary or closed range of points. |
| `sample_automation` | Curve values at given positions, native or linear. |
| `get_track_mixer` | Gain, pan, mute, solo and, on 2.3.0+, read-only `fx` (compressor, EQ, reverb, room). |
| `get_time_axis` | Tempo and time-signature marks. |
| `convert_time` | Convert between seconds, quarter notes and blicks, with optional grid rounding. |
| `convert_pitch` | Convert MIDI pitch and frequency and identify black keys. |
| `inspect_score_file` | Preview a local MusicXML or MIDI file without touching SynthV and return its SHA-256 guard. |

### Edit (`sv_command`)

| Action | Purpose |
|---|---|
| `add_notes` | Add notes. Defaults to `grouping=ensureNonMain`, which puts notes for a Track's main Group into a new Note Group. SynthV 2.3.0 rejects `grouping=target` on a main Group. |
| `edit_notes` | Change onset, duration, pitch, lyrics, phonemes, detune, language, type, rap accent or attributes. |
| `transform_notes` | Apply one explicit offset or scale to onset, duration or pitch across guarded notes. |
| `humanize_notes` | Apply seeded, bounded timing variation. |
| `fit_lyrics` | Assign syllables and optional phonemes to guarded notes. |
| `set_note_phoneme_properties` | Edit phoneme sequence, language, phoneset, syllable split and per-phoneme timing or strength. |
| `import_monophonic_score` | Import up to 512 notes from one inspected, rights-confirmed lane. The file hash must still match. |
| `generate_note_retake` | Generate a duration, pitch or timbre Take. |
| `activate_note_retake` | Activate the default Take or one the Bridge generated. |
| `add_pitch_controls` | Add Smart Pitch points or curves. |
| `edit_pitch_controls` | Edit guarded Smart Pitch objects. |
| `set_automation_points` | Add or update points, optionally clearing all or a range first. On 2.3.0+ `interpolationMethod` sets `linear`, `cosine` or `cubic`. |
| `simplify_automation` | Remove insignificant points in a range. |
| `apply_expression_preset` | Apply scoop, falloff, vibrato, crescendo or breathiness. |
| `apply_group_tuning` | Change Voice, Vocal Modes, notes, phonemes and several curves of one Group in one Undo record. |
| `set_group_voice` | Change Group Voice parameters and Vocal Modes. |
| `copy_group_voice` | **Experimental.** Merge the Voice parameters and Vocal Mode axes stored on a source Group into a target Group. Target-only values are kept and defaults are not reset. The singer itself is not copied; choose it in SynthV. |
| `update_group` | Rename a Note Group, set its `scale` on 2.3.0+, or change a reference's mute, offsets, range or Voice. |
| `create_note_group` | Create a library Note Group, optionally with notes. |
| `add_group_reference` | Place a library Note Group on a Track. |
| `clone_group_reference` | Make a linked reference on another Track. The isolated variant is **disabled**. |
| `clone_note_group` | **Disabled.** Deep-clone a Note Group into the library. |
| `add_track` | Create a Track. |
| `update_track` | Rename, recolor or change Render Panel inclusion. |
| `clone_track` | **Disabled.** Clone a Track's main Vocal context. |
| `clone_track_shell` | **Disabled.** Clone a Track's main Vocal context into an empty Track. |
| `create_harmony_track` | **Disabled.** Clone, transpose and range-fit a harmony Track. |
| `set_track_mixer` | Change gain, pan, mute and solo. |
| `set_time_axis` | Add, replace or remove tempo and time-signature marks. |
| `script_data` | Store namespaced Bridge metadata (`synthv-agent-bridge.*` keys) on SynthV objects. |

### Delete (`sv_command`)

| Action | Purpose |
|---|---|
| `delete_notes` | Delete guarded notes. |
| `delete_pitch_controls` | Delete guarded Smart Pitch objects. |
| `clear_automation` | Clear a whole curve or a closed range. |
| `delete_note_retake` | Delete a non-default Take the Bridge generated. |
| `delete_group_reference` | Remove a non-main reference. |
| `delete_note_group` | Delete a library Note Group and every reference to it. |
| `delete_track` | Delete a Track other than the last one. |

### UI (`sv_ui`)

| Action | Purpose |
|---|---|
| `get_selection` | Selected Groups, notes, Smart Pitch controls and Automation points. |
| `set_selection` | Replace, add, remove or clear selection, then report what SynthV selected. |
| `get_editor_view` | Visible time and value ranges and pixel scales. |
| `set_editor_view` | Move or zoom the piano roll or arrangement, then report the result. |
| `snap_position` | Snap a position to the current grid. |
| `convert_editor_coordinates` | Convert between time/value and x/y. |
| `playback` | Status, play, pause, stop, seek or loop, then report status and playhead. |
| `host_clipboard` | Read or write text on the host clipboard. |
| `show_dialog` | Show a message, input, confirmation or custom-form dialog. |

### Transaction (`sv_command`)

| Action | Purpose |
|---|---|
| `apply_transaction` | **Disabled.** Up to 32 writes in one Undo record. |
| `rollback_transaction` | **Disabled.** Apply a stored reverse plan. |

## Contexts and guards

A write needs proof that its target has not changed since it was read.

- Read with `sv_query` and `contextMode: "writeIntent"`. The result carries a
  `contextId` that stores locators and fingerprints in the MCP server's
  memory.
- Pass that `contextId` to `sv_command`. The server fills in Group and
  reference UUIDs, Track, Automation and time-axis fingerprints, and note or
  Smart Pitch guards. A note edit needs only `noteIndex` and `changes`.
- A `contextId` is bound to its target kind and scope. Using it for another
  target, or next to a conflicting explicit locator or guard, fails with
  `CONTEXT_SCOPE_MISMATCH`. A `readOnly` Context never authorizes a write.
- SynthV still checks every complete fingerprint before it opens an Undo
  record.
- When SynthV restarts or the Bridge reloads, the server clears every Context
  and Guard Token. A write then fails with `SYNTHV_SESSION_CHANGED`. A fresh
  read works immediately and reports `sessionReset`.

Compact reads return short **Guard Tokens** instead of long fingerprints. Pass a
note's `guardToken` to `set_note_phoneme_properties`, or a curve's token as
`expectedGuardToken` to `set_automation_points`. Tokens live only in the
current MCP process. `UNKNOWN_GUARD_TOKEN` means read again.

A note fingerprint covers:

- its Group UUID and note index;
- onset, duration and pitch;
- detune, lyrics and phonemes;
- language, musical type, pitch mode and rap accent;
- Retake count and note attributes.

An old plan therefore cannot overwrite a note the user changed.

## Writing safely

1. Read only the object you will change.
   - For a phrase, use `get_phrase_context`.
   - For Voice or Vocal Modes, use `get_group_voice` with no locator to target
     the current piano-roll Group.
2. Build one small, reviewable change.
3. Send it with the `contextId` from that read, using the smallest action that
   does the job:
   - `apply_group_tuning` for one pass over a Group's Voice, notes and curves;
   - `edit_notes`, `set_automation_points` and the like for a single kind of
     change.
4. On any `STALE_*` result, read again rather than guessing.

**Shared Note Groups.** A Note Group's content is shared by every reference to
it. Writes to a Group with more than one reference fail by default. To change
every linked occurrence on purpose, pass:

- `sharedGroupPolicy: "allowAllReferences"`;
- the fresh `expectedReferenceCount`.

**Batches.** `edit_notes` and `delete_notes` accept up to 512 items, but SynthV
is fragile with large batches, so keep each call to about 60 notes.

**Reusing one Context.** One `writeIntent` read can feed several disjoint
batches as long as every targeted note is unchanged. Read again in two cases:

- after a note in that Context has been changed;
- after `add_notes` or `delete_notes` shifts later indices.

Both cases fail before writing, so reusing a Context too long costs a rejected
call, never a wrong edit.

**Undo.** Every successful write creates exactly one SynthV Undo record and
reports `verified: true`. If a failure reports `undoRequired: true`, use
**Edit → Undo** once in SynthV before reading again or retrying.

## Paging and compact responses

**Default bounds.** Collection reads are paged by default and return
continuation metadata. An unscoped read larger than about 20,000 characters
fails with narrowing guidance instead of flooding the Agent's context.

**Automation.** Reads return a point-free summary unless you request a closed
range.

**Track notes.** `get_track_notes` drops the duplicate blick and quarter-note
position fields. Groups of 24 or more notes come back as `{columns, rows}`;
pass `dense: "never"` for plain objects.

**Field filters.** `sv_query.fields` filters only top-level result keys. A
filter that matches nothing returns a `projectionWarning` listing the keys that
exist.

**Phrase reads.** `get_phrase_context` is the preferred read before phrase
tuning:

- **What it returns.** It finds the current piano-roll Group by itself and
  prefers selected notes. Its `include` option picks from `notes`, `voice`,
  `automation`, `analysis`, `recommendations`, `pitchAnalysis`, `selection`
  and `diagnostics`; the default is `notes`, `voice` and `analysis`.
- **Diagnostics.** They flag overlaps, large pitch jumps, sustained notes,
  breath-sized gaps and dense short notes without editing anything.
- **Ranges.** `ranges` accepts up to 32 absolute ranges that share one `notes`
  array.
- **Range matching.** The default `rangeMatch: "overlap"` keeps a long note
  that crosses a range start. `"onset"` is faster but reports
  `mayExcludeEarlierSustains: true`.
- **Paging.** Unscoped pages return a `page.cursorToken`. Pass it back as
  `cursorToken`. SynthV rejects a token whose boundary note changed with
  `STALE_RANGE_CURSOR`.

**Phoneme reads.** `get_note_phoneme_data` filters by `noteIndices` or a
`startSeconds`/`endSeconds` range. Pass `includeComputedPhonemes: false` when
you only need guards or user overrides; it skips the whole-Group computation.

**Compact mode.** `get_note_phoneme_data`, `get_automation`,
`sample_automation`, `set_note_phoneme_properties` and `set_automation_points`
accept `responseMode: "compact"`. Compact writes return counts and replacement
Guard Tokens instead of full notes or curves.

## Host-specific behavior

- **Ranges come from the host.** Automation values are validated against the
  live `getDefinition().range`, which differs by SynthV version and parameter.
  For example, `tension` is ±2 on SynthV 2.3.0. Phoneme position and activity
  are `0..1` and strength is `-1..1`.
- **Phoneme writes are tested first.** They are verified on a detached copy
  before the Undo record, then again on the real note. A voice or host that
  quantizes or ignores a value fails with `HOST_POSTCONDITION_FAILED`.
- **Pitch auto mode.** Some hosts, including SynthV 2.3.0, expose
  `Note:getPitchAutoMode()` but not the setter. A real change fails with
  `UNSUPPORTED_HOST_CAPABILITY` before Undo; a value that already matches is
  skipped.
- **Note languages.** `languageOverride` accepts `mandarin`, `japanese`,
  `english`, `cantonese`, `korean` and `spanish`. On SynthV 2.3.0+ it also
  accepts `french`, `german`, `italian` and `portuguese`.
- **Phoneset overrides.** `phonesetOverride` maps to SynthV 2.3.0's `phoneset`
  attribute (the X-SAMPA switch).
- **Note Group scale.** `scale` must use a root from `SV:scaleNotes()` (sharps
  only, such as `C#`) and a type from `SV:scaleTypes()` (such as `Major`,
  `NaturalMinor` or `Dorian`).
- **Time axis.** `set_time_axis` replaces a mark by removing it and adding it
  again, then verifies the result.
- **Track colors.** Track writes accept `#RRGGBB` or SynthV's native
  `AARRGGBB`. The Bridge stores `#RRGGBB` as opaque `ffRRGGBB` and verifies it.
  Reads return the raw value plus `displayColorArgb` and `displayColorRgb`.

For the full mapping of SynthV's scripting API to these actions, see the
[API coverage matrix](sv2-api-coverage-v3.md). Error codes are listed in
[errors-v3.md](errors-v3.md).
