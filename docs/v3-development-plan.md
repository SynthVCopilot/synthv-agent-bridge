# v3 Incremental Development Plan

Status: Phases 0-9 complete; v0.2.0 released with a reduced-stable surface

Date: 2026-07-31

The public v2 surface and protocol have been replaced by v3. All live semantic
writes are classified by the v3 Command Policy catalog and enter the common
Command Dispatcher. Internal transport adapters use `v3_internal_*` names and
cannot be confused with public or legacy MCP tools.

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

## Phase 2: correlation, build identity, and command-stage telemetry — implemented

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
  for migrated commands, with common coarse lifecycle timing when an official
  host API cannot expose a finer stage;
- explicit `sv_status(operation="diagnostics")` support/debug projections,
  bounded to 8 KB/16 KB and absent from ordinary status responses.
- real SynthV Studio 2 Pro 2.2.1 standalone confirmation of the installed
  telemetry path. A 30-sample read-only `get_track_mixer` run observed 149 ms
  tool-side p95 and 77 ms Bridge-internal p95, within the ordinary 300 ms
  operation budget.

Stable-release performance evidence still required:

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

## Phase 3: v3 Query Facade and compact response envelope — complete

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

The six-tool Facade, typed Context modes, compact Command outcomes, shared
Query Projector, complete 17-Action Query policy registry, bounded host
collection defaults, compact Automation summary, and public response-budget
gate are implemented. Four representative legacy/new projector pairs run in
one-read shadow mode; the remaining Actions use the shared projector directly
and are protected by policy-completeness, Fake Host, Context, privacy, and
response-budget tests. Snapshot caching remains disabled.

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
- Existing action/path: `sv_query` -> v3 internal Query adapter ->
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
- Existing action/path: `sv_query` -> v3 internal Query adapter ->
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

Following collection slice:

- Goal: extend shadow validation to `list_tracks`, including ordered collection
  projection and one nested read-only Track `contextId` per item.
- Non-goals: pagination, Snapshot cache activation, Track mutation, or changing
  the established Track summary fields except for the required
  `mainGroupUuid` privacy correction.
- Existing action/path: `sv_query` -> v3 internal Query adapter ->
  `list_tracks`.
- Target aggregate: ordered `TrackShell` summaries.
- Public compatibility: `trackCount`, Track order, all non-sensitive
  summary/mixer/color fields, optional color variants, and nested `contextId`
  values remain unchanged. `mainGroupUuid` is deliberately removed from the
  public DTO as private locator metadata.
- Safety invariants: every Track fingerprint and main Group UUID remains
  private, the projector snapshots nested source items before the legacy
  Context path mutates them, Trace metadata contains counts only, and no second
  host read occurs.
- Regression fixture: two Tracks with different optional fields, mixer state,
  private fingerprint spellings, and nested Contexts.
- Automated acceptance: ordered collection parity, nested Context parity,
  private-field counting, mismatch counts without values, explicit top-level
  field selection, and one IPC request per Query.
- Real SynthV acceptance: completed on two current Tracks in SynthV Studio 2
  Pro 2.2.1 standalone. The full collection completed in 42 ms with a 6 ms
  shadow stage (`2` root fields, `2` items, `0` differences, `2` private);
  the `trackCount`-only projection completed in 41 ms with a 4 ms shadow stage
  (`1` root field, `0` projected items, `0` differences, `2` private). Each
  Trace contained one IPC request/response pair and no project mutation or
  Undo.
- Performance budget: no additional IPC and pure Node collection projection
  within 10 ms for the current small project.
- Rollback: remove `list_tracks` from the shadow registry; the established
  public projection remains unchanged.

Ownership collection slice:

- Goal: extend collection shadow validation to `list_note_groups`, retaining
  the reference counts required for shared-Group write policy.
- Non-goals: changing Group ownership, authorizing a write from a read-only
  Context, exposing Group UUIDs/fingerprints, or enabling Snapshot cache reuse.
- Existing action/path: `sv_query` -> v3 internal Query adapter ->
  `list_note_groups`.
- Target aggregate: ordered library `GroupContent` summaries.
- Public compatibility: `groupCount`, library order, `libraryIndex`, `name`,
  note/pitch-control/reference counts, and nested `contextId` values remain
  unchanged.
- Safety invariants: every Group UUID and content fingerprint remains private;
  a `writeIntent` query retains both inside a typed Context; fresh
  `referenceCount` remains public; Trace metadata contains counts only; and no
  second host read occurs.
- Regression fixture: one multiply referenced Group and one isolated Group,
  each with private UUID/fingerprint values and distinct note/pitch-control
  counts.
- Automated acceptance: ordered collection parity, ownership-summary parity,
  nested Context parity, private-field counting, mismatch counts without
  values, count-only projection, and one IPC request per Query. Completed with
  150 repository tests, including compatible-command expansion of the private
  library Group guards and rejection of irrelevant projection selectors as a
  response-budget bypass.
- Real SynthV acceptance: completed on two library Groups in SynthV Studio 2
  Pro 2.2.1 standalone. The write-intent full collection completed in 75 ms
  with a 7 ms shadow stage (`2` root fields, `2` items, `0` differences, `4`
  private fields); the `groupCount`-only Query completed in 74 ms with a 3 ms
  shadow stage (`1` root field, `0` projected items, `0` differences, `4`
  private fields). Both used one IPC request and created no project mutation or
  Undo.
- Performance budget: no additional IPC and pure Node collection projection
  within 10 ms for the current small project.
- Rollback: remove `list_note_groups` from the shadow registry; the established
  public projection remains unchanged.

Final Phase 3 real-host gate:

- Environment: SynthV Studio 2 Pro 2.2.1 standalone on Windows 11, two Tracks,
  two library Groups, and a selected 42-note non-main Group.
- Build: Node fingerprint
  `cf5a9ac681eff0b615d3a5c62f27195c2aec98a8262baac7092136d69e25f56f`;
  Lua executor `sv3-lua-0.2.0-alpha.1-6`; Sidebar
  `sv3-sidebar-0.2.0-alpha.1-3`; component coherence `matched`.
- Coverage: final-build reads exercised the fixed Mixer and Group Voice paths,
  paged Track and library-Group collections, a two-note phrase page, an empty
  Smart Pitch page, a ready two-note computed-data page, independently paged
  tempo/measure marks, a 22-point Automation summary, and the same 22 points in
  one explicit closed range.
- Result: ten representative Traces completed in 43-219 ms with
  160-1,698 model-facing characters. The four shadow-enabled paths reported
  zero differences. All returned Contexts remained target typed; Track/main
  Group and guardless Group UUIDs were absent from public results.
- Safety: every Trace contained zero mutation or Undo stages; Track 1 remained
  at 0 dB and unmuted; no project state was changed.

Exit criteria:

- ordinary default reads are measured and fail closed above 20,000 characters
  or UTF-8 bytes;
- explicit pages/ranges retain coverage metadata and Dense reconstruction is
  lossless;
- no normal error contains a complete fingerprint or rejected Query payload;
- no extra host read is introduced solely for projection or shadow comparison;
- all 17 `sv_query` Actions have one checked projection strategy;
- representative flat, collection, phrase, Smart Pitch, Automation, and
  computed-data reads pass one final read-only real-host acceptance.

Rollback:

- route the affected action back to the existing projector.

## Phase 4: common command lifecycle — complete

Deliver:

- a Command Dispatcher implementing accepted through projected stages;
- common preflight/Undo/postcondition helpers;
- affected-count enforcement;
- consistent `undoRequired` reporting.

Initial project-write slice delivered:

- choose a bounded, already well-tested reference-local or mixer write;
- do not begin with track cloning or a multi-curve transaction.

### `set_track_mixer` real-host acceptance (2026-07-30)

- Environment: Synthesizer V Studio 2 Pro 2.2.1 standalone on Windows 11.
  The saved destructive-test project was
  `C:\Users\pengj\Project\SynthesizerV\test2\test.svp`.
- Build: Node commit
  `343a84f276693dfceba877c6c1c584f42e420b66`; Node/Lua executor coherence
  was `matched` and writes were allowed. Executor Build ID:
  `sv3-lua-0.2.0-alpha.1-648fe4fbb3a7e14e6ce5ce7e3f0c46d389760e266614da03cc76e20cf502c3a2`.
  Sidebar Build ID:
  `sv3-sidebar-0.2.0-alpha.1-12804fef9a667c30b3bf8724eb256a6a416c91945533a88969f8567fb23b7ad7`.
- Pre-restart safety: old Node against new Lua reported `writesAllowed=false`
  and rejected a `writeIntent` read before host access.
- Initial Track 1 mixer state: gain `0 dB`, mute off, pan `0`, solo off.
- Changed command: set gain to `-3 dB`; public outcome `changed`,
  `changedCount=1`, `undoRecords=1`, `verified=true`. Trace
  `tr_0mCOxXSWDEoLkqxS` reported an internal duration of `55 ms`; the public
  acknowledgement was 144 UTF-8 bytes.
- Same-value command: set gain to `-3 dB`; public outcome `alreadySatisfied`,
  `changedCount=0`, `undoRecords=0`, `verified=true`. Trace
  `tr_4AkEqcnsRu_Bw-K4` reported an internal duration of `38 ms`; the public
  acknowledgement was 153 UTF-8 bytes.
- One explicit SynthV Edit-menu Undo restored gain to `0 dB`; mute, pan, and
  solo remained unchanged. An initial automated `Ctrl+Z` injection did not
  trigger the application shortcut, but the enabled Edit-menu Undo restored
  the state and confirmed the Bridge Undo record.
- Automated baseline: all 160 repository tests passed before this acceptance
  run.

Exit criteria:

- stale and invalid inputs fail before Undo;
- successful command creates exactly one Undo record;
- forced no-op and verification mismatch cannot return success;
- real SynthV manual test matches the fake-host result.

Rollback:

- restore that action's previous handler; the public schema remains unchanged.

## Phase 5: aggregate ownership and safe clone slices — complete

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

Automated clone slice implemented on 2026-07-30:

- `clone_group_reference`, `clone_track_shell`, and `clone_track` now use the
  common fresh-read, Guard, preflight, one-Undo, mutation, and verification
  pipeline.
- `cloneIntent` is required and constrained by the authoritative command
  policy. The v3 description omits legacy clone booleans and rejects
  `deepCopy`.
- same-callback postconditions reread UUID association, reference counts,
  target association, Track metadata, and reference-local state. Source notes,
  Automation, and Smart Pitch are captured before Undo and confirmed by a
  separate fresh host read because SynthV 2.2.1 can terminate on an immediate
  post-library-insertion GroupContent read.
- fake-host cases CLN-001 through CLN-007 cover linked reference ownership,
  isolated Group mutation, ambiguous Track rejection, empty shells, and the
  detached Vocal manual-review warning.
- real SynthV 2.2.1 Pro standalone acceptance passed on the disposable
  `test.svp` working copy:
  - linked trace `tr_fy8hnWX24j9vZ8SY` preserved the source UUID, increased
    the shared reference count, and one Edit-menu Undo restored Track 2 from
    three Groups/84 notes to two Groups/42 notes while Track 1 stayed at
    42 notes;
  - isolated trace `tr_mCtgKI_LkSBFEIix` created a new UUID distinct from the
    source UUID (raw UUIDs redacted), with one reference and one Undo;
    fresh reads showed Track 1 unchanged at 42 notes and the new library Group
    at 42 notes/reference count 1, then one Undo removed it and restored the
    two-Group baseline;
  - the Track-shell test created one verified-empty temporary Track, and one
    Undo removed only that Track while the source and prior isolated test Track
    remained unchanged.

Exit criteria:

- CLN-001 through CLN-007 pass;
- deleting or tuning an isolated clone cannot affect its source;
- ambiguous non-main cloning fails closed;
- non-main Vocal limitations are reported without invented identities;
- manual SynthV isolation test passes on a working copy.

Rollback:

- disable the newly migrated clone strategy and keep safe rejection.

## Phase 6: Group aggregate commands — implemented

Deliver:

- migrate `apply_group_tuning` into the common lifecycle;
- one complete preflight across Voice/Vocal Modes, notes/phonemes, Automation,
  and Smart Pitch inputs;
- one Undo record and one independent postcondition read;
- exact Automation boundary verification.

Implemented:

- guarded note edit/delete and `transform_notes` use fresh typed Contexts,
  shared-ownership preflight, one lazy Undo boundary, and host readback;
- `apply_group_tuning` plans Voice/Vocal Modes, note/phoneme edits,
  Automation, and Smart Pitch as one logical command;
- Automation removal verifies the intended closed interval point by point;
- Smart Pitch CRUD and aggregate tuning validate current point/curve
  fingerprints and verify the resulting object counts and values;
- independent transaction steps are fully preflighted before Undo, while
  forward `$result` steps resolve just in time and report exactly one recovery
  Undo after any earlier mutation.

### Note and transaction real-host acceptance (2026-07-31)

- Environment: SynthV Studio 2 Pro 2.2.1 standalone on Windows 11 using the
  saved disposable `test.svp` working copy.
- Diagnostic build: base commit
  `b3cd283e41026fb1d8e196010e57d54a1e0ac659`, executor source ID
  `sv3-lua-0.2.0-alpha.1-8aa5b80cad6618e5040dec2a7b55a1554a83f45a4402e874efcedae5b1b7108b`.
- `transform_notes` changed the selected Group's first note from MIDI pitch 60
  to 61 with one Undo and verified readback. One Edit-menu Undo restored pitch
  60; the 42-note Group remained structurally unchanged.
- A one-step transaction created one Track with one Undo. A two-step dependent
  transaction created and renamed one Track, reported two changes and one
  Undo, and one Edit-menu Undo removed that Track.
- A deliberately stale dependent step failed in `dependentPreflight` after the
  first step wrote. The result reported `wrote=true`, `undoRequired=true`, and
  `TRANSACTION_EXECUTION_FAILED`; one Edit-menu Undo restored the original two
  42-note Tracks.
- The first two-step attempt produced a SynthV native `0xc0000005` APPCRASH and
  no response. After adding redacted transaction-stage crash breadcrumbs, the
  one-step, two-step-success, and dependent-failure cases did not reproduce the
  crash. `apply_transaction` remains real-host `sampled` until broader repeated
  certification; this alpha does not claim the native crash is fixed.

Exit criteria:

- multi-curve same-Group tuning no longer requires separate logical commands;
- every current host range comes from the same fresh definition read;
- unexpected endpoint residue fails verification;
- stale errors remain compact;
- ordinary Agent flow is one read plus one write.

Rollback:

- retain the old guarded action and do not split a failed logical write into
  multiple automatic retries.

## Phase 7: measured performance optimization — baseline complete; cache deferred

Delivered:

- one shared set of model-facing response budgets;
- a reproducible synthetic Query/Command benchmark;
- explicit IPC queue-wait and Query projection timing;
- repository gates for the tool catalog, ordinary Query fixture, command
  acknowledgement, public error redaction, and normal Trace overhead;
- a measured decision on whether to activate cache-aside.

Restrictions:

- write-capable Context reads always reach SynthV;
- no long-lived Lua host object references;
- no background full-project synchronization;
- no persistent cache database;
- no cache-based automatic write retry.

Exit criteria:

- the six-tool catalog is below 6,000 characters and UTF-8 bytes;
- the representative 64-note Query is below 20,000 characters and UTF-8 bytes;
- command acknowledgements and public errors remain below 2,048/4,096
  characters and UTF-8 bytes;
- raw fingerprints remain absent from normal results;
- existing real-host p95 remains below the ordinary 300 ms target;
- cache activation occurs only if measured benefit justifies stale-read and
  invalidation complexity.

Decision:

- the 2026-07-31 baseline does not justify activating Snapshot LRU;
- Task 12 is skipped and `sv_query` continues to reach the authoritative host;
- the bounded cache component remains unused by production Query paths.

Rollback:

- bypass and clear the snapshot proxy; authoritative behavior remains intact.

## Phase 8: migrate remaining actions and remove v2 adapters — complete

Delivered:

- action-by-action migration inventory;
- old/new parity tests;
- removal of duplicated per-handler lifecycle code;
- updated architecture.md describing implemented rather than planned behavior.

Completed migration inventory:

1. destructive note and Smart Pitch writes;
2. Automation and same-Group tuning;
3. Group/reference/library mutations;
4. Track and time-axis mutations;
5. independent and dependent transactions;
6. Sidebar Apply through the same Command Dispatcher.

All 38 live semantic writes have a machine-checked `V3CommandPolicy`. The six
public tools are the only registered MCP surface; the old eight-tool names are
neither public tools nor internal adapter names. Protocol v1 and v2 requests
are rejected with `PROTOCOL_MISMATCH`.

Exit criteria:

- all ordinary writes use the common lifecycle;
- no success path lacks a postcondition;
- existing action catalog remains complete;
- current and v3 documentation no longer disagree.

## Phase 9: final release gate and stable decision — complete

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

Fresh 2026-07-31 validation closed Phase 9. Isolated Group-reference
clone followed by Undo reproduced the same SynthV `0xc0000005` crash three
times, and Track-shell creation reproduced one `0xc0000409` crash. The public
boundary now classifies isolated Group clone, Note Group/Track/Track-shell
clone, harmony Track, and transaction apply/rollback as experimental and
rejects them before project IPC. The API coverage checker enforces agreement
between that live stability registry and the machine-readable evidence
matrix.

The current build has 17/17 Query and 9/9 UI actions verified, plus 31/38
writes verified, 7/38 experimental, and 0/38 pending. Vocal onboarding, the
machine-verifiable tuning surface, and human listening are complete. Stage 3
ordinary write/Undo and linked-clone/Undo repetition are complete. The
user-approved one-hour dense functional soak also completed. The original
four-hour duration was replaced by explicit user direction, and the post-fix
resource rerun is recorded as waived/not passed. An executable
read-matrix driver now generates the exact 1,000
call/17-Action schedule, enforces project/Session/executor and response-budget
stop conditions, and refuses a full live run without explicit Stage 2
completion. Its 17-call current-host development smoke passed, but is not
classified as Stage 3 evidence. The final decision is reduced-stable `0.2.0`:
the 31 verified writes are supported, while all seven native-risk paths remain
experimental and fail before project IPC.

The stability driver now also provides executable dry-run and live slices for
200-request concurrency, 30 Bridge reload/Session invalidation cycles, the
reduced-capability fail-closed matrix, and trace on/off p95 comparison. A first
development smoke passed 10 concurrent reads without loss, 16 disabled-action
calls without IPC, one reload with the old Context rejected as
`UNKNOWN_CONTEXT`, and 10 samples per trace state with 2.561% p95 overhead.
Formal runs subsequently passed 1,000/1,000 mixed reads, 200/200 concurrent
requests without loss, 380/380 reduced-capability fail-closed calls, 30/30
reload/Session invalidation cycles, and 100-sample-per-state trace A/B with
0.164% p95 overhead. The ordinary matrix subsequently passed 200/200 cycles
across all 31 verified writes, and the supported linked-clone matrix passed
30/30 cycles; every command changed state, created one Undo Record, and one
operator-visible SynthV Undo restored the same complete digest. The mixed soak
was shortened by explicit user direction to one hour and increased in density;
it completed 200 writes, 3,400 reads, and 10 reloads on the same original
timeline, with the prepared digest restored and `pending=null`. A user window
move exposed a second transient foreground race at write 9; the runner failed
closed before the actual Undo, one visible menu Undo restored the prepared
digest, and the user explicitly requested continuation rather than restart.
The same original start/deadline and JSONL timeline are retained. Foreground
acquisition now uses a deterministic red/green regression, up to three bounded
attempts, and a fresh window rectangle on every pointer activation. Resume is
fail-closed unless state is clean and at most one recovered write is ahead of
the log; that write's missing read/reload evidence is completed before the
next write.

Two transient fresh-baseline read failures during dense continuation occurred
only after the write and visible Undo had completed and the full digest had
already been restored. Resume retained those failures as separate evidence,
then filled the missing read evidence. The driver now retries only the exact
read-only fresh-baseline connection error, at most three times with a bounded
750 ms interval; it never retries a write, visible Undo, or stale Context.

The companion resource gate did not pass its declared window: the warm
working-set/private-byte baseline was `320,593,920 / 352,129,024 B`, while the
final ratios were `2.471113 / 2.338203`, and only 9 of 10 batch samples were
captured. A later read-only diagnostic sample recovered to ratios
`1.040935 / 1.009957`, but cannot replace the declared final sample or missing
batch. Therefore the functional one-hour run passes. The user explicitly
replaced the four-hour requirement with one hour and waived a further post-fix
resource repeat. The resource gate remains `WAIVED / NOT PASS`; this does not
widen the reduced-stable surface or reclassify the seven experimental paths.

The stability dry-run freezes the exact completed write distribution:
200 ordinary calls over all 31 verified Actions (7 each for the first 14 and 6
each for the remaining 17), plus 30 linked-clone/Undo cycles. Counts below 93
are rejected because they cannot satisfy the minimum of three per Action.

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
