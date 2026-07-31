# SynthV Agent Bridge v3 Phases 4–6 Design

Status: approved for implementation

Date: 2026-07-30

Branch: `codex/v3-implementation`

## 1. Decision

Complete the original v3 Phase 4, Phase 5, and Phase 6 scope as one continuous
delivery with independently verifiable checkpoints:

- Phase 4: introduce the common Command Kernel and migrate one low-risk write;
- Phase 5: migrate every high-risk project-write family through that Kernel;
- Phase 6: optimize measured bottlenecks, finish the official API coverage
  classification, and remove the superseded v2 execution paths.

The implementation uses a strangler migration inside the existing v3 branch.
It is not a second public API, a Node-only wrapper around legacy behavior, or a
big-bang Lua rewrite.

The six-tool MCP surface and file IPC protocol v3 remain frozen. SynthV remains
the sole live authority.

## 2. Goals

- Give every project command one observable, testable lifecycle.
- Make success mean either a verified change or an explicitly verified
  `alreadySatisfied` state.
- Preserve one SynthV Undo recovery boundary for one logical command.
- Prevent shared Group content and clone semantics from being misclassified.
- Migrate destructive and aggregate commands without weakening current Guards,
  range checks, or postconditions.
- Reduce model-facing payloads and redundant host work using measurements
  rather than speculative infrastructure.
- Leave one maintainable v3 command path with complete API classification and
  no runtime v2 compatibility stack.
- Minimize required user interaction during development and real-host testing.

## 3. Non-goals

- Supporting the Synthesizer V Studio 1 editor.
- Adding a general Lua API passthrough.
- Parsing or monitoring `.svp` files.
- Adding SQLite, Redis, a durable project mirror, event sourcing, or MVCC.
- Adding a background full-project scanner.
- Moving tuning knowledge or artistic decisions into TypeScript or Lua.
- Changing file transport before telemetry identifies it as the dominant
  remaining cost.
- Claiming automatic rollback after a partial host write.

## 4. Chosen implementation approach

### 4.1 Common Node command boundary

`sv_command` routes every command through one action-neutral dispatcher. The
dispatcher owns:

1. public schema acceptance;
2. typed Context and Guard expansion;
3. conflicting-locator rejection;
4. build-coherence write blocking;
5. command Trace creation and stage projection;
6. v3 result normalization;
7. public redaction and size enforcement;
8. cache invalidation after verified writes.

It does not authorize a write from cached state or duplicate host-owned
preflight.

### 4.2 Common Lua execution contract

Each migrated Lua handler supplies an action-specific adapter to a shared
execution contract:

```text
freshRead -> guard -> preflight -> effectPlan
          -> undo -> mutate -> verify
```

The shared contract owns stage ordering, effect classification, Undo placement,
failure recovery metadata, and compact verification summaries. Action adapters
own only domain-specific target resolution, current-state reads, validation,
mutation, and postcondition comparison.

The legacy action handler may coexist during one slice, but it is removed after
the migrated path passes behavior parity and real-host acceptance.

### 4.3 Effect Plan

Preflight produces a serializable effect plan before opening Undo. It records:

- target kind and redacted locator digest;
- expected affected counts;
- prepared domain values;
- whether the current state already satisfies the request;
- shared-ownership decision and current reference count where applicable;
- required postconditions;
- whether any step depends on a previous batch result.

The plan contains no long-lived SynthV object references. Targets are freshly
resolved in the same Lua request and remain local to that request.

Effect classification is:

- `changed`: mutation occurred, postconditions matched, and one logical Undo
  boundary was created;
- `alreadySatisfied`: the requested postconditions already held before Undo,
  so no mutation and no Undo occurred;
- `failed`: the result identifies the last stage, whether any mutation began,
  and whether one SynthV Undo is required.

An unexpected zero affected count after a planned mutation is
`HOST_POSTCONDITION_FAILED`.

## 5. Phase 4: common Command Kernel

### 5.1 Initial slice

Use `set_track_mixer` as the first project-write slice because it is bounded,
reference-independent, already covered by real-host tests, and its state is
easy to verify without musical interpretation.

### 5.2 Deliverables

- Node `CommandDispatcher` with a single v3 result projector.
- Shared command stage and recovery types.
- Lua command-pipeline helper and action adapter contract.
- `set_track_mixer` migrated end to end.
- Fault-injection seams for unexpected no-op, postcondition mismatch, and
  mutation-time failure.
- Compact support diagnostics for effect planning, Undo, and verification.

### 5.3 Exit gate

- Invalid and stale requests stop before Undo.
- An already-satisfied mixer request creates zero Undo records.
- A changed mixer request creates exactly one Undo record.
- Forced no-op and verification mismatch cannot return success.
- A post-mutation failure returns `undoRequired=true`.
- Automated and real SynthV results agree.

## 6. Phase 5: high-risk domain slices

Migrate in this order so that later aggregate commands reuse earlier ownership
and postcondition infrastructure.

### 6.1 Clone ownership

Migrate:

- linked Group reference creation;
- isolated Group reference cloning;
- verified-empty Track shell creation;
- Track cloning with explicit non-main Group policy.

Required postconditions:

- linked clones retain the source Group UUID and increase the expected
  reference count;
- isolated clones have different Group UUIDs, intended reference counts, and
  unchanged source note/Automation/Smart Pitch summaries;
- shell clones are verified empty;
- ambiguous non-main Vocal Group cloning fails closed;
- detached Vocal identity limitations produce a manual-review warning without
  claiming a Vocal identity.

### 6.2 Guarded note edit and delete

All note mutations require current note/Group Guards and explicit scope.
Shared Group content defaults to rejection. Source geometry outside the target
scope remains unchanged.

### 6.3 `transform_notes`

`target: "contextNotes"` expands only a fresh write-intent Context. Mechanical
onset, duration, and pitch transforms use explicit Agent-provided values.
Seconds-based onset transforms use the same fresh time axis and preserve
durations in blicks. Existing user-owned gaps are not normalized implicitly.

### 6.4 `apply_group_tuning`

One effect plan spans Voice/Vocal Modes, note and phoneme properties,
Automation, and Smart Pitch for one Group. All independent inputs preflight
before Undo and the whole logical tuning pass creates one Undo record.

No tuning Skill or artistic rule is embedded in the Bridge. Real-host test
values are declared fixture values, not artistic recommendations.

### 6.5 Automation and Smart Pitch

- Automation ranges come from the same fresh host definition read.
- Closed-range removal rereads points and rejects endpoint residue.
- Stale curve and pitch Guards fail before Undo.
- Smart Pitch ownership follows GroupContent sharing rules.
- Public errors contain counts and digests, never raw curves or fingerprints.

### 6.6 Dependent batches

Independent steps are completely preflighted before Undo. A step using a whole
field `$result` reference to an earlier 1-based result is resolved and
preflighted immediately before its mutation.

If an earlier step wrote and a later dependent step fails:

- automatic retry is forbidden;
- the public result reports `undoRequired=true`;
- exactly one SynthV Undo is the recovery instruction.

### 6.7 Phase 5 exit gate

- Every high-risk family uses the common Kernel.
- The eleven incident regressions have independent behavioral coverage.
- Clone isolation, note ownership, Automation endpoints, aggregate Undo, and
  dependent failure recovery pass Fake Host and real SynthV acceptance.
- No migrated success path lacks an action-specific postcondition.

## 7. Phase 6: measured performance, API coverage, and cleanup

### 7.1 Optimization order

1. Remove unrequested computation and serialization.
2. Keep raw Guards and verbose host details server-side.
3. Aggregate one logical edit into one command.
4. Return compact deltas and postcondition summaries.
5. Measure repeated read-only work.
6. Add a bounded Snapshot LRU only if traces show material benefit.
7. Reprofile transport; keep file IPC unless it is the dominant remaining
   bottleneck.

### 7.2 Cache acceptance

If implemented, the cache:

- stores only immutable read-only projections and static schemas;
- keys by Session, target, projection, Reference, and dependency digest;
- never mints or authorizes a write-intent Context;
- invalidates on Session change and verified Bridge writes;
- degrades to a fresh host read on miss, corruption, or uncertainty;
- is removable without changing correctness.

If telemetry does not justify it, Phase 6 records that decision and ships
without the Snapshot LRU.

### 7.3 Official API coverage

Every official SV2 scripting class and method is classified as:

1. Agent semantic capability with a v3 Query, Command, or UI mapping;
2. Bridge-internal runtime capability;
3. unavailable through the official API or intentionally GUI-only;
4. intentionally not exposed, with a safety or usability reason.

Coverage records the host adapter method, preflight, postcondition, automated
test, and real-host test status where relevant. Coverage does not require a raw
method passthrough.

### 7.4 Legacy removal

After parity:

- remove the v2 public-surface adapters and protocol-v2 acceptance;
- remove duplicate per-handler Context, Undo, outcome, and error projection
  logic;
- retain only explicit protocol mismatch handling for old envelopes;
- update architecture documents to describe implemented v3 behavior;
- keep rollback at the Git release/build level, not as a live v2/v3 dual stack.

### 7.5 Phase 6 exit gate

- Public size and latency budgets pass.
- Build mismatch still blocks writes.
- API coverage has no unclassified official method.
- Runtime v2 execution paths and duplicated migrated lifecycles are gone.
- Full automated checks and the real-host matrix pass.
- The branch is suitable for `0.2.0` stabilization; this design does not by
  itself declare a stable release.

## 8. Safety and recovery

- SynthV is authoritative for every write.
- Build coherence is checked before project mutation.
- Every write-intent Context originates from a fresh host read.
- Shared Group content writes fail closed unless the caller explicitly accepts
  all references and supplies the current expected reference count.
- Guard, range, capability, and independent-batch validation finish before
  Undo.
- Postconditions reread only affected authoritative scopes.
- Any failure after mutation began clearly reports one Undo recovery
  requirement.
- No normal response or trace stores lyrics, note arrays, curve arrays, local
  score content, or raw fingerprints.
- Destructive real-host tests run only in the user-authorized saved test
  project.

## 9. Verification strategy

Each slice follows red-green-refactor:

1. add or isolate the incident/acceptance test;
2. prove the test fails for the intended reason;
3. implement the smallest end-to-end slice;
4. run focused tests;
5. run the complete repository checks;
6. install one coherent Node/Lua/Sidebar build;
7. run bounded real-host acceptance;
8. record timings, payload sizes, Undo count, source invariants, and recovery;
9. review the diff before committing and pushing the checkpoint.

Required repository checks remain:

```text
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
```

## 10. User-interaction policy

The Agent performs all repository, build, installation, Bridge, Sidebar, and
MCP checks that the available tools can safely complete.

The user is asked to act only when an official SynthV API limitation requires a
GUI observation or click. Such requests are grouped into the shortest possible
checklist. No additional approval is required for destructive experiments
inside the saved test project or for scoped development changes on the current
branch.

## 11. Delivery checkpoints

- Checkpoint A: Phase 4 Kernel and mixer slice.
- Checkpoint B: Phase 5 clone and Group ownership.
- Checkpoint C: Phase 5 notes and transforms.
- Checkpoint D: Phase 5 tuning, Automation, Smart Pitch, and dependent batches.
- Checkpoint E: Phase 6 measurement, API coverage, cleanup, and final review.

Each checkpoint is independently testable and reversible by Git. The complete
delivery remains on `codex/v3-implementation` and is pushed after verified
commits so remote history provides a recovery point.
