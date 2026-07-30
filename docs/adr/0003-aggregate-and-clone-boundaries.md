# ADR-0003: Separate GroupContent, GroupReference, TrackShell, and timeline

Status: accepted

Date: 2026-07-30

## Context

A `NoteGroupReference` can be cloned while still targeting the original
`NoteGroup`. Treating a Track clone as a recursively isolated object graph
caused source and comparison tracks to share notes and Automation.

## Decision

- Model shared Group-owned state as the `GroupContent` aggregate.
- Model placement, offsets, mute, time range, and exposed Voice properties as
  the `GroupReference` aggregate.
- Model Track metadata, mixer, and ordered references as `TrackShell`.
- Model tempo/time-signature state as `ProjectTimeline`.
- Require explicit `linked`, `isolated`, or `shell` clone intent.
- Default ambiguous non-main Group cloning to rejection.
- Verify isolated clone UUID separation, reference counts, target association,
  and unchanged source summaries.

## Consequences

- Guard and cache invalidation scopes become more precise.
- A content write intentionally affects every linked reference or is rejected.
- Non-main Vocal identity remains a manual-review limitation.
- Generic `deepCopy: true` is not an acceptable public safety claim.
