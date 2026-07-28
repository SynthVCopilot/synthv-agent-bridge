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
into the scripts directory I provide, register the MCP server with its absolute
path, and run the project doctor.
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

## 4. Register the MCP server with Codex

Use the absolute path to the built entry point:

```bash
codex mcp add synthv-agent-bridge -- node "/absolute/path/to/synthv-agent-bridge/dist/src/cli.js"
codex mcp list
```

If you use a Codex surface that was already open, start a new task or reconnect
after registration so it loads the new MCP configuration.

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

## 7. Make the first tuning edit

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

Before the first tuning write in a conversation, the Agent presents this
onboarding once.

### How to use

1. Save the project or create a working copy.
2. Select the intended Note Group in SynthV, then select or assign its intended
   Vocal and provide that Vocal's singing styles as described above. If no
   suitable Note Group exists or the Vocal Modes are hidden, create—or ask the
   Agent to create—the temporary note and Note Group described above, select
   that Group and its Vocal, then send the complete panel screenshot or exact
   style names.
3. Select a short lyric phrase, typically two to eight bars, and state the
   intended style and anything that must remain unchanged.
4. Let the Agent read fresh state and show a small, reviewable plan.
5. Apply and listen to the phrase-level style before asking for word-level
   pronunciation, timing, pitch-transition, pitch-curve, and expression work.
6. Do not edit the same target while a Bridge write is running. To undo, focus
   the main editor and press **Ctrl+Z**, or choose **Edit → Undo**.

### Preflight checklist

- [ ] The project is saved or a working copy exists.
- [ ] The intended Note Group is selected in SynthV.
- [ ] The intended Vocal is selected or assigned for that Note Group.
- [ ] Because of the official API limitation, the complete singing-style panel
      screenshot or every exact singing-style name has been provided; if the
      Vocal Modes were hidden, a temporary note and Note Group were created
      first, then that Group and its Vocal were selected to make the parameters
      appear.
- [ ] If the Vocal changed, the new Vocal's complete panel or exact
      singing-style names were provided again.
- [ ] A short lyric phrase or note range is selected.
- [ ] The intended style and content that must remain unchanged are stated.
- [ ] The same target will not be edited manually while the Bridge writes.

The Agent does not display a second checklist after publishing the preview.

After the checklist is complete, start with a read-only request:

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
4. Select the intended Note Group and its singer. If this is the first Vocal
   Mode edit for that singer, attach a screenshot of the complete Vocal Mode
   panel or type every exact mode name.
5. Select one lyric phrase and ask Codex to establish its overall singing style
   with the identified Vocal Modes. Review the preview, apply it, and listen
   before continuing.
6. Once the phrase-level style is approved, ask Codex to fine-tune the phrase
   word by word. Keep each pass focused on supported details such as
   pronunciation, phoneme timing, note timing, pitch transitions, pitch curves,
   loudness, tension, breathiness, or other requested parameters.
7. Review, apply, and listen after each bounded pass, then continue phrase by
   phrase.

Recommended prompt for the phrase-level style pass:

```text
The current singer's Vocal Modes are: <exact names from the panel>. Read the
selected lyric phrase and propose an overall singing style using only those
names. Publish a reviewable preview and do not start word-level fine-tuning yet.
```

After listening and confirming the style:

```text
Keep the approved overall style. Read the selected phrase again, then fine-tune
it word by word. Show the planned pronunciation, timing, pitch-transition,
pitch-curve, and expression changes before applying them.
```

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
| Undo affects a side-panel text field | Focus the main editor first, or use **Edit → Undo**. |
