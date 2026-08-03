# Twinkle Star demo moved to the Agent skill

The guided demo is an Agent-owned musical workflow, not Runtime behavior. Its
score, tuning recipe, safety policy, and validation test now live in the
`synthv-agent` skill inside
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS/tree/main/plugins/synthv-copilot/skills/synthv-agent).

The bridge continues to provide the same six host-neutral MCP tools and does not
contain demo-specific TypeScript or Lua logic.
