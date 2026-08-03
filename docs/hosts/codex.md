# Codex host profile

Build the Runtime from the repository root:

```powershell
npm install
npm run build
```

The project-scoped [`.codex/config.toml`](../../.codex/config.toml) launches the
same host-neutral stdio entry point used by every supported host:

```toml
[mcp_servers.synthv-agent-bridge]
command = "node"
args = ["dist/src/cli.js"]
startup_timeout_sec = 120
```

Open and trust the repository root in Codex, then start a new task after a
rebuild so the MCP process uses the current compiled identity. No user-global
Codex configuration is required or modified.

Validate the adapter without inspecting global settings:

```powershell
npm run doctor -- --host codex
```

Agent behavior and the optional guided demo are distributed separately through
the `synthv-copilot` plugin in
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS).
