# SynthV Agent Bridge

[English](README.md) | [简体中文](README_CN.md)

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets compatible AI clients inspect and control the project currently open in **Synthesizer V Studio 2 Pro**.

The bridge uses Synthesizer V's public Lua scripting API. It does **not** parse or rewrite `.svp` files, open a network port, or call an AI API by itself.

> New here? Follow the [Quickstart](docs/quickstart.md). Codex can handle most
> setup steps for you, including environment checks, Node.js installation when
> permitted, dependency installation, the build, SynthV script installation,
> MCP registration, and diagnostics.
> 中文用户请参阅[中文快速开始](docs/quickstart_cn.md)；环境检查、依赖与
> Node.js 安装、构建、SynthV 脚本安装、MCP 注册和诊断等大部分工作都可以
> 交给 Codex 完成。

> [!TIP]
> First connection? Reply **`Run the Twinkle Star demo.`** Codex will explain
> each stage with a short heading, create an isolated 42-note Demo Group, pause
> once for you to select its Vocal and provide every exact Vocal Mode name,
> then automatically tune, verify, and loop the song. Existing project material
> is not modified. See the [guided Demo](docs/twinkle-star-demo.md).

> [!IMPORTANT]
> Because SynthV's official scripting API cannot read the current Vocal
> identity or enumerate untouched default-only singing style (Vocal Mode) names
> and parameters, first select a Note Group, then select or assign the Vocal you
> want to use for that Group. Only then attach a screenshot of its complete
> singing-style panel or type every style exactly as shown; the names cannot
> appear before a singer is selected. If no suitable Note Group exists or the
> Vocal Modes are not visible, first create—or ask the Agent to create—one
> temporary note in one temporary non-main Note Group at a harmless location,
> select that Group and its Vocal, then capture the complete panel. After
> changing Vocals, capture the new Vocal's complete panel or type all of its
> singing-style names again; do not reuse the previous Vocal's list.

> Status: **v0.2.0-alpha.1 / protocol v3**. The six-tool semantic Facade,
> typed Query Contexts, compact Command outcomes, component build-coherence
> checks, Query Projector, common Command Kernel, semantic write-policy
> catalog, aggregate tuning, safe clone semantics, and dependent transaction
> recovery are implemented. Representative SynthV 2.2.1 standalone
> certification is recorded; the stable `0.2.0` release gate remains open.
> Test writes only on saved working copies.

See the [v3 architecture](docs/architecture-v3.md),
[development plan](docs/v3-development-plan.md), and
[SV2 API coverage matrix](docs/sv2-api-coverage-v3.md).

## What it can do

| Area | Capabilities |
|---|---|
| Project inspection | Read project metadata, tracks, library Groups, notes, selections, tempo/time-signature maps, computed phonemes and pitch, automation, mixer state, and editor context. |
| Notes and lyrics | Add, edit, delete, clone, transpose, or humanize guarded notes; fit lyrics and edit language, singing/rap type, timing, detune, and note attributes. |
| Voice and phonemes | Read and edit Group Voice, Vocal Mode axes, experimental Unison fields, phoneset overrides, syllable timing, pronunciation, and per-phoneme timing or strength. |
| Pitch and expression | Adjust pitch transitions and pitch curves; manage Smart Pitch controls and AI Retakes; apply scoop, falloff, vibrato, crescendo, or breathiness presets. |
| Automation | Read, add, replace, sample, simplify, or clear pitch deviation, loudness, tension, breathiness, voicing, gender, and Vocal Mode curves. |
| Tracks, Groups, and harmony | Create, clone, reuse, update, or delete library Groups, Group references, and tracks; create an empty host-cloned Vocal template track; and create range-constrained harmony tracks. Shared Group content writes fail closed unless all references are explicitly acknowledged. |
| Local score import | Inspect an explicitly supplied local MusicXML (`.xml`, `.musicxml`, `.mxl`) or SMF MIDI (`.mid`, `.midi`) file, then import one rights-confirmed monophonic lane through the guarded note-write path. URLs and `.svp` files are not accepted. |
| Timing, editor, and playback | Convert seconds, quarter notes, and blicks; edit tempo/time signatures; control selection, viewport, clipboard, grid snapping, coordinates, mixer, and playback. |
| Safe editing | Protect writes with fresh fingerprints, typed/scope-bound `contextId` values, and Guard Tokens; fully preflight independent transaction steps, resolve forward dependencies just in time, create one SynthV undo record, and optionally retain a guarded rollback plan. |
| Review and local privacy | Review, apply, dismiss, or cancel guarded previews in the optional native side panel. File IPC stays local: the Bridge does not parse `.svp` files, open a network port, or call an AI API. |

## Responsibility boundaries

The Bridge separates musical judgment from deterministic execution. The Agent
decides **why, where, and how much** to change. The MCP and Lua layers execute
that explicit decision compactly, safely, and against current SynthV state.
SynthV stores the result, and the user makes the final listening decision.

| Work | Owner | Reason |
|---|---|---|
| Understand user intent, lyric emotion, and singing style | Agent | Requires language and musical-semantic judgment |
| Decide which words to strengthen, soften, lengthen, or connect with pitch transitions | Agent | This is an artistic decision |
| Ask for the current Vocal and every Vocal Mode name | Agent + user | The official API cannot read Vocal identity or enumerate untouched default-only Vocal Modes |
| Decide whether to tune a short phrase or a larger scope | Agent | Depends on the goal, review cost, and token budget |
| Convert terms such as warm, restrained, or bright into explicit parameters | Agent | The Bridge must not interpret artistic language |
| Choose a fresh target scope and explicit numeric batch transform | Agent | Target selection and musical values belong to the current task |
| Choose a legal local score and confirm the right to import it | Agent + user | The Bridge cannot determine copyright or license authority |
| Provide current Group, note, Voice, and automation data | Lua Bridge | SynthV's live object model is authoritative |
| Cache and expand typed, scope-bound `contextId` and Guard data | TypeScript MCP | Avoids repeating large fingerprints while failing closed on incompatible scope |
| Inspect and convert an explicitly supplied local MusicXML/MIDI lane | TypeScript MCP | Keeps bounded local parsing outside SynthV without implying permission to use the file |
| Project compact reads and minimal write acknowledgements | TypeScript MCP | Keeps irrelevant host data out of the model context |
| Detect SynthV restart or Bridge reload | TypeScript MCP | Old Context and Guard data must be invalidated before another write |
| Validate request structure, routing, indices, and stable protocol ranges | TypeScript MCP | Rejects malformed work before file IPC |
| Read the current Automation `definition.range` | Lua Bridge | The range can vary with the host, voice, and parameter |
| Expand deterministic note transforms and other batch mechanics | Lua Bridge | Mechanical calculations should be centralized and reproducible |
| Validate fingerprints and the complete prepared batch | Lua Bridge | Prevents overwriting user edits or partially applying invalid work |
| Block accidental edits to multiply referenced Note Group content | Lua Bridge | Group content is shared even when references appear on different tracks |
| Create one undo record and verify host postconditions | Lua Bridge + SynthV | Provides one recovery boundary and avoids false success |
| Save, audition, undo, and approve the final result | User + SynthV | The user is the final artistic authority |

See the detailed [Agent / MCP responsibility boundaries](docs/responsibility-boundaries.md)
for the enforced layer rules and batch-operation admission criteria.

## First MCP connection: user notice

On the first project-changing use in a conversation, the Agent must briefly
tell the user:

- An optional guided Demo is available. Reply `Run the Twinkle Star demo.` to
  create and tune an isolated example without changing existing material. The
  Agent prints five short progress headings and pauses once for Vocal/Vocal
  Mode onboarding because of the official API limitation.
- Save important work before AI editing and avoid changing the same target
  while a Bridge write is running.
- After undoing or manually editing the notes, Group, Voice, or Vocal Modes
  that the Agent is about to change, the Agent will compactly reread only that
  target. Unrelated edits do not require a reread.
- SynthV's scripting API does not expose the current singer identity or
  enumerate untouched default-only Vocal Mode names and parameters. Before the
  first tuning write, the Agent must ask the user to select the intended Note
  Group, select or assign its intended Vocal, and then either list every exact
  singing style (Vocal Mode), preserving spelling and capitalization, or attach
  a screenshot of the complete Vocal Mode panel. Without a selected singer,
  its singing-style names cannot appear.
- The Agent must not perform a tuning write until this information is provided.
  If no suitable Note Group exists or the Vocal Modes are not visible, the only
  permitted bootstrap write is one temporary note in one temporary non-main
  Note Group, created solely to make the singing-style parameters available.
  The user then selects that Group and its Vocal. The Agent must stop and
  request the complete panel screenshot or exact style names. The identified
  styles are reused only for the same Vocal. After the Vocal changes, the Agent
  requires a new complete-panel screenshot or every exact style name for the
  new Vocal.
- Before the first tuning write, the Agent must present one concise
  **How to use** and one preflight checklist covering save/backup, Vocal and
  singing-style onboarding, target phrase, intended style and preserved
  content, fresh-read/plan/review behavior, phrase-level style before word-level
  tuning, concurrent-edit safety, and undo. It must not show another checklist
  after publishing the preview.

The Agent must give this notice once, not before every edit. A concise prompt
from the user is sufficient:

```text
Current singer Vocal Modes: Airy, Bright, Cool, Dark, Emotional, Power, Solid,
Sweet.
```

Alternatively, attach a screenshot that clearly shows the complete Vocal Mode
panel.

## Architecture

```text
Codex / another local stdio MCP host
                    │
                    │ MCP over stdio
                    ▼
         TypeScript MCP server
                    │
                    │ correlated JSON file IPC
                    ▼
       SynthVAgentBridge.lua (persistent)
                    │
                    │ SynthV scripting API
                    ▼
       Open Synthesizer V Studio project
```

File IPC is deliberately used for the first version because it works within SynthV's documented Lua environment and is easy to inspect and recover. See [docs/architecture.md](docs/architecture.md).

Local score inspection is the bounded exception to the Node server's
project-data pass-through role: it reads only an explicitly supplied absolute
MusicXML/MIDI path. Inspection stays in Node; an approved import sends converted
notes through the same guarded Lua `add_notes` path. It never parses `.svp`.

## Requirements

- Synthesizer V Studio **2 Pro 2.1.2 or later**.
- Node.js **20.10 or later**.
- An MCP host that supports local stdio servers, such as Codex CLI or another compatible local client.

This project targets the scripting environment in Synthesizer V Studio 2 Pro; it does not target the Basic edition.

## Installation

New users can follow the end-to-end [Quickstart](docs/quickstart.md) or
[中文快速开始](docs/quickstart_cn.md). It covers cloning the repository,
Codex-assisted Node.js setup, script installation, MCP registration, connection
verification, and the first guarded tuning edit.

### 1. Build the MCP server

```bash
git clone https://github.com/zhoupengjie/synthv-agent-bridge.git
cd synthv-agent-bridge
npm install
npm run build
```

### 2. Install the SynthV scripts

In Synthesizer V Studio, use **Scripts → Open Scripts Folder**, then pass that directory to the installer:

```bash
npm run install:synthv -- --target "/path/to/Synthesizer V Studio 2/scripts"
```

The installer copies these files into a `SynthV Agent Bridge` subfolder of the directory you selected:

- `SynthVAgentBridge.lua`
- `StopSynthVAgentBridge.lua`
- `SynthVAgentSidebar.lua` (optional)

Alternatively, set `SYNTHV_SCRIPTS_DIR` to the scripts directory before running
`npm run install:synthv`. The installer creates a `SynthV Agent Bridge`
subfolder. When the side-panel file changed, choose **Scripts → Rescan**.
SynthV then loads **SynthV Agent** as a custom side-panel section. Rescan stops
persistent scripts, so afterward run **Start SynthV Agent Bridge** once.

The Bridge and every ordinary MCP read/write tool work without the side panel.
For a core-only installation, add `--without-sidebar`; this skips the optional
panel without deleting an existing installation:

```bash
npm run install:synthv -- --target "/path/to/scripts" --without-sidebar
```

If a hot-reload-capable Bridge session is already running, the installer asks
it to load the copied Lua file and waits for a new session heartbeat. This uses
the Bridge's file IPC and Lua `loadfile()`—not UI automation or hooks. Use
`--no-reload` to copy without requesting a reload. The first installation of a
hot-reload-capable version must still be started manually once. A required
side-panel rescan also stops the current Bridge and therefore needs one manual
start afterward. SynthV may reuse cached menu-script code after a project or
app restart, so when the Bridge runtime itself changed, the installer also
asks for one **Scripts → Rescan** before the next manual start. Hot reload keeps
the current session usable until then.

### 3. Start the in-editor bridge

In Synthesizer V Studio, run:

```text
Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge
```

The script remains active and writes a heartbeat while SynthV is running. To stop it, run **Stop SynthV Agent Bridge**, or use SynthV's **Abort All Running Scripts** command.

### 4. Connect an MCP host

#### Codex

The repository includes a project-scoped `.codex/config.toml`:

```toml
[mcp_servers.synthv-agent-bridge]
command = "node"
args = ["dist/src/cli.js"]
startup_timeout_sec = 120
```

Trust and open the repository root, build it, then restart Codex or start a new
task. This keeps the MCP registration scoped to this project and avoids
modifying the user's global Codex configuration.

A complete TOML example is available at [examples/codex-config.toml](examples/codex-config.toml). Other local MCP hosts can use the same `node .../dist/src/cli.js` command when they support **STDIO** servers.

### Optional native side-panel workflow

The v0.1.4 panel is an optional local review console. It deliberately keeps the
Bridge network-free and does not call an AI API itself. It starts in a compact
layout showing connection/task state; **Show details** exposes context,
instruction, activity, and history controls. A pending preview is surfaced
automatically even while compact:

1. Select notes or a Group in SynthV and enter an instruction in
   **SynthV Agent**.
2. Click **Copy & queue**. The panel stores the request in the local IPC
   directory and copies a handoff prompt to the host clipboard.
3. Paste the prompt into the connected Codex task.
4. Codex reads fresh SynthV state and publishes one fingerprint-guarded write
   or complete transaction back to the panel, including structured changes and
   risks.
5. Review the preview in SynthV, then click **Apply** or **Dismiss**.

Apply commands are consumed by the Node coordinator and sent through the same
serialized `FileIpcClient` used by MCP tools. The side panel never edits project
objects directly. SynthV's public scripting API can create undo records but
cannot invoke Undo. After a successful Bridge write, click the main editor and
use **Ctrl+Z**, or choose **Edit > Undo** when focus is still in the side panel.
See [docs/sidebar.md](docs/sidebar.md).

### 5. Verify the connection

Open an MCP-enabled conversation and ask it to call `sv_status`, followed by
`sv_query` with `action: "get_project_info"` and
`contextMode: "readOnly"`. A healthy status contains:

```json
{
  "connected": true,
  "fresh": true
}
```

## MCP v3 tools

The public MCP surface exposes six stable tools. Individual SynthV actions
and their full schemas are returned just in time by `sv_describe`, rather than
placing every action schema in the model context.

| Tool | Purpose |
|---|---|
| `sv_status` | Read connection, Session, capability, trace, and component-build status. |
| `sv_describe` | List actions or return one compact Query/Command/UI/Review schema. |
| `sv_query` | Run a read projection and create a `readOnly` or `writeIntent` Context. |
| `sv_command` | Run validated edit, delete, clone, import, or bounded batch commands. |
| `sv_ui` | Control selection, viewport, clipboard, dialogs, snapping, coordinates, or playback. |
| `sv_review` | Publish or inspect an optional Sidebar preview; the user applies or dismisses it inside SynthV. |

The normal tuning sequence is:

1. Call `sv_describe` for unfamiliar actions.
2. Read current state with `sv_query`; use `contextMode: "writeIntent"` before
   a project command.
3. Reuse the returned `contextId` in one `sv_command`.
4. Query again after an unknown Context, Session change, or any `STALE_*`
   result.

`contextId` stores only locators and concurrency guards in bounded Node memory.
Each handle is bound to a target kind and source scope. Reusing it with an
incompatible action, or combining it with a conflicting explicit locator or
guard, fails closed instead of silently retargeting the call. Locator-only
`readOnly` Contexts do not authorize writes. A `writeIntent` Context is minted
only from a fresh host read. SynthV still checks every complete private
fingerprint before creating an Undo record.

Phrase reads accept an `include` projection over `notes`, `voice`,
`automation`, `analysis`, `recommendations`, `pitchAnalysis`, `selection`, and
`diagnostics`. The v3 default is `notes`, `voice`, and `analysis`. Results with
at least 24 notes use a column/row representation when `dense: "auto"`; use
`dense: "never"` for ordinary objects. V3 note rows omit derivable absolute
end positions and report `noteDefaults.absolutePitch: "pitch"` when equal
absolute/local pitches were omitted.

Collection reads are bounded by default and return page/continuation metadata.
This includes Tracks, library Groups, time-axis marks, Track Groups/notes, computed
performance data, and Smart Pitch controls. Automation defaults to a compact
full-curve summary and returns point arrays only for an explicitly requested
closed range. An unscoped default Query above the 20,000-character response
budget fails with narrowing guidance instead of flooding the Agent context.

### Action catalog

These actions are routed internally through the six MCP v3 tools. They are
not registered as standalone MCP tools; request their current schemas through
`sv_describe` only when needed.

| Action | Access | Purpose |
|---|---:|---|
| `bridge_status` | Read | Read the heartbeat without requiring a round trip. |
| `sidebar_get_request` | Read | Read the latest instruction and selection summary queued by the native side panel. |
| `sidebar_status` | Read | Read Bridge/MCP diagnostics, task state, IPC path, recent summaries, and the latest coordinator error. |
| `sidebar_publish_preview` | Control | Publish one complete guarded write or transaction, structured changes, and risks for confirmation in SynthV. |
| `ping` | Read | Test the complete Node → Lua → Node path. |
| `reload_bridge` | Control | Reload the installed Lua Bridge in the current script session. |
| `get_host_info` | Read | SynthV host version, OS, language, project, and IPC information. |
| `host_clipboard` | Control | Read or write text through SynthV's host clipboard API. |
| `show_dialog` | Control | Show message, input, confirmation, or custom-form dialogs. |
| `convert_pitch` | Read | Convert MIDI pitch and frequency and identify black keys. |
| `get_project_info` | Read | Project, timing, playback, host, and current editor location. |
| `inspect_score_file` | Read | Inspect an explicitly supplied local MusicXML or SMF MIDI file in Node, return a SHA-256 file guard and selectable parts/voices/staves or tracks/channels, and preview a bounded monophonic lane without changing SynthV. |
| `get_time_axis` | Read | Bounded, independently paged tempo/time-signature marks; private full-state guards are captured behind Contexts. |
| `convert_time` | Read | Convert seconds, quarter notes, or blicks through the current tempo map, with optional Blick-grid rounding. |
| `set_time_axis` | Destructive | Add, replace, or remove tempo/time-signature marks. |
| `list_tracks` | Read | A bounded page of Track summaries, Group/note counts, and mixer state. |
| `list_note_groups` | Read | A bounded page of reusable library Group summaries and reference counts; private identities and guards remain Context-backed. |
| `create_note_group` | Write | Create an optionally populated reusable library group. |
| `clone_note_group` | Write | Deep-clone a track or library group into the library. |
| `delete_note_group` | Destructive | Delete a library group and all references to it. |
| `add_group_reference` | Write | Place a library group on a track. |
| `clone_group_reference` | Write | Make a linked or deep-copied reference on another track. |
| `get_track_notes` | Read | Independently bounded Group and note pages with attributes and offsets; private Group/note guards remain Context-backed. |
| `get_group_voice` | Read | Typed group voice defaults, Vocal Modes, experimental Unison fields, and target selection context. |
| `get_note_phoneme_data` | Read | User/computed phonemes, phoneset overrides, per-phoneme attributes, and note selection state, with optional compact note-index or seconds-range filtering. |
| `get_phrase_context` | Read | One compact, write-ready selected/ranged phrase read with note and automation Guard Tokens, voice/Vocal Modes, diagnostics, and recommendation-only review targets. |
| `get_selection` | Read | Selected groups, notes, Smart Pitch controls, and requested automation points. |
| `set_selection` | Control | Replace, add, remove, or clear editor selections and return the selection actually reported by SynthV. |
| `get_computed_group_data` | Read | Computed phonemes/rap attributes and optional pitch samples. |
| `add_track` | Write | Create a track and return its main Group locator. |
| `update_track` | Write | Rename, recolor, or change Render Panel inclusion. |
| `clone_track` | Write | Host-clone a track's main Vocal context with optional clear/transpose. A source containing non-main vocal Groups is rejected by default; `nonMainGroupPolicy=detach` makes their Group content independent, but their non-main Vocal identities must be reviewed manually. |
| `clone_track_shell` | Write | Host-clone the source track's main Vocal context into one verified-empty track, removing notes, pitch controls, known automation, non-main Groups, and—by default—mixer state. The API cannot read or name the inherited Vocal identity. |
| `delete_track` | Destructive | Delete a fingerprint-verified non-final track. |
| `update_group` | Write | Change vocal/instrumental reference state and supported vocal properties. |
| `set_group_voice` | Write | Fingerprint-verified typed voice, Vocal Mode, and host-validated experimental Unison updates, with an optional current-Group guard. |
| `apply_group_tuning` | Destructive | Prevalidate and apply one same-Group Voice/Vocal Mode, note/phoneme, and multi-automation tuning pass in one undo record. Unexpected execution failures explicitly require one SynthV Undo before retrying. |
| `delete_group_reference` | Destructive | Remove a non-main vocal or instrumental reference. |
| `import_monophonic_score` | Write | Import at most 512 notes from one freshly inspected, rights-confirmed local MusicXML/MIDI lane through guarded `add_notes`; the SHA-256 guard must match and source tempo is reported but not applied. |
| `add_notes` | Write | Add notes to a target group. V2 defaults to `grouping=ensureNonMain`, creating a reusable non-main group/reference when the target is the track main group; use `grouping=target` to write to the exact group. |
| `edit_notes` | Write | Edit fingerprint-verified notes. |
| `transform_notes` | Destructive | Apply one explicit guarded batch offset/scale to note onset, duration, or pitch. V2 can transform every note in a fresh Context without repeating indices. |
| `set_note_phoneme_properties` | Write | Edit fingerprint/Guard-verified phoneme, phoneset, syllable, timing, and strength properties, with optional compact acknowledgement and current-Group/selected-note guards. |
| `delete_notes` | Destructive | Delete fingerprint-verified notes. |
| `get_note_retakes` | Read | Read take count and Bridge-tracked Take IDs. |
| `generate_note_retake` | Write | Generate duration, pitch, or timbre variations. |
| `activate_note_retake` | Write | Activate the default or a Bridge-tracked Take. |
| `delete_note_retake` | Destructive | Delete a Bridge-tracked non-default Take. |
| `get_pitch_controls` | Read | Read point and curve Smart Pitch objects and fingerprints. |
| `add_pitch_controls` | Write | Add point or curve Smart Pitch objects. |
| `edit_pitch_controls` | Write | Edit fingerprint-verified Smart Pitch objects. |
| `delete_pitch_controls` | Destructive | Delete fingerprint-verified Smart Pitch objects. |
| `get_automation` | Read | Read a parameter definition and control points, optionally returning a compact Guard Token instead of the verbose curve fingerprint. |
| `sample_automation` | Read | Sample native or linear curve values at requested positions. |
| `simplify_automation` | Destructive | Remove insignificant points in a curve range. |
| `set_automation_points` | Write | Add/update fingerprint/Guard-verified points, optionally clearing all or a range first and returning a compact acknowledgement. |
| `clear_automation` | Destructive | Clear a complete curve or a selected range. |
| `get_editor_view` | Read | Read editor time/value ranges and pixel scales. |
| `set_editor_view` | Control | Move or scale the main-editor or arrangement viewport and return the host's resulting navigation state. |
| `snap_position` | Read | Snap a position using current editor grid settings. |
| `convert_editor_coordinates` | Read | Convert time/value and x/y editor coordinates. |
| `script_data` | Read/Write | Manage namespaced Bridge JSON metadata on SynthV objects. |
| `get_track_mixer` | Read | Read gain, pan, mute, and solo. |
| `set_track_mixer` | Write | Change gain, pan, mute, and solo. |
| `apply_transaction` | Destructive | Apply up to 32 writes in one undo record. Independent steps are fully preflighted; later steps may consume earlier results with `$result` and are preflighted just in time. This is a single-Undo recovery boundary, not automatic rollback. |
| `rollback_transaction` | Destructive | Apply the stored guarded reverse steps for a transaction in one new undo record. |
| `create_harmony_track` | Write | Clone a guarded vocal track, transpose it, octave-fit an optional voice range, and set its mixer. |
| `humanize_notes` | Destructive | Apply deterministic fingerprint-guarded onset/duration variation, optionally preserving chord alignment. |
| `apply_expression_preset` | Destructive | Apply scoop, falloff, vibrato, crescendo, or breathiness through note attributes or automation. |
| `fit_lyrics` | Destructive | Assign syllables and optional phonemes to fingerprint-verified notes. |
| `playback` | Control | Read status, play, pause, stop, seek, or loop, then return the host's observed status and playhead. |

All track, group, and note indices are **1-based**, matching the SynthV Lua API. Note and automation coordinates are group-local blicks unless the returned field explicitly says `absolute`. Playback positions are seconds.

### Compact tuning responses

`get_note_phoneme_data`, `get_automation`, and `sample_automation` accept
`responseMode: "compact"`. Full mode remains the default.

- Prefer `get_phrase_context` before phrase tuning. It can locate the current
  piano-roll Group without a prior selection call, prefers selected notes when
  no explicit scope is supplied, and combines compact pitch/timing/phoneme
  notes, Group voice/Vocal Modes, and bounded automation summaries in one
  request. Nested note and automation fingerprints become short Guard Tokens.
- Phrase diagnostics identify timing overlaps, large pitch transitions,
  sustained notes, breath-sized gaps, and dense short notes without editing the
  project. `pitchAnalysisFrames` optionally summarizes the computed contour
  without returning raw frames.
- Phrase-note seconds are rounded to 0.1 ms. Empty/default phoneme overrides,
  zero detune, and false selection flags are omitted; non-default values remain,
  and the response reports `noteDefaultsOmitted` plus `secondsPrecision`.
- Absolute ranges default to `rangeMatch: "overlap"`, which preserves a long
  note crossing the range start. Use `rangeMatch: "onset"` only when onset-only
  coverage is acceptable; it binary-seeks into the sorted Group and reports
  `coverage: "onset_only"` plus `mayExcludeEarlierSustains: true`.
- Unscoped phrase pages return an opaque `page.cursorToken` when more notes
  remain. Pass it back as `cursorToken` instead of repeating the Group locator
  and numeric offset. The server rejects an expired token, and SynthV rejects it
  with `STALE_RANGE_CURSOR` if the boundary note changed.
- `get_phrase_context.ranges` accepts up to 32 absolute ranges. The executor
  sweeps the Group once, serializes each unique matched note once, and returns
  one shared `notes` array; each range references it through `noteIndices` and
  has its own diagnostics, automation summaries, and optional pitch summary.
- Phoneme reads can filter by exact `noteIndices` and/or an overlapping absolute
  `startSeconds`/`endSeconds` range. Compact notes include timing, lyrics,
  computed phonemes, user overrides, and a short `guardToken`; large raw and
  computed attribute objects are omitted unless explicitly requested.
- Exact-index and ordinary paginated reads only fetch the returned note page.
  Time ranges convert their two boundaries once and stop scanning after the
  first later note. Set `includeComputedPhonemes: false` when only refreshing
  Guard Tokens or user overrides, avoiding the whole-Group host computation.
- Pass a note `guardToken` to `set_note_phoneme_properties` instead of its
  verbose `fingerprint`.
- Compact automation reads return `guardToken`; pass it as
  `expectedGuardToken` to `set_automation_points`.
- These Guard Tokens also work inside `apply_transaction` steps and
  `sidebar_publish_preview` payloads; they are resolved before the plan reaches
  file IPC.
- Compact write responses contain counts and replacement Guard Tokens instead
  of complete notes or automation curves.

Guard Tokens are opaque and live only in the current MCP server process. MCP v3
automatically detects a changed SynthV/Bridge session token and clears every
cached context and Guard Token. A write then returns
`SYNTHV_SESSION_CHANGED`; read the target again and build the write from its
fresh context. A fresh read can proceed immediately and reports
`sessionReset`. Eviction or `UNKNOWN_GUARD_TOKEN` likewise requires a reread.
An MCP-requested hot reload waits for the new session token and clears these
caches before `sv_status` returns, closing the reload acknowledgement race.
The server resolves each token to the original complete fingerprint before the
request reaches SynthV, so existing stale-write protection is unchanged.

Phoneme writes are verified on a detached clone before an undo record is
created, then verified again on the project note. A host or older Voice that
quantizes or ignores a requested value fails with
`HOST_POSTCONDITION_FAILED`. Stable phoneme ranges are validated directly:
position/activity `0..1`, strength `-1..1`, and finite-second `leftOffset`
without a Bridge-imposed bound. No startup or first-use range probe is needed.

### Track colors

Track write tools accept the backward-compatible `#RRGGBB` form or a native
`AARRGGBB` value. The bridge converts `#RRGGBB` to opaque `ffRRGGBB` before
calling SynthV and verifies the value retained by the host. Track reads preserve
SynthV's raw `displayColor` and also return normalized `displayColorArgb` and
`displayColorRgb` fields when the host value is recognizable.

SynthV's editor offers a small preset palette, but the public scripting API only
defines the value as a hexadecimal string. The bridge therefore validates the
encoding without restricting callers to undocumented palette constants.

### Host capability differences

Some SynthV hosts expose `Note:getPitchAutoMode()` but fail to expose or execute
`Note:setPitchAutoMode()`. If a requested value already matches the note, the
bridge safely skips the setter. A real mode change on an incompatible host fails
with `UNSUPPORTED_HOST_CAPABILITY` before an undo record is created.

Time-axis replacement is performed as remove-then-add at occupied positions.
Every successful `set_time_axis` response has `verified: true`; a host that does
not retain the requested marks returns `HOST_POSTCONDITION_FAILED` instead of a
false success.

## Safe editing workflow

The Codex Agent rules require this sequence:

1. For phrase tuning, call `get_phrase_context` immediately before editing.
   For Group Voice or Vocal Modes, call `get_group_voice` with no locator to
   target the current piano-roll Group. V2 returns only the parameters, Vocal
   Modes, target indices, and `contextId` by default; request full fields only
   for diagnostics. For other work, read only the object that owns the intended
   change.
2. Present or internally construct a small, reviewable change.
3. Copy the latest applicable group/reference UUIDs and fingerprints, track fingerprint, automation/time-axis fingerprint, and note or Smart Pitch fingerprints.
4. Call the smallest write tool that completes the intended change. Group
   content writes reject a multiply referenced Note Group by default. Use
   `sharedGroupPolicy=allowAllReferences` only when changing every linked
   occurrence is intentional, and pair it with the fresh
   `expectedReferenceCount`. Prefer
   `apply_group_tuning` when one pass changes Voice/Vocal Modes,
   notes/phonemes, or multiple automation curves in the same Group. Use
   `apply_transaction` for a bounded multi-object batch; independent steps are
   preflighted before writing, while a step that uses an earlier `$result` is
   necessarily checked just before that dependent step executes.
5. If SynthV reports any `STALE_*` error, read again rather than guessing.

One compact read should feed one complete batch of related changes. Do not
refresh `contextId` by reading the whole selection or song when only Group
Voice changed.

A note fingerprint includes the group UUID, note index, onset, duration, pitch, detune, lyrics, phonemes, language, musical type, pitch mode, rap accent, retake count, and note attributes. This prevents an agent from applying an old plan to a note that the user has already changed.

## Example requests

```text
Read the notes currently selected in SynthV. Show the planned change, then extend
only the final note by half a quarter note. Use the fingerprints from the latest read.
```

```text
Read the current group's loudness automation. Add a gentle 3 dB crescendo across
the selected phrase without deleting points outside that phrase.
```

```text
Read track 1 and create a new harmony track a minor third below the selected notes.
Do not apply anything until you have listed the resulting pitches and warned about
notes outside MIDI 0–127.
```

```text
Read track 1, then clone it as "Harmony -3st" with transposeSemitones -3.
Use the latest track fingerprint. If it has non-main vocal Groups, stop unless
I explicitly approve detaching their content and reviewing their Vocals.
```

```text
Inspect D:\scores\melody.musicxml without editing SynthV. Show the selectable
part/voice/staff, overlap status, SHA-256 guard, and note preview. Import one
chosen monophonic lane only after I confirm that I have the right to use it.
```

More examples are in [examples/prompts.md](examples/prompts.md).

## Configuration

The Node server and SynthV script must resolve the **same physical IPC directory**.

| Variable | Default | Meaning |
|---|---:|---|
| `SYNTHV_AGENT_BRIDGE_DIR` | OS temporary directory | Shared IPC directory. |
| `SYNTHV_AGENT_BRIDGE_TIMEOUT_MS` | `15000` | Maximum response wait. |
| `SYNTHV_AGENT_BRIDGE_POLL_MS` | `10` | Node response polling interval. |
| `SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS` | `30000` | Age at which abandoned request files and locks can be recovered. Must be greater than the response timeout. |
| `SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS` | `5000` | Maximum heartbeat age considered connected. |

When a custom IPC directory is used, create it before starting the SynthV script. The Node process also creates the directory, but the documented startup order starts SynthV first.

### Windows and WSL

The simplest setup is to run the MCP server with **Windows Node.js** when SynthV runs on Windows. When Codex runs inside WSL, point Node at the existing Windows temporary directory that SynthV uses by default:

- SynthV/Windows: leave `SYNTHV_AGENT_BRIDGE_DIR` unset so the script uses `%TEMP%`.
- Node/WSL: set `SYNTHV_AGENT_BRIDGE_DIR=/mnt/c/Users/you/AppData/Local/Temp`.

For a dedicated subdirectory, create it first and set equivalent Windows and WSL path spellings for the two processes. The SynthV GUI must inherit its Windows environment variable, so restart SynthV after changing it. The MCP server can receive its own value through the `env` table in Codex configuration.

## Development

```bash
npm run typecheck
npm test
npm run check
npm run inspector
```

Lua syntax can be checked with:

```bash
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
```

CI runs TypeScript tests on Node 20 and 22, parses all three production Lua
files with Lua 5.4, and exercises both the persistent Bridge and side panel
through mock SynthV integration harnesses.

For a local installation and connection report, run:

```bash
npm run doctor -- --target "/path/to/Synthesizer V Studio 2/scripts"
```

The doctor checks source/installed versions and exact script contents, compiled
MCP freshness, the running MCP capability fingerprint, Bridge and MCP
heartbeats, the resolved IPC directory, residual processing/control files, and
Codex configuration. Add `--json` for machine-readable output. It never
modifies the project or installed files.

## Current limitations

- One request may be in flight at a time.
- A client-side timeout is ambiguous: SynthV may still finish the operation. The processing marker remains until the Lua host completes, and the agent should read the current project before deciding whether to retry a write.
- The side panel holds one pending preview at a time. That preview may contain
  either one write or one `apply_transaction` batch.
- Generic transactions reject conflicting writes to the same guarded scope.
  A later step may use an earlier result through a complete-field `$result`
  reference. Independent steps are fully preflighted before writing; dependent
  steps are resolved and checked just in time because their targets do not yet
  exist during the first pass. Index-shifting track/library-group deletes must
  be the only step.
- `atomicity: "singleUndoRecord"` means one SynthV recovery boundary, not
  automatic rollback.
  An independent preflight failure makes no project changes. A dependent
  validation or unexpected host failure can occur after earlier steps have
  written; when the error reports `undoRequired`, immediately use
  **Edit > Undo** once before rereading or retrying.
- Rollback plans are held in Bridge memory for the current project/session and
  are lost when the Bridge reloads or SynthV closes. A rollback is a new
  guarded write and is refused if its fingerprints are stale.
- The panel cannot initiate a Codex turn by itself. **Copy & queue** writes a
  local request and puts a handoff prompt on the clipboard for the user to paste.
- SynthV's public scripting API does not expose an Undo command. The panel shows
  the latest write and directs the user to click the main editor before using
  **Ctrl+Z**, with **Edit > Undo** as the focus-independent fallback.
- SynthV's public scripting API does not expose project save, audio rendering,
  selecting an installed singer database by display name, reading Vocal
  identity, or Voice Panel scale/mode settings. `clone_track_shell` can
  host-clone a source track's main Vocal context without naming it.
- Local score support is intentionally import-only and bounded. It accepts
  absolute local `.xml`, `.musicxml`, `.mxl`, `.mid`, or `.midi` paths after
  explicit inspection and rights confirmation. It rejects URLs, `.svp`,
  XML `DOCTYPE`/`ENTITY`, ambiguous/polyphonic lanes, changed file hashes, and
  imports above 512 notes. Source tempo is returned for review but is not
  silently applied to the project.
- `singers` and `spacing` are returned by SynthV 2.2.1 but are not documented in the public `getVoice` field list. The typed Unison surface is therefore experimental and refuses writes unless the host returns and retains the requested fields on a cloned reference.
- The Retake API does not enumerate Take IDs or expose the active Take ID. The bridge therefore activates and deletes only the default Take or IDs it generated and stored itself.
- Expression presets are intentionally small building blocks, not phrase
  analysis or pronunciation-quality scoring.
- The bridge has not yet been validated against every SynthV 2.x patch and every voice database.
- ChatGPT does not connect directly to this local stdio server. Use Codex or another local MCP host; a future remote adapter would need explicit authentication and transport security.

See [docs/roadmap.md](docs/roadmap.md).

## Security and privacy

This is a local control bridge. It does not upload project data. However, any connected MCP host can receive project metadata and can request edits, so connect only trusted clients and review destructive tool calls. See [SECURITY.md](SECURITY.md).

## Acknowledgements

The architecture was inspired by Haruki Okada's proof-of-concept [`ocadaruma/mcp-svstudio`](https://github.com/ocadaruma/mcp-svstudio), which demonstrated that a local MCP server and a persistent SynthV Lua script can communicate through files. This repository reimplements the bridge around request correlation, validation, stale-context protection, undo records, cross-platform paths, tests, and a broader tool surface.

Synthesizer V and Synthesizer V Studio are products and trademarks of Dreamtonics. This independent project is not affiliated with or endorsed by Dreamtonics.

## License

Apache License 2.0. See [LICENSE](LICENSE).
