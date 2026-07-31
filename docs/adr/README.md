# Architecture Decision Records

These ADRs record the accepted vNext direction. They constrain incremental
implementation but do not claim that the target code already exists.

| ADR | Decision |
|---|---|
| [0001](0001-synthv-is-the-authority.md) | SynthV is the sole live authority |
| [0002](0002-cqrs-lite-cache-aside-occ.md) | CQRS-lite, cache-aside, and OCC |
| [0003](0003-aggregate-and-clone-boundaries.md) | Aggregate and clone boundaries |
| [0004](0004-command-lifecycle-and-single-writer.md) | Common command lifecycle and one writer |
| [0005](0005-keep-protocol-v2-and-file-ipc.md) | Superseded by ADR-0008 for the surface/envelope; file transport rationale retained |
| [0006](0006-observability-and-redaction.md) | Dual response/trace projections with redaction |
| [0007](0007-strangler-migration.md) | Migrate by vertical slices |
| [0008](0008-v3-breaking-surface-and-protocol.md) | Six-tool v3 surface, protocol v3, and atomic component upgrade |

New ADRs use the next number and one of these statuses:

- proposed;
- accepted;
- superseded by ADR-NNNN;
- rejected.

An accepted ADR is changed only by a new superseding ADR. Small clarifications
that do not alter the decision may be added with a dated note.
