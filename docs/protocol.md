# File IPC protocol v1

The v0.1.4 side-panel handoff is not a new Bridge protocol version. It is a
local, display-oriented sideband owned by the Node coordinator. Confirmed panel
changes still enter SynthV through an ordinary protocol v1 request, so protocol
v1 clients remain backward compatible. See [sidebar.md](sidebar.md).

## Request

```json
{
  "protocolVersion": 1,
  "requestId": "7b2fcf15-2cb1-4df2-86c6-d3a8d6c49f8f",
  "action": "get_project_info",
  "createdAt": "2026-07-26T00:00:00.000Z",
  "payload": {}
}
```

## Success response

```json
{
  "protocolVersion": 1,
  "requestId": "7b2fcf15-2cb1-4df2-86c6-d3a8d6c49f8f",
  "completedAt": "2026-07-26T00:00:01Z",
  "ok": true,
  "result": {}
}
```

## Error response

```json
{
  "protocolVersion": 1,
  "requestId": "7b2fcf15-2cb1-4df2-86c6-d3a8d6c49f8f",
  "completedAt": "2026-07-26T00:00:01Z",
  "ok": false,
  "error": {
    "code": "STALE_NOTE",
    "message": "The note changed after it was read; read the group again before writing",
    "details": {}
  }
}
```

## Indexing and coordinates

- Track, group, and note indices are **1-based**, matching the Lua API.
- Note onset and pitch values are local to their note group.
- Read responses also include absolute onset, end, and pitch after applying group-reference offsets.
- Automation point positions are group-local blicks.
- Smart Pitch anchor positions and curve-point offsets are group-local blicks.
- Editor view time coordinates are blicks and screen coordinates are pixels.
- Playback positions are seconds.
- Time-axis tempo positions are project-global blicks; time-signature positions are zero-based measure numbers.

## Optimistic-concurrency fields

Protocol v1 keeps concurrency fields optional for backward compatibility. New clients should always echo the latest applicable values:

- `groupUuid` for every Group write.
- `referenceFingerprint` for reference updates/deletes, especially instrumental references without a Group UUID.
- `fingerprint` for note and Smart Pitch edits/deletes.
- `expectedFingerprint` for automation, time-axis, and library-group writes.
- `trackFingerprint` for track updates, clones, deletes, and mixer writes.

The bridge reports `STALE_GROUP`, `STALE_GROUP_REFERENCE`,
`STALE_LIBRARY_GROUP`, `STALE_NOTE`, `STALE_PITCH_CONTROL`, `STALE_TRACK`,
`STALE_AUTOMATION`, or `STALE_TIME_AXIS` before creating an undo record when a
supplied guard no longer matches.

## Serialization rules

- The server accepts exactly one in-flight request.
- Request and response filenames are stable, but writes are published atomically through temporary files.
- `requestId` correlates a response with its request.
- A protocol-version mismatch fails closed.
- New action names and optional payload fields may be added without changing the v1 envelope.
- Unknown fields may be added to read responses in minor releases; clients should ignore fields they do not recognize.

### Additive v1 actions

Protocol v1 permits new action names without changing the request/response
envelope. The expanded action set includes reusable note-group library
operations, linked/deep group references, Smart Pitch CRUD, Bridge-tracked
Retakes, automation sampling/simplification, full selection control, viewport
navigation, host clipboard/dialog helpers, coordinate conversion, and
namespaced script data. Later additive actions expose typed Group voice/Vocal
Mode settings, host-validated experimental Unison fields, and dedicated
per-note phoneme properties without changing the v1 envelope. Version 0.1.4
also adds `apply_transaction`, `rollback_transaction`,
`create_harmony_track`, `humanize_notes`, `apply_expression_preset`, and
`fit_lyrics` as additive v1 actions.

`script_data` only exposes keys beginning with `synthv-agent-bridge.`. It never
lists, clears, or overwrites another script's namespace.

### Guarded transactions

`apply_transaction` uses the ordinary v1 envelope:

```json
{
  "protocolVersion": 1,
  "requestId": "example",
  "action": "apply_transaction",
  "createdAt": "2026-07-26T00:00:00.000Z",
  "payload": {
    "summary": "Update two independent tracks",
    "steps": [
      {"action": "update_track", "payload": {"trackIndex": 1, "trackFingerprint": "...", "name": "Lead"}},
      {"action": "set_track_mixer", "payload": {"trackIndex": 2, "trackFingerprint": "...", "gainDecibel": -3}}
    ]
  }
}
```

The batch contains 1–32 non-transaction project-write steps. The Bridge
preflights every step before one undo record is created. Validation failure
leaves the project unchanged. Steps that mutate the same guarded scope are
rejected because their validation would be order-dependent. Track and
library-group deletes, which shift later indices, must be the only step.

Optional `rollbackSteps` may refer to a forward result with a value shaped as
`{"$result":{"step":1,"path":["fingerprint"]}}`; `step` is 1-based and `path`
walks fields in that result. Resolved reverse steps are stored only in the
current Bridge session. `rollback_transaction` accepts the returned
`transactionId`, revalidates current fingerprints, and creates one new undo
record.

### Track color compatibility

- Track write actions accept `#RRGGBB`, `AARRGGBB`, or `#AARRGGBB`.
- Six-digit RGB is normalized to an opaque native SynthV value by prepending `ff` and removing `#`.
- Track reads keep the host's raw `displayColor` and may additionally include `displayColorArgb` and `displayColorRgb`.
- A color write is verified through `Track:getDisplayColor()` before it is reported as successful.

### Verified time-axis writes

`set_time_axis` explicitly removes an occupied tempo/time-signature position
before adding its replacement. The bridge validates the complete operation on a
cloned `TimeAxis`, applies one undo record, and verifies the project-owned
`TimeAxis` afterward. Successful responses include `verified: true`.

### Optional host capabilities

When the current SynthV Lua host cannot execute `Note:setPitchAutoMode()`, a
request that would actually change the note fails with
`UNSUPPORTED_HOST_CAPABILITY`. A request matching the current value succeeds
without invoking the unavailable setter.

`set_group_voice` treats `singers` and `spacing` as experimental host
capabilities because they are not in the public `NoteGroupReference#getVoice`
field list. It accepts them only when the current reference returns the field,
and it verifies the requested value on a cloned reference before creating an
undo record.

Vocal Mode axes accept non-negative finite values. The bridge deliberately
does not impose a fixed upper bound because current projects can return values
above the older documented range. It first tries a sparse nested update and
verifies the complete Vocal Mode map, so an unrequested legacy value is never
silently clamped. A directly requested value must still survive
`NoteGroupReference:setVoice()` on a cloned reference; SynthV 2.2.1 clamps some
host-returned values such as 220 to 150 when they are written, and the bridge
therefore rejects that write before an undo record is created.

### Hot reload

`reload_bridge` compiles the currently running script file with Lua
`loadfile()`, writes the correlated response, and then transfers polling to a
new in-session Bridge instance. It does not call UI automation or inject hooks.
The installer can request the same transition through the
`synthv-agent-bridge.reload` marker, records the installed absolute path in a
local `synthv-agent-bridge.install.json` manifest, and confirms that the
session token changed. The manifest fallback is needed because SynthV 2.2.1
does not expose the loaded script path to Lua. A Bridge version that predates
this action must be restarted manually once before later installs can reload
automatically.

### Selection-aware writes

Group voice and phoneme reads include whether the target is the current
piano-roll Group, whether it is selected in either editor, and how many of its
notes are selected. `set_group_voice` can require the current editor Group;
`set_note_phoneme_properties` can additionally require every target note to be
selected. These guards are opt-in because official object setters operate on
explicit Group UUIDs, note indices, and fingerprints without requiring UI
selection. This keeps batch automation available while allowing
selection-sensitive user requests to fail safely with `SELECTION_MISMATCH`.
