# Quickstart

[中文](quickstart_cn.md)

This guide takes a new user from cloning the repository to the first guarded
Synthesizer V edit. For protocol details and the complete action catalog, see
the main [README](../README.md).

## 1. Clone the project and open it in Codex

```bash
git clone https://github.com/zhoupengjie/synthv-agent-bridge.git
cd synthv-agent-bridge
```

Open the cloned `synthv-agent-bridge` folder in the Codex app, Codex CLI, or a
Codex-enabled editor.

You can ask Codex to perform the remaining setup:

```text
Set up this SynthV Agent Bridge project. Check whether Node.js 20.10 or later is
available. If it is missing or too old, install a suitable Node.js LTS release
with the system package manager, asking for permission when required. Then
install the locked dependencies, build the project, install the SynthV scripts
into the scripts directory I provide, verify the repository's project-scoped
MCP configuration, and run the project doctor.
```

Codex can run the environment checks and package-manager commands, but an
operating-system installation may need network access, administrator approval,
or a terminal/Codex restart before the new `node` command is visible.

## 2. Check Node.js and build

The project requires Synthesizer V Studio 2 Pro 2.1.2 or later and Node.js
20.10 or later. Synthesizer V Studio Basic is not supported.

```bash
node --version
npm --version
npm ci
npm run build
```

If Node.js is missing, ask Codex to install an LTS release. Typical manual
fallbacks are:

```powershell
# Windows
winget install --id OpenJS.NodeJS.LTS -e
```

```bash
# macOS with Homebrew
brew install node
```

After a new Node.js installation, restart the terminal or Codex if
`node --version` still uses the old environment.

## 3. Install the SynthV scripts

In Synthesizer V Studio, choose **Scripts → Open Scripts Folder**. Copy the
directory path, then run:

```bash
npm run install:synthv -- --target "/path/to/Synthesizer V Studio 2/scripts"
```

The installer creates a `SynthV Agent Bridge` subfolder containing the Bridge,
stop command, and optional native side panel.

On Windows, the scripts directory commonly resembles:

```text
C:\Users\<you>\AppData\Roaming\Dreamtonics\Synthesizer V Studio 2\scripts
```

Use the path opened by SynthV rather than assuming the example is correct for
your machine.

## 4. Load the project-scoped MCP configuration

The repository already contains `.codex/config.toml`:

```toml
[mcp_servers.synthv-agent-bridge]
command = "node"
args = ["dist/src/cli.js"]
startup_timeout_sec = 120
```

No user-level MCP registration or absolute installation path is required. Trust
and open the repository root in Codex, complete the build, then restart Codex
or start a new task so it loads the project configuration. Codex ignores
project-scoped configuration for untrusted projects.

## 5. Rescan and start the Bridge

In Synthesizer V Studio, run:

```text
Scripts → Rescan
Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge
```

Rescan stops persistent scripts, so always start the Bridge again after a
rescan. The Bridge remains active until SynthV closes, the stop script is run,
or all running scripts are aborted.

## 6. Verify the connection

In a Codex task with the MCP server enabled, ask:

```text
Check the SynthV Bridge status, then read the current project information.
```

A healthy `sv_status` result includes:

```json
{
  "connected": true,
  "fresh": true
}
```

You can also run the read-only local doctor:

```bash
npm run doctor -- --target "/path/to/Synthesizer V Studio 2/scripts"
```

If the Bridge is healthy but the MCP heartbeat is missing, restart or reconnect
the Codex task.

## Optional: run the guided Demo

After the first healthy connection, Codex offers the bundled example. Start it
with:

```text
Run the Twinkle Star demo.
```

Codex prints five short stage headings, creates one isolated 42-note non-main
Group after existing project content, and never modifies existing notes. After
score creation, select that Demo Group and select or assign its Vocal, then
attach the complete Vocal Mode panel or type every singing style exactly as
shown. This one handoff is required by the official API limitation; tuning,
pitch curves, verification, and loop playback then finish automatically.

See [Twinkle Star guided demo](twinkle-star-demo.md) for the exact workflow,
safety rules, undo boundaries, and machine-readable template.

## 7. Make the first tuning edit

> [!IMPORTANT]
> SynthV's official scripting API cannot read the current Vocal identity or
> enumerate untouched default-only singing style (Vocal Mode) names and
> parameters. When a request uses or changes Vocal Modes, select the intended
> Note Group and Vocal, then attach the complete panel screenshot or type every
> style exactly as shown. Explicit mechanical edits that do not depend on
> singing styles do not require this handoff. Provide the information again
> after changing Vocals.

The Agent does not show a fixed onboarding checklist. It asks only for missing
information needed for the current request: the intended target and effect,
anything that must remain unchanged, and Vocal Mode information when applicable.
It briefly suggests saving a working copy and shows a small preview before
writing. Fresh reads, guards, preflight, and verification remain internal.
Undo guidance appears only if an actual result reports `undoRequired: true`.

A useful first read-only request is:

```text
Read the currently selected notes. Summarize their lyrics, pitches, timing, and
computed phonemes. Do not modify the project.
```

Then request one bounded edit:

```text
Read the selected phrase again. Check its timing and pitch transitions, show a
small reviewable plan, and do not change lyrics or points outside the selected
range. Apply the edit only with the fresh context returned by that read.
```

The normal Agent sequence is:

1. Describe an unfamiliar SynthV action when needed.
2. Read only the intended target.
3. Build a small plan from the fresh state.
4. Reuse the returned `contextId` for the guarded write.
5. Read the target again after any `STALE_*` or `UNKNOWN_CONTEXT` result.

Do not manually change the same target while a Bridge write is running. Each
successful write normally creates one SynthV undo record. To undo, focus the
main editor and press **Ctrl+Z**, or choose **Edit → Undo**.

## 8. Optional side-panel review flow

The **SynthV Agent** side panel provides explicit confirmation:

1. Select notes or a Group in SynthV.
2. Enter an instruction in the side panel.
3. Click **Copy & queue**.
4. Paste the copied handoff prompt into Codex.
5. Let Codex read fresh state and publish a guarded preview.
6. Review the changes and risks in SynthV.
7. Click **Apply** or **Dismiss**.
8. Listen to the result and undo or continue with the next phrase.

The side panel does not contact Codex by itself; the copied handoff prompt must
be pasted into a Codex task.

## 9. Vocal Mode edits

SynthV's scripting API does not expose the current singer identity or enumerate
Vocal Modes that still have only their untouched default values. An empty
Vocal Mode result therefore does not mean that the singer has no Vocal Modes;
it means the Bridge cannot discover those default-only names and parameters
through the official API.

Before the first Vocal Mode edit, select the intended Note Group and select or
assign its singer. The mode names cannot appear before a singer is selected.
Then either:

- tell Codex every exact Vocal Mode name shown in the panel, preserving spelling
  and capitalization; or
- attach a screenshot showing the complete Vocal Mode panel.

After this first identification, Codex can reuse the same list for later edits
with that singer. Provide the list or a new screenshot again after changing
singers.

## Daily use

For later sessions:

1. Open the SynthV project and save a working copy.
2. Start **SynthV Agent Bridge**.
3. Open or reconnect a Codex task that has the MCP server enabled.
4. Select the intended target and tell Codex the result you want. Mention
   anything that must remain unchanged. If the request uses Vocal Modes, also
   select the Vocal and provide its complete panel screenshot or exact mode
   names.
5. Review the small preview, apply it, and listen to the result.

## Updating an existing installation

From the repository directory:

```bash
git pull --ff-only
npm ci
npm run build
npm run install:synthv -- --target "/path/to/Synthesizer V Studio 2/scripts"
npm run doctor -- --target "/path/to/Synthesizer V Studio 2/scripts"
```

If the installer reports that the runtime or side panel changed, choose
**Scripts → Rescan**, then start **SynthV Agent Bridge** again.

## Quick troubleshooting

| Symptom | Action |
|---|---|
| Bridge status (`B`) is offline | Run **Start SynthV Agent Bridge** in SynthV. |
| MCP status (`M`) is offline | Restart or reconnect the Codex task. |
| Side panel is missing or outdated | Run **Scripts → Rescan**, then restart the Bridge. |
| `node` or `npm` is not found | Ask Codex to install Node.js LTS, then restart the terminal/Codex. |
| A write returns `STALE_*` | Read only the target again; do not retry the old payload. |
| A write returns `SYNTHV_SESSION_CHANGED` | SynthV or the Bridge restarted; cached contexts were cleared automatically. Read the target again, then continue from the fresh context. |
| Undo affects a side-panel text field | Focus the main editor first, or use **Edit → Undo**. |
