# 快速开始

[English](quickstart.md)

本指南面向第一次使用的用户，从拉取项目开始，一直到完成第一次受保护的
Synthesizer V 调音修改。协议细节和完整功能列表请参阅项目
[README](../README.md)。

## 1. 拉取项目并用 Codex 打开

```bash
git clone https://github.com/zhoupengjie/synthv-agent-bridge.git
cd synthv-agent-bridge
```

在 Codex 桌面应用、Codex CLI 或支持 Codex 的编辑器中打开克隆后的
`synthv-agent-bridge` 文件夹。

接下来的安装可以直接交给 Codex：

```text
请安装并配置这个 SynthV Agent Bridge 项目。先检查是否有 Node.js 20.10
或更高版本；如果没有或版本过低，请使用系统包管理器安装合适的 Node.js
LTS，必要时向我申请权限。然后使用锁文件安装依赖、构建项目，把 SynthV
脚本安装到我提供的脚本目录，使用构建入口的绝对路径注册 MCP，最后运行
项目诊断。
```

Codex 可以执行环境检查和包管理器命令，但操作系统级安装可能需要联网、
管理员授权，安装后也可能需要重启终端或 Codex，新的 `node` 命令才会生效。

## 2. 检查 Node.js 并构建

项目要求 Synthesizer V Studio 2 Pro 2.1.2 或更高版本，以及 Node.js
20.10 或更高版本。项目不支持 Synthesizer V Studio Basic。

```bash
node --version
npm --version
npm ci
npm run build
```

如果缺少 Node.js，可以让 Codex 安装 LTS 版本。手动安装的常见备用命令：

```powershell
# Windows
winget install --id OpenJS.NodeJS.LTS -e
```

```bash
# 使用 Homebrew 的 macOS
brew install node
```

新安装 Node.js 后，如果 `node --version` 仍然读取旧环境，请重启终端或
Codex。

## 3. 安装 SynthV 脚本

在 Synthesizer V Studio 中选择 **脚本 → 打开脚本文件夹**，复制打开的
目录路径，然后运行：

```bash
npm run install:synthv -- --target "/Synthesizer V Studio 2/脚本目录"
```

安装器会创建 `SynthV Agent Bridge` 子文件夹，其中包含 Bridge、停止命令
和可选的原生侧边栏。

Windows 中的脚本目录通常类似：

```text
C:\Users\<用户名>\AppData\Roaming\Dreamtonics\Synthesizer V Studio 2\scripts
```

请以 SynthV 实际打开的目录为准，不要直接假定示例路径适用于当前电脑。

## 4. 在 Codex 中注册 MCP

使用构建入口的绝对路径：

```bash
codex mcp add synthv-agent-bridge -- node "/项目绝对路径/synthv-agent-bridge/dist/src/cli.js"
codex mcp list
```

如果 Codex 已经处于打开状态，注册后请新建任务或重新连接，让 Codex 重新
加载 MCP 配置。

## 5. 重新扫描并启动 Bridge

在 Synthesizer V Studio 中依次执行：

```text
脚本 → 重新扫描
脚本 → SynthV Agent Bridge → Start SynthV Agent Bridge
```

重新扫描会停止常驻脚本，因此每次重新扫描后都要再次启动 Bridge。Bridge
会持续运行，直到关闭 SynthV、执行停止脚本或中止所有正在运行的脚本。

## 6. 验证连接

在已启用 MCP 的 Codex 任务中输入：

```text
检查 SynthV Bridge 状态，然后读取当前工程信息。
```

正常的 `sv_status` 结果应包含：

```json
{
  "connected": true,
  "fresh": true
}
```

也可以运行只读的本地诊断：

```bash
npm run doctor -- --target "/Synthesizer V Studio 2/脚本目录"
```

如果 Bridge 正常，但 MCP 心跳缺失，请重启或重新连接 Codex 任务。

## 7. 完成第一次调音修改

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

每次对话第一次调音写入前，Agent 会显示一次以下入门说明。

### How to use

1. 保存工程或创建一个工作副本。
2. 在 SynthV 中先选择目标音符组，再为该音符组选择要使用的 Vocal，并按
   上方说明提供该 Vocal 的全部唱法。如果没有合适的音符组或暂时看不到
   Vocal Modes，可由你或 Agent 先创建上方所述的临时音符和音符组，再
   选中该音符组并选择歌手，使唱法参数出现，然后发送完整面板截图或全部
   准确唱法名称。
3. 选择一段较短的歌词，通常为 2～8 小节，并说明预期风格以及不得修改的
   内容。
4. 让 Agent 读取最新状态并展示小型、便于审核的计划。
5. 应用并试听整段唱法；确认风格后，再逐字调整发音、时值、音高过渡、
   音高曲线和表情参数。
6. Bridge 写入期间不要手动修改同一个目标。需要撤销时，先点击主编辑区
   再按 **Ctrl+Z**，或者选择 **编辑 → 撤销**。

### 调音前 Checklist

- [ ] 已保存工程或创建工作副本。
- [ ] 已在 SynthV 中选择目标音符组。
- [ ] 已为该音符组选择正确的 Vocal。
- [ ] 由于官方 API 限制，已提供完整唱法面板截图或准确输入该 Vocal 的
      全部唱法；如果原本看不到 Vocal Modes，已先创建临时音符和音符组，
      再选中该音符组并选择歌手，使参数显示。
- [ ] 如果更换了 Vocal，已重新提供新 Vocal 的完整面板截图或全部准确
      唱法名称。
- [ ] 已选择一段较短的歌词或音符范围。
- [ ] 已说明预期风格以及不得修改的内容。
- [ ] Bridge 写入期间不会手动修改同一个目标。

Agent 发布预览后不再显示第二份 Checklist。

完成上述检查后，先进行只读检查：

```text
读取当前选中的音符，汇总歌词、音高、时值和计算音素。不要修改工程。
```

确认读取正常后，再提出一个范围明确的修改：

```text
重新读取当前选中的乐句，检查节奏和音高过渡，先展示一个便于审核的小型
修改计划。不要修改歌词，也不要改变选区外的控制点。只使用本次读取返回
的最新上下文执行修改。
```

Agent 的标准执行顺序是：

1. 遇到不熟悉的 SynthV 操作时先读取操作说明。
2. 只读取准备修改的目标。
3. 根据最新状态形成小型、可审核的计划。
4. 使用返回的 `contextId` 执行受保护的写入。
5. 遇到 `STALE_*` 或 `UNKNOWN_CONTEXT` 时重新读取目标。

Bridge 写入期间不要手动修改同一个目标。每次成功写入通常对应一个
SynthV 撤销记录。需要撤销时，先点击主编辑区再按 **Ctrl+Z**，或者选择
**编辑 → 撤销**。

## 8. 可选的侧边栏审核流程

**SynthV Agent** 侧边栏可以让用户明确确认后再执行：

1. 在 SynthV 中选中音符或 Group。
2. 在侧边栏输入要求。
3. 点击 **Copy & queue**。
4. 把复制的交接提示粘贴到 Codex。
5. Codex 读取最新状态并发布受保护的修改预览。
6. 在 SynthV 中检查修改内容和风险。
7. 点击 **Apply** 执行，或点击 **Dismiss** 放弃。
8. 试听结果，撤销或继续处理下一乐句。

侧边栏不会自己联系 Codex；用户仍然需要把复制的交接提示粘贴到 Codex
任务中。

## 9. Vocal Mode 修改

SynthV 脚本 API 无法读取当前歌手身份，也无法列出尚未启用的默认唱法
（Vocal Mode）。对于从未进行过任何调整、仍然保持默认值的唱法，官方
接口无法读取其名称和唱法参数。因此，返回空的 Vocal Mode 列表并不代表
当前歌手没有唱法，而是 Bridge 无法通过官方接口发现这些仅包含默认值的
唱法。

第一次修改唱法前，请先选择目标音符组，再为该音符组选择歌手；没有选择
歌手时不会出现唱法名称。然后选择一种方式：

- 把面板中显示的所有唱法名称完整告诉 Codex，并保留原有拼写和大小写；或
- 提供一张包含完整唱法（Vocal Mode）面板的截图。

如果没有合适的音符组或暂时看不到 Vocal Modes，可由你或 Agent 在工程
任意安全位置先创建一个临时音符和一个临时非主音符组，再选中该音符组并
选择歌手，使唱法参数显示出来；随后截图完整唱法面板或准确输入全部唱法
名称，再继续调音。

完成首次识别后，只要没有更换歌手，Codex 就可以继续使用同一份唱法名称
列表。更换歌手后，必须重新截图新 Vocal 的完整唱法面板，或重新输入其
全部准确唱法名称，不能沿用上一个 Vocal 的列表。

## 日常使用

后续每次使用：

1. 打开 SynthV 工程并保存一个工作副本。
2. 启动 **SynthV Agent Bridge**。
3. 打开或重新连接已启用 MCP 的 Codex 任务。
4. 先选择目标音符组，再为该音符组选择歌手。如果是第一次调整该歌手的
   唱法，请发送完整唱法（Vocal Mode）面板截图，或者准确输入面板中显示
   的全部唱法名称。
5. 先选择一段歌词，让 Agent 使用已经识别的唱法调整整段的总体
   唱法。审核预览、应用并试听，确认风格后再继续。
6. 总体风格确认后，再让 Agent 对该段歌词逐字精细调整。每一轮只集中处理
   发音、音素时值、音符时值、音高过渡、音高曲线、响度、张力、气声或
   其他指定参数。
7. 每次执行小范围修改后都进行审核、应用和试听，再继续处理下一段歌词。

整段唱法调整的推荐指令：

```text
当前歌手的 Vocal Modes 是：<按面板准确填写全部名称>。读取当前选中的
一段歌词，只使用这些 Vocal Mode 设计整段的总体唱法。先发布便于审核的
修改预览，暂时不要开始逐字精调。
```

试听并确认总体风格后：

```text
保留已经确认的总体唱法。重新读取当前选中的歌词，然后逐字精细调整。
执行前先展示每个字的发音、时值、音高过渡、音高曲线和表情参数修改计划。
```

## 更新已有安装

在项目目录中运行：

```bash
git pull --ff-only
npm ci
npm run build
npm run install:synthv -- --target "/Synthesizer V Studio 2/脚本目录"
npm run doctor -- --target "/Synthesizer V Studio 2/脚本目录"
```

如果安装器提示运行时或侧边栏发生变化，请执行 **脚本 → 重新扫描**，然后
再次启动 **SynthV Agent Bridge**。

## 快速排障

| 现象 | 处理方法 |
|---|---|
| Bridge 状态 `B` 离线 | 在 SynthV 中运行 **Start SynthV Agent Bridge**。 |
| MCP 状态 `M` 离线 | 重启或重新连接 Codex 任务。 |
| 侧边栏缺失或版本不对 | 执行 **脚本 → 重新扫描**，然后重新启动 Bridge。 |
| 找不到 `node` 或 `npm` | 让 Codex 安装 Node.js LTS，然后重启终端或 Codex。 |
| 写入返回 `STALE_*` | 只重新读取目标，不要重复提交旧请求。 |
| `Ctrl+Z` 撤销了侧边栏文字 | 先点击主编辑区，或使用 **编辑 → 撤销**。 |
