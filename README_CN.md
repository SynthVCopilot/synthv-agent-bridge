# SynthV Agent Bridge

[English](README.md) | [简体中文](README_CN.md)

这是一个本地 [Model Context Protocol（MCP）](https://modelcontextprotocol.io/)
服务器，让 Codex、Claude Code 等 AI 客户端读取和编辑当前在
**Synthesizer V Studio 2 Pro** 中打开的工程。

- 只通过 SynthV 公开的 Lua 脚本 API 工作，从不解析或改写 `.svp` 文件。
- 完全本地运行：不开网络端口，也不调用任何 AI API。
- 出错即停：每次写入都会先核对最新的工程状态，只产生一条 SynthV 撤销记录，
  写完再读回校验。

**视频演示：** [在哔哩哔哩观看](https://www.bilibili.com/video/BV1kU3P6LEoF)

## 状态

**v0.3.2 · 协议 v3。** 已在 Synthesizer V Studio 2 Pro 2.2.1 和 2.3.0 上测试。
全部 17 个读取动作和 9 个界面动作已在真机上验证；39 个写入动作中有 31 个
已验证，其余 8 个中：

- 7 个已禁用，见[当前限制](#当前限制)；
- `copy_group_voice` 可以使用，但还在等待它自己的真机验收。

请在已保存的工程副本上测试写入。

## 功能

| 领域 | 能力 |
|---|---|
| 工程读取 | 轨道、音符组、音符、选区、速度与拍号、计算音素与音高、自动化、混音器和编辑器状态。 |
| 音符与歌词 | 添加、编辑、删除、移调和人性化音符；匹配歌词；设置语言、演唱/说唱类型、微调音高和音符属性。 |
| 歌声与音素 | 音符组的歌声参数与唱法（Vocal Mode）、在音符组之间复制已存储的歌声设置、音素序列、音素集（X-SAMPA）覆盖、音节时值和单个音素的强度。 |
| 音高与表情 | Smart Pitch 控制点、AI 重唱，以及滑入、滑出、颤音、渐强和气声预设。 |
| 自动化 | 读取、添加、采样、简化和清除参数曲线（包括唱法曲线）；在 SynthV 2.3.0+ 上设置曲线插值方式。 |
| 轨道与音符组 | 创建、修改和删除轨道、库音符组和关联引用；在 SynthV 2.3.0+ 上设置音符组的调式。 |
| 乐谱导入 | 预览本地 MusicXML 或 MIDI 文件，并导入一条你有权使用的单声部旋律。 |
| 编辑器与播放 | 选区、视图、网格吸附、坐标和时间换算、剪贴板、对话框和播放控制。 |

## 工作原理

```text
MCP 宿主（Codex、Claude Code 等）
        │  stdio 上的 MCP
        ▼
TypeScript MCP 服务器 ── node dist/src/cli.js
        │  共享本地目录中的 JSON 请求/响应文件
        ▼
SynthVAgentBridge.lua ── 在 SynthV 内常驻运行的脚本
        │  SynthV 脚本 API
        ▼
Synthesizer V Studio 2 Pro 中打开的工程
```

Agent 决定改什么；MCP 服务器负责校验和转发请求；Lua 脚本读取实时状态、
核对守卫、在一条撤销记录内写入，并校验 SynthV 实际保存的结果；最后由你来
试听和确认。详见[职责边界](docs/responsibility-boundaries_cn.md)和
[架构说明](docs/architecture.md)。

## 环境要求

- Synthesizer V Studio **2 Pro 2.1.2 或更高版本**（Basic 版没有脚本功能）。
- Node.js **20.10 或更高版本**。
- 支持启动本地 stdio 服务器的 MCP 宿主。

## 快速开始

每一步的详细说明见[快速开始](docs/quickstart_cn.md)（[English](docs/quickstart.md)）。

1. **构建服务器。**

   ```bash
   git clone https://github.com/SynthVCopilot/synthv-agent-bridge.git
   cd synthv-agent-bridge
   npm install
   npm run build
   ```

2. **安装 SynthV 脚本。** 在 SynthV 中选择 **脚本 → 打开脚本文件夹**，把这个
   文件夹传给安装器：

   ```bash
   npm run install:synthv -- --target "/path/to/Synthesizer V Studio 2/scripts"
   ```

   安装器会在其中创建 `SynthV Agent Bridge` 子文件夹。加上
   `--without-sidebar` 可以跳过可选的状态侧栏。

3. **启动 Bridge。** 在 SynthV 中选择 **脚本 → SynthV Agent Bridge →
   Start SynthV Agent Bridge**，它会一直在后台运行。

4. **连接 MCP 宿主。** 本仓库自带 [Codex](docs/hosts/codex.md)
   （`.codex/config.toml`）和 [Claude Code](docs/hosts/claude-code.md)
   （`.mcp.json`）的项目配置；其他 stdio 宿主运行 `node dist/src/cli.js` 即可。

5. **检查连接。** 让 Agent 调用 `sv_status`，正常时会返回
   `"connected": true` 和 `"fresh": true`。也可以在本地运行：

   ```bash
   npm run doctor -- --target "/path/to/Synthesizer V Studio 2/scripts"
   ```

《小星星》引导式演示和 Agent 的工作规则在独立的
[`synthv-copilot` 技能插件](https://github.com/SynthVCopilot/SKILLS)里。

### 更新

检查有没有新版本：

```bash
npm run doctor -- --check-updates
```

不加这个参数时，Doctor 完全离线运行。

一条命令更新：

```bash
npm run update
```

它会快进拉取代码、重新安装依赖、重新构建，并把 SynthV 脚本重新装到上次安装的
位置。如果工作区有未提交的修改，它会直接停止，不做任何改动。更新完成后：

1. 如果提示 Bridge 运行时有变化，在 SynthV 中选择 **脚本 → 重新扫描**，再重新
   启动 Bridge（重新扫描会停止正在运行的 Bridge）。
2. 重新连接 MCP 宿主，让它加载新的构建。

想在 GitHub 上收到新版本通知，可以在仓库页面选择 **Watch → Custom → Releases**。

## 歌手与唱法

SynthV 的脚本 API 读不出音符组用的是哪个歌手，也列不出从未调整过的唱法
（Vocal Mode）。在 Agent 编辑唱法之前：

1. 在 SynthV 中选中这个音符组，并为它选好歌手。
2. 把唱法面板上显示的全部唱法名称原样告诉 Agent，或者附上完整唱法面板的截图。

```text
当前歌手的唱法：Airy, Bright, Cool, Dark, Emotional, Power, Solid, Sweet。
```

换了歌手以后需要再提供一次。不涉及唱法的编辑不需要这一步。

## 使用方式

服务器只暴露 6 个 MCP 工具，65 个具体的 SynthV 动作都藏在它们后面；Agent
需要时才用 `sv_describe` 获取某个动作的参数结构。

| 工具 | 用途 |
|---|---|
| `sv_status` | 连接、会话、宿主版本和构建一致性检查。 |
| `sv_describe` | 列出动作，或返回某个动作的参数结构。 |
| `sv_query` | 读取工程状态；`writeIntent` 读取会返回供写入使用的 `contextId`。 |
| `sv_command` | 带守卫、单条撤销记录和结果校验的编辑、删除与导入。 |
| `sv_ui` | 选区、视图、剪贴板、对话框、吸附、坐标和播放。 |
| `sv_review` | 可选侧栏的状态。 |

每次写入都遵循同样的流程：

1. 用 `sv_query` 加 `contextMode: "writeIntent"` 读取目标。
2. 带上返回的 `contextId`，发送一次 `sv_command`。
3. 如果结果是 `STALE_*` 或 `SYNTHV_SESSION_CHANGED`，重新读取，不要猜。

索引从 1 开始，音符位置是音符组内的 blick，播放时间以秒为单位。全部动作，
以及 Context、守卫令牌、分页和紧凑响应的说明，见[动作参考](docs/actions_cn.md)。

## 请求示例

```text
读取选中的音符，先展示计划修改的内容，然后只把最后一个音符延长半拍。
```

```text
读取当前音符组的响度曲线，在选中的乐句上加一个平缓的 3 dB 渐强，不要动乐句以外的点。
```

```text
把当前音符组的调式设为 D Dorian。
```

```text
在不修改 SynthV 的前提下预览 D:\scores\melody.musicxml，列出声部、重叠情况和音符预览；
等我确认有使用权后，再导入其中一条旋律。
```

更多示例见 [examples/prompts.md](examples/prompts.md)。

## 配置

MCP 服务器和 SynthV 脚本必须使用**同一个 IPC 目录**。

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `SYNTHV_AGENT_BRIDGE_DIR` | 系统临时目录 | 共享 IPC 目录；请在启动 SynthV 脚本前创建好。 |
| `SYNTHV_AGENT_BRIDGE_TIMEOUT_MS` | `30000` | 等待响应的最长时间。 |
| `SYNTHV_AGENT_BRIDGE_POLL_MS` | `10` | 轮询响应的间隔。 |
| `SYNTHV_AGENT_BRIDGE_LOCK_WAIT_MS` | `1000` | 等待单写入锁的时间，超时后返回 `BRIDGE_BUSY`。 |
| `SYNTHV_AGENT_BRIDGE_STALE_REQUEST_MS` | `60000` | 超过这个时长的遗留请求和锁会被回收，必须大于超时时间。 |
| `SYNTHV_AGENT_BRIDGE_STATUS_STALE_MS` | `5000` | 心跳在多长时间内视为已连接。 |

**Windows 搭配 WSL：** 最简单的做法是用 Windows 版 Node.js 运行 MCP 服务器。
如果服务器跑在 WSL 里，SynthV 一侧不要设置这个变量（它会使用 `%TEMP%`），
服务器一侧设置 `SYNTHV_AGENT_BRIDGE_DIR=/mnt/c/Users/<你的用户名>/AppData/Local/Temp`。

## 当前限制

- **为稳定性禁用：** 下面这 7 个动作曾导致 SynthV 2.2.1 崩溃，会在到达 SynthV
  之前被拒绝：
  - 隔离式音符组克隆和音符组克隆；
  - 轨道克隆、轨道外壳克隆，以及和声轨；
  - 事务的应用和回滚。

  关联式音符组引用克隆可以正常使用。
- **脚本 API 不支持：** 保存工程、渲染音频、读取或选择歌手，以及列出未调整过
  的唱法。
- **SynthV 2.3.0：**
  - 不能再往轨道的主音符组里添加音符，Bridge 默认会把新音符放进单独的音符组；
  - 轨道效果器参数只读；
  - 详见 [2.3.0 运行时说明](docs/sv2-api-coverage-v3.md#synthv-230-runtime-delta)。
- **一次只处理一个请求：** 第二个客户端会短暂等待，然后收到 `BRIDGE_BUSY`。
- **超时不代表失败：** 超时的写入可能已经在 SynthV 中完成，Agent 会先重新读取
  再决定是否重试。
- **部分写入后的恢复：** 失败结果报告 `undoRequired: true` 时，先在 SynthV 中
  执行一次 **编辑 → 撤销**，再做别的操作。
- **乐谱导入有上限：** 每次最多从本地文件的一条单声部旋律导入 512 个音符；
  源文件的速度只会报告，不会自动应用。

完整的 SynthV API 覆盖情况见 [API 覆盖矩阵](docs/sv2-api-coverage-v3.md)，
后续计划见[路线图](docs/roadmap.md)。

## 开发

```bash
npm run check          # 类型检查、构建并运行全部测试
npm run doctor         # 检查本地 Runtime、Bridge 和 MCP 状态
npm run inspector      # 打开 MCP Inspector
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
```

CI 会在 Node 20 和 22 上运行 TypeScript 测试，用 Lua 5.4 解析 Lua 脚本，并在
模拟的 SynthV 宿主上运行 Bridge 和侧栏。另见 [CONTRIBUTING.md](CONTRIBUTING.md)
和 [AGENTS.md](AGENTS.md)。

## 文档

| 主题 | 文档 |
|---|---|
| 安装配置 | [快速开始](docs/quickstart_cn.md) · [Quickstart](docs/quickstart.md) · [Codex](docs/hosts/codex.md) · [Claude Code](docs/hosts/claude-code.md) |
| 使用 | [动作参考](docs/actions_cn.md) · [错误码](docs/errors-v3.md) · [请求示例](examples/prompts.md) |
| 设计 | [架构](docs/architecture.md) · [v3 架构](docs/architecture-v3.md) · [协议](docs/protocol.md) · [职责边界](docs/responsibility-boundaries_cn.md) · [架构决策记录](docs/adr/README.md) |
| 侧栏 | [原生连接面板](docs/sidebar.md) |
| 覆盖与进度 | [SynthV API 覆盖](docs/sv2-api-coverage-v3.md) · [路线图](docs/roadmap.md) · [更新日志](CHANGELOG.md) |

## 安全与隐私

Bridge 不会上传任何数据。但你连接的任何 MCP 宿主都能读取工程并发起修改，
所以只连接你信任的客户端，并留意具有破坏性的修改。详见 [SECURITY.md](SECURITY.md)。

## 致谢

本项目的设计受到 Haruki Okada 的概念验证项目
[`ocadaruma/mcp-svstudio`](https://github.com/ocadaruma/mcp-svstudio) 启发，它证明了
MCP 服务器可以和常驻的 SynthV Lua 脚本通过文件通信。

Synthesizer V 和 Synthesizer V Studio 是 Dreamtonics 的产品和商标。本项目是独立
项目，与 Dreamtonics 没有关联，也未获其认可。

## 许可证

Apache License 2.0，详见 [LICENSE](LICENSE)。
