# Protocol v3

Status: authoritative for `0.2.0-alpha.1`

Protocol v3 is the only Node-to-Lua envelope accepted by the Bridge. Protocol
v1 and v2 fail with `PROTOCOL_MISMATCH`. The first implementation uses local
files as its transport, but the semantic envelope is transport-independent.

## Public MCP surface

The server registers exactly six tools:

| Tool | Responsibility |
|---|---|
| `sv_status` | Connection, session, capability, trace, and component-build diagnostics |
| `sv_describe` | One compact Query, Command, UI, or Review action schema |
| `sv_query` | Read-only projection, pagination, and typed Context creation |
| `sv_command` | Project edit, delete, clone, import, and bounded batch commands |
| `sv_ui` | Selection, navigation, playback, dialogs, and clipboard |
| `sv_review` | Read optional Sidebar connection and runtime status |

Detailed SynthV actions are private catalog entries. Arbitrary Lua method
execution is not supported.

## File envelope

A request is serialized as:

```json
{
  "v": 3,
  "id": "request-id",
  "t": "trace-id",
  "a": "internal-action",
  "p": {},
  "b": "expected-executor-build-id"
}
```

A successful response is:

```json
{
  "v": 3,
  "id": "request-id",
  "t": "trace-id",
  "b": "executor-build-id",
  "m": {
    "totalMs": 7.5,
    "stages": [
      { "stage": "freshRead", "durationMs": 2.25 },
      { "stage": "verified", "durationMs": 1.5 }
    ]
  },
  "r": {}
}
```

A failed response replaces `r` with `e`. The response must echo `id` and `t`.
Node rejects a mismatched executor build before any project command is
accepted. Full Build Identity is returned by `sv_status`; normal operations
carry only short build identifiers.

`m` is optional, bounded executor telemetry. It accepts at most 24 entries and
each entry contains only a short stage name and a non-negative duration. It
cannot carry lyrics, notes, fingerprints, arbitrary metadata, or project
payloads. Node folds these measurements into the matching internal Trace and
does not expose them in ordinary Query or Command results.

`sv_status(operation="diagnostics")` is the explicit diagnostics projection:

- `support` returns bounded stage durations and identifiers, at most 8 KB;
- `debug` adds bounded safe transport/action metadata, at most 16 KB;
- an optional `traceId` selects one Trace and `limit` is capped at 20;
- ordinary `sv_status` operations do not include recent Trace history.

## Query Contexts

`sv_query` provides two Context modes and defaults to `readOnly`; callers must
explicitly choose `writeIntent` before reusing a Context for a command:

- `readOnly`: may be served by a bounded session cache and never authorizes a
  write.
- `writeIntent`: always reaches the current SynthV host and binds a short-lived
  typed Context to server-side locators and Guards.

Raw fingerprints do not cross the public MCP boundary. Session replacement
clears Contexts, Guards, cursors, and read snapshots.

Every Query action is classified by one projection strategy:

- `fixed`: bounded scalar/object result;
- `offsetPage`: collection with an explicit offset, limit, total count, and
  continuation metadata;
- `cursorPage`: phrase paging with a target-bound opaque cursor;
- `rangeSummary`: compact full-state summary unless a closed range is
  explicitly requested;
- `explicitBounded`: the action requires or internally enforces a bounded
  caller scope.

Default Track, library Group, time-axis-mark, Track-Group/note, computed-data,
and Smart Pitch reads are paged. A compact Automation read omits its point array unless
the caller supplies a closed range. The complete private fingerprint is still
computed from current host state before paging or summarization and remains
available only to the server-side Context.

The shared Query Projector measures the final public JSON. An unscoped default
result above 20,000 characters fails with
`QUERY_RESPONSE_BUDGET_EXCEEDED`. An explicitly requested page, range,
`include`, or `fields` projection may exceed that ordinary budget, but it is
still measured and must expose its coverage rather than silently truncate.
Projection and shadow comparison never perform a second SynthV read.

Computed phoneme/attribute pages retain their pending state in the normal
projection. A pending page reports zero advancement plus the same retry offset;
the caller must retry that page after SynthV finishes computation rather than
skip ahead. Smart Pitch paging serializes only the requested controls instead
of constructing the complete control array before slicing it.

## Command outcomes

Every `sv_command` public result has one outcome:

- `changed`: at least one intended effect was verified; reports affected
  counts and the actual Undo count.
- `alreadySatisfied`: the fresh host state already matches the command; no
  mutation and no Undo occurred.
- `failed`: reports the failed stage, whether mutation may have occurred, and
  whether exactly one SynthV Undo is required.

A command cannot report `changed` merely because no exception occurred.
Unexpected zero effect or a write/readback mismatch is
`HOST_POSTCONDITION_FAILED`.

## Command lifecycle

```text
Schema -> Context Resolve -> Fresh Host Read -> Guard
-> Ownership/Capability/Range Preflight -> Effect Plan
-> Undo -> Mutate -> Postcondition Read
-> Cache Invalidate -> Compact Projection
```

All independent work is preflighted before `Project:newUndoRecord()`.
Dependent batch steps are preflighted immediately before their mutation.
Failure after an earlier dependent step wrote returns `undoRequired=true` and
is never automatically retried.

## Public response rules

Normal responses contain only:

- `traceId`;
- outcome/error code and failed stage;
- affected counts and durable identifiers;
- verification and Undo metadata;
- replacement `contextId` when safe;
- bounded warnings and recovery guidance.

They do not contain raw fingerprints, lyrics, phoneme text, full note arrays,
Automation point arrays, stack traces, or local IPC paths. The target limits
are 20 KB for an ordinary compact read, 2 KB for a write acknowledgement, and
4 KB for a public error.

## Indexing and ownership

Track, Group, Reference, and note indices remain 1-based at the protocol
boundary.

Group-content commands treat notes, lyrics, phonemes, Retakes, Automation, and
Smart Pitch as shared content. A fresh reference count greater than one fails
by default unless the caller explicitly chooses all-reference intent and
supplies the matching fresh count.

Clone intent is one of:

- `linked`: intentionally share the target Note Group;
- `isolated`: clone the Note Group and verify distinct UUID, reference count,
  and target association; confirm the unchanged source through a separate
  fresh host read;
- `shell`: create a verified-empty track shell.

No `deepCopy` boolean exists in v3.

## Transport and recovery

The persistent Lua executor claims one request at a time. Node also serializes
transport calls, so there is one logical writer and no lock service. Temporary
and stale transport files are recovered according to session identity.

The installer stages Node-owned Lua/Sidebar files, verifies source hashes,
replaces the installed set, and restores the previous set on replacement
failure. Runtime code does not access GitHub, Git, or any network service.
