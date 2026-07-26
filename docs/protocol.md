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
- Playback positions are seconds.
- Time-axis tempo positions are project-global blicks; time-signature positions are zero-based measure numbers.

## Optimistic-concurrency fields

Protocol v1 keeps concurrency fields optional for backward compatibility. New clients should always echo the latest applicable values:

- `groupUuid` for every Group write.
- `fingerprint` for note edits/deletes and automation/time-axis writes.
- `trackFingerprint` for track updates, clones, deletes, and mixer writes.

The bridge reports `STALE_GROUP`, `STALE_NOTE`, `STALE_TRACK`, `STALE_AUTOMATION`, or `STALE_TIME_AXIS` before creating an undo record when a supplied guard no longer matches.

## Serialization rules

- The server accepts exactly one in-flight request.
- Request and response filenames are stable, but writes are published atomically through temporary files.
- `requestId` correlates a response with its request.
- A protocol-version mismatch fails closed.
- New action names and optional payload fields may be added without changing the v1 envelope.
- Unknown fields may be added to read responses in minor releases; clients should ignore fields they do not recognize.
