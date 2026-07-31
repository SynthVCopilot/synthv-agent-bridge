# v3 Performance and Token Budget

Status: enforced budgets with measured Phase 6 baseline

Date: 2026-07-30

These targets prioritize correctness. A budget failure blocks optimization
claims but never permits dropping required Guards, preflight, or
postconditions.

## Observed problem shape

A July 2026 production-sized tuning session showed:

- one full-song diagnostic response around 1.67 million characters;
- later phases consuming millions more characters through repeated complete
  note and Guard rereads;
- individual ordinary Bridge writes commonly around 40-100 ms;
- bounded sampling and verification commonly around 100-300 ms.

The first optimization target is projection and orchestration volume, not
transport replacement.

## Implemented Phase 6 outcome

- The six-tool catalog, Query Projector, command acknowledgement, public error,
  and normal Trace-size budgets are executable repository gates.
- File IPC reports queue wait separately from host processing, and Query
  projection reports its own duration.
- The official API coverage checker joins every live semantic write to one
  Command Policy and test/host-verification status.
- Snapshot caching remains disabled in production after measurement; no
  performance claim depends on a potentially stale project read.
- File IPC remains the transport because total real-host round trips meet the
  ordinary target, while the current traces do not isolate enough
  transport-versus-host time to justify a transport rewrite.

## Model-facing size targets

| Payload | Target |
|---|---:|
| Complete default MCP tool catalog | under 6 KB, existing gate retained |
| Ordinary compact read | p95 at or below 20 KB |
| Write success acknowledgement | at or below 2 KB |
| Public error | at or below 4 KB |
| One requested action description | at or below 12 KB |
| Normal stale error raw fingerprints | 0 bytes |
| Unrequested full note/curve arrays | 0 bytes |

Larger explicit reads are allowed only when the caller requests the relevant
projection/page. They must report pagination or range coverage rather than
silently truncating correctness data.

Phase 3 enforces the ordinary-read target as simultaneous 20,000-character and
20,000-UTF-8-byte hard gates for unscoped defaults. The final public JSON is
measured after compact projection.
Explicit pages, ranges, `include`, or `fields` projections remain available
when the caller deliberately requests them; telemetry records whether they
exceed the ordinary budget. The rejected payload is never copied into the
public error.

## Interaction targets

- Common guarded edit: one focused fresh read plus one logical write.
- Same-Group composite tuning: one write request and one Undo record.
- Computed phoneme/pitch pending retries: handled inside one bounded Lua
  operation where practical, not repeated by the Agent.
- Stale write: one compact failure containing enough scope information to
  perform a deliberate reread; no automatic unsafe retry.

## Latency targets

Initial local engineering targets, measured without audio-render completion:

| Operation | p95 target |
|---|---:|
| Node immutable snapshot cache hit | 5 ms |
| Context/Guard expansion | 5 ms |
| Compact pure Node projection | 10 ms |
| Ordinary host read/write round trip | 300 ms |
| File IPC queue wait with no earlier work | 50 ms |

Host-computed pitch, phonemes, large Automation sampling, dialogs, and actual
rendering are reported separately and do not use the ordinary 300 ms target.

### Current real-host sample

On 2026-07-30, the following preliminary real-host sample was recorded:

| Field | Observed value |
|---|---|
| Bridge / protocol | `0.2.0-alpha.1` / v3 |
| Node runtime | `v26.1.0` |
| Installed Git commit | `612afb2815146edb95b5892be943ecc23c57d81c` |
| Node build fingerprint | `3f48948394ecdd850601cd41e78d39665839dfe93db888a25b828760135a4502` |
| Lua executor | `sv3-lua-0.2.0-alpha.1-6` |
| Sidebar | `sv3-sidebar-0.2.0-alpha.1-3`, matched |
| Host / mode | SynthV Studio 2 Pro 2.2.1 / standalone / Windows 11 |
| Project size | 2 Tracks, 84 Notes total; target Track 1 has 42 Notes |
| Derived-data counts | Pitch controls: N/A; Automation points: N/A (Mixer-only query) |
| Action / projection | 30 sequential `get_track_mixer` / `readOnly` / default fields |
| Cache / freshness | not used; every sample reached the authoritative host and was `hostVerified` |
| Tool-side latency | 60 ms minimum, 83 ms median, 149 ms p95, 151 ms maximum |
| Bridge-internal latency | 77 ms p95 from the 15 most recent bounded summaries |
| IPC queue stage | 4 ms p95 in the retained internal summaries |
| Lua and final projection | Lua schema/read/projection 0-3 ms; Node final projection 2-5 ms |
| Example payload sizes | 130 request characters, 398 Lua response characters, 160 model-facing characters |
| Outcome / Undo | success / read-only / 0 Undo records |
| Preflight, mutation, verification | not applicable to this read-only action |

This confirms the instrumented ordinary-read path is below the 300 ms target.
It does not yet prove the less-than-5% tracing overhead target because the
running build has no tracing-off comparison mode. That relative claim remains
open until a controlled A/B benchmark exists.

The first Query Projector real-host acceptance used Node build fingerprint
`91cc96454c8fcee1439f9db94e393cf925974b46f3a6a10614713bf1f323c4ba`
at Git commit `efba4bb50889824baad5b86130e87eb17c9c1210`. One
`get_track_mixer` read completed in 73 ms; its independently built shadow
projection took 6 ms, matched all 7 compared fields with 0 differences, and
reported 1 private source field without exposing its value. The Trace contained
one `ipcPublished`/`ipcResponded` pair, so the shadow comparison introduced no
second host read. Node, Lua, and Sidebar Build Identity were `matched`.

The second Query Projector acceptance used Node build fingerprint
`e342aa372d6e9eba31ecab9ab775934a75287b1c9e64a32c9a55db3bf31ee340`
at Git commit `7fd21ab719525992653460993b2d8f152a6b98a1`. A compact
`get_group_voice` Query completed in 52 ms with a 6 ms shadow projection; an
explicit-diagnostics Query completed in 61 ms with a 4 ms shadow projection.
They matched `5/5` and `7/7` public fields respectively, counted 2 private
Group/Reference fields without exposing them, and each used one IPC host
request. Component Build Identity remained `matched`.

The first collection acceptance used Node build fingerprint
`b65fd7a419ddaa084fbf48d88ccb525d16774bb14f009f724db2bbfd0299a333`
at Git commit `7a588940b447087ed18517f1b9954c656757e4bb`. A two-item
`list_tracks` Query completed in 42 ms with a 6 ms shadow projection; the
`trackCount`-only projection completed in 41 ms with a 4 ms shadow projection.
They reported 0 differences, retained two nested read-only Contexts in the
full collection, counted two private Track fingerprints without exposing them,
and each used one IPC host request. Component Build Identity remained
`matched`.

The library-ownership collection acceptance used Node build fingerprint
`e4bf1c1632120863c2fc68df67a2ac2b99517bc9c55bcc6637ec67f3d8f0b16a`
at Git commit `0f748b6df0ebc608858717c58c165d0bda472874`. A two-item
write-intent `list_note_groups` Query completed in 75 ms with a 7 ms shadow
projection; the `groupCount`-only Query completed in 74 ms with a 3 ms shadow
projection. They reported 0 differences, retained two nested library-Group
Contexts in the full collection, counted four private UUID/fingerprint fields
without exposing them, and each used one IPC host request. The model-facing
JSON was 357 and 48 characters respectively. Both authoritative Lua responses
were 30,429 bytes because the current private content fingerprints serialize
the complete Group definition; this remains an internal transport/projection
optimization opportunity rather than model-token exposure. Component Build
Identity remained `matched`.

The final Phase 3 Query gate used Node build fingerprint
`cf5a9ac681eff0b615d3a5c62f27195c2aec98a8262baac7092136d69e25f56f`
with Lua executor `sv3-lua-0.2.0-alpha.1-6` and Sidebar
`sv3-sidebar-0.2.0-alpha.1-3`; all components were `matched`. The saved
standalone SynthV 2.2.1 test project contained two Tracks, two library Groups,
42 Notes in the selected Group, zero Smart Pitch controls, and 22 Loudness
Automation points.

Ten final-build representative reads covered Mixer, Group Voice,
Track/library collection pages, a two-note phrase page, an empty Smart Pitch
page, a ready two-note computed-data page, independent time-axis pages, and
Automation summary/closed-range modes. End-to-end Trace duration ranged from
43 to 219 ms. Model-facing JSON ranged from 160 to 1,698 characters. All four
shadow-enabled paths reported zero differences; the Track and library-Group
collection shadows each counted four private UUID/fingerprint fields without
exposing them. Every Trace reported zero mutation or Undo stages. Snapshot
caching remained disabled, so each result came from the authoritative host.

### Reproducible Phase 6 synthetic baseline

Run `npm run benchmark:v3` after a build. The benchmark uses generated data
only and does not connect to SynthV or copy project content.

On 2026-07-31 with Node `v26.1.0`, 500 iterations produced:

| Projection | p95 | Result chars / UTF-8 bytes | Budget chars / bytes |
|---|---:|---:|---:|
| Six-tool catalog | N/A | 4,336 / 4,336 | 6,000 / 6,000 |
| 64-note compact phrase Query | 1.104 ms | 4,757 / 4,757 | 20,000 / 20,000 |
| Changed command acknowledgement | 0.008 ms | 129 / 129 | 2,048 / 2,048 |

The repository test also constructs a 100,000-character private fingerprint
and multibyte Chinese diagnostics, and proves that the normal public error
remains below both 4,096 characters and 4,096 UTF-8 bytes without containing
the fingerprint. Normal Trace correlation stays within both 1,024-unit
response allowances.

The file IPC Trace now records queue entry and dequeue wait separately. Query
projection records its own duration, while Lua continues to report bounded
numeric schema/read/preflight/mutation/verification stage timings.

### Snapshot cache decision

**Decision on 2026-07-31: Snapshot LRU not justified; activation is deferred.**

The measured 30-request real-host sample has a 149 ms p95 and the final Phase 3
matrix remains below the 300 ms ordinary-operation target. Model-facing
results are already 160-1,698 characters in that matrix, and pure projection is
well below 1 ms in the reproducible 64-note fixture. A cache could avoid some
authoritative read latency, but SynthV provides no complete project-change
subscription, so a read-only hit may omit a user's later manual edit. The
current latency and token data do not justify that freshness tradeoff or the
additional invalidation surface.

`V3SnapshotCache` remains a bounded, disposable tested component but is not
wired into `sv_query`; every current Query reaches SynthV. Task 12 is skipped.
It may be reconsidered only after new traces show repeated cache-tolerant reads
are a material workload and a specific projection can declare acceptable
staleness. Write-intent reads and all write authorization will remain
host-authoritative regardless.

## Dormant cache requirements

- Cache memory is bounded by both entry count and estimated weight.
- Every entry includes session, target, projection, version digest, and
  freshness class.
- `hostVerified` and `sessionCached` hit counts are recorded separately.
- A cache error always falls back to an authoritative host read.
- Cache eviction never invalidates an in-flight command's copied Guard data.
- No target is considered fresh only because its TTL has not expired.

No minimum hit rate is set because the component is not active. A future
activation requires a new measured workload, an explicitly cache-tolerant
projection, and a superseding implementation decision. A cache with a low hit
rate or high invalidation cost should remain disabled.

## Trace overhead targets

- `normal` tracing adds no musical content and no more than 1 KB to a response.
- `support` diagnostics are explicitly requested, bounded to 8 KB, and use
  hashes/counts instead of payload copies.
- `debug` diagnostics are explicitly requested and bounded to 16 KB; their
  metadata keys are allowlisted and still cannot carry musical content.
- the optional Lua protocol telemetry block contains at most 24 numeric stage
  timings and is retained inside Node rather than ordinary model-facing
  results.
- tracing adds less than 5% p95 latency to ordinary operations after the first
  implementation phase;
- debug-content capture is excluded from normal performance claims.

## Measurement rules

Each benchmark record includes:

- Bridge, Node, Lua, and SynthV versions;
- action and target kind;
- projection/include mode;
- note, pitch-control, and Automation-point counts;
- cache status and freshness class;
- queue, preflight, mutation, verification, and projection timings;
- request, response, and model-facing character counts;
- success/error code and Undo count.

Do not compare timings from different project sizes without reporting the
counts. Do not include binary screenshots, audio, or render-cache sizes in
model-token character totals.

## Optimization order

1. Remove unrequested computation and serialization.
2. Keep raw Guards server-side behind Contexts/Tokens.
3. Batch one logical aggregate edit into one command.
4. Return deltas and postcondition summaries.
5. Consider bounded read-only snapshot caching only when measurements justify
   its freshness and invalidation cost.
6. Profile again.
7. Consider transport changes only with measured remaining IPC dominance.
