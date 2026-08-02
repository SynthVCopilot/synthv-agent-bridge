# v3 Test Matrix

Status: v0.2.0 reduced-stable baseline; seven native-risk writes remain experimental

Date: 2026-07-31

Current automated baseline: 250 passing tests. Fresh real-host acceptance uses
SynthV Studio 2 Pro 2.2.1 standalone and the saved disposable
`D:\Projects\sv\test.svp` project. The current build has 17/17 Query and 9/9
UI actions exercised, plus the ordinary writes listed below. Four reproducible
native-host crashes caused the unsafe clone and transaction tail to be
classified `experimental` and disabled before project IPC. Vocal/Vocal Mode
onboarding, the machine-verifiable tuning write matrix, and human listening are
complete. Stage 3 read, concurrency, reduced-capability, reload, trace A/B,
200 ordinary write/Undo, and 30 linked-clone/Undo gates have passed. At the
user-approved one-hour deadline, the dense continuation also completed 200
writes, 3,400 reads, and 10 reloads with the prepared digest restored. The
original four-hour duration was not run. The first resource gate failed in its
declared final sampling window; a synchronized rerun exposed and fixed a
resource-monitor sampling bug, after which the user explicitly waived another
one-hour rerun. That resource gate is therefore recorded as waived/not passed.
The release decision is reduced stable because all seven host-risk paths are
disabled before IPC, not because the resource evidence was reclassified.

The executable Stage 3 harness now covers the read, concurrent-request,
Bridge-reload/Session-invalidation, reduced-capability fail-closed and trace
A/B slices. Sub-threshold real-host development smoke has passed for each new
stability slice. The formal read, concurrency, fail-closed, reload, trace A/B,
ordinary write/Undo and linked-clone/Undo counts now also pass. The one-hour
functional soak passes. The four-hour duration was replaced by explicit user
direction, and the post-fix settled-resource rerun is an acknowledged follow-up.

All 38 live semantic writes are joined to the machine-readable official API
inventory, Command Policy catalog, and live capability-stability registry.
The coverage checker now accepts the Stage 2 terminal states `verified`,
`unsupported`, and `experimental`, and rejects any drift between an
experimental runtime capability and this matrix. Historical host samples are
context only and do not override the fresh status recorded here and in
`docs/v3-test-evidence-2026-07-31-1510.zh-CN.md`.

This matrix turns architecture and known production-session failures into
release gates. It supplements the current tests; it does not replace the
checks in `AGENTS.md`.

## Test layers

| Layer | Purpose | May claim |
|---|---|---|
| TypeScript unit | Schema, projection, Context, cache, routing, redaction | Node behavior only |
| Lua fake host | Object ownership, preflight, Undo placement, postconditions | Deterministic executor behavior |
| File IPC contract | Correlation, serialization, timeout, session changes | Protocol behavior |
| Shadow read comparison | Old/new read projection equivalence | Read parity for sampled fixtures |
| Real SynthV manual | Official API behavior, UI state, Undo, rendering side effects | Supported host integration |

Fake-host tests must not be described as proof that SynthV implements an
undocumented behavior. A `Yes` entry proves the regression fixture and current
migrated slice; it does not certify every semantic action against that case.

## Required fake-host capabilities

The minimal fake host models:

- Project, Track, main/non-main Note Groups, and Group references;
- Group UUID identity and multiple references to shared content;
- notes sorted by onset with 1-based Lua indices;
- Automation definitions, ranges, points, interpolation, and boundary removal;
- Smart Pitch point/curve ownership;
- Track clone versus NoteGroupReference/NoteGroup clone semantics;
- object deletion and invalid-reference failures;
- Undo-record count and the first mutation after each boundary;
- host postcondition rereads;
- computed-data `pending` and `ready` results;
- session-token replacement.

It does not model audio rendering or Vocal timbre.

## Correctness and safety cases

| ID | Case | Required result | Automated | Real host |
|---|---|---|---|---|
| SAF-001 | Shared Group content write with default policy | `SHARED_GROUP_WRITE`, no Undo | Yes | Yes |
| SAF-002 | Explicit all-reference write with changed count | `STALE_GROUP_REFERENCE_COUNT`, no Undo | Yes | Yes |
| SAF-003 | Stale note/Automation/track Guard | applicable `STALE_*`, no Undo | Yes | Sample |
| SAF-004 | Session changes after Context issue | old Context and Guard rejected | Yes | Yes |
| SAF-005 | Ordinary write preflight failure | no mutation and no Undo | Yes | Sample |
| SAF-006 | Dependent transaction failure after earlier mutation | `undoRequired=true`, one recovery boundary | Yes | Yes |
| SAF-007 | Unexpected zero affected count | no success; postcondition error | Yes | Yes |
| SAF-008 | Write verification differs from request | `HOST_POSTCONDITION_FAILED` | Yes | Yes |
| SAF-009 | Existing notes outside explicit target | byte/value-equivalent projection before/after | Yes | Yes |
| SAF-010 | `.svp` supplied to local score reader | `SVP_NOT_SUPPORTED` | Existing | Not needed |

## Clone and ownership cases

| ID | Case | Required result | Automated | Real host |
|---|---|---|---|---|
| CLN-001 | `linked` reference clone | same Group UUID; reference count increases | Yes | Yes |
| CLN-002 | `isolated` non-main Group clone | disabled before IPC after reproducible native crash | Yes | Experimental disabled |
| CLN-003 | Delete notes from isolated clone | source unchanged; live path unavailable while isolated clone is disabled | Yes | Experimental disabled |
| CLN-004 | Automation write to isolated clone | source unchanged; live path unavailable while isolated clone is disabled | Yes | Experimental disabled |
| CLN-005 | Ambiguous Track clone with non-main Vocal Groups | whole host-clone action disabled before IPC | Existing + new postconditions | Experimental disabled |
| CLN-006 | `clone_track_shell` | disabled before IPC after reproducible Track-shell crash | Existing + fake host | Experimental disabled |
| CLN-007 | Detached non-main Vocal identity | manual-review warning retained in schema; action unavailable | Yes | Experimental disabled |

## Context, projection, and cache cases

| ID | Case | Required result |
|---|---|---|
| CTX-001 | Locator-only read | cannot mint write-capable Context |
| CTX-002 | Context target-kind mismatch | `CONTEXT_INCOMPATIBLE` |
| CTX-003 | Conflicting explicit locator/Guard | `CONTEXT_SCOPE_MISMATCH` |
| CTX-004 | Session change | all Context, Guard, cursor, and snapshots cleared |
| PRJ-001 | Default phrase read | excluded sections are not computed or serialized |
| PRJ-002 | Dense rows | lossless reconstruction of every included field |
| PRJ-003 | Write acknowledgement | counts/identifiers only; no full mutated objects |
| PRJ-004 | Public Query catalog changes | every read Action must have exactly one projection policy |
| PRJ-005 | Default pageable Query | bounded host page with count/offset/continuation metadata |
| PRJ-006 | Default Automation Query | full private Guard, no public point array without an explicit range |
| PRJ-007 | Unscoped default response exceeds 20,000 characters or UTF-8 bytes | bounded `QUERY_RESPONSE_BUDGET_EXCEEDED`; rejected payload not echoed |
| PRJ-008 | Explicit large page/range/projection | allowed, measured, and coverage reported |
| CAC-001 | Cache hit for read-only projection | same DTO and `sessionCached` support trace |
| CAC-002 | Write-capable Context request | host read even when a cache entry exists |
| CAC-003 | Bridge write | touched keys invalidated before replacement |
| CAC-004 | Cache corruption/miss | safe host-read fallback |
| CAC-005 | Computed pitch key | different references never share one entry |
| CAC-006 | Weight/age eviction | bounded memory and no write failure |

`CAC-*` currently certifies the dormant bounded cache component only.
Production `sv_query` does not use mutable project snapshots; every Query
reaches SynthV because Phase 6 measurements did not justify stale-read risk.

## Command lifecycle cases

| ID | Case | Required result |
|---|---|---|
| CMD-001 | Successful ordinary write | all eleven stages in order |
| CMD-002 | Schema rejection | stops at `accepted`; no IPC |
| CMD-003 | Stale Guard | stops at `guarded`; no Undo |
| CMD-004 | Host range/capability rejection | stops at `preflighted`; no Undo |
| CMD-005 | Successful logical batch | exactly one Undo record |
| CMD-006 | Postcondition mismatch | public failure with `traceId` |
| CMD-007 | Concurrent Node calls | serialized file IPC order |
| CMD-008 | Claimed request times out | no overlapping retry or deletion |

## Automation boundary cases

| ID | Case | Required result |
|---|---|---|
| AUT-001 | Remove exact closed range | no point remains in intended range |
| AUT-002 | Host leaves an endpoint | verification catches residue |
| AUT-003 | Cubic interpolation sampling | values remain in fresh definition range |
| AUT-004 | Multiple curves in one Group tuning command | one complete preflight and one Undo |
| AUT-005 | Curve changes between read and write | `STALE_AUTOMATION`, compact error |

## Observability and privacy cases

| ID | Case | Required result |
|---|---|---|
| OBS-001 | Normal success | `traceId`, counts, warnings, no raw Guard |
| OBS-002 | Normal stale error | under budget; no complete fingerprint |
| OBS-003 | Support trace | phase, timings, hashes, counts, cache status |
| OBS-004 | Default stderr/log files | no lyrics, phonemes, note arrays, or curves |
| OBS-005 | Explicit debug | bounded to requested target and size |
| OBS-006 | MCP-to-Lua failure | same `traceId` across all available records |

## Performance and regression fixtures

Sanitized generated fixtures must include:

- a small one-Group phrase for fast unit tests;
- a Track with one main and three non-main shared references;
- a 735-note Group;
- at least 1,500 Smart Pitch controls;
- at least 500 Automation points on one parameter;
- eight explicit Vocal Mode parameter names without a Vocal identity claim;
- pending computed phonemes/pitch followed by ready results.

Fixtures contain synthetic lyrics only and are not `.svp` files.

## Real SynthV acceptance matrix

Fresh v3 real-host evidence used for the `0.2.0` release decision:

| Area | Environment and result |
|---|---|
| Query projection | SynthV 2.2.1 Pro standalone; 17/17 Query actions passed with bounded projections and no private locator/Guard leak |
| UI | 9/9 UI actions passed with actual selection, viewport, clipboard/dialog, snap/coordinate, playback, and playhead readback; all temporary state restored |
| Mixer Command | `0 dB → -3 dB` returned `changed`, one Undo and verified readback; repeating `-3 dB` returned `alreadySatisfied`, zero Undo; one Edit-menu Undo restored `0 dB` |
| Sidebar status | Connection-only panel reported separate B/M rows; Restart Bridge requested a hot reload without touching project content |
| Linked clone | Source UUID was shared intentionally, fresh reference count increased, and one Undo removed only the new reference; the formal Stage 3 loop passed 30/30 writes with 30 visible Undos and complete baseline restoration |
| Note and structure writes | guarded edit/delete/transform, Track add/update/delete, Group/reference add/update/delete, library Group create/delete, time-axis, metadata, and local score import all passed authoritative readback and visible Undo recovery |
| Native clone risk | isolated Group-reference clone followed by Undo reproduced `0xc0000005` three times at the same fault offset; Track shell reproduced `0xc0000409` once |
| Experimental fail-closed | isolated Group-reference clone, Note Group/Track/Track-shell clone, harmony Track, and transaction apply/rollback are classified experimental and rejected before project IPC with no write or Undo |
| Tuning tail | Voice/Vocal Modes, phoneme, Retake, Smart Pitch, Automation, humanization, expression, lyrics, and integrated tuning passed authoritative readback and visible Undo recovery; human listening confirmation passed |
| Visible Undo focus recovery | A transient foreground race caused fail-closed before Undo; one actual Edit-menu Undo restored the complete digest. A deterministic injected-focus regression changed from red with one attempt to green with three bounded attempts, and window coordinates are reread after movement |
| Stage 3 repetition | 200/200 ordinary writes covered all 31 verified actions; every write changed state, created one Undo Record, and one visible Undo restored the identical full-project digest. The user-approved one-hour dense continuation also passed 200 writes, 3,400 reads and 10 reloads on the same timeline; the original four-hour duration was not run |
| Stage 3 resources | `WAIVED / NOT PASS`: the first declared gate ended with ratios `2.471113 / 2.338203` and 9/10 batch samples; a later sample recovered. A synchronized repeat completed all 200 writes/3,400 reads/10 reloads, but its monitor crashed at the final checkpoint because a PowerShell overload selected `Int32` and a transient invalid file timestamp escaped validation. Commit `b8e39b4` fixed both defects and added a file-age self-test; the user canceled and explicitly waived the next one-hour repeat. No resource PASS is claimed. |

The authoritative per-action status is the machine-readable `actionGroups`
inventory in `docs/sv2-api-coverage-v3.md`. Current totals are 17 verified
reads, 9 verified UI actions, 31 verified writes, 7 experimental writes, and
zero pending writes. No action is currently classified `unsupported`.

The four native crashes are release evidence, not a fixed-host claim. The
public TypeScript boundary now prevents those command variants from reaching
the file-IPC project request path. Fake Host behavior remains covered for
diagnosis, but it does not override the experimental real-host classification.

At minimum, each release candidate records:

- Synthesizer V Studio version;
- Bridge and MCP build fingerprints;
- standalone or plugin/ARA mode;
- representative installed Voice capability cases when applicable;
- clone isolation result;
- Undo count and recovery result;
- response sizes and timings;
- any manual Vocal review requirement.

Use a saved working copy. Never run destructive acceptance cases on the user's
only project copy.

## Required repository checks

```bash
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
node --check scripts/release-validation-v3.mjs
node --check scripts/stage3-stability-v3.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
npm run validate:v3-reads -- --dry-run
npm run validate:v3-stability -- --dry-run --mode all
```

Actual SynthV integration remains a manual release gate.
