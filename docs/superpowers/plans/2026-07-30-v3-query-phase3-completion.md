# v3 Query Phase 3 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 3 by routing every `sv_query` Action through one classified, bounded Query Projector with private Guard handling, pagination/explicit-scope rules, response measurements, and old/new projection parity.

**Architecture:** `v3-surface.ts` remains responsible for authoritative host invocation and Context issuance. `v3-query-projector.ts` becomes the deep Query module: it owns the complete 17-Action policy registry, v3 argument defaults, compact public projection, shadow parity, and model-facing response-budget measurement. Lua returns bounded pages or summaries for host collections that were previously unbounded; it still computes private fingerprints from authoritative full state.

**Tech Stack:** TypeScript 5.8, Node.js test runner, Zod 4, Lua 5.4, MCP SDK 1.29, file IPC protocol v3.

## Global Constraints

- Keep the six public v3 tools and file IPC protocol v3 unchanged.
- SynthV remains the sole live authority; no cache may authorize a write.
- Keep all raw fingerprints, Group UUID guards, lyrics, note arrays, and curve arrays out of public errors and Trace metadata.
- Do not add a second host read for projection or shadow comparison.
- Default model-facing reads target at most 20 KB; larger reads require explicit caller scope and report pagination/range coverage.
- Preserve 1-based protocol indices and current Context/Guard semantics.
- No project write is added or shadow-executed in this phase.

---

### Task 1: Freeze complete Query policy coverage

**Files:**
- Modify: `src/v3-query-projector.ts`
- Modify: `tests/v3-query-shadow.test.ts`
- Modify: `docs/sv2-api-coverage-v3.md`

**Interfaces:**
- Produces: `queryProjectionPolicy(action)` and `queryProjectionActionNames()` for runtime classification and completeness tests.
- Produces: one policy for each of the 17 read Actions returned by `sv_describe`.

- [x] Add a failing test that compares the public `sv_describe` read catalog with the Query policy registry.
- [x] Add failing assertions for fixed, offset-page, cursor-page, range-summary, and explicit-bounded strategies.
- [x] Run the focused test and confirm unclassified Actions fail.
- [x] Add the policy types and complete registry without adding behavior branches to `v3-surface.ts`.
- [x] Run the focused test and confirm all 17 Actions are classified.

### Task 2: Centralize public projection and size measurement

**Files:**
- Modify: `src/v3-query-projector.ts`
- Modify: `src/v3-surface.ts`
- Modify: `src/v3-command-kernel.ts`
- Modify: `tests/v3-surface.test.ts`
- Modify: `tests/v3-query-shadow.test.ts`

**Interfaces:**
- Consumes: host result after private Context/Guard capture.
- Produces: `projectQueryResult(action, root, options)` returning the public DTO plus `responseCharacters`, `budgetClass`, and shadow parity counts.

- [x] Add failing tests proving phrase includes, diagnostic stripping, dense rows, field projection, Context envelope fields, and four existing shadow slices are preserved by `projectQueryResult`.
- [x] Add a failing test proving an ordinary oversized default result is rejected with `QUERY_RESPONSE_BUDGET_EXCEEDED`, while an explicitly scoped page is allowed and measured.
- [x] Move projection-only helpers from `v3-surface.ts` into the Query Projector and route all `sv_query` results through it.
- [x] Emit only allowlisted count/size metadata in a `queryProjected` Trace stage.
- [x] Run focused surface, projector, architecture, and facade tests.

### Task 3: Bound host collection defaults and Automation summaries

**Files:**
- Modify: `src/server.ts`
- Modify: `src/v3-query-projector.ts`
- Modify: `synthv/SynthVAgentBridge.lua`
- Modify: `scripts/mock-synthv-smoke.lua`
- Modify: `tests/lua-fake-host.test.ts`
- Modify: `tests/v3-query-shadow.test.ts`

**Interfaces:**
- Produces: offset/limit page metadata for Track, library Group, time-axis, computed-attribute, and Pitch Control collections.
- Produces: compact `get_automation` summary with full private fingerprint but no point array unless a closed range is explicitly supplied.

- [x] Add failing Fake Host markers for collection page counts/offsets/`hasMore` and compact Automation point omission.
- [x] Add failing TypeScript tests for v3 default limits and explicit-scope detection.
- [x] Add bounded schemas and Lua serialization while preserving total counts and full-state fingerprints.
- [x] Keep explicit ranges, note indices, sample positions, pitch frames, and score-preview limits caller-bounded.
- [x] Run the Fake Host and focused Query tests.

### Task 4: Close documentation and acceptance gates

**Files:**
- Modify: `docs/v3-development-plan.md`
- Modify: `docs/v3-test-matrix.md`
- Modify: `docs/v3-performance-budget.md`
- Modify: `docs/sv2-api-coverage-v3.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final automated and real-host measurements.
- Produces: Phase 3 status, complete Action policy table, response-size results, and remaining Phase 2 tracing A/B caveat.

- [x] Record all 17 Query strategies and why each is bounded.
- [x] Mark Phase 3 complete only after the automated and real-host gates pass.
- [x] Run `npm run check`, both Node syntax checks, Lua syntax checks, `git diff --check`, and inspect the final diff.
- [x] Reload the installed Bridge once and run representative read-only real-host checks for flat, collection, phrase/page, Pitch Control, Automation summary/range, and computed-data paths.
- [x] Record latency, model-facing size, parity, Context behavior, and zero Undo.
- [ ] Commit and push the complete Phase 3 batch.
