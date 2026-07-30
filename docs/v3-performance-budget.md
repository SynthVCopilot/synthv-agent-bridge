# v3 Performance and Token Budget

Status: initial engineering targets

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

## Cache targets

- Cache memory is bounded by both entry count and estimated weight.
- Every entry includes session, target, projection, version digest, and
  freshness class.
- `hostVerified` and `sessionCached` hit counts are recorded separately.
- A cache error always falls back to an authoritative host read.
- Cache eviction never invalidates an in-flight command's copied Guard data.
- No target is considered fresh only because its TTL has not expired.

No minimum hit rate is set before real traces exist. A cache with a low hit
rate or high invalidation cost should be removed rather than defended.

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
5. Add bounded read-only snapshot caching.
6. Profile again.
7. Consider transport changes only with measured remaining IPC dominance.
