# SynthV Agent Bridge

[English](README.md) | [简体中文](README_CN.md)

A local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server
that lets AI clients such as Codex and Claude Code read and edit the project
open in **Synthesizer V Studio 2 Pro**.

- Works through SynthV's public Lua scripting API. It never parses or rewrites
  `.svp` files.
- Stays local. It opens no network port and calls no AI API.
- Fails closed. Every write checks fresh host state, creates one SynthV Undo
  record and verifies the result.

**Video demo:** [SynthV Agent Bridge on Bilibili](https://www.bilibili.com/video/BV1kU3P6LEoF)

## Status

**v0.3.2 · protocol v3.** Tested on Synthesizer V Studio 2 Pro 2.2.1 and
2.3.0. All 17 read actions and 9 UI actions are verified on a real host, as
are 31 of 39 write actions. Of the other 8:

- 7 are disabled; see [Limitations](#limitations).
- `copy_group_voice` works but is still awaiting its own real-host acceptance.

Test writes on a saved working copy of your project.

## What it can do

| Area | Capabilities |
|---|---|
| Project inspection | Tracks, Note Groups, notes, selection, tempo and time signatures, computed phonemes and pitch, Automation, mixer and editor state. |
| Notes and lyrics | Add, edit, delete, transpose and humanize notes; fit lyrics; set language, sing/rap type, detune and note attributes. |
| Voice and phonemes | Group Voice and Vocal Mode parameters, copying stored Voice settings between Groups, phoneme sequences, phoneset (X-SAMPA) overrides, syllable timing and per-phoneme strength. |
| Pitch and expression | Smart Pitch controls, AI Retakes, and scoop, falloff, vibrato, crescendo and breathiness presets. |
| Automation | Read, add, sample, simplify and clear parameter curves, including Vocal Mode curves; set curve interpolation on SynthV 2.3.0+. |
| Tracks and Groups | Create, update and delete Tracks, library Note Groups and linked Group references; set a Note Group's scale on SynthV 2.3.0+. |
| Score import | Inspect a local MusicXML or MIDI file and import one monophonic lane you have the rights to use. |
| Editor and playback | Selection, viewport, grid snapping, coordinate and time conversion, clipboard, dialogs and playback. |

## How it works

```text
MCP host (Codex, Claude Code, …)
        │  MCP over stdio
        ▼
TypeScript MCP server ── node dist/src/cli.js
        │  JSON request/response files in a shared local directory
        ▼
SynthVAgentBridge.lua ── a persistent script inside SynthV
        │  SynthV scripting API
        ▼
The project open in Synthesizer V Studio 2 Pro
```

The Agent decides what to change. The MCP server validates and routes the
request. The Lua script reads live state, checks guards, writes inside one Undo
record and verifies what SynthV kept. You listen and approve. See
[responsibility boundaries](docs/responsibility-boundaries.md) and
[architecture](docs/architecture.md).

## Requirements

- Synthesizer V Studio **2 Pro 2.1.2 or later** (the Basic edition has no
  scripting).
- Node.js **20.10 or later**.
- An MCP host that can launch a local stdio server.

## Quick start

The [Quickstart](docs/quickstart.md) ([中文](docs/quickstart_cn.md)) covers
each step in detail.

1. **Build the server.**

   ```bash
   git clone https://github.com/SynthVCopilot/synthv-agent-bridge.git
   cd synthv-agent-bridge
   npm install
   npm run build
   ```

2. **Install the SynthV scripts.** In SynthV, choose **Scripts → Open Scripts
   Folder** and pass that folder to the installer:

   ```bash
   npm run install:synthv -- --target "/path/to/Synthesizer V Studio 2/scripts"
   ```

   This creates a `SynthV Agent Bridge` subfolder. Add `--without-sidebar` to
   skip the optional status panel.

3. **Start the Bridge.** In SynthV, choose **Scripts → SynthV Agent Bridge →
   Start SynthV Agent Bridge**. It keeps running in the background.

4. **Connect your MCP host.** This repository ships project profiles for
   [Codex](docs/hosts/codex.md) (`.codex/config.toml`) and
   [Claude Code](docs/hosts/claude-code.md) (`.mcp.json`). Any other stdio
   host can run `node dist/src/cli.js`.

5. **Check the connection.** Ask the Agent to call `sv_status`. A healthy
   Bridge reports `"connected": true` and `"fresh": true`. For a local report,
   run:

   ```bash
   npm run doctor -- --target "/path/to/Synthesizer V Studio 2/scripts"
   ```

The guided *Twinkle Star* demo and the Agent's working rules are a separate
[`synthv-copilot` skill plugin](https://github.com/SynthVCopilot/SKILLS).

### Updating

To check for a new release:

```bash
npm run doctor -- --check-updates
```

Doctor works offline unless you pass this flag.

To update:

```bash
npm run update
```

This fast-forwards your checkout, reinstalls dependencies, rebuilds, and
reinstalls the SynthV scripts where you last installed them. It stops without
changing anything if you have uncommitted edits. Afterwards:

1. If it says the Bridge runtime changed, choose **Scripts → Rescan** in SynthV
   and start the Bridge again. Rescan stops a running Bridge.
2. Reconnect your MCP host so it loads the new build.

To hear about new releases on GitHub, choose **Watch → Custom → Releases** on
the repository page.

## Singers and Vocal Modes

SynthV's scripting API cannot tell which singer a Group uses, and it does not
list Vocal Modes (singing styles) whose values you have never changed. Before
the Agent edits Vocal Modes:

1. Select the Note Group and choose its singer in SynthV.
2. Give the Agent the full list of Vocal Mode names exactly as the panel shows
   them, or attach a screenshot of the complete panel.

```text
Current singer Vocal Modes: Airy, Bright, Cool, Dark, Emotional, Power, Solid, Sweet.
```

Repeat this after changing the singer. Edits that do not touch Vocal Modes do
not need it.

## Using the tools

The server exposes six MCP tools. The 65 detailed SynthV actions stay behind
them, and `sv_describe` returns one action's schema only when the Agent needs
it.

| Tool | Purpose |
|---|---|
| `sv_status` | Connection, session, host version and build checks. |
| `sv_describe` | List actions or return one action's schema. |
| `sv_query` | Read project state. A `writeIntent` read returns a `contextId` for a write. |
| `sv_command` | Edit, delete or import with guards, one Undo record and verification. |
| `sv_ui` | Selection, viewport, clipboard, dialogs, snapping, coordinates and playback. |
| `sv_review` | Optional side-panel status. |

A write always follows the same pattern:

1. Read the target with `sv_query` and `contextMode: "writeIntent"`.
2. Send one `sv_command` with the returned `contextId`.
3. If the result reports `STALE_*` or `SYNTHV_SESSION_CHANGED`, read again.
   Never guess.

Indices are 1-based, note positions are Group-local blicks, and playback times
are seconds. The [action reference](docs/actions.md) lists every action and
explains Contexts, Guard Tokens, paging and compact responses.

## Example requests

```text
Read the selected notes. Show the planned change, then lengthen only the final
note by half a quarter note.
```

```text
Read the current Group's loudness and add a gentle 3 dB crescendo across the
selected phrase without touching points outside it.
```

```text
Set the current Note Group's scale to D Dorian.
```

```text
Inspect D:\scores\melody.musicxml without editing SynthV. Show the parts,
overlaps and a note preview. Import one lane only after I confirm I have the
rights to use it.
```

More examples are in [examples/prompts.md](examples/prompts.md).

## Configuration

The MCP server and the SynthV script must use the **same IPC directory**.

| Variable | Default | Meaning |
|---|---:|---|
| `SYNTHV_AGENT_BRIDGE_DIR` | OS temp directory | Shared IPC directory. Create it before starting the SynthV script. |
| `SYNTHV_AGENT_BRIDGE_TIMEOUT_MS` | `30000` | Maximum wait for a response. |
| `SYNTHV_AGENT_BRIDGE_POLL_MS` | `10` | Response polling interval. |
| `SYNTHV_AGENT_BRIDGE_LOCK_WAIT_MS` | `1000` | Wait for the single-writer lock before `BRIDGE_BUSY`. |
| `SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS` | `60000` | Age after which abandoned requests and locks are recovered. Must exceed the timeout. |
| `SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS` | `5000` | Maximum heartbeat age treated as connected. |

**Windows with WSL:** the simplest setup runs the MCP server with Windows
Node.js. If the server runs inside WSL, leave the variable unset for SynthV
(it uses `%TEMP%`) and set
`SYNTHV_AGENT_BRIDGE_DIR=/mnt/c/Users/<you>/AppData/Local/Temp` for the server.

## Limitations

- **Disabled for stability.** These 7 actions are rejected before they reach
  SynthV because they crashed SynthV 2.2.1:
  - isolated Group clone and Note Group clone;
  - Track and Track-shell clone, and harmony Tracks;
  - transaction apply and rollback.

  Linked Group-reference clone works.
- **Not in SynthV's scripting API:** saving the project, rendering audio,
  reading or choosing the singer, and listing untouched Vocal Modes.
- **SynthV 2.3.0:**
  - Notes can no longer go into a Track's main Group; the Bridge puts new notes
    in a separate Group by default.
  - Track FX parameters are read-only.
  - See the [2.3.0 runtime notes](docs/sv2-api-coverage-v3.md#synthv-230-runtime-delta).
- **One request at a time.** A second client waits briefly, then gets
  `BRIDGE_BUSY`.
- **Timeouts are ambiguous.** SynthV may still finish a timed-out write, so the
  Agent reads again before retrying.
- **Partial recovery.** A failed write that reports `undoRequired: true` needs
  one **Edit → Undo** in SynthV before anything else.
- **Score import limits.** Imports are limited to 512 notes from one monophonic
  lane of a local file. Source tempo is reported, never applied.

Full coverage of the SynthV API is in the
[API coverage matrix](docs/sv2-api-coverage-v3.md). Planned work is in the
[roadmap](docs/roadmap.md).

## Development

```bash
npm run check          # type-check, build and run all tests
npm run doctor         # check local Runtime, Bridge and MCP state
npm run inspector      # open the MCP Inspector
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
```

CI runs the TypeScript tests on Node 20 and 22, parses the Lua scripts with
Lua 5.4, and runs the Bridge and side panel against a mock SynthV host. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Documentation

| Topic | Document |
|---|---|
| Setup | [Quickstart](docs/quickstart.md) · [快速开始](docs/quickstart_cn.md) · [Codex](docs/hosts/codex.md) · [Claude Code](docs/hosts/claude-code.md) |
| Using the tools | [Action reference](docs/actions.md) · [Errors](docs/errors-v3.md) · [Example prompts](examples/prompts.md) |
| Design | [Architecture](docs/architecture.md) · [v3 architecture](docs/architecture-v3.md) · [Protocol](docs/protocol.md) · [Responsibility boundaries](docs/responsibility-boundaries.md) · [ADRs](docs/adr/README.md) |
| Side panel | [Native connection panel](docs/sidebar.md) |
| Coverage and status | [SynthV API coverage](docs/sv2-api-coverage-v3.md) · [Roadmap](docs/roadmap.md) · [Changelog](CHANGELOG.md) |

## Security and privacy

The Bridge uploads nothing. Any MCP host you connect can read your project and
request edits, so connect only clients you trust and review destructive
changes. See [SECURITY.md](SECURITY.md).

## Acknowledgements

The design was inspired by Haruki Okada's proof of concept
[`ocadaruma/mcp-svstudio`](https://github.com/ocadaruma/mcp-svstudio), which
showed that an MCP server and a persistent SynthV Lua script can talk through
files.

Synthesizer V and Synthesizer V Studio are products and trademarks of
Dreamtonics. This independent project is not affiliated with or endorsed by
Dreamtonics.

## License

Apache License 2.0. See [LICENSE](LICENSE).
