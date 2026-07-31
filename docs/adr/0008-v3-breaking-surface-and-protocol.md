# ADR-0008: Adopt the v3 semantic surface and protocol

Status: accepted

Date: 2026-07-30

Supersedes: ADR-0005 for the public MCP surface and IPC envelope. It also
supersedes the public-compatibility portion of ADR-0007. The local file
transport and vertical-slice migration strategy remain accepted.

## Context

The eight-tool v2 surface made callers choose between edit, delete, and
transaction transport concepts even though they are all project commands.
Responses also lacked a first-class distinction between a real mutation, an
already-satisfied state, and a failure. Build skew between Node, Lua, and the
Sidebar was difficult to diagnose.

Maintaining a runtime v2/v3 dual stack would preserve those ambiguities and
double the safety and test surface during the highest-risk part of the
migration.

## Decision

- Bridge v3 exposes exactly six public tools:
  `sv_status`, `sv_describe`, `sv_query`, `sv_command`, `sv_ui`, and
  `sv_review`.
- Detailed SynthV actions remain private, just-in-time definitions.
- File IPC protocol v3 is the sole accepted envelope. Protocol v1 and v2
  requests fail with `PROTOCOL_MISMATCH`.
- The first v3 release remains on local file transport behind a transport
  adapter.
- Project command results use `changed`, `alreadySatisfied`, or `failed`.
- Node, Lua, Sidebar, protocol, and action-catalog build identities are checked
  before project writes.
- There is no runtime v2 compatibility mode.

## Consequences

- The package version advances to `0.2.0-alpha`.
- Clients and all installed Bridge components must upgrade together.
- Failed installation must restore the previous complete component set.
- Existing v2 action handlers may temporarily remain as private adapters, but
  must not be registered as public MCP tools.
- Read-only diagnostics remain available when the optional Sidebar is absent.
  A detected active component mismatch blocks project writes.
