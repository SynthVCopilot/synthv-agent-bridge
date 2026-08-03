# Claude Code host profile

Build the Runtime from the repository root:

```powershell
npm install
npm run build
```

The project-scoped [`.mcp.json`](../../.mcp.json) launches the same host-neutral
stdio entry point used by Codex:

```json
{
  "mcpServers": {
    "synthv-agent-bridge": {
      "command": "node",
      "args": ["dist/src/cli.js"]
    }
  }
}
```

Open the repository root as the Claude Code project and approve the local MCP
server when prompted. The repository does not write user-global Claude settings.

Validate the adapter statically:

```powershell
npm run doctor -- --host claude
```

This confirms the project profile, not Claude's authenticated clean-session tool
discovery. That final acceptance test requires an installed Claude Code CLI.

Agent behavior and the optional guided demo are distributed separately through
the `synthv-copilot` plugin in
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS).
