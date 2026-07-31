# Twinkle Star guided demo

[English](twinkle-star-demo.md) |
[简体中文](twinkle-star-demo_cn.md)

The bundled demo lets a first-time user ask Codex to create and tune a complete
Mandarin version of **Twinkle Star** with the existing compact MCP surface.
It is a guided one-command workflow: once Vocal onboarding is complete, Codex
handles score creation, tuning, verification, and playback.

Start it with:

```text
Run the Twinkle Star demo.
```

The machine-readable score and tuning recipe is
[`examples/twinkle-star-demo.json`](../examples/twinkle-star-demo.json).
It is Agent-owned example data, not a ninth MCP tool and not hidden musical
logic in the TypeScript or Lua layers.

## What the user sees

Codex prints one short heading before each stage:

1. **Demo 1/5: Check the connection and safe location**
2. **Demo 2/5: Create an isolated Twinkle Star Note Group**
3. **Demo 3/5: Select the Vocal and identify every singing style**
4. **Demo 4/5: Write full-song tuning and pitch curves**
5. **Demo 5/5: Reread, verify, and start playback**

Each heading may have one concise status sentence. Codex does not print raw MCP
payloads or repeat the full first-use checklist after a preview.

## Guided workflow

1. Codex verifies the Bridge and reads only enough project structure to choose
   a harmless position after existing project content.
2. After explicit user consent, Codex uses `add_notes` with
   `grouping: "ensureNonMain"` to create one non-main Group named
   `SynthV Agent Demo - 小星星`. It does not edit existing notes, lyrics,
   timing, automation, tracks, or Groups.
3. The user selects that Demo Group and selects or assigns the intended Vocal.
   The user then attaches the complete Vocal Mode panel or types every singing
   style exactly as shown.
4. This pause is required because SynthV's official scripting API cannot read
   the current Vocal identity or enumerate untouched default-only Vocal Mode
   names. Codex must not guess or skip it.
5. Codex rereads the Demo Group, maps only the supplied exact style names to
   the bundled gentle/bright/childlike intent, reads current Automation
   `definition.range` values, and applies one `apply_group_tuning` batch. The
   Demo template puts `automation` and `pitchAnalysis` in the top-level
   `sv_query.include` projection so their fresh Guards remain in the Context.
6. Codex rereads the entire Demo Group and verifies 42 notes, five intentional
   phrase gaps, zero overlaps, retained Vocal Modes and phonemes, and all five
   automation curves before starting loop playback.

The initial request is therefore one command, with one required user handoff
for Vocal selection and singing-style names. Everything after that handoff is
automatic.

## Safety and undo

- The Demo may change only the Group it created during the current task.
- Existing or provenance-unknown material is user-owned and must not be
  normalized, moved, shortened, lengthened, or retuned by the Demo.
- Notes inside each Demo phrase connect exactly. The only positive gaps are the
  five declared phrase boundaries; pronunciation is shaped through phonemes,
  Voice settings, and Automation rather than tiny note gaps.
- Score creation and tuning are two SynthV undo records. Undo tuning once,
  then undo score creation once if the whole Demo should be removed.
- SynthV and the user remain the final state and listening authorities.

## What the Demo covers

- 42 Mandarin notes and the common lyrics
- one isolated reusable non-main Note Group
- exact intra-phrase note connections and six phrase endings
- Group Voice and exact user-supplied Vocal Mode names
- computed-phoneme strength and timing work
- loudness, tension, breathiness, pitch-deviation, and vibrato-envelope curves
- guarded fresh reads, one prevalidated tuning batch in a single undo record,
  post-write verification, and
  loop playback

The Demo intentionally uses the same six MCP v3 tools and internal actions as a
normal tuning session, so a successful run demonstrates the real workflow.
