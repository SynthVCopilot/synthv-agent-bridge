# ADR-0004: Use one command lifecycle and one logical writer

Status: accepted

Date: 2026-07-30

## Context

Low-level actions currently contain repeated validation, Undo, mutation, and
verification behavior. Missing or inconsistent postconditions can allow a
no-op route to appear successful. The existing file IPC path already
serializes operations.

## Decision

Every ordinary project write follows:

```text
accept -> resolve -> fresh read -> guard -> preflight
       -> undo -> mutate -> verify -> project
```

- Node and Lua retain one logical writer.
- Every stage emits redacted trace metadata under one `traceId`.
- A successful command must satisfy an affected-count or action-specific
  postcondition.
- Independent work is fully preflighted before Undo.
- Dependent transaction steps retain just-in-time preflight and explicit
  `undoRequired` recovery.
- No per-object lock service is added.

## Consequences

- Failures are attributable to a stable stage.
- One logical command maps to one SynthV recovery boundary.
- Action migration requires adapting existing handlers to the common pipeline.
- Host integration still requires manual testing in SynthV.
