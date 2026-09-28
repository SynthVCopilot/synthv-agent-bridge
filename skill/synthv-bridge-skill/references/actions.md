# Action catalog

Action names passed as `action` to `sv_query`, `sv_command`, or `sv_ui`.
Call `sv_describe` with an action name to get its exact schema before using it.

## sv_status operations

`bridge`, `host`, `ping`, `reload`, `diagnostics`.

`reload` hot-reloads the Lua executor. `diagnostics` accepts `level` and a
`traceId` to look up.

## sv_query — 17 reads

| Action | Returns |
|---|---|
| `get_project_info` | Project metadata, track and Group counts |
| `get_time_axis` | Tempo and meter map |
| `convert_time` | Blick ↔ second ↔ quarter conversion at the current timeline |
| `convert_pitch` | MIDI pitch ↔ frequency |
| `list_tracks` | Tracks, paged with `offset` / `limit` |
| `list_note_groups` | Library Groups, paged with `offset` / `limit` |
| `get_track_notes` | Notes in a Group, with guards |
| `get_phrase_context` | The bounded phrase read to use before a tuning edit |
| `get_group_voice` | Group Vocal parameters and discoverable Vocal Modes |
| `get_note_phoneme_data` | Per-note phonemes and attributes |
| `get_computed_group_data` | Computed pitch and phonemes, asynchronous |
| `get_note_retakes` | Retake list for a note |
| `get_pitch_controls` | Smart Pitch control points |
| `get_automation` | Automation points and `definition.range` |
| `sample_automation` | Values at explicit positions |
| `get_track_mixer` | Gain, pan, mute, solo |
| `inspect_score_file` | Read-only inspection of a local MusicXML/MIDI path |

`inspect_score_file` runs in Node, not in SynthV. It takes an absolute local
`.xml`, `.musicxml`, `.mxl`, `.mid`, or `.midi` path — never a URL, never
`.svp` — and is capped at 512 monophonic notes.

## sv_command — 38 writes

Timeline

- `set_time_axis`

Note Groups and References

- `create_note_group`, `delete_note_group`, `update_group`
- `add_group_reference`, `delete_group_reference`
- `clone_group_reference` — `cloneIntent: "linked"` only
- `clone_note_group` — **disabled**

Tracks

- `add_track`, `update_track`, `delete_track`, `set_track_mixer`
- `clone_track`, `clone_track_shell`, `create_harmony_track` — **disabled**

Voice

- `set_group_voice`, `apply_group_tuning`
- `copy_group_voice` — copies documented Voice parameters and Vocal Modes
  between Group References; it does not change or identify the voicebank

Notes

- `add_notes`, `edit_notes`, `transform_notes`, `delete_notes`
- `set_note_phoneme_properties`
- `humanize_notes`, `apply_expression_preset`, `fit_lyrics`
- `import_monophonic_score`

Retakes

- `generate_note_retake`, `activate_note_retake`, `delete_note_retake`

Pitch and automation

- `add_pitch_controls`, `edit_pitch_controls`, `delete_pitch_controls`
- `set_automation_points`, `simplify_automation`, `clear_automation`

Project script data

- `script_data`

Transactions

- `apply_transaction`, `rollback_transaction` — **disabled**

Every write needs a `contextId` from a `writeIntent` read of the same target.
Note edits and deletes additionally need each note's current `fingerprint`.

## sv_ui — 9 actions

| Action | Effect |
|---|---|
| `get_selection` / `set_selection` | Read or change the editor selection |
| `get_editor_view` / `set_editor_view` | Read or change the viewport |
| `snap_position` | Snap a position to the current grid |
| `convert_editor_coordinates` | Pixel ↔ musical coordinates |
| `host_clipboard` | Read or write the host clipboard |
| `show_dialog` | Show a host dialog |
| `playback` | `status`, `pause`, `stop`, `seek`, `loop` |

UI actions change host state, not project data, and create no Undo record.

## sv_review

`operation: "status"` only. Reports the optional native side panel's runtime
status. It never reads or writes project data.
