# 《小星星》引导式 Demo

[English](twinkle-star-demo.md) |
[简体中文](twinkle-star-demo_cn.md)

这个内置 Demo 让第一次使用的用户通过一句指令，体验 Codex 使用现有紧凑
MCP 接口创建并调音完整中文版《小星星》。它属于“引导式一键”：完成 Vocal
初始化后，创建音符、整曲调音、回读验证和播放均由 Codex 自动完成。

启动指令：

```text
运行《小星星》Demo。
```

机器可读的曲谱和调音模板位于
[`examples/twinkle-star-demo.json`](../examples/twinkle-star-demo.json)。
它是 Agent 负责解释的示例数据，不是第九个 MCP 工具，也没有把艺术判断
藏入 TypeScript 或 Lua。

## 用户会看到什么

Codex 在每个阶段开始前打印一个简短小标题：

1. **Demo 1/5：检查连接与安全位置**
2. **Demo 2/5：创建独立《小星星》音符组**
3. **Demo 3/5：选择歌手并识别全部唱法**
4. **Demo 4/5：写入整曲调音与音高曲线**
5. **Demo 5/5：回读验证并开始试听**

每个标题下面最多补充一句简短状态，不打印冗长 MCP 原始数据；发布预览后
也不会再次显示完整首次使用 Checklist。

## 引导流程

1. Codex 检查 Bridge，只读取足以确定安全位置的工程结构，并把 Demo 放在
   现有工程内容之后。
2. 用户明确同意后，Codex 使用 `add_notes` 和
   `grouping: "ensureNonMain"` 创建名为
   `SynthV Agent Demo - 小星星` 的独立非主 Group。它不修改已有音符、
   歌词、时值、自动化、轨道或 Group。
3. 用户选择这个 Demo Group，再选择或分配要使用的 Vocal，然后截图完整
   唱法（Vocal Mode）面板，或按照面板准确输入全部唱法名称。
4. 这一步无法省略：SynthV 官方脚本 API 无法读取当前 Vocal 身份，也无法
   枚举从未调整、仍为默认值的唱法名称。Codex 不得猜测或绕过。
5. Codex 重新读取 Demo Group，只把用户提供的准确唱法名称映射到模板中的
   温柔、明亮、童真风格；同时读取当前 Automation `definition.range`，
   再通过一个 `apply_group_tuning` 批次完成调音。模板会把 `automation`
   和 `pitchAnalysis` 放进顶层 `sv_query.include` 投影，确保新鲜 Guard
   保留在 Context 中。
6. Codex 回读整个 Demo Group，确认 42 个音符、5 处明确乐句间隙、
   0 个重叠、唱法和音素保持、5 条自动化曲线存在，然后开始循环播放。

因此，用户只需用一句话启动 Demo，并在中途完成一次歌手选择和唱法名称
交接；交接完成后的其余步骤全部自动执行。

## 安全与撤销

- Demo 只能修改当前任务中由它创建的 Group。
- 用户已有或来源不确定的内容一律视为用户资产，Demo 不得整理、移动、
  缩短、延长或调音。
- Demo 每个乐句内部的音符精确连接，只有 5 处预先声明的乐句停顿。咬字
  通过音素、Voice 和自动化调整，不能制造细小音符间隙。
- 创建曲谱和整曲调音分别对应一个 SynthV 撤销记录。先撤销一次调音，再
  撤销一次曲谱创建，即可移除整个 Demo。
- SynthV 是工程状态权威，用户负责最终试听和艺术验收。

## Demo 覆盖内容

- 42 个普通话音符和常见歌词
- 一个独立、可复用的非主 Note Group
- 句内精确连接和六个乐句结尾
- Group Voice 和用户提供的准确唱法名称
- 计算音素的强度与时值调整
- 响度、张力、气声、音高偏差和颤音包络曲线
- 受保护的最新读取、一个撤销记录内的一次完整预检调音批次、写后验证和
  循环播放

Demo 使用的就是日常调音所用的六个 MCP v3 工具和内部动作，因此成功运行
可以真实验证完整工作流。
