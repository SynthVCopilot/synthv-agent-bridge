# SynthV Agent Bridge

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets compatible AI clients inspect and control the project currently open in **Synthesizer V Studio 2 Pro**.

The bridge uses Synthesizer V's public Lua scripting API. It does **not** parse or rewrite `.svp` files, open a network port, or call an AI API by itself.

> Status: **v0.1.4 pre-release**. The protocol, safety guards, broad official scripting-API coverage, editor lifecycle operations, and first native side-panel workflow are implemented. Test on copies of important projects.

## What it can do

- Read project metadata, the complete tempo/time-signature map, playback state, tracks, library groups, notes, complete selection state, computed phonemes/pitch, Smart Pitch objects, automation curves, editor viewports, and mixer state.
- Create, clone, reuse, update, or delete library note groups and vocal/instrumental Group references.
- Clone an existing track to inherit its singer/database, optionally clearing or transposing cloned notes.
- Add notes and edit per-note language, sing/rap type, pitch-auto mode, rap accent, timing, pitch, lyrics, phonemes, detune, and attributes.
- Read and safely update typed group voice defaults, Vocal Mode pitch/timbre/pronunciation axes, and host-returned experimental Unison fields.
- Read computed and user phonemes together, and safely edit phoneset overrides, syllable timing, and per-phoneme timing/strength attributes.
- Add, edit, and delete point or curve Smart Pitch controls with stale-write protection.
- Generate, activate, and delete Bridge-tracked AI Retakes.
- Safely edit or delete notes using fresh note fingerprints.
- Convert between seconds, quarter notes, and blicks, and edit tempo/time-signature marks.
- Add, replace, sample, simplify, or clear automation curves such as pitch deviation, loudness, tension, breathiness, voicing, gender, and Vocal Mode.
- Read and change selection and viewport state, use grid snapping and coordinate conversion, and exchange text through SynthV's host clipboard.
- Control gain, pan, mute, solo, play, pause, stop, seek, and loop.
- Put each successful write call into one SynthV undo record.
- Use a native SynthV side panel to inspect connection/current-selection context,
  queue an instruction, review one guarded write, apply or dismiss it, and see
  the latest Bridge operation.

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

## Requirements

- Synthesizer V Studio **2 Pro 2.1.2 or later**.
- Node.js **20.10 or later**.
- An MCP host that supports local stdio servers, such as Codex CLI or another compatible local client.

This project targets the scripting environment in Synthesizer V Studio 2 Pro; it does not target the Basic edition.

## Installation

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
- `SynthVAgentSidebar.lua`

Alternatively, set `SYNTHV_SCRIPTS_DIR` to the scripts directory before running `npm run install:synthv`. The installer creates a `SynthV Agent Bridge` subfolder. After copying the files, choose **Scripts → Rescan**. SynthV then loads **SynthV Agent** as a custom side-panel section.

If a hot-reload-capable Bridge session is already running, the installer asks
it to load the copied Lua file and waits for a new session heartbeat. This uses
the Bridge's file IPC and Lua `loadfile()`—not UI automation or hooks. Use
`--no-reload` to copy without requesting a reload. The first installation of a
hot-reload-capable version must still be started manually once.

### 3. Start the in-editor bridge

In Synthesizer V Studio, run:

```text
Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge
```

The script remains active and writes a heartbeat while SynthV is running. To stop it, run **Stop SynthV Agent Bridge**, or use SynthV's **Abort All Running Scripts** command.

### 4. Connect an MCP host

#### Codex CLI

Use an absolute path to the built entry point:

```bash
codex mcp add synthv-agent-bridge -- node "/absolute/path/to/synthv-agent-bridge/dist/src/cli.js"
```

Then verify the registration:

```bash
codex mcp list
```

A complete TOML example is available at [examples/codex-config.toml](examples/codex-config.toml). Other local MCP hosts can use the same `node .../dist/src/cli.js` command when they support **STDIO** servers.

### Native side-panel workflow

The v0.1.4 panel deliberately keeps the Bridge network-free and does not call
an AI API itself:

1. Select notes or a Group in SynthV and enter an instruction in
   **SynthV Agent**.
2. Click **Copy & queue**. The panel stores the request in the local IPC
   directory and copies a handoff prompt to the host clipboard.
3. Paste the prompt into the connected Codex task.
4. Codex reads fresh SynthV state and publishes one fingerprint-guarded write
   back to the panel.
5. Review the preview in SynthV, then click **Apply** or **Dismiss**.

Apply commands are consumed by the Node coordinator and sent through the same
serialized `FileIpcClient` used by MCP tools. The side panel never edits project
objects directly. SynthV's public scripting API can create undo records but
cannot invoke Undo. After a successful Bridge write, click the main editor and
use **Ctrl+Z**, or choose **Edit > Undo** when focus is still in the side panel.
See [docs/sidebar.md](docs/sidebar.md).

### 5. Verify the connection

Open an MCP-enabled conversation and ask it to call `bridge_status`, followed by `get_project_info`. A healthy status contains:

```json
{
  "connected": true,
  "fresh": true
}
```

## Available MCP tools

| Tool | Access | Purpose |
|---|---:|---|
| `bridge_status` | Read | Read the heartbeat without requiring a round trip. |
| `sidebar_get_request` | Read | Read the latest instruction and selection summary queued by the native side panel. |
| `sidebar_publish_preview` | Control | Publish one complete guarded write for Apply/Dismiss confirmation in SynthV. |
| `ping` | Read | Test the complete Node → Lua → Node path. |
| `reload_bridge` | Control | Reload the installed Lua Bridge in the current script session. |
| `get_host_info` | Read | SynthV host version, OS, language, project, and IPC information. |
| `host_clipboard` | Control | Read or write text through SynthV's host clipboard API. |
| `show_dialog` | Control | Show message, input, confirmation, or custom-form dialogs. |
| `convert_pitch` | Read | Convert MIDI pitch and frequency and identify black keys. |
| `get_project_info` | Read | Project, timing, playback, host, and current editor location. |
| `get_time_axis` | Read | All tempo/time-signature marks and a safe-write fingerprint. |
| `convert_time` | Read | Convert seconds, quarter notes, or blicks through the current tempo map, with optional Blick-grid rounding. |
| `set_time_axis` | Destructive | Add, replace, or remove tempo/time-signature marks. |
| `list_tracks` | Read | Track summaries, group counts, note counts, and mixer state. |
| `list_note_groups` | Read | Reusable library groups, UUIDs, fingerprints, and reference counts. |
| `create_note_group` | Write | Create an optionally populated reusable library group. |
| `clone_note_group` | Write | Deep-clone a track or library group into the library. |
| `delete_note_group` | Destructive | Delete a library group and all references to it. |
| `add_group_reference` | Write | Place a library group on a track. |
| `clone_group_reference` | Write | Make a linked or deep-copied reference on another track. |
| `get_track_notes` | Read | Groups, UUIDs, notes, attributes, offsets, and safe-write fingerprints. |
| `get_group_voice` | Read | Typed group voice defaults, Vocal Modes, experimental Unison fields, and target selection context. |
| `get_note_phoneme_data` | Read | User/computed phonemes, phoneset overrides, per-phoneme attributes, and note selection state. |
| `get_selection` | Read | Selected groups, notes, Smart Pitch controls, and requested automation points. |
| `set_selection` | Control | Replace, add, remove, or clear editor selections. |
| `get_computed_group_data` | Read | Computed phonemes/rap attributes and optional pitch samples. |
| `add_track` | Write | Create a track and return its main Group locator. |
| `update_track` | Write | Rename, recolor, or change Render Panel inclusion. |
| `clone_track` | Write | Deep-clone a track, preserving its singer/database, with optional clear/transpose. |
| `delete_track` | Destructive | Delete a fingerprint-verified non-final track. |
| `update_group` | Write | Change vocal/instrumental reference state and supported vocal properties. |
| `set_group_voice` | Write | Fingerprint-verified typed voice, Vocal Mode, and host-validated experimental Unison updates, with an optional current-Group guard. |
| `delete_group_reference` | Destructive | Remove a non-main vocal or instrumental reference. |
| `add_notes` | Write | Add notes to a specific group. |
| `edit_notes` | Write | Edit fingerprint-verified notes. |
| `set_note_phoneme_properties` | Write | Edit fingerprint-verified phoneme, phoneset, syllable, timing, and strength properties, with optional current-Group/selected-note guards. |
| `delete_notes` | Destructive | Delete fingerprint-verified notes. |
| `get_note_retakes` | Read | Read take count and Bridge-tracked Take IDs. |
| `generate_note_retake` | Write | Generate duration, pitch, or timbre variations. |
| `activate_note_retake` | Write | Activate the default or a Bridge-tracked Take. |
| `delete_note_retake` | Destructive | Delete a Bridge-tracked non-default Take. |
| `get_pitch_controls` | Read | Read point and curve Smart Pitch objects and fingerprints. |
| `add_pitch_controls` | Write | Add point or curve Smart Pitch objects. |
| `edit_pitch_controls` | Write | Edit fingerprint-verified Smart Pitch objects. |
| `delete_pitch_controls` | Destructive | Delete fingerprint-verified Smart Pitch objects. |
| `get_automation` | Read | Read a parameter definition and every control point. |
| `sample_automation` | Read | Sample native or linear curve values at requested positions. |
| `simplify_automation` | Destructive | Remove insignificant points in a curve range. |
| `set_automation_points` | Write | Add/update points, optionally clearing all or a range first. |
| `clear_automation` | Destructive | Clear a complete curve or a selected range. |
| `get_editor_view` | Read | Read editor time/value ranges and pixel scales. |
| `set_editor_view` | Control | Move or scale the main-editor or arrangement viewport. |
| `snap_position` | Read | Snap a position using current editor grid settings. |
| `convert_editor_coordinates` | Read | Convert time/value and x/y editor coordinates. |
| `script_data` | Read/Write | Manage namespaced Bridge JSON metadata on SynthV objects. |
| `get_track_mixer` | Read | Read gain, pan, mute, and solo. |
| `set_track_mixer` | Write | Change gain, pan, mute, and solo. |
| `playback` | Control | Read status, play, pause, stop, seek, or loop. |

All track, group, and note indices are **1-based**, matching the SynthV Lua API. Note and automation coordinates are group-local blicks unless the returned field explicitly says `absolute`. Playback positions are seconds.

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

The server instructions tell an agent to follow this sequence:

1. Read the project, time axis, track, group, automation, or current selection immediately before editing.
2. Present or internally construct a small, reviewable change.
3. Copy the latest applicable group/reference UUIDs and fingerprints, track fingerprint, automation/time-axis fingerprint, and note or Smart Pitch fingerprints.
4. Call the smallest write tool that completes the intended change in one undo record.
5. If SynthV reports any `STALE_*` error, read again rather than guessing.

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
Use the latest track fingerprint so the cloned track inherits the same singer.
```

More examples are in [examples/prompts.md](examples/prompts.md).

## Configuration

The Node server and SynthV script must resolve the **same physical IPC directory**.

| Variable | Default | Meaning |
|---|---:|---|
| `SYNTHV_AGENT_BRIDGE_DIR` | OS temporary directory | Shared IPC directory. |
| `SYNTHV_AGENT_BRIDGE_TIMEOUT_MS` | `15000` | Maximum response wait. |
| `SYNTHV_AGENT_BRIDGE_POLL_MS` | `50` | Node response polling interval. |
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

## Current limitations

- One request may be in flight at a time.
- A client-side timeout is ambiguous: SynthV may still finish the operation. The processing marker remains until the Lua host completes, and the agent should read the current project before deciding whether to retry a write.
- Multi-call preview/commit transactions are planned but not implemented in v0.1.
- The v0.1.4 side panel confirms one Bridge write at a time; multi-tool
  preview/commit transactions remain planned for v0.2.
- The panel cannot initiate a Codex turn by itself. **Copy & queue** writes a
  local request and puts a handoff prompt on the clipboard for the user to paste.
- SynthV's public scripting API does not expose an Undo command. The panel shows
  the latest write and directs the user to click the main editor before using
  **Ctrl+Z**, with **Edit > Undo** as the focus-independent fallback.
- SynthV's public scripting API does not expose project save, audio rendering, selecting an installed singer database by display name, or Voice Panel scale/mode settings. These remain out of scope; `clone_track` can inherit an already-selected singer.
- `singers` and `spacing` are returned by SynthV 2.2.1 but are not documented in the public `getVoice` field list. The typed Unison surface is therefore experimental and refuses writes unless the host returns and retains the requested fields on a cloned reference.
- The Retake API does not enumerate Take IDs or expose the active Take ID. The bridge therefore activates and deletes only the default Take or IDs it generated and stored itself.
- Semantic expression presets are not implemented yet; the primitive Smart Pitch and automation tools are available.
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

---

## 中文快速说明

这是一个本地 MCP 控制桥：Codex 或其他支持本地 stdio 的 MCP 客户端通过 Node.js 服务发出结构化命令，SynthV 内部常驻的 Lua 脚本再调用官方脚本 API 修改当前工程。

最小安装流程：

```bash
npm install
npm run build
npm run install:synthv -- --target "/SynthV/脚本目录"
codex mcp add synthv-agent-bridge -- node "/绝对路径/dist/src/cli.js"
```

然后在 SynthV 中执行 **脚本 → 重新扫描 → SynthV Agent Bridge → Start SynthV Agent Bridge**。首次使用建议先复制工程，并让 AI 每次修改前先读取当前选区、展示修改计划，再执行写操作。
