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

## Authority

SynthV is the only live project authority. Agent knowledge, user instructions,
and tuning Skills choose artistic intent and explicit values; they do not
become persisted Bridge strategy state.
