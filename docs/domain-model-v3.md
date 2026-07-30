# v3 Domain Model

Status: frozen for `0.2.0-alpha`

The Bridge models ownership and concurrency boundaries, not the complete
SynthV object graph.

| Aggregate | Identity | Owned state | Important rule |
|---|---|---|---|
| `GroupContent` | Session + Note Group UUID | Notes, lyrics, phonemes, Retakes, Automation, Smart Pitch, Group name | Shared by every Reference; content writes fail closed by default |
| `GroupReference` | Session + Track/Reference locator + digest | Target association, offsets, mute, time range, Voice and Vocal Mode values | Copying a Reference is not content isolation |
| `TrackShell` | Session + Track locator + digest | Name, color, mixer, order, bounced state, ordered references, host main Group | A shell clone must be verified empty |
| `ProjectTimeline` | Session + time-axis digest | Tempo, meter, blick/second conversion inputs | Every seconds conversion uses the fresh timeline |
| `UIState` | Current host UI | Selection, navigation, playback, dialogs, clipboard | Not project data and creates no project Undo |
| `ComputedPerformance` | Session + Reference + dependency digest | Computed pitch, phonemes, computed attributes | Asynchronous and never shared across References |

## Serialized locators only

Node stores serialized values, typed locators, short-lived Contexts, and
digests. Lua resolves current host objects inside each request. Neither side
retains a SynthV object reference across commands.

## Clone vocabulary

- `linked`: new Reference, same Note Group UUID.
- `isolated`: cloned Note Group, distinct UUID, reference count `1`, unchanged
  source snapshot, verified target association.
- `shell`: one empty track shell with host-owned main context.

Ambiguous clone intent fails. A `deepCopy` boolean is not part of v3.

The command registry declares the allowed intent for each clone action:

| Action | Intent | Aggregate effect |
|---|---|---|
| `clone_group_reference` | `linked` or `isolated` | Add a Reference to existing `GroupContent`, or clone the content and then add a Reference |
| `clone_track` | `isolated` | Clone the `TrackShell` and isolate every vocal `GroupContent` target |
| `clone_track_shell` | `shell` | Clone the host-owned main context, then remove notes, Smart Pitch, Automation, and non-main References |

Success is based on a fresh host reread. Linked success preserves the source
UUID and verifies the incremented reference count. Isolated success verifies
distinct UUIDs, intended target associations and reference counts, plus
unchanged source note, Automation, Smart Pitch, Track, and Reference snapshots.
Shell success verifies one Reference and no notes, Bridge-supported Automation
points, or Smart Pitch controls.

The official scripting API cannot read or prove detached non-main Vocal
identity. Such a clone returns a bounded manual-review warning and never names
or claims the Vocal.

## Authority

SynthV is the only live project authority. Agent knowledge, user instructions,
and tuning Skills choose artistic intent and explicit values; they do not
become persisted Bridge strategy state.
