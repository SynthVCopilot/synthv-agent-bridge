# ADR-0002: Use CQRS-lite, cache-aside, and OCC

Status: accepted

Date: 2026-07-30

## Context

Read and write representations have different token, validation, and latency
requirements. A separate durable read store would require a synchronization
mechanism that the SynthV API cannot provide. Current fingerprints already
express an optimistic "unchanged since read" expectation.

## Decision

- Separate Query and Command logic while retaining SynthV as their shared
  underlying state.
- Use bounded in-memory cache-aside for immutable projections.
- Invalidate touched entries after Bridge writes and repopulate only from
  verified host results.
- Require host-verified data to mint a write-capable Context.
- Continue optimistic fingerprint validation in Lua.
- Describe retained projections as versioned snapshots, not MVCC versions.

## Rejected alternatives

- Separate SQLite/Redis read database.
- Pure write-through cache as the consistency mechanism.
- Write-behind caching.
- Event sourcing.
- Full MVCC or snapshot isolation claims.

## Consequences

- The cache reduces repeated read-only work without weakening writes.
- Manual edits can make read-only cached projections stale.
- Cache freshness, hit/miss reason, and invalidation cause become observable.
- Cache failure degrades to host reads instead of blocking project access.
