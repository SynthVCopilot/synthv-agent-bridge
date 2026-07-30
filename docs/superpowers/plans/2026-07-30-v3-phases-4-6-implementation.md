# SynthV Agent Bridge v3 Phases 4–6 Implementation Plan

> Execution mode: test-driven, one vertical slice per checkpoint, current
> `codex/v3-implementation` branch.

Design source:
[2026-07-30-v3-phases-4-6-design.md](../specs/2026-07-30-v3-phases-4-6-design.md)

## Goal

Complete the original v3 Phase 4–6 scope:

1. make one Command Kernel own the v3 command lifecycle;
2. migrate every high-risk write family through it;
3. optimize measured bottlenecks, complete SV2 API classification, and remove
   superseded v2 execution paths.

## Architecture

The public six-tool Facade remains stable. Node resolves the public schema,
typed Context, build coherence, redacted outcome, and cache invalidation. Lua
freshly reads SynthV, prepares an effect plan, opens one Undo boundary only when
needed, mutates, and verifies. Action adapters keep domain details; shared
pipeline code owns lifecycle and recovery semantics.

## Working rules

- Write a focused failing behavior test before each production change.
- Never weaken an existing Guard while moving code.
- Keep each migrated action callable only through the v3 Facade.
- Do not add a runtime v2/v3 dual stack.
- Run destructive host tests only in the authorized saved test project.
- Commit and push each checkpoint after full verification.
- Ask the user only for unavoidable SynthV GUI observations.

## Task 1: Freeze the executable command contract

Files:

- Create: `src/v3-command-dispatcher.ts`
- Create: `tests/v3-command-dispatcher.test.ts`
- Modify: `src/v3-command-kernel.ts`
- Modify: `src/v3-facade.ts`

Steps:

1. Add failing tests for:
   - ordered Node stages from `accepted` through `projected`;
   - one internal invocation per command;
   - `alreadySatisfied` accepted only with zero Undo;
   - `changed` accepted only with positive effect, one Undo, and verification;
   - unexpected zero effect becoming `HOST_POSTCONDITION_FAILED`;
   - failure phase/recovery normalization;
   - cache invalidation callback occurring only after verified change.
2. Run:
   `node --test --import=tsx tests/v3-command-dispatcher.test.ts`
   and confirm the missing dispatcher fails.
3. Implement immutable dispatcher request/result types and the smallest
   action-neutral dispatch function.
4. Move `expectedEffect=mustChange` enforcement from the Facade handler into
   the dispatcher.
5. Route `sv_command` through the dispatcher while retaining the existing
   internal adapter for one slice.
6. Run the focused tests and `npm run typecheck`.

Expected commit:
`feat: add v3 command dispatcher contract`

## Task 2: Add the Lua effect-plan pipeline

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/lua-fake-host.test.ts`
- Modify: `src/protocol.ts`
- Modify: `tests/protocol.test.ts`

Steps:

1. Add failing Fake Host markers for:
   - effect plan is complete before Undo;
   - planned no-op exits without Undo;
   - mutation is forbidden before `undoOpened`;
   - postcondition mismatch reports the failed stage and one Undo recovery;
   - Lua stage telemetry follows the frozen state order.
2. Add protocol assertions for bounded effect and stage summaries.
3. Run the focused Lua and protocol tests and confirm failure.
4. Implement a Lua pipeline helper that:
   - stores only serialized plan metadata;
   - calls action adapter callbacks for fresh read, Guard, preflight, mutate,
     and verify;
   - opens Undo exactly once when the plan requires mutation;
   - maps failures before/after mutation to recovery metadata;
   - emits bounded stage timings.
5. Do not retain SynthV objects outside the request.
6. Run focused tests, Lua syntax checking, and type checking.

Expected commit:
`feat: add lua command effect pipeline`

## Task 3: Migrate `set_track_mixer` through the complete Kernel

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-dispatcher.ts`
- Modify: `src/v3-command-kernel.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/v3-command-dispatcher.test.ts`
- Modify: `tests/lua-fake-host.test.ts`
- Modify: `tests/v3-session.test.ts`

Steps:

1. Add failing tests for:
   - fresh Track Guard mismatch before Undo;
   - exact already-satisfied mixer state;
   - two requested mixer fields counted as one logical changed command;
   - one Undo boundary;
   - injected setter no-op;
   - injected readback mismatch;
   - injected exception after the first mixer mutation;
   - build mismatch and Session change still stopping before dispatch.
2. Confirm the tests fail on the legacy mixer handler.
3. Convert `set_track_mixer` to a pipeline adapter.
4. Return explicit effect count, `undoRecordCount`, verification state, and
   bounded postcondition summary from Lua.
5. Make Node reject malformed legacy success shapes for this migrated action.
6. Run focused tests, then `npm run check`.
7. Build and atomically install Node/Lua/Sidebar.
8. Real-host acceptance in SynthV:
   - query Track 1 mixer with `writeIntent`;
   - apply a reversible gain or mute change;
   - verify one change and one Undo;
   - repeat the same command and verify `alreadySatisfied`/zero Undo;
   - Undo once and verify the initial mixer state.
9. Record trace timings and response sizes in `docs/v3-development-plan.md`.

Expected commit:
`feat: migrate mixer to v3 command kernel`

Checkpoint A: push after full repository checks and real-host acceptance.

## Task 4: Introduce command policy and domain-target registries

Files:

- Create: `src/v3-command-policy.ts`
- Create: `tests/v3-command-policy.test.ts`
- Modify: `src/v3-surface.ts`
- Modify: `src/v3-facade.ts`
- Modify: `src/server.ts`

Steps:

1. Add failing tests proving every live non-read action is classified by:
   - target aggregate;
   - Context kind;
   - ownership policy;
   - expected-effect policy;
   - postcondition strategy;
   - transaction eligibility.
2. Assert registry/action-catalog equality so a new write cannot bypass policy.
3. Move the scattered command classification sets from `v3-surface.ts` and
   `v3-facade.ts` into the registry.
4. Preserve just-in-time `sv_describe` output and six-tool metadata budget.
5. Run focused tests and `npm run typecheck`.

Expected commit:
`refactor: centralize v3 command policy`

## Task 5: Migrate linked, isolated, and shell clone semantics

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/lua-fake-host.test.ts`
- Create: `tests/v3-clone-command.test.ts`
- Modify: `docs/domain-model-v3.md`

Steps:

1. Add failing behavior tests for CLN-001 through CLN-007:
   - linked reference keeps UUID and increases reference count;
   - isolated clone changes UUID and has reference count one;
   - deleting the isolated clone's final note does not alter the source;
   - isolated Automation mutation does not alter the source;
   - ambiguous non-main clone fails before Undo;
   - Track shell is verified empty;
   - detached Vocal state emits manual-review warning without identity claims.
2. Add source snapshot assertions for notes, Automation, and Smart Pitch.
3. Migrate `clone_group_reference`, `clone_track_shell`, and `clone_track` to
   the pipeline in that order.
4. Make clone intent explicit in command policy; do not accept `deepCopy`.
5. Verify UUID association and reference counts after mutation.
6. Run focused tests, then the complete checks.
7. Atomically install and run real-host linked/isolated/shell tests.
8. Use one Undo per test and verify the source Track/Group remains unchanged.
9. Record the result in `docs/v3-development-plan.md`.

Expected commit:
`feat: migrate explicit clone ownership commands`

Checkpoint B: push after clone isolation and Undo tests pass in SynthV.

## Task 6: Migrate guarded note edit and delete

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/lua-fake-host.test.ts`
- Create: `tests/v3-note-command.test.ts`

Steps:

1. Add failing tests for:
   - every edited/deleted note needs a current Guard;
   - stale note Guard fails before Undo;
   - shared Group default rejection;
   - explicit all-reference policy requires current reference count;
   - notes outside the target preserve a byte/value-equivalent projection;
   - unexpected zero edit/delete effect fails verification;
   - one edit/delete batch creates one Undo.
2. Migrate `edit_notes` and `delete_notes` into the pipeline.
3. Reuse Context expansion without returning note fingerprints.
4. Ensure deletion verifies remaining note identity/order rather than only a
   count.
5. Run focused and complete checks.
6. Real-host acceptance:
   - edit one isolated-clone note;
   - delete its final note;
   - verify source unchanged;
   - Undo each logical command once and verify restoration.

Expected commit:
`feat: migrate guarded note commands`

## Task 7: Migrate `transform_notes`

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/v3-surface.test.ts`
- Modify: `tests/lua-fake-host.test.ts`

Steps:

1. Add failing tests for:
   - `contextNotes` requires a fresh write-intent Context;
   - every Context note expands exactly once;
   - explicit seconds onset uses the same fresh time axis;
   - durations in blicks remain unchanged for seconds onset transforms;
   - pre-existing gaps remain unchanged unless explicitly targeted;
   - unexpected overlap/range/host failure occurs before Undo;
   - one transform batch creates one Undo.
2. Migrate `transform_notes` to the effect pipeline.
3. Preserve the existing separation between Agent-chosen numeric transform and
   Bridge mechanical expansion.
4. Run focused and complete checks.
5. Real-host acceptance on an isolated clone using a small explicit semitone
   or onset test transform, followed by one Undo.

Expected commit:
`feat: migrate guarded note transforms`

Checkpoint C: push after note and transform real-host acceptance.

## Task 8: Migrate `apply_group_tuning`

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/v3-surface.test.ts`
- Modify: `tests/lua-fake-host.test.ts`
- Create: `tests/v3-group-tuning-command.test.ts`

Steps:

1. Add failing tests for one effect plan spanning:
   - reference-local Group Voice and explicit Vocal Mode values;
   - guarded note/phoneme edits;
   - multiple Automation curves with fresh definition ranges;
   - Smart Pitch additions/edits/removals;
   - shared Group ownership;
   - all-or-no-Undo preflight;
   - one Undo on success.
2. Add injected mid-mutation and postcondition faults with explicit one-Undo
   recovery.
3. Migrate `apply_group_tuning` to the pipeline without splitting its batch.
4. Verify every modified subsection independently and return only counts,
   durable identifiers, warnings, and a replacement Context.
5. Run focused and complete checks.
6. Real-host acceptance uses declared synthetic test values on an isolated test
   Group. Do not infer Vocal identity or artistic style.

Expected commit:
`feat: migrate aggregate group tuning`

## Task 9: Migrate standalone Automation and Smart Pitch commands

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/lua-fake-host.test.ts`
- Create: `tests/v3-automation-command.test.ts`
- Create: `tests/v3-pitch-command.test.ts`

Steps:

1. Add failing Automation tests:
   - range is read from current `definition.range`;
   - stale Guard fails before Undo;
   - exact closed-range removal leaves no endpoint residue;
   - host-exclusive endpoint behavior is compensated and verified;
   - zero-point already-satisfied clear creates no Undo.
2. Add failing Smart Pitch tests:
   - point/curve ownership follows GroupContent;
   - stale per-control Guard fails before Undo;
   - add/edit/delete effects and order are verified;
   - source clone content remains unchanged.
3. Migrate `set_automation_points`, `clear_automation`,
   `simplify_automation`, `add_pitch_controls`, `edit_pitch_controls`, and
   `delete_pitch_controls`.
4. Reuse shared pipeline helpers and keep raw curves private.
5. Run focused and complete checks.
6. Real-host acceptance writes and clears one bounded synthetic curve and one
   bounded Smart Pitch fixture on an isolated Group, with one Undo per logical
   command.

Expected commit:
`feat: migrate automation and smart pitch commands`

## Task 10: Migrate dependent transactions

Files:

- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `src/v3-command-dispatcher.ts`
- Modify: `src/v3-command-policy.ts`
- Modify: `src/v3-surface.ts`
- Modify: `src/compact-results.ts`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/compact-results.test.ts`
- Create: `tests/v3-transaction-command.test.ts`
- Modify: `tests/lua-fake-host.test.ts`

Steps:

1. Add failing tests for:
   - all independent steps preflight before Undo;
   - `$result` points only to an earlier 1-based step and occupies the whole
     value;
   - dependent steps resolve/preflight just in time;
   - independent failure means zero writes and zero Undo;
   - dependent failure after an earlier write means one Undo recovery;
   - automatic retry is never attempted;
   - compact results match step count without leaking Guards.
2. Adapt `apply_transaction` and `rollback_transaction` to the common Node and
   Lua lifecycle while preserving one recovery boundary.
3. Remove transaction-specific outcome duplication from the Facade.
4. Run focused and complete checks.
5. Real-host acceptance uses a two-step bounded test transaction and an
   injected/stale dependent failure; verify the documented one-Undo recovery.

Expected commit:
`feat: migrate dependent command batches`

Checkpoint D: push after tuning, Automation, Smart Pitch, and transaction
acceptance.

## Task 11: Measure before adding any cache

Files:

- Modify: `src/v3-command-kernel.ts`
- Modify: `src/v3-query-projector.ts`
- Modify: `src/ipc/file-ipc-client.ts`
- Create: `scripts/benchmark-v3.mjs`
- Create: `tests/v3-performance-budget.test.ts`
- Modify: `docs/v3-performance-budget.md`
- Modify: `docs/v3-development-plan.md`

Steps:

1. Add tests enforcing:
   - six-tool catalog below 6 KB;
   - ordinary Query p95 payload fixture below 20 KB;
   - command acknowledgement below 2 KB;
   - public error below 4 KB;
   - zero raw fingerprint bytes in normal results;
   - trace metadata overhead below the configured budget.
2. Record queue, host read, preflight, mutation, verification, projection,
   request bytes, and response bytes without project content.
3. Benchmark representative Query and Command fixtures.
4. Run a real-host measurement set for repeated read-only requests and common
   writes.
5. Decide from evidence:
   - if repeated read-only projection/IPC cost is material, proceed to Task 12;
   - otherwise document `Snapshot LRU not justified` and skip Task 12.

Expected commit:
`perf: establish v3 command and query baselines`

## Task 12: Add Snapshot LRU only if justified

Conditional files:

- Modify: `src/v3-snapshot-cache.ts`
- Modify: `src/v3-surface.ts`
- Modify: `src/v3-command-dispatcher.ts`
- Modify: `tests/v3-architecture.test.ts`
- Create: `tests/v3-snapshot-cache-integration.test.ts`

Conditional steps:

1. Add failing CAC-001 through CAC-006 tests.
2. Implement bounded immutable read-only entries keyed by Session, target,
   projection, Reference, and dependency digest.
3. Prove write-intent reads always reach the host.
4. Invalidate touched entries after verified writes and all entries on Session
   change.
5. Prove cache corruption/miss degrades to a fresh host read.
6. Rebenchmark and retain the cache only if measured results improve.

Expected commit if retained:
`perf: add measured bounded snapshot cache`

## Task 13: Complete the SV2 API coverage audit

Files:

- Modify: `docs/sv2-api-coverage-v3.md`
- Create: `scripts/check-api-coverage.mjs`
- Create: `tests/sv2-api-coverage.test.ts`
- Modify: `package.json`

Steps:

1. Convert the coverage document into a mechanically checkable inventory.
2. Classify every official class/method as semantic, internal, unavailable/
   GUI-only, or intentionally unexposed.
3. For semantic writes, record action, target aggregate, preflight,
   postcondition, automated test, and real-host status.
4. Add a repository test that rejects blank or duplicate classifications and
   verifies all live actions appear in the matrix.
5. Run the coverage test and full checks.

Expected commit:
`docs: complete sv2 api coverage matrix`

## Task 14: Remove superseded v2 and duplicated command paths

Files:

- Modify: `src/server.ts`
- Modify: `src/v3-surface.ts`
- Modify: `src/v3-facade.ts`
- Modify: `src/sidebar-coordinator.ts`
- Modify: `src/protocol.ts`
- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: relevant tests and docs

Steps:

1. Add tests proving:
   - only six public v3 tools are registered;
   - only protocol v3 is accepted;
   - every write routes through the Command Dispatcher;
   - migrated actions no longer use duplicate outcome/Undo projection;
   - Sidebar Apply uses the same command route;
   - protocol v1/v2 receive `PROTOCOL_MISMATCH`.
2. Remove runtime v2 tool registration and obsolete private adapters after
   catalog parity is proven.
3. Keep internal action definitions as schemas/adapters, not public tools.
4. Remove duplicate Context expansion, outcome projection, and lifecycle code
   now owned by v3 modules.
5. Run all checks and a clean build/install from an empty `dist`.

Expected commit:
`refactor: remove superseded v2 command paths`

## Task 15: Final documentation and release gate

Files:

- Modify: `docs/architecture-v3.md`
- Modify: `docs/v3-development-plan.md`
- Modify: `docs/v3-test-matrix.md`
- Modify: `docs/v3-performance-budget.md`
- Modify: `docs/atomic-upgrade-v3.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`

Steps:

1. Replace planned descriptions with implemented behavior and measured data.
2. Record every real-host test:
   SynthV 2.2.1 Pro standalone, build identity, Undo count, source invariants,
   timings, response sizes, and recovery.
3. Run:

```text
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
git diff --check
```

4. Atomically install the final Node/Lua/Sidebar build.
5. Verify B/M build coherence and run the final bounded real-host matrix.
6. Request independent Standards and Spec code review.
7. Address confirmed findings and rerun all verification.
8. Commit and push the final checkpoint.

Expected commit:
`docs: complete v3 phases 4 through 6`

Checkpoint E: final verified push. Do not label `0.2.0` stable until all release
gates outside this implementation plan are also satisfied.
