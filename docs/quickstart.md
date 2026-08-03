# Quickstart

This guide installs the host-neutral SynthV Agent Bridge Runtime. It does not
install Agent prompts or edit any user-global Codex/Claude configuration.

## 1. Requirements

- Synthesizer V Studio 2 Pro 2.1.2 or newer
- Node.js 20.10 or newer
- Windows, macOS, or Linux for the MCP server; SynthV and the Lua scripts must
  share access to the same file-IPC directory
- A local stdio MCP host

Check Node and npm:

```powershell
node --version
npm --version
```

## 2. Clone and build

Choose any non-system drive or workspace you control:

```powershell
git clone https://github.com/SynthVCopilot/synthv-agent-bridge.git D:\synthv-agent-bridge
Set-Location D:\synthv-agent-bridge
npm install
npm run build
```

`npm install` writes JavaScript dependencies under the repository's
`node_modules` directory. The server entry point is `dist/src/cli.js`.

## 3. Install the SynthV scripts

In SynthV, choose **Scripts → Open Scripts Folder**. Pass that exact folder to:

```powershell
npm run install:synthv -- --target "C:\path\to\Synthesizer V Studio 2\scripts"
```

For a core-only installation without the optional connection Sidebar:

```powershell
npm run install:synthv -- --target "C:\path\to\scripts" --without-sidebar
```

The installer creates `SynthV Agent Bridge` under the selected scripts folder.
It copies the persistent Bridge, Stop command, and optional Sidebar. It does not
modify a SynthV project.

In SynthV, run **Scripts → Rescan**, then:

```text
Scripts → SynthV Agent Bridge → Start SynthV Agent Bridge
```

Leave the persistent script running. Use **Stop SynthV Agent Bridge** when you
want to stop only the Bridge; avoid **Abort All Running Scripts** if you still
need the optional Sidebar.

## 4. Choose the MCP host profile

Both maintained profiles launch the same Runtime.

### Codex

The repository already includes `.codex/config.toml`. Open and trust the
repository root in Codex, then start a new task after building.

See [Codex host profile](hosts/codex.md).

### Claude Code

The repository already includes `.mcp.json`. Open the repository root as the
Claude Code project and approve the project MCP server when prompted.

See [Claude Code host profile](hosts/claude-code.md).

### Another stdio host

Register this command with the repository root as its working directory:

```text
node dist/src/cli.js
```

The server must receive valid JSON-RPC on stdin. Do not launch it in a normal
interactive terminal and expect a prompt.

## 5. Diagnose

Core Runtime diagnosis is host-neutral and is the default:

```powershell
npm run doctor -- --target "C:\path\to\SynthV scripts"
```

Validate a project profile without reading global settings:

```powershell
npm run doctor -- --host codex
npm run doctor -- --host claude
npm run doctor -- --host all --json
```

Doctor checks compiled build freshness, component versions/build identities,
file-IPC access, current Bridge/MCP heartbeats, and optional installed script
contents. Host flags add only repository-scoped configuration checks. Doctor is
read-only.

If the compiled build changed while the host MCP process was already running,
start a new Agent task or reconnect that MCP server so it loads the new build
identity.

## 6. Verify through MCP

Once the Bridge and MCP server are both running:

1. Call `sv_status` and confirm protocol v3, a current Session, and matched
   component identities.
2. Call `sv_describe` to list the internal actions behind the six public tools.
3. Use `sv_query` for a read-only project summary before attempting a write.

The public MCP surface is intentionally limited to:

- `sv_status`
- `sv_describe`
- `sv_query`
- `sv_command`
- `sv_ui`
- `sv_review`

## 7. Optional Agent skills

For host-neutral guidance on safe writes, tuning, composition, and lyrics,
install `synthv-copilot` separately from
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS). The optional
Twinkle Star demo lives there as an Agent-owned reference asset. Installing the
skills does not install or start this Runtime.

## Update

From a clean checkout:

```powershell
git pull --ff-only
npm install
npm run build
npm run install:synthv -- --target "C:\path\to\SynthV scripts"
```

Then rescan/restart the Bridge as requested by the installer and reconnect the
MCP host. Re-run Doctor before editing a real project.
