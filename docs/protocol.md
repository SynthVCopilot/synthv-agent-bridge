# File IPC protocol v1

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
namespaced script data.

`script_data` only exposes keys beginning with `synthv-agent-bridge.`. It never
lists, clears, or overwrites another script's namespace.

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
