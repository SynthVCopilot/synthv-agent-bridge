# ADR-0005: Keep MCP v2 and file IPC v2 during migration

Status: superseded in part by ADR-0008

Date: 2026-07-30

## Context

Observed large-session cost is dominated by full projections, repeated guarded
reads, and verbose errors. Ordinary host writes are comparatively short. A
transport rewrite would not reduce model tokens or solve consistency.

## Decision

- Keep the eight public MCP v2 tools.
- Keep file IPC protocol v2 as the sole Bridge envelope.
- Add only backward-compatible actions, optional fields, and compact
  projections during vNext migration.
- Preserve current correlation, single-writer locking, session detection, and
  stale-file recovery.
- Reconsider transport only after projection and command changes meet their
  budgets and profiling still identifies IPC as the dominant bottleneck.

## Consequences

- Migration does not require coordinated client, Node, and Lua replacement.
- Current manual and automated protocol tests remain useful.
- A future transport may reuse the same semantic envelope but would require a
  separate superseding ADR and protocol plan.
