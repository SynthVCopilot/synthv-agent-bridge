# ADR-0001: SynthV is the sole live authority

Status: accepted

Date: 2026-07-30

## Context

The official scripting API exposes a live object model but no complete project
change feed. Users and other scripts may edit the project without passing
through the Bridge. The `.svp` file is a saved snapshot with an undocumented
internal schema and may lag behind unsaved host state.

## Decision

- The current SynthV project is the sole authority for live project data.
- Every project write is freshly resolved and validated in Lua.
- Node caches are disposable projections and never authorize writes.
- The Bridge does not parse, mutate, or monitor `.svp` files.
- The Bridge does not build a durable project mirror or event store.

## Consequences

- Repeated authoritative reads still require host interaction.
- Read-only cache entries may be stale after manual edits and must be labeled
  internally as such.
- Writes remain safe even if the cache is stale or empty.
- Missing official API fields require an explicit user/UI handoff or a future
  official API, not raw project-file access.
