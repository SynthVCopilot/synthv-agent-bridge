# v3 Incremental Development Plan

Status: active; Phases 0-1 complete, Phases 2-4 have alpha foundations

Date: 2026-07-30

The public v2 surface and protocol have been replaced by v3. Existing proven
action handlers remain private migration adapters while internal slices move
behind the v3 Query Projector and Command Kernel.

## Global migration rules

- No big-bang rewrite.
- No runtime v2/v3 dual stack.
- Preserve the six public v3 tools and protocol-v3 envelope.
- No project write is shadow-executed.
- Every behavior change starts with a regression or acceptance test.
- Every migrated write has an affected-count or action-specific
  postcondition.
- Existing safety checks remain in force until an equivalent tested v3
  check replaces them.
- Old code is removed only after automated parity and real SynthV acceptance.
- Each phase can be released or reverted independently.

## Phase 0: v3 contract freeze — complete

Deliver:

- `architecture-v3.md`;
- accepted ADRs;
- this migration plan;
- test matrix;
- performance/token budget.

Exit criteria:

- documents use the current protocol and error terminology;
- the six tools, v3 envelope, outcome model, and atomic upgrade contract agree
  with the alpha code;
- existing repository checks pass.

## Phase 1: accident regression safety net — complete

Deliver:

- independently named clone, shared ownership, stale Guard, no-op,
  Automation endpoint, redaction, Undo, session, postcondition, and partial
  write tests;
- a fault-injectable Lua fake-host harness;
- compact stale fingerprints and closed-range Automation verification.

Exit criteria:

- all accident regressions execute as behavior tests;
- the complete automated repository check passes.

## Phase 2: correlation, build identity, and command-stage telemetry — implementation complete, real-host gate pending

Deliver:

- one `traceId` spanning MCP call, Context expansion, IPC request, Lua result,
  and final projection;
- stable command-stage names;
- normal/support redaction policy;
- timing and character-count collection;
- tests proving default logs contain no musical content.

Implemented alpha slice:

- one cross-layer `traceId`, IPC byte/timing events, bounded recent summaries,
  redacted public errors, and Build Identity/coherence gating.
- a strict optional protocol telemetry block containing only numeric Lua stage
  timings;
- exact fresh-read, Guard, preflight, Undo, mutation, and verification timing
  for the migrated mixer command, with common coarse lifecycle timing for
  remaining legacy-adapter commands;
- explicit `sv_status(operation="diagnostics")` support/debug projections,
  bounded to 8 KB/16 KB and absent from ordinary status responses.
- real SynthV Studio 2 Pro 2.2.1 standalone confirmation of the installed
  telemetry path. A 30-sample read-only `get_track_mixer` run observed 149 ms
  tool-side p95 and 77 ms Bridge-internal p95, within the ordinary 300 ms
  operation budget.

Still required before closing the phase:

- a controlled tracing-on/tracing-off comparison against the 5% p95 overhead
  target. The current sample measures the instrumented path, not tracing's
  isolated incremental cost.

Exit criteria:

- all v3 MCP results remain schema-compatible;
- errors identify the last completed stage;
- trace overhead meets the initial budget;
- no lyrics, phonemes, notes, curves, or raw fingerprints appear by default.

Rollback:

- disable the new collector while leaving request behavior unchanged.

## Phase 3: v3 Query Facade and compact response envelope — in progress

Deliver:

- one shared model-facing result projector;
- affected-count/durable-identifier write acknowledgements;
- compact stale and postcondition errors;
- server-side storage of verbose Guard details;
- explicit projection-size measurements.

Shadow validation:

- run old and new read projectors over the same already-returned host result;
- compare all requested semantic fields;
- return only the old projection until parity passes.

The six-tool Facade, typed Context modes, and compact Command outcomes are
implemented. Shadow projection parity, complete pagination budgets, and action
coverage remain open.

The first focused-query slice is also implemented: `get_track_mixer` carries a
private Track guard to Node, so a `writeIntent` query can mint one directly
reusable Track `contextId`. The public projection removes the Guard and keeps
the intended one-focused-read plus one-logical-command workflow.

The same Mixer read is the first shadow-projection slice. The new Query
Projector independently builds a bounded candidate from the already-returned
host result, compares it with the established public projection, and records
only parity and field counts. It performs no second host read and keeps the
established projection public while parity validation expands to other
queries.

Current slice record:

- Goal: prove the Query Projector seam on `get_track_mixer` using the same raw
  host result as the established projection.
- Non-goals: changing the public Mixer DTO, authorizing writes, enabling the
  Snapshot cache, or migrating other Query actions.
- Existing action/path: `sv_query` -> private `sv_read` adapter ->
  `get_track_mixer`.
- Target aggregate: `TrackShell` Mixer state.
- Public compatibility: the established projection remains the returned
  result; the candidate never becomes model-facing in this slice.
- Safety invariants: private fingerprints remain excluded even when requested,
  comparison telemetry contains only allowlisted counts, and no second host
  request is made.
- Regression fixture: one real file-IPC request with a private Track
  fingerprint, explicit public/private field selection, parity/mismatch unit
  cases, and debug Trace inspection.
- Automated acceptance: candidate parity, mismatch count, private-field count,
  one host read, Context issuance, and unchanged public values.
- Real SynthV acceptance: restart the Node MCP process, run one read-only Mixer
  query, and inspect its `shadowProjected` debug stage. Completed on
  SynthV Studio 2 Pro 2.2.1 standalone: the 73 ms Query used one IPC host
  request, the 6 ms shadow stage matched all 7 compared fields with 0
  differences, and 1 private fingerprint field remained excluded.
- Performance budget: no additional IPC; pure projection remains within the
  10 ms target.
- Rollback: remove the shadow call and module; the established public
  projection is unchanged.

Next slice record:

- Goal: extend the same shadow seam to `get_group_voice` and prove both its
  compact default and explicitly requested diagnostic fields.
- Non-goals: changing the Group Voice DTO, enabling cache reuse, interpreting
  singer identity, or exposing untouched default Vocal Mode names.
- Existing action/path: `sv_query` -> private `sv_read` adapter ->
  `get_group_voice`.
- Target aggregate: `GroupReference` Voice state.
- Public compatibility: default output remains Track/Group locators,
  `parameters`, `vocalModes`, and `contextId`; explicitly requested documented
  fields keep their established values.
- Safety invariants: `groupUuid` and `referenceFingerprint` remain private even
  if requested, raw Voice data appears only when explicitly requested,
  telemetry contains counts only, and the candidate performs no host read.
- Regression fixture: one file-IPC Group Voice result containing compact,
  diagnostic, selection, and private Guard fields.
- Automated acceptance: default and explicit-field parity, private-field
  exclusion/counting, one host read, Context issuance, and bounded Trace
  metadata.
- Real SynthV acceptance: completed on the current piano-roll Group in
  SynthV Studio 2 Pro 2.2.1 standalone. The compact Query completed in 52 ms
  with a 6 ms shadow stage (`5` compared, `0` different, `2` private); the
  explicit-diagnostics Query completed in 61 ms with a 4 ms shadow stage
  (`7` compared, `0` different, `2` private). Each Trace contained one IPC
  request/response pair and no project mutation or Undo.
- Performance budget: no additional IPC and pure Node projection within 10 ms.
- Rollback: remove `get_group_voice` from the shadow definition registry; the
  established public projection remains unchanged.

Exit criteria:

- ordinary reads/writes meet size targets;
- Dense/page reconstruction is lossless;
- no normal error contains a complete fingerprint;
- no extra host read is introduced solely for projection.

Rollback:

- route the affected action back to the existing projector.

## Phase 4: common command lifecycle — first slice implemented

Deliver:

- a Command Dispatcher implementing accepted through projected stages;
- common preflight/Undo/postcondition helpers;
- affected-count enforcement;
- consistent `undoRequired` reporting.

Initial project-write slice:

- choose a bounded, already well-tested reference-local or mixer write;
- do not begin with track cloning or a multi-curve transaction.

Exit criteria:

- stale and invalid inputs fail before Undo;
- successful command creates exactly one Undo record;
- forced no-op and verification mismatch cannot return success;
- real SynthV manual test matches the fake-host result.

Rollback:

- restore that action's previous handler; the public schema remains unchanged.

## Phase 5: aggregate ownership and safe clone slices

Deliver:

- explicit target-kind resolvers for GroupContent, GroupReference, TrackShell,
  and ProjectTimeline;
- reference-count-aware content write policy in the common pipeline;
- explicit linked/isolated/shell clone strategies;
- fake-host clone and ownership model;
- source-unchanged and UUID/reference-count postconditions.

Order:

1. linked Group reference creation;
2. isolated single Group reference clone;
3. verified-empty Track shell;
4. Track clone containing non-main Groups.

Exit criteria:

- CLN-001 through CLN-007 pass;
- deleting or tuning an isolated clone cannot affect its source;
- ambiguous non-main cloning fails closed;
- non-main Vocal limitations are reported without invented identities;
- manual SynthV isolation test passes on a working copy.

Rollback:

- disable the newly migrated clone strategy and keep safe rejection.

## Phase 6: Group aggregate commands

Deliver:

- migrate `apply_group_tuning` into the common lifecycle;
- one complete preflight across Voice/Vocal Modes, notes/phonemes, Automation,
  and Smart Pitch inputs;
- one Undo record and one independent postcondition read;
- exact Automation boundary verification.

Exit criteria:

- multi-curve same-Group tuning no longer requires separate logical commands;
- every current host range comes from the same fresh definition read;
- unexpected endpoint residue fails verification;
- stale errors remain compact;
- ordinary Agent flow is one read plus one write.

Rollback:

- retain the old guarded action and do not split a failed logical write into
  multiple automatic retries.

## Phase 7: measured performance optimization

Deliver:

- immutable projection keys and freshness classes;
- bounded entry/weight/age eviction;
- read-only cache-aside path;
- Bridge-write invalidation and verified-result repopulation;
- session-wide invalidation;
- support metrics for hit, miss, dirty reason, age, and fallback.

Restrictions:

- write-capable Context reads always reach SynthV;
- no long-lived Lua host object references;
- no background full-project synchronization;
- no persistent cache database;
- no cache-based automatic write retry.

Exit criteria:

- CAC-001 through CAC-006 pass;
- a deliberately stale read cache cannot cause an unsafe write;
- cache failure degrades to host reads;
- measured hit rate and latency justify keeping the cache.

Rollback:

- bypass and clear the snapshot proxy; authoritative behavior remains intact.

## Phase 8: migrate remaining actions and remove v2 adapters

Deliver:

- action-by-action migration inventory;
- old/new parity tests;
- removal of duplicated per-handler lifecycle code;
- updated architecture.md describing implemented rather than planned behavior.

Migration priority:

1. destructive note and Smart Pitch writes;
2. Automation and same-Group tuning;
3. Group/reference/library mutations;
4. track and time-axis mutations;
5. transactions;
6. UI actions where the common trace adds value.

Exit criteria:

- all ordinary writes use the common lifecycle;
- no success path lacks a postcondition;
- existing action catalog remains complete;
- current and v3 documentation no longer disagree.

## Phase 9: stable 0.2.0 release gate and transport decision

Collect:

- response-size distribution;
- Agent interaction count per common workflow;
- IPC queue and polling delay;
- host preflight/mutation/verification time;
- cache hit rate and invalidation cost;
- trace overhead.

Only if file IPC remains the dominant measured cost should a new ADR evaluate a
named pipe or another local transport. Any future transport must retain local,
network-free defaults and the versioned protocol semantics.

## Per-slice work template

Each implementation task records:

```markdown
Goal:
Non-goals:
Existing action/path:
Target aggregate:
Public compatibility:
Safety invariants:
Regression fixture:
Automated acceptance:
Real SynthV acceptance:
Performance budget:
Rollback path:
```

The task is complete only when code, tests, documentation, and the applicable
manual SynthV result agree.
