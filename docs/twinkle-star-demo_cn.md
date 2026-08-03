# 《小星星》Demo 已迁移到 Agent 技能

引导式 Demo 属于 Agent 拥有的音乐工作流，不是 Runtime 行为。它的乐谱、调音
方案、安全规则和验证测试现存放在
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS/tree/main/plugins/synthv-copilot/skills/synthv-agent)
中的 `synthv-agent` 技能里。

Bridge 继续提供同样的六个宿主中立 MCP 工具，不包含 Demo 专用 TypeScript 或
Lua 逻辑。
