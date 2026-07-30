# SynthV Agent Bridge

[English](README.md) | [简体中文](README_CN.md)

这是一个本地 [Model Context Protocol（MCP）](https://modelcontextprotocol.io/)
服务器，让兼容的 AI 客户端可以检查和控制当前在
**Synthesizer V Studio 2 Pro** 中打开的工程。

Bridge 使用 Synthesizer V 公开的 Lua 脚本 API。它**不会**解析或重写
`.svp` 文件，不会打开网络端口，也不会自行调用 AI API。

> 第一次使用？请参阅[中文快速开始](docs/quickstart_cn.md)。环境检查、
> 依赖与 Node.js 安装、构建、SynthV 脚本安装、MCP 注册和诊断等大部分
> 工作都可以交给 Codex 完成；系统级安装可能需要用户授权。
> English users: see the [Quickstart](docs/quickstart.md). Codex can handle
> most setup steps, including environment checks, dependency and Node.js
> installation, the build, SynthV script installation, MCP registration, and
> diagnostics.

> [!TIP]
> 第一次连接？回复 **`运行《小星星》Demo。`** Codex 会用简短小标题说明每个
> 阶段，创建包含 42 个音符的独立 Demo Group；中途只需选择它的 Vocal 并
> 提供全部准确唱法名称，随后会自动完成调音、回读验证和循环播放。Demo
> 不修改工程原有内容。详见[引导式 Demo](docs/twinkle-star-demo_cn.md)。

> [!IMPORTANT]
> 由于 SynthV 官方脚本 API 无法读取当前 Vocal 身份，也无法枚举从未调整、
> 仍保持默认值的唱法名称和参数，开始调音前请先选择一个音符组，再为该
> 音符组选择要使用的 Vocal（歌手/声库），然后截图完整唱法（Vocal Mode）
> 面板，或按照面板中的原始拼写和大小写准确输入该 Vocal 的全部唱法；没有
> 选择歌手时不会出现唱法名称。如果没有合适的音符组或暂时看不到
> Vocal Modes，可由用户或 Agent 先在工程任意安全位置创建一个临时音符和
> 一个临时非主音符组，再选中该音符组并选择歌手，使唱法参数显示出来；
> 随后截图完整唱法面板，再继续调音。更换 Vocal 后，必须重新截图新 Vocal
> 的完整唱法面板，或重新输入它的全部唱法名称，不能沿用上一个 Vocal 的
> 列表。

> 状态：**v0.1.5 预发布版**。协议、安全保护、广泛的官方脚本 API
> 覆盖、可选的原生侧边栏工作流、受保护的事务，以及首批音乐语义工具
> 均已实现。请在重要工程的副本上测试。

## 功能

| 领域 | 能力 |
|---|---|
| 工程检查 | 读取工程元数据、轨道、库 Group、音符、选区、速度/拍号图、计算音素与音高、自动化、混音器状态和编辑器上下文。 |
| 音符与歌词 | 添加、编辑、删除、克隆、移调或人性化受保护音符；匹配歌词，并编辑语言、歌唱/说唱类型、时值、微调和音符属性。 |
| Voice 与音素 | 读取和编辑 Group Voice、Vocal Mode 轴、实验性 Unison 字段、音素集覆盖、音节时值、发音，以及单音素时值或强度。 |
| 音高与表情 | 调整音高过渡和音高曲线；管理 Smart Pitch 控制和 AI Retake；应用 Scoop、Falloff、Vibrato、Crescendo 或 Breathiness 预设。 |
| 自动化 | 读取、添加、替换、采样、简化或清除音高偏差、响度、张力、气声、发声、性别和 Vocal Mode 曲线。 |
| 轨道、Group 与和声 | 创建、克隆、复用、更新或删除库 Group、Group 引用和轨道；创建宿主克隆 Vocal 上下文的空白模板轨；并创建受音域约束的和声轨。共享 Group 内容写入默认安全失败，除非明确确认要影响全部引用。 |
| 本地曲谱导入 | 检查明确提供的本地 MusicXML（`.xml`、`.musicxml`、`.mxl`）或 SMF MIDI（`.mid`、`.midi`），再通过受保护音符写入路径导入一个已确认权利的单旋律声部。不接受 URL 或 `.svp`。 |
| 时序、编辑器与播放 | 转换秒、四分音符和 blick；编辑速度/拍号；控制选区、视口、剪贴板、网格吸附、坐标、混音器和播放。 |
| 安全编辑 | 使用最新指纹、带类型/作用域的 `contextId` 和 Guard Token 保护写入；完整预检独立事务步骤，按需解析正向依赖；创建一个 SynthV 撤销记录，并可选保留受保护回滚计划。 |
| 审核与本地隐私 | 在可选原生侧边栏中审核、应用、放弃或取消受保护预览。文件 IPC 保持本地：Bridge 不解析 `.svp` 文件、不打开网络端口，也不调用 AI API。 |

## 责任边界

Bridge 将音乐判断与确定性执行分开：Agent 决定**为什么改、改哪里、改多少**；
MCP 和 Lua 根据 SynthV 的当前状态，紧凑、安全地执行这个明确决定；
SynthV 保存结果，用户负责最终听感判断。

| 工作 | 负责人 | 原因 |
|---|---|---|
| 理解用户意图、歌词情感、演唱风格 | Agent | 需要语言和音乐语义判断 |
| 决定哪些字加强、减弱、拖长或增加音高过渡 | Agent | 属于艺术决策 |
| 询问当前歌手、全部唱法名称 | Agent＋用户 | 官方接口无法读取歌手身份或枚举未调整的默认唱法 |
| 决定先调一小段还是更大范围 | Agent | 需要结合用户目标、审核成本和 token 成本 |
| 把温柔、明亮、克制等要求转换成明确参数 | Agent | Bridge 不应自行解释艺术语言 |
| 选择新鲜目标范围和明确的批量数值变换 | Agent | 目标和音乐数值属于当前任务决策 |
| 选择合法本地曲谱并确认有权导入 | Agent＋用户 | Bridge 无法判断版权或许可权限 |
| 提供当前 Group、音符、Voice 和自动化数据 | Lua Bridge | SynthV 实时对象模型才是权威数据源 |
| 缓存并展开带类型/作用域的 `contextId` 和 Guard 数据 | TypeScript MCP | 避免重复传输大型指纹，同时对不兼容作用域安全失败 |
| 检查并转换明确提供的本地 MusicXML/MIDI 声部 | TypeScript MCP | 在 SynthV 外有界本地解析，但不代表用户有权使用文件 |
| 压缩读取结果和写入确认 | TypeScript MCP | 避免无关宿主数据进入模型上下文 |
| 检测 SynthV 重启或 Bridge 重载 | TypeScript MCP | 再次写入前必须清除旧 Context 和 Guard |
| 校验请求结构、路由、索引和稳定协议范围 | TypeScript MCP | 在文件 IPC 前拒绝错误请求 |
| 读取当前 Automation `definition.range` | Lua Bridge | 范围可能随宿主、歌手和参数变化 |
| 展开确定性音符变换和其他批处理机械计算 | Lua Bridge | 机械计算应集中、可复现 |
| 校验指纹和完整的预备批次 | Lua Bridge | 防止覆盖用户修改或只执行部分无效请求 |
| 阻止意外修改有多个引用的 Note Group 内容 | Lua Bridge | 即使引用位于不同轨道，Group 内容仍然共享 |
| 创建一个撤销记录并验证宿主写入结果 | Lua Bridge＋SynthV | 提供一个恢复边界并避免假成功 |
| 保存、试听、撤销并确认最终效果 | 用户＋SynthV | 用户是最终艺术判断者 |

详细的代码分层规则与批处理准入条件请参阅
[Agent / MCP 责任边界](docs/responsibility-boundaries_cn.md)。

## 首次 MCP 连接：用户提示

在一次对话中第一次修改工程前，Agent 必须简短告知用户：

- 可以选择运行引导式 Demo。回复 `运行《小星星》Demo。` 后，Agent 会在
  不修改原有内容的前提下创建并调音独立示例；执行时打印五个简短进度
  小标题，并因官方 API 限制在选择 Vocal、提供全部唱法时暂停一次。
- 在 AI 编辑前保存重要工作；Bridge 写入期间不要同时修改同一个目标。
- 如果用户撤销或手动修改了 Agent 即将处理的音符、Group、Voice 或
  Vocal Mode，Agent 会只重新读取该目标。无关修改不需要重新读取。
- SynthV 脚本 API 不公开当前歌手身份，也无法枚举仍保持默认值、从未调整
  过的唱法（Vocal Mode）名称和参数。修改唱法前，Agent 必须要求用户先
  选择目标音符组，再为该音符组选择歌手，然后按原始拼写和大小写列出面板
  中的全部唱法，或提供完整唱法面板截图；没有选择歌手时不会出现唱法名称。
- 如果没有合适的音符组或暂时看不到 Vocal Modes，唯一允许的初始化写入
  是由用户或 Agent 创建一个临时音符和一个临时非主音符组。用户随后必须
  选中该音符组并选择歌手，仅用于使唱法参数显示出来。参数出现后，Agent
  必须暂停并索要完整面板截图或全部准确唱法名称，之后才能继续调音。
- 同一歌手可复用已经识别的名称；更换歌手后，必须重新提供新 Vocal 的
  完整面板截图或重新输入其全部准确唱法名称，不能沿用原列表。
- 第一次调音写入前，Agent 必须显示一次简短的 **How to use** 和一份调音前
  Checklist，涵盖保存/备份、Vocal 与唱法、目标歌词、预期风格和保留内容、
  最新读取/计划/审核、先确定整段唱法再逐字精调、并发编辑安全和撤销。
  发布预览后不再显示第二份 Checklist。

Agent 每次对话只需给出一次提示，不必在每次编辑前重复。用户可以提供
如下简短提示：

```text
当前歌手的唱法（Vocal Modes）：Airy、Bright、Cool、Dark、Emotional、Power、
Solid、Sweet。
```

也可以提供一张清楚显示完整唱法（Vocal Mode）面板的截图。

## 架构

```text
Codex / 其他本地 stdio MCP 宿主
                    │
                    │ 基于 stdio 的 MCP
                    ▼
           TypeScript MCP 服务器
                    │
                    │ 关联式 JSON 文件 IPC
                    ▼
       SynthVAgentBridge.lua（常驻）
                    │
                    │ SynthV 脚本 API
                    ▼
          已打开的 SynthV 工程
```

第一版有意采用文件 IPC，因为它可在 SynthV 文档规定的 Lua 环境中工作，
并且便于检查和恢复。参阅 [docs/architecture.md](docs/architecture.md)。

本地曲谱检查是 Node 服务器单纯转发工程数据职责的有界例外：它只读取明确
提供的绝对 MusicXML/MIDI 路径。检查留在 Node；获准导入后，转换出的音符
仍通过受保护 Lua `add_notes` 路径写入。它绝不解析 `.svp`。

## 要求

- Synthesizer V Studio **2 Pro 2.1.2 或更高版本**。
- Node.js **20.10 或更高版本**。
- 支持本地 stdio 服务器的 MCP 宿主，例如 Codex CLI 或其他兼容客户端。

本项目面向 Synthesizer V Studio 2 Pro 的脚本环境，不支持 Basic 版。

## 安装

新用户可以按照完整的[中文快速开始](docs/quickstart_cn.md)操作；英文版见
[Quickstart](docs/quickstart.md)。其中包含拉取仓库、由 Codex 协助配置
Node.js、安装脚本、注册 MCP、验证连接和第一次受保护调音修改。

### 1. 构建 MCP 服务器

```bash
git clone https://github.com/zhoupengjie/synthv-agent-bridge.git
cd synthv-agent-bridge
npm install
npm run build
```

### 2. 安装 SynthV 脚本

在 Synthesizer V Studio 中选择 **脚本 → 打开脚本文件夹**，然后把该目录
传给安装器：

```bash
npm run install:synthv -- --target "/Synthesizer V Studio 2/脚本目录"
```

安装器会把以下文件复制到所选目录下的 `SynthV Agent Bridge` 子文件夹：

- `SynthVAgentBridge.lua`
- `StopSynthVAgentBridge.lua`
- `SynthVAgentSidebar.lua`（可选）

也可以在运行 `npm run install:synthv` 前，把 `SYNTHV_SCRIPTS_DIR` 设置为
脚本目录。安装器会创建 `SynthV Agent Bridge` 子文件夹。侧边栏文件发生
变化时，请选择 **脚本 → 重新扫描**。SynthV 随后会把 **SynthV Agent**
加载为自定义侧边栏区域。重新扫描会停止常驻脚本，因此之后需要再次运行
一次 **Start SynthV Agent Bridge**。

Bridge 和所有普通 MCP 读写工具都不依赖侧边栏。如果只需核心安装，可
添加 `--without-sidebar`；它会跳过可选侧边栏，但不会删除已有安装：

```bash
npm run install:synthv -- --target "/脚本目录" --without-sidebar
```

如果支持热重载的 Bridge 会话正在运行，安装器会请求它加载复制后的 Lua
文件，并等待新的会话心跳。此流程使用 Bridge 的文件 IPC 和 Lua
`loadfile()`，不使用 UI 自动化或 Hook。使用 `--no-reload` 可以只复制而
不请求重载。首次安装支持热重载的版本时，仍需手动启动一次。侧边栏需要
重新扫描时，当前 Bridge 也会停止，因此扫描后必须再次手动启动。工程或
应用重启后，SynthV 可能复用缓存的菜单脚本代码；所以 Bridge 运行时本身
发生变化时，安装器也会要求在下次手动启动前执行一次
**脚本 → 重新扫描**。在此之前，热重载会保持当前会话可用。

### 3. 启动编辑器内 Bridge

在 Synthesizer V Studio 中运行：

```text
脚本 → SynthV Agent Bridge → Start SynthV Agent Bridge
```

SynthV 运行期间，该脚本会保持活动并写入心跳。需要停止时，运行
**Stop SynthV Agent Bridge**，或使用 SynthV 的**中止所有正在运行的脚本**
命令。

### 4. 连接 MCP 宿主

#### Codex

仓库已经包含项目级 `.codex/config.toml`：

```toml
[mcp_servers.synthv-agent-bridge]
command = "node"
args = ["dist/src/cli.js"]
startup_timeout_sec = 120
```

请在 Codex 中信任并打开仓库根目录，完成构建后重启 Codex 或新建任务。
这样 MCP 注册只对当前项目生效，不会修改用户的全局 Codex 配置。

完整 TOML 示例位于
[examples/codex-config.toml](examples/codex-config.toml)。其他支持
**STDIO** 服务器的本地 MCP 宿主也可以使用同一条
`node .../dist/src/cli.js` 命令。

### 可选的原生侧边栏工作流

v0.1.4 侧边栏是可选的本地审核控制台。它有意保持 Bridge 不联网，也不会
自行调用 AI API。它以紧凑布局启动，显示连接/任务状态；**Show details**
可以展开上下文、指令、活动和历史记录控件。即使处于紧凑模式，待确认
预览也会自动显示：

1. 在 SynthV 中选中音符或 Group，并在 **SynthV Agent** 中输入指令。
2. 点击 **Copy & queue**。面板会把请求写入本地 IPC 目录，并把交接提示
   复制到宿主剪贴板。
3. 把提示粘贴到已连接的 Codex 任务。
4. Codex 读取最新 SynthV 状态，并把一个带指纹保护的写入或完整事务发送
   回面板，其中包含结构化变更和风险。
5. 在 SynthV 中审核预览，然后点击 **Apply** 或 **Dismiss**。

Apply 命令由 Node 协调器消费，并通过 MCP 工具使用的同一个串行
`FileIpcClient` 发送。侧边栏绝不会直接编辑工程对象。SynthV 公开脚本 API
可以创建撤销记录，但不能调用撤销。Bridge 成功写入后，请点击主编辑区并
使用 **Ctrl+Z**；如果焦点仍在侧边栏，也可以选择
**编辑 → 撤销**。参阅 [docs/sidebar.md](docs/sidebar.md)。

### 5. 验证连接

打开启用了 MCP 的对话，让它调用 `sv_status`，然后通过 `sv_read` 调用
`action: "get_project_info"`。正常状态包含：

```json
{
  "connected": true,
  "fresh": true
}
```

## MCP v2 工具

默认 MCP 表面提供八个稳定工具。各个 SynthV 操作及其完整 Schema 由
`sv_describe` 按需返回，而不是把所有操作 Schema 都放进模型上下文。

| 工具 | 用途 |
|---|---|
| `sv_status` | 读取 Bridge/宿主状态、Ping，或热重载 Lua 执行器。 |
| `sv_describe` | 列出操作，或返回最多 16 个指定操作的 Schema。 |
| `sv_read` | 执行一个读取操作，可选投影、Dense 行和 `contextId` 复用。 |
| `sv_edit` | 执行经过验证的工程写入，默认返回最小确认信息。 |
| `sv_delete` | 执行明确具有破坏性的删除/清除操作。 |
| `sv_transaction` | 应用或回滚事务；步骤负载可以携带 `contextId`。 |
| `sv_ui` | 控制选区、视口、剪贴板、对话框、吸附、坐标或播放。 |
| `sv_sidebar` | 读取可选面板任务/状态，或发布受保护预览。 |

正常调音顺序：

1. 对不熟悉的操作调用 `sv_describe`。
2. 使用 `sv_read` 读取最新状态。
3. 在 `sv_edit`、`sv_delete`、另一次作用域读取或事务步骤中复用返回的
   `contextId`。
4. 遇到 `UNKNOWN_CONTEXT` 或任何 `STALE_*` 结果后重新读取。

`contextId` 只在有界的 Node 内存中保存定位器和并发保护。每个句柄都绑定
目标类型和来源作用域；把它用于不兼容操作，或同时提供互相冲突的显式定位器/
Guard，会安全失败，而不会静默改换目标。只有定位器、没有保护信息的读取不会
生成可用于写入的 Context。Context 不缓存可变的音符、Voice、选区或自动化
内容；SynthV 在创建撤销记录前仍会检查每一个完整指纹。

乐句读取支持对 `notes`、`voice`、`automation`、`analysis`、
`recommendations`、`pitchAnalysis`、`selection` 和 `diagnostics` 进行
`include` 投影。v2 默认包含 `notes`、`voice` 和 `analysis`。当结果至少
包含 24 个音符且 `dense: "auto"` 时，会使用列/行表示；普通对象可使用
`dense: "never"`。V2 音符行会省略可推导的绝对结束位置；当绝对音高和
局部音高相同时，会通过 `noteDefaults.absolutePitch: "pitch"` 表示省略。

### SynthV 操作目录

这些操作由八个 MCP v2 工具在内部路由，不会注册为独立 MCP 工具。仅在
需要时通过 `sv_describe` 获取其当前 Schema。

| 操作 | 权限 | 用途 |
|---|---:|---|
| `bridge_status` | 读取 | 无需往返即可读取心跳。 |
| `sidebar_get_request` | 读取 | 读取原生侧边栏排队的最新指令和选区摘要。 |
| `sidebar_status` | 读取 | 读取 Bridge/MCP 诊断、任务状态、IPC 路径、近期摘要和最新协调器错误。 |
| `sidebar_publish_preview` | 控制 | 发布一项完整受保护写入或事务、结构化变更和风险，供用户在 SynthV 中确认。 |
| `ping` | 读取 | 测试完整的 Node → Lua → Node 链路。 |
| `reload_bridge` | 控制 | 在当前脚本会话中重载已安装的 Lua Bridge。 |
| `get_host_info` | 读取 | 读取 SynthV 宿主版本、操作系统、语言、工程和 IPC 信息。 |
| `host_clipboard` | 控制 | 通过 SynthV 宿主剪贴板 API 读取或写入文本。 |
| `show_dialog` | 控制 | 显示消息、输入、确认或自定义表单对话框。 |
| `convert_pitch` | 读取 | 转换 MIDI 音高和频率，并识别黑键。 |
| `get_project_info` | 读取 | 读取工程、时序、播放、宿主和当前编辑器位置。 |
| `inspect_score_file` | 读取 | 在 Node 中检查明确提供的本地 MusicXML 或 SMF MIDI，返回 SHA-256 文件保护和可选 part/voice/staff 或 track/channel，并在不修改 SynthV 的前提下预览有界单旋律声部。 |
| `get_time_axis` | 读取 | 读取全部速度/拍号标记及安全写入指纹。 |
| `convert_time` | 读取 | 通过当前速度图转换秒、四分音符或 blick，并可按 Blick 网格取整。 |
| `set_time_axis` | 破坏性 | 添加、替换或删除速度/拍号标记。 |
| `list_tracks` | 读取 | 读取轨道摘要、Group 数量、音符数量和混音器状态。 |
| `list_note_groups` | 读取 | 读取可复用库 Group、UUID、指纹和引用数。 |
| `create_note_group` | 写入 | 创建可选包含音符的可复用库 Group。 |
| `clone_note_group` | 写入 | 把轨道或库 Group 深度克隆到库中。 |
| `delete_note_group` | 破坏性 | 删除一个库 Group 及其所有引用。 |
| `add_group_reference` | 写入 | 在轨道上放置库 Group。 |
| `clone_group_reference` | 写入 | 在另一轨道上创建链接或深度复制的引用。 |
| `get_track_notes` | 读取 | 读取 Group、UUID、音符、属性、偏移和安全写入指纹。 |
| `get_group_voice` | 读取 | 读取类型化 Group Voice 默认值、Vocal Mode、实验性 Unison 字段和目标选区上下文。 |
| `get_note_phoneme_data` | 读取 | 读取用户/计算音素、音素集覆盖、单音素属性和音符选区状态，可选紧凑音符索引或秒范围过滤。 |
| `get_phrase_context` | 读取 | 一次紧凑、可直接写入的选中/范围乐句读取，包含音符与自动化 Guard Token、Voice/Vocal Mode、诊断和仅供建议的审核目标。 |
| `get_selection` | 读取 | 读取选中的 Group、音符、Smart Pitch 控制和指定自动化点。 |
| `set_selection` | 控制 | 替换、添加、删除或清空编辑器选区，并返回 SynthV 实际报告的选区。 |
| `get_computed_group_data` | 读取 | 读取计算音素/说唱属性和可选音高采样。 |
| `add_track` | 写入 | 创建轨道并返回其主 Group 定位器。 |
| `update_track` | 写入 | 重命名、重新着色或修改 Render Panel 包含状态。 |
| `clone_track` | 写入 | 通过宿主克隆继承轨道主 Vocal 上下文，可选清空或移调。含非主人声 Group 的源轨默认被拒绝；`nonMainGroupPolicy=detach` 可使其 Group 内容独立，但必须人工核对这些非主 Group 的 Vocal 身份。 |
| `clone_track_shell` | 写入 | 通过宿主克隆把源轨主 Group 的 Vocal 上下文带到一条已验证为空的轨道，同时移除音符、Smart Pitch、已知自动化、非主 Group，并默认重置混音器。API 无法读取或命名继承到的 Vocal 身份。 |
| `delete_track` | 破坏性 | 删除经过指纹验证且不是最后一条的轨道。 |
| `update_group` | 写入 | 修改人声/乐器引用状态和受支持的人声属性。 |
| `set_group_voice` | 写入 | 使用指纹验证更新类型化 Voice、Vocal Mode 和经宿主验证的实验性 Unison，可选当前 Group 保护。 |
| `apply_group_tuning` | 破坏性 | 完整预检后，在一个撤销记录中应用同一 Group 的 Voice/唱法、音符/音素及多条自动化调音；若宿主在执行期意外失败，重试前必须先在 SynthV 中撤销一次。 |
| `delete_group_reference` | 破坏性 | 删除非主人声或乐器引用。 |
| `import_monophonic_score` | 写入 | 通过受保护 `add_notes` 从刚检查且已确认使用权的本地 MusicXML/MIDI 单旋律声部导入最多 512 个音符；SHA-256 必须仍匹配，源速度只返回审核而不自动应用。 |
| `add_notes` | 写入 | 向目标 Group 添加音符。V2 默认为 `grouping=ensureNonMain`：目标为轨道主 Group 时创建可复用的非主 Group/引用；使用 `grouping=target` 可写入准确目标 Group。 |
| `edit_notes` | 写入 | 编辑经过指纹验证的音符。 |
| `transform_notes` | 破坏性 | 对受保护音符批量应用明确的起音偏移、时值缩放/偏移或音高偏移。V2 可直接变换新鲜 Context 中的全部音符，无需重复索引。 |
| `set_note_phoneme_properties` | 写入 | 编辑经过指纹/Guard 验证的音素、音素集、音节、时值和强度属性，可选紧凑确认及当前 Group/选中音符保护。 |
| `delete_notes` | 破坏性 | 删除经过指纹验证的音符。 |
| `get_note_retakes` | 读取 | 读取 Take 数量和 Bridge 跟踪的 Take ID。 |
| `generate_note_retake` | 写入 | 生成时值、音高或音色变化。 |
| `activate_note_retake` | 写入 | 激活默认 Take 或 Bridge 跟踪的 Take。 |
| `delete_note_retake` | 破坏性 | 删除 Bridge 跟踪的非默认 Take。 |
| `get_pitch_controls` | 读取 | 读取点/曲线 Smart Pitch 对象及其指纹。 |
| `add_pitch_controls` | 写入 | 添加点或曲线 Smart Pitch 对象。 |
| `edit_pitch_controls` | 写入 | 编辑经过指纹验证的 Smart Pitch 对象。 |
| `delete_pitch_controls` | 破坏性 | 删除经过指纹验证的 Smart Pitch 对象。 |
| `get_automation` | 读取 | 读取参数定义和控制点，可返回紧凑 Guard Token 代替冗长曲线指纹。 |
| `sample_automation` | 读取 | 在指定位置采样原生或线性曲线值。 |
| `simplify_automation` | 破坏性 | 删除曲线范围内不重要的点。 |
| `set_automation_points` | 写入 | 添加/更新经过指纹或 Guard 验证的点，可先清除全部或一个范围，并返回紧凑确认。 |
| `clear_automation` | 破坏性 | 清除完整曲线或选中范围。 |
| `get_editor_view` | 读取 | 读取编辑器时间/数值范围和像素比例。 |
| `set_editor_view` | 控制 | 移动或缩放主编辑器/编曲视口，并返回宿主最终的导航状态。 |
| `snap_position` | 读取 | 使用当前编辑器网格设置吸附位置。 |
| `convert_editor_coordinates` | 读取 | 转换时间/数值与 x/y 编辑器坐标。 |
| `script_data` | 读/写 | 管理 SynthV 对象上具有命名空间的 Bridge JSON 元数据。 |
| `get_track_mixer` | 读取 | 读取增益、声像、静音和独奏。 |
| `set_track_mixer` | 写入 | 修改增益、声像、静音和独奏。 |
| `apply_transaction` | 破坏性 | 在一个撤销记录中应用最多 32 个写入。独立步骤会完整预检；后续步骤可用 `$result` 取得前一步结果，并在执行前即时预检。它提供单次撤销恢复边界，不是自动回滚。 |
| `rollback_transaction` | 破坏性 | 在一个新的撤销记录中应用已保存的受保护事务反向步骤。 |
| `create_harmony_track` | 写入 | 克隆受保护人声轨、移调、把可选音域适配到八度，并设置混音器。 |
| `humanize_notes` | 破坏性 | 对起音/时值应用确定性的指纹保护变化，可选保留和弦对齐。 |
| `apply_expression_preset` | 破坏性 | 通过音符属性或自动化应用 Scoop、Falloff、Vibrato、Crescendo 或 Breathiness。 |
| `fit_lyrics` | 破坏性 | 把音节和可选音素分配到经过指纹验证的音符。 |
| `playback` | 控制 | 读取状态、播放、暂停、停止、定位或循环，并返回宿主实际状态和播放头。 |

所有轨道、Group 和音符索引均从 **1 开始**，与 SynthV Lua API 一致。
除非返回字段明确标记为 `absolute`，音符和自动化坐标均为 Group 局部 blick。
播放位置使用秒。

### 紧凑调音响应

`get_note_phoneme_data`、`get_automation` 和 `sample_automation` 接受
`responseMode: "compact"`。完整模式仍为默认值。

- 乐句调音前优先使用 `get_phrase_context`。没有显式作用域时，它可以在
  无需先读取选区的情况下定位当前钢琴卷帘 Group，并优先使用选中音符；
  一次请求即可组合紧凑音高/时值/音素音符、Group Voice/Vocal Mode 和
  有界自动化摘要。嵌套音符与自动化指纹会变成短 Guard Token。
- 乐句诊断会识别时值重叠、大音程跳进、长音、适合换气的间隙和密集短音，
  不会编辑工程。`pitchAnalysisFrames` 可选汇总计算轮廓，而不返回原始帧。
- 乐句音符的秒数取整到 0.1 ms。空值/默认音素覆盖、零微调和 false 选中
  标记会省略；非默认值保留，并在响应中报告 `noteDefaultsOmitted` 和
  `secondsPrecision`。
- 绝对范围默认为 `rangeMatch: "overlap"`，可保留跨越范围起点的长音。
  只有能接受仅覆盖起音时才使用 `rangeMatch: "onset"`；它会在排序后的
  Group 中进行二分查找，并报告 `coverage: "onset_only"` 及
  `mayExcludeEarlierSustains: true`。
- 无作用域乐句分页在仍有音符时返回不透明的 `page.cursorToken`。再次传入
  `cursorToken`，无需重复 Group 定位器和数字偏移。服务器会拒绝过期
  Token；如果边界音符发生变化，SynthV 会返回 `STALE_RANGE_CURSOR`。
- `get_phrase_context.ranges` 接受最多 32 个绝对范围。执行器只扫描 Group
  一次，每个匹配音符只序列化一次，并返回共享 `notes` 数组；每个范围通过
  `noteIndices` 引用音符，并拥有自己的诊断、自动化摘要和可选音高摘要。
- 音素读取可按准确 `noteIndices` 和/或重叠的绝对
  `startSeconds`/`endSeconds` 范围过滤。紧凑音符包含时值、歌词、计算
  音素、用户覆盖和短 `guardToken`；除非明确请求，否则省略大型原始与
  计算属性对象。
- 精确索引和普通分页读取只获取返回的音符页。时间范围只转换两次边界，
  并在第一个更晚的音符后停止扫描。仅刷新 Guard Token 或用户覆盖时，
  可设置 `includeComputedPhonemes: false`，避免整个 Group 的宿主计算。
- 可把音符 `guardToken` 传给 `set_note_phoneme_properties`，代替冗长的
  `fingerprint`。
- 紧凑自动化读取返回 `guardToken`；把它作为 `expectedGuardToken` 传给
  `set_automation_points`。
- 这些 Guard Token 也可用于 `apply_transaction` 步骤和
  `sidebar_publish_preview` 负载；计划到达文件 IPC 前会先完成解析。
- 紧凑写入响应返回数量和替换后的 Guard Token，而不是完整音符或自动化
  曲线。

Guard Token 是不透明的，并且只存在于当前 MCP 服务器进程。MCP v2 会自动
检测 SynthV/Bridge 会话 Token 变化，并清除全部缓存 Context 和 Guard
Token。此后的写入会返回 `SYNTHV_SESSION_CHANGED`；请重新读取目标，并用
新 Context 构建写入。无旧 Context 的新读取可以直接继续，并返回
`sessionReset`。淘汰或 `UNKNOWN_GUARD_TOKEN` 同样需要重新读取。服务器会在
MCP 发起热重载时等待新会话 Token，并在 `sv_status` 返回前清除这些缓存，
从而关闭“先确认重载、后发布新心跳”的时序窗口。服务器会在
请求到达 SynthV 前把 Token 解析为原始完整指纹，因此陈旧写入保护不变。

音素写入会先在分离的克隆上验证，再创建撤销记录，之后还会在工程音符上
再次验证。如果宿主或较旧 Voice 对请求值进行量化或忽略，会返回
`HOST_POSTCONDITION_FAILED`。稳定音素范围会直接校验：位置/活跃度
`0..1`、强度 `-1..1`，`leftOffset` 为有限秒数且 Bridge 不额外设限。
启动或首次使用时不再执行范围探测。

### 轨道颜色

轨道写入工具接受向后兼容的 `#RRGGBB` 格式或原生 `AARRGGBB` 值。Bridge
会在调用 SynthV 前把 `#RRGGBB` 转换为不透明的 `ffRRGGBB`，并验证宿主
保留的值。轨道读取保留 SynthV 的原始 `displayColor`；可识别时还会返回
标准化的 `displayColorArgb` 和 `displayColorRgb`。

SynthV 编辑器提供少量预设色板，但公开脚本 API 只把该值定义为十六进制
字符串。因此 Bridge 会验证编码，但不会把调用方限制在未记录的色板常量。

### 宿主能力差异

部分 SynthV 宿主公开 `Note:getPitchAutoMode()`，但没有公开或无法执行
`Note:setPitchAutoMode()`。如果请求值已经与音符一致，Bridge 会安全跳过
Setter。在不兼容宿主上真正修改模式，会在创建撤销记录前返回
`UNSUPPORTED_HOST_CAPABILITY`。

时间轴替换会在被占用位置执行先删除后添加。每个成功的 `set_time_axis`
响应都有 `verified: true`；如果宿主没有保留请求的标记，会返回
`HOST_POSTCONDITION_FAILED`，而不会假报成功。

## 安全编辑工作流

Codex Agent 规则要求按以下顺序执行：

1. 乐句调音时，在编辑前立即调用 `get_phrase_context`。对于 Group Voice
   或 Vocal Mode，调用不带定位器的 `get_group_voice`，以当前钢琴卷帘
   Group 为目标。V2 默认只返回参数、Vocal Mode、目标索引和 `contextId`；
   只有诊断时才请求完整字段。其他工作只读取拥有预期变更的对象。
2. 展示或在内部构建一个小型、便于审核的变更。
3. 复制最新适用的 Group/引用 UUID 和指纹、轨道指纹、自动化/时间轴指纹，
   以及音符或 Smart Pitch 指纹。
4. 调用能完成目标的最小写入工具。Group 内容写入默认拒绝有多个引用的
   Note Group。只有确实要修改全部链接位置时，才使用
   `sharedGroupPolicy=allowAllReferences`，并同时提供刚读取的
   `expectedReferenceCount`。同一次调音会修改同一 Group 的
   Voice/唱法、音符/音素或多条自动化时，优先使用
   `apply_group_tuning`；有界的多对象批处理使用 `apply_transaction`。
   独立步骤在写入前预检；依赖前一步 `$result` 的步骤只能在执行前即时检查。
5. SynthV 返回任何 `STALE_*` 错误时重新读取，不进行猜测。

一次紧凑读取应支持一批完整的相关变更。如果只修改了 Group Voice，不要
通过读取整个选区或整首歌曲来刷新 `contextId`。

音符指纹包含 Group UUID、音符索引、起点、时值、音高、微调、歌词、音素、
语言、音乐类型、音高模式、说唱重音、Retake 数量和音符属性。这可以防止
Agent 把旧计划应用到用户已经修改的音符。

## 请求示例

```text
读取 SynthV 当前选中的音符。先展示修改计划，然后只把最后一个音符延长
半个四分音符。使用最新读取返回的指纹。
```

```text
读取当前 Group 的响度自动化。在选中乐句上添加柔和的 3 dB 渐强，不要
删除乐句范围外的控制点。
```

```text
读取轨道 1，并在选中音符下方创建低小三度和声轨。在列出最终音高并警告
任何超出 MIDI 0–127 的音符前，不要应用修改。
```

```text
读取轨道 1，然后将其克隆为“和声 -3st”，transposeSemitones 设为 -3。
使用最新轨道指纹。如果它包含非主人声 Group，除非我明确同意分离其内容并
人工核对这些 Vocal，否则停止。
```

```text
检查 D:\scores\melody.musicxml，但不要修改 SynthV。列出可选的
part/voice/staff、重叠状态、SHA-256 保护和音符预览。只有在我确认有权使用
该文件后，才导入选定的单旋律声部。
```

更多示例见 [examples/prompts.md](examples/prompts.md)。

## 配置

Node 服务器和 SynthV 脚本必须解析到**同一个物理 IPC 目录**。

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `SYNTHV_AGENT_BRIDGE_DIR` | 操作系统临时目录 | 共享 IPC 目录。 |
| `SYNTHV_AGENT_BRIDGE_TIMEOUT_MS` | `15000` | 最大响应等待时间。 |
| `SYNTHV_AGENT_BRIDGE_POLL_MS` | `10` | Node 响应轮询间隔。 |
| `SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS` | `30000` | 可恢复废弃请求文件和锁的时间阈值，必须大于响应超时。 |
| `SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS` | `5000` | 仍视为已连接的最大心跳年龄。 |

使用自定义 IPC 目录时，请在启动 SynthV 脚本前创建它。Node 进程也会创建
该目录，但文档规定的启动顺序会先启动 SynthV。

### Windows 和 WSL

SynthV 在 Windows 上运行时，最简单的配置是让 MCP 服务器使用
**Windows Node.js**。Codex 在 WSL 中运行时，请把 Node 指向 SynthV 默认
使用的现有 Windows 临时目录：

- SynthV/Windows：不设置 `SYNTHV_AGENT_BRIDGE_DIR`，使脚本使用 `%TEMP%`。
- Node/WSL：设置
  `SYNTHV_AGENT_BRIDGE_DIR=/mnt/c/Users/you/AppData/Local/Temp`。

如果使用专用子目录，请先创建目录，并为两个进程设置等价的 Windows 和
WSL 路径写法。SynthV GUI 必须继承 Windows 环境变量，所以修改后需要重启
SynthV。MCP 服务器可以通过 Codex 配置中的 `env` 表接收自己的值。

## 开发

```bash
npm run typecheck
npm test
npm run check
npm run inspector
```

可以使用以下命令检查 Lua 语法：

```bash
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
```

CI 会在 Node 20 和 22 上运行 TypeScript 测试，使用 Lua 5.4 解析三个生产
Lua 文件，并通过模拟 SynthV 集成框架测试常驻 Bridge 和侧边栏。

运行以下命令可获取本地安装和连接报告：

```bash
npm run doctor -- --target "/Synthesizer V Studio 2/脚本目录"
```

Doctor 会检查源码/安装版本、脚本准确内容、MCP 构建新鲜度、运行中 MCP 的
能力指纹、Bridge 和 MCP 心跳、解析后的 IPC 目录、残留处理/控制文件以及
Codex 配置。添加 `--json` 可获得机器可读输出。它不会修改工程或已安装
文件。

## 当前限制

- 同一时间只能有一个请求进行中。
- 客户端超时具有不确定性：SynthV 可能仍会完成操作。处理标记会保留到
  Lua 宿主执行结束；Agent 应先读取当前工程，再决定是否重试写入。
- 侧边栏同一时间只保存一个待处理预览。该预览可以包含一个写入或一批
  `apply_transaction`。
- 通用事务会拒绝多个冲突修改同一受保护作用域的步骤。后续步骤可以用完整
  字段形式的 `$result` 引用前一步结果。独立步骤在写入前完整预检；依赖
  步骤由于目标尚不存在，只能解析结果后即时预检。会改变索引的轨道/库
  Group 删除必须是唯一步骤。
- `atomicity: "singleUndoRecord"` 表示一个 SynthV 恢复边界，不表示自动
  回滚。独立预检失败不会修改工程；依赖预检或宿主执行失败可能发生在前面
  步骤已经写入之后。
  错误返回 `undoRequired` 时，重新读取或重试前请立即执行一次
  **编辑 → 撤销**。
- 回滚计划保存在当前工程/会话的 Bridge 内存中，Bridge 重载或 SynthV
  关闭后会丢失。回滚本身是新的受保护写入；指纹陈旧时会被拒绝。
- 面板无法自行启动 Codex 回合。**Copy & queue** 会写入本地请求，并把
  交接提示复制到剪贴板，仍需用户粘贴。
- SynthV 公开脚本 API 不提供 Undo 命令。面板会显示最新写入，并提示用户
  先点击主编辑区再按 **Ctrl+Z**；无论焦点在哪里都可使用
  **编辑 → 撤销**。
- SynthV 公开脚本 API 不支持工程保存、音频渲染、按显示名称选择已安装
  歌手数据库、读取 Vocal 身份或 Voice Panel 音阶/模式设置。
  `clone_track_shell` 可以通过宿主克隆继承源轨主 Vocal 上下文，但无法命名它。
- 本地曲谱支持有意限定为有界导入。它只接受绝对本地 `.xml`、`.musicxml`、
  `.mxl`、`.mid` 或 `.midi` 路径，并要求先检查、再确认使用权；URL、
  `.svp`、XML `DOCTYPE`/`ENTITY`、含歧义或复调的声部、已变化的文件哈希，
  以及超过 512 个音符的导入都会被拒绝。源速度会返回供审核，但不会静默
  应用到工程。
- SynthV 2.2.1 会返回 `singers` 和 `spacing`，但公开 `getVoice` 字段列表
  没有记录它们。因此类型化 Unison 表面属于实验性功能；只有宿主在克隆
  引用上返回并保留请求字段时才允许写入。
- Retake API 不会枚举 Take ID，也不公开当前活动 Take ID。因此 Bridge
  只激活和删除默认 Take，或由自身生成并保存的 ID。
- 表情预设是有意保持小型的构建块，不是乐句分析或发音质量评分工具。
- Bridge 尚未在每一个 SynthV 2.x 补丁版本和每一个声库上验证。
- ChatGPT 不能直接连接此本地 stdio 服务器。请使用 Codex 或其他本地 MCP
  宿主；未来的远程适配器需要明确的身份验证和传输安全。

参阅 [docs/roadmap.md](docs/roadmap.md)。

## 安全与隐私

这是一个本地控制 Bridge，不会上传工程数据。但任何已连接的 MCP 宿主都
可以接收工程元数据并请求编辑，因此只应连接可信客户端，并审核破坏性
工具调用。参阅 [SECURITY.md](SECURITY.md)。

## 致谢

本项目的架构受到 Haruki Okada 概念验证项目
[`ocadaruma/mcp-svstudio`](https://github.com/ocadaruma/mcp-svstudio)
启发。该项目证明了本地 MCP 服务器和常驻 SynthV Lua 脚本可以通过文件
通信。本仓库围绕请求关联、验证、陈旧上下文保护、撤销记录、跨平台路径、
测试和更广泛的工具表面重新实现了 Bridge。

Synthesizer V 和 Synthesizer V Studio 是 Dreamtonics 的产品和商标。
本独立项目与 Dreamtonics 没有关联，也未获得其认可。

## 许可证

Apache License 2.0。参阅 [LICENSE](LICENSE)。
