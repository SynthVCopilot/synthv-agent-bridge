# Agent / MCP 责任边界

[English](responsibility-boundaries.md) |
[简体中文](responsibility-boundaries_cn.md)

Bridge 将音乐判断与确定性执行分开：Agent 决定**为什么改、改哪里、改多少**；
MCP 和 Lua 把这个明确决定紧凑、安全、基于最新状态地执行，并提供撤销边界；
SynthV 保存结果，用户负责最终听感判断。

## 责任划分

| 工作 | 负责人 | 原因 |
|---|---|---|
| 理解用户意图、歌词情感、演唱风格 | Agent | 需要语言和音乐语义判断 |
| 决定哪些字加强、减弱、拖长或增加音高过渡 | Agent | 属于艺术决策 |
| 询问当前歌手、全部唱法名称 | Agent＋用户 | 官方接口无法读取歌手身份或枚举未调整的默认唱法 |
| 决定先调一小段还是更大范围 | Agent | 需要结合用户目标、审核成本和 token 成本 |
| 把温柔、明亮、克制等要求转换成明确参数 | Agent | Bridge 不应自行解释艺术语言 |
| 选择新鲜目标范围和明确的批量数值变换 | Agent | 目标和音乐数值属于当前任务决策 |
| 选择合法本地曲谱并确认有权使用 | Agent＋用户 | Bridge 无法判断版权或许可权限 |
| 提供当前 Group、音符、Voice 和自动化数据 | Lua Bridge | SynthV 实时对象模型才是权威数据源 |
| 缓存并展开带类型/作用域的 `contextId` 和 Guard 数据 | TypeScript MCP | 避免重复传输大型指纹，同时对不兼容或冲突作用域安全失败 |
| 检查并转换明确提供的本地 MusicXML/MIDI 声部 | TypeScript MCP | 本地解析不应交给 SynthV，也不代表用户拥有文件使用权 |
| 压缩读取结果和写入确认 | TypeScript MCP | 避免无关宿主数据进入模型上下文 |
| 检测 SynthV 重启或 Bridge 重载 | TypeScript MCP | 再次写入前必须清除旧 Context 和 Guard |
| 校验请求结构、路由、索引和稳定协议范围 | TypeScript MCP | 在文件 IPC 前拒绝错误请求 |
| 读取当前 Automation `definition.range` | Lua Bridge | 范围可能随宿主、歌手和参数变化 |
| 展开确定性音符变换和其他批处理机械计算 | Lua Bridge | 机械计算应集中、可复现 |
| 校验指纹和完整的预备批次 | Lua Bridge | 防止覆盖用户修改或只执行部分无效请求 |
| 创建一个撤销记录并验证宿主写入结果 | Lua Bridge＋SynthV | 提供一个恢复边界并避免假成功 |
| 保存、试听、撤销并确认最终效果 | 用户＋SynthV | 用户是最终艺术判断者 |

## 代码中的边界

### Agent

Agent 可以分析歌词、提出乐句处理、选择具体音符/音素/自动化目标并给出明确
数值。Agent 不得猜测歌手或未调整的默认唱法名称；只读取准备修改的目标，
优先组织为一个相关批次，并在陈旧状态或会话变化错误后重新读取。
用户要求使用节省 token 模式时，普通写入返回 `verified: true` 后不必再由
Agent 发起第二次独立写后查询，除非后续操作依赖最新状态。这不会关闭
TypeScript 或 Lua 校验、宿主写后条件验证，也不会跳过恢复流程、UI 或 Demo
要求的读取。
导入曲谱前，Agent 要求用户提供有权使用的本地来源，先检查可选声部和重叠
诊断，只有获得明确权利确认后才请求导入。搜索结果、在线 URL 或文件可访问
本身都不代表许可。
《小星星》Demo 仍由 Agent 编排：明确的曲谱和调音模板随可移植
`synthv-agent` 技能存放在
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS)，MCP 与 Lua
继续只校验和执行 Agent 提供的数值。

### TypeScript MCP

MCP 层负责 Schema、动作分类、紧凑投影、`contextId`/Guard 展开、会话失效
和最小确认。每个 Context 都绑定目标类型和来源作用域；不兼容复用或冲突的
显式定位器/Guard 会安全失败。Node 层还会在不联网的情况下有界解析明确提供
的本地 MusicXML/MIDI，用刚检查的 SHA-256 绑定导入，拒绝不安全、有歧义或
复调的输入，并把一个选定声部转换为音符。它不选择音符、不解释情感、不生成
唱法名称、不判断法律权利、不应用源速度，也不暗中修改 Agent 请求的音乐数值。

### Lua 执行器

Lua 层读取权威 SynthV 对象，使用当前宿主能力，展开确定性操作，校验每个
目标和结果值，并且只在普通写入和独立事务步骤完成预检之后到达
`Project:newUndoRecord()`。
如果同一次新鲜读取没有提供有效的 Automation `definition.range`，自动化
控制点写入会安全失败。共享 Note Group 内容写入也会默认拒绝；只有调用者
明确选择影响全部引用并提供相符的最新引用数时才会继续。事务会在写入前完整
预检独立步骤；定位器依赖前一步 `$result` 的步骤则在解析结果后、执行该步
之前即时预检。执行器还会验证支持的写后条件。

### SynthV 和用户

SynthV 是工程状态权威。用户选择目标 Group 和歌手，提供接口无法读取的
唱法名称，试听预览，判断结果是否符合歌曲，确认有权导入本地曲谱，在分离
克隆轨道后人工核对非主 Group 的 Vocal，并在需要时使用 SynthV 撤销。事务
的单个撤销记录只是恢复边界，不承诺自动回滚。

## 批处理准入规则

只有当一个动作是机械的、确定性的、有界的且可预览时，才应加入批处理。
它的独立输入必须能在一个撤销记录之前完整验证。显式依赖前一步 `$result`
的事务步骤是狭义例外：它会即时预检；失败时由于前面步骤可能已写入，用户
可能需要撤销一次。`transform_notes` 符合这些条件，
因为它只应用明确的起音、时值和半音数值；`make_emotional` 或
`tune_whole_song` 不符合，因为它们隐藏了艺术判断，也难以审核失败原因。

对于刚读取的 `writeIntent` 乐句 Context，MCP v3 可以在不重复全部音符索引的情况下执行
统一变换：

```json
{
  "action": "transform_notes",
  "contextId": "<新鲜乐句 Context>",
  "args": {
    "target": "contextNotes",
    "transform": {
      "onsetOffsetSeconds": 2
    }
  }
}
```

TypeScript 层只展开这个 Context 中已受保护的音符。Lua 再通过 SynthV 当前
时间轴换算、校验全部结果、创建一个撤销记录，并验证宿主保留的音符值。
仅提供 `onsetOffsetSeconds` 时，音符时值仍按 blick 保持。
