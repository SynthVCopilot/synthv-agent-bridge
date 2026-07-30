# ADR-0007: Migrate vNext by vertical slices

Status: accepted

Date: 2026-07-30

## Context

The current Bridge already has broad API coverage and safety behavior. A
big-bang rewrite would make parity difficult to prove and would increase the
risk of destructive regressions inside SynthV.

## Decision

- Keep the public interface and migrate internal actions one vertical slice at
  a time.
- Add tests that reproduce known failures before changing their handlers.
- Introduce observability before cache behavior.
- Improve compact projections before changing transport.
- Introduce the common command pipeline with one low-risk action, then migrate
  higher-risk clone and aggregate writes.
- Run new read paths in non-mutating shadow comparisons where practical.
- Never shadow-execute project writes.
- Remove an old path only after automated parity and real SynthV manual
  acceptance.

## Consequences

- Old and new internal paths temporarily coexist.
- Each slice has a small rollback surface.
- Architecture progress is measured by migrated actions and passed acceptance
  gates, not by a directory rewrite.
