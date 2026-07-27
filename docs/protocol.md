# File IPC protocols

The Node client uses the compact protocol-v2 envelope by default. The Lua
executor continues to accept protocol v1 for recovery tools and isolated legacy
clients.

## Compact protocol v2

Request:

```json
{"v":2,"id":"AbCdEfGh12345678","a":"get_project_info","p":{}}
```

Success:

```json
{"v":2,"id":"AbCdEfGh12345678","r":{}}
```

Error:

```json
{"v":2,"id":"AbCdEfGh12345678","e":{"code":"STALE_NOTE","message":"The note changed"}}
```

The single-writer channel still requires `id` correlation. V2 removes
per-request timestamps, the repeated long field names, and the explicit `ok`
flag. Heartbeat and session files carry timing and supported-version
diagnostics.

## Legacy protocol v1

The v0.1.4 side-panel handoff is not a new Bridge protocol version. It is a
local, display-oriented sideband owned by the Node coordinator. Confirmed panel
changes enter SynthV through the same preferred v2 channel as normal Node
requests; the underlying actions remain available to v1 clients. See
[sidebar.md](sidebar.md).

### Request

```json
{
  "protocolVersion": 1,
  "requestId": "7b2fcf15-2cb1-4df2-86c6-d3a8d6c49f8f",
  "action": "get_project_info",
  "createdAt": "2026-07-26T00:00:00.000Z",
  "payload": {}
}
```

### Success response

```json
{
  "protocolVersion": 1,
  "requestId": "7b2fcf15-2cb1-4df2-86c6-d3a8d6c49f8f",
  "completedAt": "2026-07-26T00:00:01Z",
  "ok": true,
  "result": {}
}
```

### Error response

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

### Automatic note grouping

`add_notes` accepts `grouping=target|ensureNonMain`. The MCP v2 surface injects
`ensureNonMain` by default. When the requested target is a track main group, the
Bridge validates and constructs all notes first, then creates one reusable
library `NoteGroup`, places one non-main reference on the same track, copies the
main reference's Voice/Vocal Modes, and inserts all notes into that group in one
undo record. Existing non-main targets are reused.

Set `grouping=target` to write directly to the requested group. Protocol-v1
requests that omit `grouping` retain this legacy behavior. `groupName` may be
provided only when `ensureNonMain` actually creates a group.
- Time-axis tempo positions are project-global blicks; time-signature positions are zero-based measure numbers.

## Optimistic-concurrency fields

Protocol v1 keeps concurrency fields optional for backward compatibility. New clients should always echo the latest applicable values:

- `groupUuid` for every Group write.
- `referenceFingerprint` for reference updates/deletes, especially instrumental references without a Group UUID.
- `fingerprint` for note and Smart Pitch edits/deletes.
- `expectedFingerprint` for automation, time-axis, and library-group writes.
- `trackFingerprint` for track updates, clones, deletes, and mixer writes.

The MCP layer additionally supports short `guardToken` and
`expectedGuardToken` values in compact tuning workflows. These tokens are
resolved in memory to the original fingerprint before a file-protocol request
is written, including guarded steps nested in `apply_transaction` and payloads
staged through `sidebar_publish_preview`, so the Lua executor continues to
compare the complete current fingerprint. Guard Tokens are intentionally
invalid after the MCP server restarts or evicts an old entry.

The bridge reports `STALE_GROUP`, `STALE_GROUP_REFERENCE`,
`STALE_LIBRARY_GROUP`, `STALE_NOTE`, `STALE_PITCH_CONTROL`, `STALE_TRACK`,
`STALE_AUTOMATION`, or `STALE_TIME_AXIS` before creating an undo record when a
supplied guard no longer matches.

### Default MCP v2 surface

The model-facing MCP surface is versioned independently from this file
envelope. By default it exposes `sv_status`, `sv_describe`, `sv_read`,
`sv_edit`, `sv_delete`, `sv_transaction`, `sv_ui`, and `sv_sidebar`.
`sv_describe` returns the existing action schemas only when requested.

V2 reads may return an opaque `contextId`. The MCP server binds it to the
complete locators and fingerprints already returned by the underlying action,
then removes those verbose values from the model-facing result. V2 writes
expand the handle before submitting an ordinary file-protocol request. A context
does not bypass any Lua validation, does not survive MCP restart/eviction, and
does not cache mutable musical state.

`get_phrase_context.include` is an additive file-protocol projection used by
the v2 surface. Omitted `include` retains the complete legacy response. When it
is present, excluded voice, automation, analysis, recommendations, selection
diagnostics, and computed-pitch summaries are not serialized and, where
possible, are not computed.

Set `SYNTHV_AGENT_BRIDGE_MCP_SURFACE=legacy` to expose the original
one-tool-per-action MCP surface. This does not change the file protocol.

## Serialization rules

- The server accepts exactly one in-flight request.
- Request and response filenames are stable, but writes are published atomically through temporary files.
- `requestId` correlates a response with its request.
- A protocol-version mismatch fails closed.
- New action names and optional payload fields may be added without changing the v1 envelope.
- Unknown fields may be added to read responses in minor releases; clients should ignore fields they do not recognize.

### Compact tuning responses

The additive `responseMode` payload field accepts `full` or `compact`; `full`
is the backward-compatible default. Compact phoneme reads may also provide
`noteIndices` and/or an absolute `startSeconds`/`endSeconds` overlap range.
Compact writes return counts and fresh fingerprints rather than complete
serialized objects. At the MCP boundary those fingerprints are replaced by
short Guard Tokens.

`includeComputedPhonemes` defaults to `true` for backward compatibility. When
false, the executor skips `SV:getPhonemesForGroup` and omits each note's
`computedPhonemes` field. Read responses report `computedPhonemesIncluded`,
`scanMode`, and `scannedNoteCount`; these additive diagnostics let clients
confirm whether an index, page, or time-range fast path was used.

Response mode remains an optional action payload field in both envelopes, and
the Node-only Guard Token substitution is not part of the file IPC contract.

### Phrase context

`get_phrase_context` is an additive read-only v1 action. It accepts an explicit
Group locator or uses the current piano-roll Group when `trackIndex` is absent.
An explicit `noteIndices` list or `startSeconds`/`endSeconds` range wins over
selection; otherwise `preferSelectedNotes` defaults to true. The returned notes
always use compact timing/pitch/phoneme serialization.

The response also contains compact Group voice/Vocal Modes, aggregate phrase
metrics, bounded recommendation-only targets, and summaries for up to eight
requested automation parameters. Optional `pitchAnalysisFrames` samples at most
256 computed-pitch frames but returns only aggregate statistics. At the MCP
boundary, note fingerprints and each nested automation fingerprint become
short Guard Tokens suitable for the existing guarded write tools.

Phrase-note seconds are rounded to the reported `secondsPrecision` of `0.0001`.
When `noteDefaultsOmitted` is true, absent empty phoneme/language/phoneset
overrides, zero detune, true/default even-syllable duration, empty phoneme
attributes, and false selection flags represent their ordinary defaults.
Non-default values are never removed.

The executor recomputes this context for each request. It intentionally does
not cache note, selection, voice, or automation state across requests.

P3 adds optional range controls without changing the v1 envelope:

- `rangeMatch` defaults to `overlap`. This scans from the Group front when
  necessary so notes sustained across a range start are included and reports
  `coverage: "complete_overlap"`.
- `rangeMatch: "onset"` binary-seeks to the first onset at or after the range
  start. Responses report `coverage: "onset_only"` and
  `mayExcludeEarlierSustains: true`.
- An ordinary page with more notes contains a raw `pageCursor` in file IPC. The
  MCP server replaces it with `page.cursorToken`; on continuation it restores
  the exact Group locator, next index, and boundary fingerprint. A changed
  boundary fails with `STALE_RANGE_CURSOR`. Tokens do not survive MCP restart or
  eviction.
- `ranges` accepts 1–32 `{startSeconds,endSeconds,label?}` objects and cannot be
  combined with top-level time bounds, exact note indices, a cursor, or a
  non-zero offset. The result contains one shared unique `notes` array and
  per-range `noteIndices`, diagnostics, automation summaries, and optional
  pitch summaries. The union is bounded to 256 notes and pitch sampling is
  bounded to 256 total requested frames.

These are additive payload and response fields. Existing clients that omit
them retain complete overlap matching, numeric pagination, and protocol v1
compatibility.

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
`fit_lyrics` as additive v1 actions. `get_phrase_context` later adds compact
selected/ranged phrase analysis without changing the v1 envelope.

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

### Token-efficient Group Voice refresh

`get_group_voice` accepts either an explicit Group locator or an empty payload.
An empty payload resolves the current piano-roll vocal Group, avoiding a
potentially large `get_selection` response merely to discover the target. On
the MCP v2 surface, the default projection contains only `trackIndex`,
`groupIndex`, documented `parameters`, `vocalModes`, and a guarded `contextId`.
Callers can request additional fields explicitly for diagnostics.

The MCP server instructions require one first-use notice per conversation,
not one notice per edit. Before Vocal Mode work, the Agent asks the user either
for the exact current singer mode names or for a screenshot of that panel.
The Agent reuses that list until the user reports changing singer. Undo or a
manual edit only requires a compact reread when it touched the same target.

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
above the older documented range. SynthV may omit every default Vocal Mode from
`getVoice()` until a non-default value is written, so an empty
`vocalModeParams` map is not treated as a capability catalog. The caller may
submit all desired mode names in one `set_group_voice` request. The Bridge
tries the complete batch on a cloned reference and reads it back; no
interactive per-mode discovery request is required. Names rejected by the
current host fail before an undo record, while successful non-default values
become visible in later reads.

If clone validation returns `VOCAL_MODE_NOT_FOUND`, its details contain
`requiredUserInput.kind=vocal_mode_names`, the attempted names, any names
already visible in the Group, and an instruction to stop guessing. The Agent
must tell the user that the scripting API cannot enumerate the current
singer's default-only modes and ask for the exact names displayed in SynthV's
Vocal Mode panel, preserving spelling and capitalization. The user may instead
attach a screenshot that clearly shows the complete panel. The Agent should
then retry all identified names in one batch and reuse them for that singer.

The Bridge first tries a sparse nested update and verifies every previously
visible Vocal Mode value, so an unrequested legacy value is never silently
clamped. A directly requested value must still survive
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
