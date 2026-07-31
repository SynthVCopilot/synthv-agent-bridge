# v3 Test Matrix

Status: enforced alpha baseline

Date: 2026-07-30

Current automated baseline: 215 passing tests. Recorded real-host acceptance
uses SynthV Studio 2 Pro 2.2.1 standalone and a saved disposable test project.
It currently covers the Mixer command/no-op path, Session invalidation,
Sidebar Apply/Undo, isolated clone/source preservation, and closed-range
Automation/Undo scenarios, plus the first Mixer Query Projector shadow-parity
slice and the compact/explicit Group Voice Query Projector slice; it does not
certify every Semantic action. Collection acceptance additionally covers
`list_tracks` order, optional public fields, nested read-only Contexts, private
fingerprint isolation, and count-only projection. Automated collection
coverage also includes `list_note_groups` order, shared ownership summaries,
nested write-intent Contexts, private Group UUID/fingerprint isolation, and
count-only projection. Its real-host gate confirms the same projection and
privacy behavior on two current library Groups; the multiply referenced case
remains covered by the deterministic fixture. Phase 3 automation additionally
proves exact policy coverage for all 17 public Query actions, bounded host
pages for time-axis/Track/library-Group/computed-data/Smart-Pitch collections,
compact Automation summaries, shared projection behavior, and a redacted
20,000-character default-response gate. It also verifies Retake/nested Track
Guard redaction, retry-safe pending computed data, 1-based page reconstruction,
and stable full-state Guards across pages/range projections. The final
real-host Phase 3 gate covers ten representative paths on the final build:
43-219 ms end to end, 160-1,698 model-facing characters, zero shadow
differences, private Group UUID isolation even for guardless reads, and zero
mutation/Undo stages. All 38 live semantic writes are also joined to the
machine-readable official API inventory and Command Policy catalog. All 215
official methods classified as Agent semantic capabilities inherit a checked
public-tool, Action, Host Adapter, preflight, postcondition, automated-test,
and real-host evidence mapping.

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
| CLN-002 | `isolated` non-main Group clone | different UUID; intended new reference count | Yes | Yes |
| CLN-003 | Delete notes from isolated clone | source note count/fingerprint unchanged | Yes | Yes |
| CLN-004 | Automation write to isolated clone | source curve unchanged | Yes | Yes |
| CLN-005 | Ambiguous clone with non-main vocal Groups | default rejection | Existing + new postconditions | Yes |
| CLN-006 | `clone_track_shell` | one verified-empty Track shell | Existing + fake host | Yes |
| CLN-007 | Detached non-main Vocal identity | manual-review warning; no identity claim | Yes | Yes |

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

Recorded `0.2.0-alpha.1` evidence:

| Area | Environment and result |
|---|---|
| Query projection | SynthV 2.2.1 Pro standalone; ten representative reads completed in 43-219 ms and 160-1,698 model-facing characters, with zero shadow differences and zero mutation/Undo stages |
| Mixer Command | `0 dB → -3 dB` returned `changed`, one Undo and verified readback; repeating `-3 dB` returned `alreadySatisfied`, zero Undo; one Edit-menu Undo restored `0 dB` |
| Sidebar review | Preview did not mutate; Apply muted Track 1 with one Undo; one Edit-menu Undo restored mute off while gain remained `0 dB` |
| Linked clone | Source UUID was shared intentionally, fresh reference count increased, and one Undo removed only the new reference |
| Isolated clone | New UUID differed, reference count was one, deleting/restoring the clone's final note never changed the 42-note source |
| Track shell/delete | A verified-empty Track shell was removed by one Undo boundary while the source Track and isolated clone Track remained |
| Automation | A gender curve was visibly applied to the test Group and one Undo restored the prior flat curve |

These are bounded representative host checks, not a claim that every official
API method has been manually exercised.

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
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua
```

Actual SynthV integration remains a manual release gate.
