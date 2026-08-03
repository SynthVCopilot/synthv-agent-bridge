# 中文快速开始

本指南只安装宿主中立的 SynthV Agent Bridge Runtime，不安装 Agent 提示词，
也不修改 Codex 或 Claude 的用户全局配置。

## 1. 要求

- Synthesizer V Studio 2 Pro 2.1.2 或更高版本
- Node.js 20.10 或更高版本
- MCP 服务可运行在 Windows、macOS 或 Linux；SynthV 与 Lua 脚本必须能访问
  同一个文件 IPC 目录
- 支持本地 stdio 服务的 MCP 宿主

检查 Node 与 npm：

```powershell
node --version
npm --version
```

## 2. 拉取与构建

可把仓库放在任意有权限的非系统盘或工作目录：

```powershell
git clone https://github.com/SynthVCopilot/synthv-agent-bridge.git D:\synthv-agent-bridge
Set-Location D:\synthv-agent-bridge
npm install
npm run build
```

`npm install` 会把 JavaScript 依赖写入仓库自己的 `node_modules`。MCP 服务入口为
`dist/src/cli.js`。

## 3. 安装 SynthV 脚本

在 SynthV 中选择 **脚本 → 打开脚本文件夹**，把这个准确目录传给：

```powershell
npm run install:synthv -- --target "C:\SynthV脚本目录"
```

若不需要可选连接侧边栏，只装核心脚本：

```powershell
npm run install:synthv -- --target "C:\SynthV脚本目录" --without-sidebar
```

安装器会在所选脚本目录下创建 `SynthV Agent Bridge`，复制常驻 Bridge、Stop
命令与可选 Sidebar；它不会修改 SynthV 工程。

在 SynthV 中执行 **脚本 → 重新扫描**，再运行：

```text
脚本 → SynthV Agent Bridge → Start SynthV Agent Bridge
```

常驻脚本需保持运行。只停止 Bridge 时使用 **Stop SynthV Agent Bridge**；若还要
保留可选 Sidebar，不要使用 **中止所有正在运行的脚本**。

## 4. 选择 MCP 宿主配置

两个正式配置启动的是同一份 Runtime。

### Codex

仓库已提供 `.codex/config.toml`。在 Codex 中打开并信任仓库根目录，构建后新建
任务，让 MCP 进程加载当前编译版本。

详见 [Codex 宿主配置](hosts/codex.md)。

### Claude Code

仓库已提供 `.mcp.json`。把仓库根目录作为 Claude Code 项目打开，并在提示时
批准项目 MCP 服务。

详见 [Claude Code 宿主配置](hosts/claude-code.md)。

### 其它 stdio 宿主

把工作目录设为仓库根目录并注册：

```text
node dist/src/cli.js
```

服务通过 stdin 接收 JSON-RPC；直接在普通交互终端启动不会出现命令提示符。

## 5. 诊断

默认 Doctor 只检查宿主中立 Runtime：

```powershell
npm run doctor -- --target "C:\SynthV脚本目录"
```

需要时再检查项目级宿主配置，不读取全局设置：

```powershell
npm run doctor -- --host codex
npm run doctor -- --host claude
npm run doctor -- --host all --json
```

Doctor 检查编译产物新鲜度、组件版本/构建身份、文件 IPC 可访问性、当前
Bridge/MCP 心跳以及可选的已安装脚本内容；宿主参数只增加仓库项目配置检查。
整个过程只读。

若 MCP 宿主已经运行，而编译身份随后发生变化，请新建 Agent 任务或重新连接
MCP，让它载入当前构建。

## 6. 通过 MCP 验证

Bridge 与 MCP 服务都运行后：

1. 调用 `sv_status`，确认协议为 v3、Session 当前有效、组件身份一致。
2. 调用 `sv_describe`，查看六个公开工具背后的内部动作。
3. 在任何写入前，先用 `sv_query` 做只读工程摘要。

公开 MCP 能力面固定为六个工具：

- `sv_status`
- `sv_describe`
- `sv_query`
- `sv_command`
- `sv_ui`
- `sv_review`

## 7. 可选 Agent 技能

安全写入、调声、作曲编曲和作词指导从
[`SynthVCopilot/SKILLS`](https://github.com/SynthVCopilot/SKILLS) 单独安装
`synthv-copilot`。可选《小星星》Demo 也作为 Agent 拥有的参考资料存放在那里。
安装技能不会安装或启动本 Runtime。

## 更新

在干净工作区中：

```powershell
git pull --ff-only
npm install
npm run build
npm run install:synthv -- --target "C:\SynthV脚本目录"
```

按安装器提示重新扫描/启动 Bridge，再重新连接 MCP 宿主。编辑真实工程前重新
运行 Doctor。
