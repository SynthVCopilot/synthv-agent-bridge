# v3 Architecture Baseline

Status: implemented alpha baseline

Decision date: 2026-07-30

This document defines the authoritative architecture for Bridge v3. The
implemented alpha contains the six-tool Facade, protocol-v3 envelope, typed
Contexts, command result model, build-coherence gate, redacted tracing, and
the first common command slice. Remaining action migrations are tracked in
[the v3 development plan](v3-development-plan.md).

## Outcome

The target architecture is:

> CQRS-lite + session-scoped versioned snapshots + cache-aside +
> optimistic concurrency control + one serialized Lua command executor.

Synthesizer V remains the sole authority for live project state. Node may cache
bounded immutable projections, but a cache entry never authorizes a project
write. Lua must freshly resolve and validate every write against the current
host state.

## Goals

- Keep ordinary Agent workflows to one focused read and one logical write.
- Keep the public MCP surface at six compact v3 tools.
- Make project writes fail closed, independently verifiable, and recoverable
  with one clearly reported SynthV Undo boundary.
- Prevent shared Note Group content from being mistaken for reference-local
  data.
- Make normal responses small while preserving enough structured telemetry to
  debug failures without reproducing user content in logs.
- Migrate internal actions by tested vertical slices while making one
  intentional public/protocol breaking change from v2 to v3.

## Non-goals

- Building a second project database or a durable read replica.
- Event sourcing or reconstructing SynthV state from Bridge commands.
- Claiming MVCC, snapshot isolation, automatic rollback, or distributed
  transactions.
- Parsing, modifying, or monitoring `.svp` files as a source of live state.
- Replacing file IPC before measurements show that transport is the dominant
  remaining bottleneck.
- Mirroring the complete SynthV object graph in TypeScript.
- Moving artistic or target-selection decisions from the Agent and user into
  TypeScript or Lua.

## Existing contracts that remain authoritative

v3 does not weaken the repository safety invariants:

- File IPC protocol v3 is the only request/response envelope.
- Track, Group, and note indices remain 1-based at the protocol boundary.
- The public MCP surface is `sv_status`, `sv_describe`, `sv_query`,
  `sv_command`, `sv_ui`, and `sv_review`.
- `contextId` and Guard Tokens remain opaque, target-typed, scope-bound, and
  invalid after session change or eviction.
- Every ordinary write and independent transaction step completes preflight
  before `Project:newUndoRecord()`.
- A dependent transaction step is resolved and preflighted immediately before
  its mutation.
- Shared Group content writes default to rejection.
- SynthV is the project-state authority and the user is the listening and
  artistic authority.
- The Node process remains network-free by default.
- `.svp` files are never parsed or mutated by the Bridge.

## Target component model

```text
Agent / MCP client
        |
        | six compact v3 tools
        v
Intent Facade
  |                     |
  | query               | command
  v                     v
Query Projector      Command Dispatcher
  |                     |
  v                     v
Snapshot Proxy       Resolve -> Fresh Read -> Guard -> Preflight
  |                  -> Undo -> Mutate -> Verify -> Compact Result
  |                     |
  +----------+----------+
             |
             | file IPC protocol v3
             v
       Persistent Lua executor
             |
             v
       Synthesizer V project
       (sole live authority)
```

Cross-cutting components attach to the Facade, projector, dispatcher, IPC
client, and Lua executor:

- session tracker;
- typed Context and Guard stores;
- trace/correlation service;
- redaction policy;
- response-size and latency metrics.

## Domain boundaries

The Bridge must model ownership instead of treating a Track clone as an
isolated object-graph clone.

### GroupContent aggregate

Identity: current SynthV session + `NoteGroup` UUID.

Includes:

- notes, lyrics, note attributes, user phonemes, and phoneme properties;
- AI Retake content associated with notes;
- Automation curves;
- Smart Pitch points and curves;
- the Note Group name and other genuinely Group-owned data.

All references to the same Note Group observe this content. Every
content-mutating command must fresh-read the reference count and enforce
`sharedGroupPolicy`.

### GroupReference aggregate

Identity: current SynthV session + Track locator + reference locator and
fingerprint.

Includes:

- target Group association;
- time and pitch offsets;
- reference time range and mute state;
- Group Voice properties, explicit Vocal Mode parameters, and other
  reference-local values exposed by the official API.

A copied `NoteGroupReference` may still target the original `NoteGroup`.
Reference cloning is therefore not proof of GroupContent isolation.

### TrackShell aggregate

Identity: current SynthV session + Track locator and fingerprint.

Includes:

- Track name, display order, color, mixer, and bounced state;
- ordered Group references;
- the host-owned main Group context.

`clone_track_shell` is the preferred way to create one verified-empty track
while inheriting the host-cloned main Vocal context.

### ProjectTimeline aggregate

Identity: current SynthV session + time-axis fingerprint.

Includes tempo and measure marks and all conversion state required to map
blicks to seconds.

### UI state

Selection, navigation, dialogs, clipboard, and playback are not project
aggregates. UI actions return the host state observed after the request and do
not create project Undo records.

## CQRS-lite boundary

CQRS-lite separates behavior and representations, not storage:

- Queries never mutate SynthV and return compact DTO projections.
- Commands represent explicit user/Agent intent and own validation,
  concurrency checks, mutation, and postcondition verification.
- Both paths ultimately read the same current SynthV project.
- There is no second durable data store and no event stream.

The v3 public MCP tools remain stable. Query and command separation is visible
as `sv_query` versus `sv_command`, while detailed actions remain internal.

## Snapshot and cache policy

### What may be cached

Node may retain bounded, immutable, serialized values:

- static action descriptions and schemas;
- compact read projections;
- the existing Context/Guard bindings;
- short-lived computed-data results keyed to a reference-specific input
  version;
- redacted trace metadata and aggregate counters.

Lua must not retain long-lived SynthV object references between commands.

### Cache entry identity

A mutable-state snapshot key must include:

- SynthV session token;
- target kind and complete locator;
- requested projection/include shape;
- the relevant Guard or aggregate version digest;
- for computed pitch or phonemes, the Group reference and all known input
  dependencies needed to prevent cross-reference reuse.

### Freshness classes

Every mutable projection is internally classified as one of:

- `hostVerified`: obtained from the current host request or its verified
  postcondition read;
- `sessionCached`: reusable for a read-only response within policy limits, but
  not known to include later manual edits;
- `dirty`: invalidated by a session event, Bridge write, dependency change, or
  explicit refresh;
- `expired`: removed by age, weight, or entry-count policy.

Only `hostVerified` data may mint a write-capable Context. A
`sessionCached` result must not be used to authorize or preflight a write.

### Read behavior

- Read paths that mint write-capable Contexts always reach the host.
- Pure status, description, and explicitly cache-tolerant read-only
  projections may use `sessionCached` entries.
- A cache hit reports compact freshness metadata in support/debug telemetry,
  not verbose cache internals in the normal Agent response.
- Cache misses and dirty entries fall back to the current file IPC read.

### Write behavior

For every write:

1. Node expands the typed Context and Guard data.
2. Lua resolves the current target from SynthV.
3. Lua recomputes and compares the applicable current fingerprint or version.
4. Lua completes full preflight.
5. Lua creates one Undo boundary and performs the mutation.
6. Lua rereads supported postconditions.
7. Node invalidates touched snapshot keys and may populate a new
   `hostVerified` projection from the verified result.

Refreshing a cache after a Bridge-originated write is an optimization. It does
not make the cache authoritative because user edits and other scripts can
bypass the Bridge.

## Concurrency model

The Bridge uses optimistic concurrency control, not MVCC:

- Contexts and Guard Tokens bind a caller to a previously observed scope.
- Lua compares that expectation with the current SynthV object state.
- A mismatch fails before the Undo boundary.
- The Bridge does not expose historical versions or concurrent snapshot
  isolation.
- Recent immutable projections may be retained for diagnostics or compact
  diffs, but they are not transaction versions.

Node and Lua keep a single logical writer:

- Node serializes file IPC operations.
- The persistent Lua executor handles one claimed request at a time.
- No per-object lock manager is added.

## Command lifecycle

Every ordinary project command follows the same observable stages:

1. `accepted`: validate the public schema and route.
2. `resolved`: expand Context/Guard data without overriding conflicting
   explicit scope.
3. `freshRead`: resolve current SynthV objects and collect required state.
4. `guarded`: compare concurrency expectations and shared-content policy.
5. `preflighted`: validate all prepared values and host capabilities.
6. `undoOpened`: create the one SynthV recovery boundary.
7. `mutated`: call official API mutations.
8. `verified`: reread supported postconditions.
9. `projected`: return a minimal acknowledgement and replacement Context.

An operation cannot report success only because no exception was thrown.
Every successful write must report an expected affected count or another
action-specific postcondition. An unexpected zero-effect mutation is
`HOST_POSTCONDITION_FAILED` or a more specific existing error.

Transactions retain the existing independent/dependent preflight rules.
`singleUndoRecord` continues to describe a recovery boundary rather than an
automatic rollback guarantee.

## Clone semantics

The public intent must be explicit:

- `linked`: new references intentionally target existing GroupContent.
- `isolated`: each non-main GroupContent target is separately cloned and
  verified.
- `shell`: one verified-empty host-cloned Track shell.

`isolated` success requires all of the following:

- every cloned content target has a different Group UUID from its source;
- each expected new Group has the intended fresh reference count;
- source note, Automation, and Smart Pitch summaries are unchanged;
- a postcondition proves that references point to the intended targets;
- non-main Vocal identity limitations are reported and require manual review.

No boolean named only `deepCopy` is sufficient to represent these semantics.

## Response projections

Normal Agent responses prioritize intent and outcome:

- `traceId`;
- success/error code;
- affected counts and durable identifiers;
- warnings and manual Vocal review requirements;
- one-Undo guidance when applicable;
- replacement `contextId` when safe.

Normal responses omit:

- raw fingerprints;
- full before/after objects;
- lyrics and note lists not explicitly requested;
- stack traces;
- cache keys and internal filenames.

Support/debug representations are defined in
[ADR-0006](adr/0006-observability-and-redaction.md).

## Error and recovery policy

Errors are classified by phase and recovery:

- input/scope errors: correct the request; no project write occurred;
- stale/session errors: reread the target; do not reuse old Contexts;
- shared-content policy errors: choose linked/all-reference intent explicitly;
- host capability errors: choose a supported operation or require manual work;
- postcondition errors before mutation: no Undo required;
- execution or dependent-step errors after mutation began: report
  `undoRequired` and require one SynthV Undo before reread or retry.

Large raw Guard values are never included in a normal error. Support telemetry
uses hashes, counts, target kinds, and phase information.

## Proposed internal seams

The migration may introduce these seams without requiring an immediate
directory rewrite:

- Query projector: builds bounded DTOs and projection identities.
- Snapshot proxy: owns cache-aside policy and freshness state.
- Command dispatcher: owns the common lifecycle and action routing.
- Domain target resolver: distinguishes GroupContent, GroupReference,
  TrackShell, ProjectTimeline, and UI state.
- Trace collector: correlates MCP, Context expansion, file IPC, Lua stages, and
  result projection.
- Host adapter/fake host: gives Lua command behavior a deterministic test seam.

Existing functions move behind these seams one vertical slice at a time.

## Delivery and acceptance

Implementation order, rollback rules, and phase exit criteria are in
[the v3 development plan](v3-development-plan.md).

Required tests are in [the v3 test matrix](v3-test-matrix.md).

Initial response, latency, cache, and observability budgets are in
[the v3 performance budget](v3-performance-budget.md).

Architecture decisions are indexed in [ADR index](adr/README.md).

Frozen companion contracts:

- [v3 domain model](domain-model-v3.md);
- [v3 command state machine](command-state-machine-v3.md);
- [v3 public error catalog](errors-v3.md);
- [protocol v3](protocol.md);
- [SV2 API coverage matrix](sv2-api-coverage-v3.md);
- [atomic upgrade and rollback](atomic-upgrade-v3.md).
