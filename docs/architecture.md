# Architecture

## Components

```text
MCP client (Codex / compatible local stdio host)
                 │ stdio MCP
                 ▼
       TypeScript MCP server
                 │ request/response JSON files
                 ▼
  SynthVAgentBridge.lua (persistent script)
                 │ Synthesizer V scripting API
                 ▼
       Current SynthV project and UI

  SynthVAgentSidebar.lua (optional native panel)
                 │ instruction/preview/command text sideband
                 └──────── TypeScript sidebar coordinator
```

The TypeScript process never parses or rewrites `.svp` files. All project mutations run inside Synthesizer V through its public scripting object model.

## Why file IPC

SynthV scripts expose filesystem access through Lua, while a stable socket API is not documented. File IPC is slower than a local socket but is portable, inspectable, and easy to recover after a crash. Version 0.1 deliberately prioritizes correctness over throughput.

The channel contains a single in-flight transaction:

- `synthv-agent-bridge.request.json`
- `synthv-agent-bridge.processing.json`
- `synthv-agent-bridge.response.json`
- `synthv-agent-bridge.status.json`
- `synthv-agent-bridge.lock`
- `synthv-agent-bridge.session.json`
- `synthv-agent-bridge.stop`

The optional v0.1.4 side panel uses a separate local sideband:

- `synthv-agent-bridge.sidebar.instruction.txt`
- `synthv-agent-bridge.sidebar.preview.json` (Node-private structured plan)
- `synthv-agent-bridge.sidebar.preview.txt` (display-only panel text)
- `synthv-agent-bridge.sidebar.command.txt`
- `synthv-agent-bridge.sidebar.activity.txt`
- `synthv-agent-bridge.sidebar.client-status.txt`
- `synthv-agent-bridge.sidebar.state.txt`
- `synthv-agent-bridge.sidebar.history.json`

The panel never writes the project. An Apply click creates a sideband command;
the TypeScript coordinator claims it and submits the stored action through the
same serialized `FileIpcClient` and preferred v2 request channel as a normal
MCP call.
None of these sideband files or the panel script is required for the core
stdio server, file IPC executor, reads, writes, transactions, or Guard checks.

The Node side serializes calls and owns the lock. It writes requests using a temporary file plus rename. The Lua side claims a request by renaming it to the processing filename, executes it on SynthV's script thread, and publishes one correlated response.

## Compact MCP boundary

P4 makes the compact surface the default. Sixty-three file-protocol actions are
kept behind eight MCP tools and a just-in-time schema catalog. This keeps action
validation and the Lua executor unchanged while reducing the default serialized
tool metadata from roughly 72 KB to under 6 KB.

`sv_read` can issue one opaque `contextId` for the returned scope. The bounded
Node entry contains only locators and complete note, Smart Pitch, automation,
track, reference, library, or time-axis guards. A later v2 call expands that
handle back into the ordinary action payload before file IPC. Manual edits are
therefore detected by the existing Lua fingerprint checks; contexts do not
cache or claim that musical state is current.

Phrase projections are also applied inside the Lua executor. Voice,
automation, analysis, recommendations, selection diagnostics, and computed
pitch summaries are skipped when they were not requested. The Node boundary
then removes redundant note end coordinates, bundles guards into `contextId`,
and optionally returns large note arrays as a single column header plus rows.
Write acknowledgements default to counts, durable identifiers, and a
replacement context rather than complete mutated objects.

Full Bridge fingerprints deliberately contain all guarded state, which can
be large for automation curves and attribute-heavy notes. Compact MCP reads
replace those values with random, scope-bound Guard Tokens held in a bounded
Node memory cache. A compact write resolves the token back to the original
fingerprint before entering file IPC. SynthV therefore performs the same
complete stale-state comparison as a full request, while the model sees only a
short opaque handle.

Compact phoneme reads also filter inside the Lua executor by note index or
absolute seconds before serialization. Compact write acknowledgements omit
complete notes and curves. Full mode remains unchanged for clients that need
every host field.

P1 adds projection fast paths. Unfiltered pagination and exact note-index reads
fetch only the returned page instead of walking the complete Group. Time-range
reads convert the two second boundaries to blicks once and stop when sorted note
onsets pass the range. Attribute snapshots are sanitized once and reused for
both the response and the unchanged complete fingerprint. Callers that only
need Guard Tokens or user overrides can disable host-computed phonemes.

The persistent Lua executor checks for requests every 25 ms, while the Node
client checks for a completed response every 10 ms by default. Session
ownership is checked every 250 ms and the heartbeat remains one second, keeping
idle file reads bounded while reducing request wake-up latency.

P2 adds a request-scoped phrase context rather than a cross-request cache.
Selected notes, an explicit note list, or an absolute-seconds range are scanned
through the same P1 projections. The executor reuses those notes to derive
bounded rhythm/pitch diagnostics, compact Group voice data, automation
summaries, and optional aggregate computed-pitch metrics. The Node boundary
replaces nested note and automation fingerprints with scope-bound Guard Tokens.
This collapses the normal selection, note, voice, automation, and pitch-analysis
read sequence into one correlated IPC request while ensuring every result
reflects the current SynthV project state.

P3 uses the compact protocol-v2 envelope and adds three bounded read paths.
`rangeMatch: "overlap"` remains the complete path;
`"onset"` uses binary search over SynthV's onset-sorted notes and explicitly
reports that a sustain beginning before the range may be absent. Page cursors
live only in the MCP process and bind the next index to the previous boundary
note fingerprint, so continuation avoids skipped-note traversal without
caching mutable note data. Multi-range reads convert all boundaries once,
sweep the Group once, serialize the union of matching notes once, and reference
that shared array from per-range analyses. Automation is serialized and
fingerprinted once per parameter, then sampled for every requested range.

## Responsibility boundary

Musical intent and execution safety are deliberately separated. The user and
Agent decide what a phrase should express and supply explicit targets and
values. The TypeScript MCP layer transports that decision compactly without
inventing musical data. The Lua executor resolves it against current SynthV
state, performs deterministic calculations, validates the complete write, and
owns the single undo boundary. SynthV and the user remain the final state and
listening authorities.

The complete responsibility table and batch-design rules are documented in
[Agent / MCP responsibility boundaries](responsibility-boundaries.md).

## Transaction layer

`apply_transaction` accepts up to 32 existing project-write actions. Before
creating an undo record, the Lua executor runs every step in validation mode.
A shared undo-record helper intercepts each step at its normal
`Project:newUndoRecord()` boundary while keeping the real SynthV `Project`
object intact. This occurs after that handler has completed its input,
fingerprint, clone, and host-capability checks. If every step passes, the
executor creates one real undo record and reruns the steps while suppressing
their nested undo calls.

The generic engine conservatively rejects multiple forward steps that mutate
the same guarded scope. This avoids making a later step's preflight depend on
an earlier mutation. Index-shifting track and library-group deletes are
exclusive single-step transactions. Common dependent operations are
implemented as dedicated single-write actions such as
`create_harmony_track`.

Optional reverse steps are resolved from forward results and retained only in
Bridge memory, associated with the current project/session. A later
`rollback_transaction` revalidates those steps and applies them in one new undo
record. A Bridge reload intentionally discards this volatile rollback state.

## Safety model

Destructive note, Smart Pitch, Group reference, library Group, track,
automation, and time-axis operations use optimistic concurrency:

1. Read notes with `get_track_notes` or `get_selection`.
2. Receive the applicable UUID and object fingerprint.
3. Send those guards back with the write request.
4. The Lua bridge rechecks every target and validates detached clones or
   complete prepared inputs before changing anything.
5. If any target changed, the complete request is rejected with the applicable
   `STALE_*` error.

All inputs are validated before an undo record is created. Each successful
write tool or transaction creates one SynthV undo record, so the user can undo
the operation in the editor. If an unexpected host exception occurs only after
transaction execution begins, the single undo record is the recovery boundary;
the Bridge reports the failure and directs the user to **Edit > Undo**.

Selection, viewport, clipboard, dialog, and playback controls change host UI
state rather than project model data and therefore do not create undo records.
Bridge metadata is restricted to the `synthv-agent-bridge.` script-data
namespace so other scripts' stored data is never enumerated or cleared.

## Trust boundary

The MCP server is intentionally local and uses stdio. It does not open a network listener, upload projects, or call an AI API. The connected MCP host decides which model sees tool results.

## Timeout semantics

After SynthV renames a request to the processing filename, that file is owned by the Lua host. The Node client does not delete it when a request times out, which prevents another write from overlapping a still-running editor operation. A timeout does not prove that the edit failed: SynthV may complete after the MCP caller stops waiting. Clients must read the affected state before retrying a write. A stale processing marker can be recovered after the configured stale-request interval if the host crashed.

The stale-request interval must be greater than the response timeout. The Node configuration loader enforces this invariant so a live operation cannot be reclaimed as stale while its original caller is still waiting.
