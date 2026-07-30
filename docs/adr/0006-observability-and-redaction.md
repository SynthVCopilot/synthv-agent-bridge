# ADR-0006: Separate normal responses from developer traces

Status: accepted

Date: 2026-07-30

## Context

Small Agent responses save tokens, but removing all detail makes host failures
hard to diagnose. Logging full notes, lyrics, Automation points, or raw Guard
values would expose project content and recreate the response-size problem.

## Decision

Provide three observability levels:

- `normal`: compact MCP outcome, public error, affected counts, warnings,
  `traceId`, and Undo guidance.
- `support`: version/build/session hashes, target kind, stage, timing, cache
  status, counts, and fingerprint digests without musical content.
- `debug`: explicitly enabled, bounded, target-scoped diagnostic projections.

All stages share one correlation identifier across MCP, Context expansion,
file IPC, Lua execution, and result projection.

Default logs must not contain:

- lyrics or computed/user phoneme text;
- complete note or curve arrays;
- raw fingerprints or Guard values;
- absolute local score/audio paths beyond existing explicitly requested
  diagnostics;
- full request/response payloads.

## Consequences

- Users receive concise, actionable results.
- Developers can locate the failed stage without asking the Agent to repeat a
  large read.
- Content-bearing debugging requires explicit opt-in and remains bounded.
- A future support bundle can be implemented without changing normal MCP
  responses.
