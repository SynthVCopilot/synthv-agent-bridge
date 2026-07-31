# SynthV Agent Bridge 当前分支综合交接报告

> - 面向：在另一台 PC 上接手开发、自动化测试和 Synthesizer V 真机验证的 Agent
> - 快照日期：2026-07-31（Europe/Berlin）
> - 快照分支：`codex/v3-implementation`
> - 快照提交：`7383b1cf66a23a275343367b1862e2bbb58342ff`
> - 产品版本：`0.2.0-alpha.1`；文件 IPC 协议：`v3`

本文是一份一次性的“当前状态快照”，用于跨机器交接。代码或分支继续变化后，先重新运行第 12 节的状态和验证命令，再更新文中的提交、测试结果和风险判断。

## 1. 一句话项目简介

SynthV Agent Bridge 是一个本地、默认无网络的 TypeScript MCP stdio 服务。它让 Codex 等 MCP 客户端通过版本化 JSON 文件 IPC，把经过结构校验、并发保护、完整预检和结果回读的命令交给 Synthesizer V Studio 2 Pro 内常驻的 Lua 执行器，再由执行器调用 SynthV 官方脚本 API 读取或修改当前工程；它不解析或重写 `.svp` 文件，也不自行调用 AI API或开放网络端口。[项目说明](../README_CN.md) [v3 架构](architecture-v3.md)

项目要解决的核心问题不是“让模型直接操纵对象”，而是为 Agent 与 SynthV 之间建立一条可审计、可拒绝陈旧请求、对共享 Group 所有权敏感、每个逻辑写入最多一个 Undo 恢复边界、并能回读验证实际效果的确定性执行通道。[责任边界](responsibility-boundaries_cn.md) [命令状态机](command-state-machine-v3.md)

## 2. 当前结论（接手前必读）

当前分支不是早期骨架，而是 **v3 主体迁移已完成、正在做 Alpha 发布验证**：

- v3 的 6 个公共 MCP 工具、协议 v3、类型化 Context、紧凑 Query 投影、统一 Command Dispatcher/Policy/Kernel、组件构建一致性门禁、脱敏 Trace、后置条件验证已经落地。[v3 架构](architecture-v3.md)
- 开发计划 Phase 0–8 已完成；Phase 9（最终 Alpha 发布门禁和未来稳定版决策）仍为 active。[v3 开发计划](v3-development-plan.md)
- 所有 38 个实时语义写 Action 已有机器检查的 `V3CommandPolicy`，旧 v2 公共/内部命令路径已经移除；v1/v2 文件协议应以 `PROTOCOL_MISMATCH` 拒绝。[v3 开发计划](v3-development-plan.md) [命令策略源码](../src/v3-command-policy.ts)
- 自动化测试和 Fake Host 覆盖较强，但真机覆盖仍有大量 `sampled`/`pending` 项，不能把“代码已实现”写成“稳定版已验证”。[测试矩阵](v3-test-matrix.md) [SV2 API 覆盖矩阵](sv2-api-coverage-v3.md)
- 一次真机依赖事务曾触发 SynthV 原生 `0xc0000005` APPCRASH；之后安装 crash breadcrumb 后未复现，但事务仍只能标记 sampled/experimental。这是稳定 `0.2.0` 的主要阻塞项之一。[v3 开发计划](v3-development-plan.md) [发布验证设计](superpowers/specs/2026-07-31-v3-release-validation-design.md)
- 当前最重要的工作是执行四阶段发布验证，而不是继续扩大功能范围。[发布验证设计](superpowers/specs/2026-07-31-v3-release-validation-design.md)

## 3. 当前 Git/分支状态

本节记录的是写入本报告前的只读快照；本报告本身会新增一个未提交文件。

| 项目 | 当前值 |
|---|---|
| 当前分支 | `codex/v3-implementation` |
| HEAD | `7383b1c` — `docs: define v3 release validation gates` |
| 上游 | `origin/codex/v3-implementation` |
| 与上游关系 | 本地领先 1 个提交；远端分支停在 `429ac15` |
| `main` | `612afb2` |
| 相对 `main` | 领先 28 个提交 |
| 分支总改动 | 85 个文件，约 `+19,365/-2,552` |
| 远端 | `https://github.com/SynthVCopilot/synthv-agent-bridge.git` |
| Git tag | 当前没有 tag |
| 写报告前工作树 | 干净 |

特别注意：只在另一台 PC 执行 `git fetch`/`git checkout`，目前拿不到本地的 `7383b1c` 和本报告。交接前必须选择一种方式：

1. 在本机审核、提交本报告并把当前分支 push 到远端；或
2. 把包含 `.git` 的完整仓库/`git bundle`/补丁安全传到另一台 PC。

不要误把 `origin/codex/v3-implementation` 当前的 `429ac15` 当作本机完整 HEAD。

## 4. 项目目标、边界与非目标

### 4.1 要达到的目的

- 把自然语言 Agent 的艺术意图转换为显式、可审核的目标和数值后，安全地应用到 SynthV 当前工程。
- 用新鲜读取、类型化 `contextId`、Guard Token、指纹和引用计数避免覆盖用户刚做的修改。
- 对普通写入先完成全部预检，再打开一个 SynthV Undo 记录；写后回读真实宿主状态，避免“无异常即成功”。
- 把共享的 Note Group 内容与引用本地字段区分开，默认拒绝会意外影响多个引用的内容写入。
- 让正常模型响应保持紧凑，同时保留脱敏的 trace、阶段、耗时和构建信息用于定位故障。
- 保持 Node/Lua/Sidebar 为一个可验证、可回滚的原子构建集合。[原子升级设计](atomic-upgrade-v3.md)

### 4.2 明确非目标

- 不建立第二个工程数据库，不做事件溯源或 MVCC。
- 不解析、修改或监视 `.svp` 文件来绕过官方 API。
- 不把情感、风格、Singer 身份、强调哪些音符等音乐判断下沉到 TypeScript 或 Lua。
- 不宣称事务会自动回滚；`singleUndoRecord` 只表示一次 SynthV Undo 恢复边界。
- 不在现阶段因“看起来更快”而启用可陈旧的工程 Snapshot 缓存；当前每次项目 Query 都到 SynthV。
- 不在第一版稳定决策中承诺插件/ARA 模式、保存工程或渲染/导出音频。[v3 架构](architecture-v3.md) [发布验证设计](superpowers/specs/2026-07-31-v3-release-validation-design.md)

## 5. 总体架构与数据流

```text
Codex / 其他本地 MCP 客户端
        │ stdio：6 个公共 v3 工具
        ▼
TypeScript MCP Server
  ├─ Intent Facade / v3 Surface
  ├─ Query Projector + Context/Guard Store
  ├─ Command Policy + Dispatcher + Kernel
  ├─ Session / Build Coherence / Trace
  └─ Serial File IPC Client
        │ 协议 v3：本地 JSON 文件、单写者、请求关联
        ▼
SynthVAgentBridge.lua（SynthV 内常驻）
  ├─ 新鲜读取、Guard/共享所有权检查
  ├─ 完整预检和确定性批量展开
  ├─ 一个 Undo 边界
  ├─ 官方 API 写入
  └─ 宿主回读与后置条件验证
        ▼
Synthesizer V Studio 2 Pro 当前工程（唯一实时权威）

可选旁路：SynthVAgentSidebar.lua
  用户队列/预览 → MCP 协调器 → Apply/Dismiss/Cancel
```

### 5.1 TypeScript 层

- `src/server.ts`：定义详细内部 Action 的 Zod schema 和 Node-local 曲谱检查/导入入口。
- `src/v3-facade.ts`：收集内部定义，注册公共 v3 Facade，进行构建一致性、会话和命令路由协调。
- `src/v3-surface.ts`：6 工具表面、`sv_describe` 目录、Context 扩展、作用域冲突检查、最小结果投影。
- `src/v3-query-projector.ts`：17 个 Query 的默认边界、字段投影、Dense notes、私有字段剥离和响应预算。
- `src/v3-command-policy.ts`：38 个写 Action 的聚合边界、Guard、预检、后置条件和 no-op 语义目录。
- `src/v3-command-dispatcher.ts` / `src/v3-command-kernel.ts`：统一命令生命周期、`changed/alreadySatisfied/failed` 结果、Trace/脱敏/预算和失效处理。
- `src/v3-context-store.ts` / `src/guard-token-store.ts`：有界内存中的类型化 Context 与私有 Guard 数据。
- `src/ipc/file-ipc-client.ts`：原子写请求、锁、串行执行、心跳、超时、陈旧文件恢复、响应关联和构建 ID 校验。
- `src/score-import.ts` / `src/local-actions.ts`：Node 侧有界解析显式绝对路径的 MusicXML/MXL/MIDI；不处理 `.svp`。

### 5.2 Lua 层

- `synthv/SynthVAgentBridge.lua`：真实 SynthV 对象解析、动态能力/范围检查、Guard、Undo、写入、回读、事务、克隆和 crash breadcrumb。
- `synthv/StopSynthVAgentBridge.lua`：停止常驻 Bridge。
- `synthv/SynthVAgentSidebar.lua`：可选原生侧边栏和用户审核流程；核心 Bridge/MCP 不依赖它。

Lua 不应跨命令长期保存 SynthV 对象代理。尤其在插入克隆 Group 后，不要在同一次 Lua callback 中通过旧代理访问 Automation；仓库已记录 SynthV 2.2.1 可能因此终止宿主。[v3 架构“Clone semantics”](architecture-v3.md)

## 6. 对外接口与功能范围

### 6.1 六个公共 MCP 工具

| 工具 | 职责 |
|---|---|
| `sv_status` | 连接、Session、能力、构建一致性和有界诊断 |
| `sv_describe` | 按需列出 Action 或返回单个 Query/Command/UI/Review schema |
| `sv_query` | 权威读取、紧凑投影，创建 `readOnly` 或 `writeIntent` Context |
| `sv_command` | 受保护写入、删除、克隆、导入和事务 |
| `sv_ui` | 选区、视口、剪贴板、对话框、吸附、坐标和播放 |
| `sv_review` | 发布/检查可选 Sidebar 预览并由用户确认 |

详细 Action 不能注册成独立 MCP 工具；只允许通过 `sv_describe` 即时发现。[公共工具常量](../src/build-info.ts) [v3 Surface](../src/v3-surface.ts)

### 6.2 当前能力盘点

权威矩阵记录 17 个 Query Action、9 个 UI Action 和 38 个写 Action。主要能力包括：

- 工程、轨道、Group、音符、Voice/Vocal Modes、音素、Retake、Smart Pitch、Automation、Mixer、时间轴和计算数据读取；
- 轨道/Group/引用创建、更新、链接或隔离克隆、删除，以及空 Track shell；
- 音符增删改、统一机械变换、歌词匹配、人性化、表达预设、和声轨；
- Voice、Vocal Mode、音素属性、Smart Pitch 和多 Automation 曲线的一次 Group 综合调音；
- 速度/拍号、混音器、编辑器选区/视口、剪贴板/对话框和播放控制；
- 显式本地 MusicXML/MXL/MIDI 的检查和经过权利确认的单旋律导入；
- 独立步骤完整预检、前向 `$result` 依赖即时预检的一次 Undo 事务；
- 可选 Sidebar 的预览、Apply、Dismiss、Cancel 和状态协调。

功能目录以 [SV2 API 覆盖矩阵](sv2-api-coverage-v3.md)、[协议 v3](protocol.md) 和运行时 `sv_describe` 为准，不要从旧提示词复制 schema。

### 6.3 本地曲谱导入硬限制

只允许调用者显式提供的绝对本地 `.xml`、`.musicxml`、`.mxl`、`.mid`、`.midi` 路径；拒绝 URL、`.svp`、XML `DOCTYPE`/`ENTITY`、SHA-256 已变化文件、歧义/多声部 lane 和超过 512 音符的导入；必须 `rightsConfirmed: true`。源速度只返回供审核，绝不隐式应用到项目。[README 功能说明](../README_CN.md) [实现入口](../src/score-import.ts)

## 7. 安全、一致性和责任边界

### 7.1 必须保持的协议/索引不变量

- 文件 IPC 只接受协议 v3；v1/v2 不提供兼容运行模式。
- 公共边界的 Track、Group、Reference、note index 均为 1-based。
- Node 默认无网络；不得输出用户歌词、音符数组、曲线或原始指纹到普通 stderr/日志。
- `contextId` 与 Guard 必须绑定 Session、目标类型和来源作用域；Session 变化后全部失效，旧值不得自动重试。
- note 编辑/删除必须带当前指纹；Automation 使用同一次新鲜读取返回的 `definition.range`。

### 7.2 写入生命周期

标准阶段为：

`accepted → contextResolved → freshRead → guarded → preflighted → effectPlanned → undoOpened → mutated → verified → cacheInvalidated → projected`

没有实际效果时应在 `undoOpened` 前返回 `alreadySatisfied`。一旦写入开始后失败，结果必须准确报告 `undoRequired`；若为 `true`，用户必须在 SynthV 执行一次 Undo，之后重新读取，禁止盲目重试。[命令状态机](command-state-machine-v3.md) [错误目录](errors-v3.md)

### 7.3 共享 Group 与克隆

- Note Group 内容被所有引用共享。内容写入默认 `sharedGroupPolicy=reject`；引用数大于 1 时，必须显式 `allowAllReferences` 并提供匹配的新鲜 `expectedReferenceCount`。
- reference offset/mute 等引用本地字段不按 Group 内容处理。
- `clone_track` 遇到非主 Vocal Groups 默认拒绝。`nonMainGroupPolicy=detach` 只能证明 Group 内容独立，不能声称官方 API 保留/识别了那些 Vocal；必须人工复核。
- 若只需要继承宿主克隆的 main Vocal 上下文且得到一条已验证空轨，优先 `clone_track_shell`。

### 7.4 调音时 Agent/用户交接

官方脚本 API 无法读取当前 Vocal 身份，也无法枚举从未修改、仍为默认值的全部 Vocal Mode 名称。每次对话第一次调音写入前，Agent 必须让用户选中目标 Note Group、为其选择/分配 Vocal，并提供完整 Vocal Mode 面板截图或精确输入全部名称；换 Vocal 后必须重新提供。Agent 决定艺术意图和具体数值，Bridge 只做确定性执行，用户负责最终试听判断。[快速开始](quickstart_cn.md) [责任边界](responsibility-boundaries_cn.md)

## 8. 实现状态与测试证据

### 8.1 已实现

- Phase 0–8：合同冻结、安全回归、跨层 Trace/Build Identity、Query Facade、统一命令生命周期、聚合/克隆边界、Group 综合命令、性能基线、剩余 Action 迁移和 v2 路径移除。
- 6 工具默认目录低于 6,000 字符/UTF-8 字节；普通 Query 预算 20,000，写确认 2,048，公共错误 4,096。
- Snapshot LRU 有经过测试的组件，但生产 Query 未启用；所有项目 Query 仍到真实宿主。
- 当前仓库有 23 个 `*.test.ts` 文件；静态计数为 211 个顶层 `test(...)` 调用，另有 Lua Fake Host/Sidebar smoke 脚本。

### 8.2 已记录的真机样本

仓库记录了 SynthV Studio 2 Pro 2.2.1 standalone 的代表性结果：Query 投影、Mixer no-op/Undo、Sidebar Apply/Undo、linked/isolated clone、Track shell/delete、Automation、note transform、事务成功和依赖步骤失败后的单 Undo 恢复等。30 次 `get_track_mixer` 只读样本中，工具侧 p95 149 ms、Bridge 内部 p95 77 ms，低于普通操作 300 ms 目标。[测试矩阵](v3-test-matrix.md) [性能预算](v3-performance-budget.md)

这些历史结果只能作为上下文，不能替代当前 HEAD 和新安装构建的 fresh evidence。

### 8.3 本次交接机器的验证状态

| 项目 | 状态 |
|---|---|
| Node | `v26.1.0`；满足 `>=20.10`，但不在 CI 的 Node 20/22 矩阵中 |
| npm | `11.13.0` |
| `npm run check` | 本次通过：216 tests，216 pass，0 fail；交接时仍须重新运行 |
| `node --check` 两个安装/清理脚本 | 本次通过 |
| `luac5.4` | 本机未安装，Lua 语法门禁只能标记 blocked，不能写 passed |
| SynthV 真机 | 本报告没有执行新的真机写入/Undo/崩溃压力验证 |

CI 在 Ubuntu 的 Node 20/22 上运行 `npm ci --ignore-scripts`、依赖审计和 `npm run check`，并安装 Lua 5.4 后编译 3 个 Lua 文件、运行 Bridge 与 Sidebar mock smoke。[CI 工作流](../.github/workflows/ci.yml)

## 9. 已知限制、风险与文档债务

### 9.1 稳定版阻塞风险

1. **事务原生崩溃历史**：一次 `0xc0000005` APPCRASH 的根因未被证明已消除。稳定版前必须修复并通过重复矩阵，或把 transaction 从 stable capability 中禁用/移除。
2. **真机覆盖不完整**：所有 17 Query、9 UI、38 write 尚未在当前构建上逐项达到 `verified/unsupported/experimental` 三选一。
3. **稳定性/寿命测试未完成**：1,000 reads、200 write/Undo、clone/transaction/reload/concurrency 批次和 4 小时混合运行仍是计划，不是已完成事实。
4. **Trace 开销缺证据**：已有带 Trace 的性能样本，但缺少 tracing on/off 的受控对比来证明 p95 增量低于 5%。
5. **Lua 编译环境缺失**：本机没有 `luac5.4`，必须在另一台 PC 或 CI 补齐门禁。

### 9.2 官方 API 明确缺口

- 当前 Vocal 显示名/数据库身份；
- 从未修改的默认 Vocal Mode 名称枚举；
- 当前 active Retake getter 和 Take 内容枚举；
- Track effect-chain 对象/参数；
- instrumental source 文件路径；
- 工程保存、音频渲染/导出。

这些只能显式交给用户/UI，不得通过解析 `.svp` 补洞。[SV2 API 覆盖矩阵](sv2-api-coverage-v3.md)

### 9.3 文档漂移

接手时不要只读入口 README/roadmap：

- `README_CN.md` 顶部仍写“私有操作迁移仍在进行”，而 v3 开发计划已记录 Phase 0–8 完成。
- `docs/roadmap.md` 的 v3 stabilization 仍列出“完成迁移/移除 v2 adapters”等已完成事项。
- `CHANGELOG.md` 的 Unreleased 段落仍夹杂多个 MCP v2 时代描述。
- 快速开始中的示例 clone URL 与当前 `origin` 组织不同；跨机交接应以本报告第 3 节记录的实际 `origin` 为准。

建议在发布验证证据稳定后统一清理，而不是在证据不足时先改成“stable”。

## 10. 后续开发与测试计划（建议优先级）

### P0：保证交接可复现

1. 把 `7383b1c`、本报告和任何后续改动提交并 push，或制作可校验的 `git bundle`。
2. 另一台 PC 使用 Node 20 或 22 LTS、npm lockfile 和 Lua 5.4，从干净 checkout 运行完整自动化门禁。
3. 构建并原子安装 Node/Lua/Sidebar 完整集合；在 SynthV reload 后确认 `sv_status` 的 build coherence 为 matched。
4. 只用已保存的 disposable project copy，禁止在唯一工程副本做破坏性测试。

### P0：执行 Stage 1 Alpha daily-use gate

- 完成自动化门禁、连接和全部代表性读取。
- 验证 Mixer/no-op/Undo、Sidebar、stale/session、共享 Group 拒绝、linked/isolated/shell clone、guarded note、Automation closed range、依赖事务成功与失败恢复。
- 记录每项初始投影、命令结果、Undo 数、恢复后投影、traceId、响应字节和耗时。
- 任一 native crash、意外 mutation、额外 Undo、source drift、Guard 泄漏或 `undoRequired=true` 都立即停止场景，先恢复/诊断。

### P1：执行 Stage 2 公共能力真机覆盖

- 跑完 17 Query 的默认/边界投影和 9 UI 的真实状态回读。
- 对 38 write 逐项给出 `verified`、`unsupported` 或 `experimental`，不得保留模糊的 `pending/sampled` 作为稳定能力。
- 做一次完成 Vocal onboarding 的 `apply_group_tuning` 综合场景，并人工试听渲染、连音和非预期 gap。

### P1：解决 transaction stable 决策

- 优先尝试最小复现、记录 breadcrumb 和最后 native-host stage，隔离是 SynthV 代理复用、依赖结果解析、Undo 生命周期还是特定 API 序列。
- 若无法在可控时间内证明修复，则把 transaction 明确降为 experimental 或从 stable surface 禁用，再对缩减后的能力集合跑完整矩阵。

### P2：Stage 3 稳定性/性能

- 按发布验证设计执行 reads、writes/Undo、clone、transaction、reload、并发请求和 4 小时持续运行矩阵。
- 监控无重叠请求、无遗留 IPC 文件、无假成功、内存无单调增长、heartbeat 恢复和 crash breadcrumb 清理。
- 增加 tracing on/off 对照；只有测量显示文件 IPC 是主瓶颈时，才新建 ADR 评估替代本地传输。

### P3：Stage 4 发布决策与文档收口

- 在 full stable、reduced stable、remain alpha 三者中基于证据选择。
- 清理 README/roadmap/changelog 的 v2 与“迁移进行中”漂移。
- 更新版本、发布说明、测试矩阵、API coverage、开发计划和最终 release report。

## 11. 关键文件索引与权威顺序

发生冲突时建议按以下顺序判断：当前源码/测试与根目录 `AGENTS.md` → v3 权威设计和矩阵 → README/roadmap/历史计划。

| 目的 | 文件 |
|---|---|
| 仓库不可破坏的不变量 | [`AGENTS.md`](../AGENTS.md) |
| v3 实际架构 | [`docs/architecture-v3.md`](architecture-v3.md) |
| 当前阶段和迁移状态 | [`docs/v3-development-plan.md`](v3-development-plan.md) |
| 下一阶段发布门禁 | [`docs/superpowers/specs/2026-07-31-v3-release-validation-design.md`](superpowers/specs/2026-07-31-v3-release-validation-design.md) |
| 自动/真机测试矩阵 | [`docs/v3-test-matrix.md`](v3-test-matrix.md) |
| 官方 API/Action 状态 | [`docs/sv2-api-coverage-v3.md`](sv2-api-coverage-v3.md) |
| 性能和响应预算 | [`docs/v3-performance-budget.md`](v3-performance-budget.md) |
| 协议、错误、状态机 | [`docs/protocol.md`](protocol.md)、[`docs/errors-v3.md`](errors-v3.md)、[`docs/command-state-machine-v3.md`](command-state-machine-v3.md) |
| 原子安装/回滚 | [`docs/atomic-upgrade-v3.md`](atomic-upgrade-v3.md) |
| 用户安装和首次调音 | [`docs/quickstart_cn.md`](quickstart_cn.md) |
| MCP 注册与 schema | [`src/v3-facade.ts`](../src/v3-facade.ts)、[`src/v3-surface.ts`](../src/v3-surface.ts)、[`src/server.ts`](../src/server.ts) |
| Query/Command 核心 | [`src/v3-query-projector.ts`](../src/v3-query-projector.ts)、[`src/v3-command-policy.ts`](../src/v3-command-policy.ts)、[`src/v3-command-dispatcher.ts`](../src/v3-command-dispatcher.ts)、[`src/v3-command-kernel.ts`](../src/v3-command-kernel.ts) |
| 文件 IPC | [`src/ipc/file-ipc-client.ts`](../src/ipc/file-ipc-client.ts)、[`src/protocol.ts`](../src/protocol.ts) |
| SynthV 执行器/侧边栏 | [`synthv/SynthVAgentBridge.lua`](../synthv/SynthVAgentBridge.lua)、[`synthv/SynthVAgentSidebar.lua`](../synthv/SynthVAgentSidebar.lua) |

## 12. 另一台 PC 的接手步骤

### 12.1 获取正确分支

```powershell
git clone https://github.com/SynthVCopilot/synthv-agent-bridge.git
Set-Location synthv-agent-bridge
git fetch origin
git switch codex/v3-implementation
git rev-parse HEAD
git status --short --branch
```

期望 HEAD 必须等于交接时最终 push 的提交，不能机械期待本快照的 `7383b1c`。若远端仍是 `429ac15`，说明本机新增提交尚未完成交接。

### 12.2 建立环境并运行自动化门禁

优先使用 Node 20/22 LTS 与 CI 对齐：

```powershell
node --version
npm --version
npm ci
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
git diff --check
npm run check:api-coverage
npm run benchmark:v3
```

如果 Windows 上的 Lua 可执行文件叫 `luac` 而不是 `luac5.4`，先确认它确实是 Lua 5.4，再用等价命令。缺少 Lua 编译器时状态是 `blocked`，不是 `passed`。

### 12.3 构建、安装、连接

```powershell
npm run build
npm run install:synthv -- --target "<SynthV 实际打开的脚本目录>"
npm run doctor -- --target "<同一脚本目录>"
```

然后在 SynthV 执行“脚本 → 重新扫描”，再次启动 **Start SynthV Agent Bridge**；在新的 Codex 任务内检查 `sv_status` 和工程信息。仓库的 [`.codex/config.toml`](../.codex/config.toml) 使用项目级 `node dist/src/cli.js`，因此构建后需要让 Codex 重新加载项目 MCP 配置。

### 12.4 真机测试记录要求

每个场景至少保存：Git commit、Node/Lua/Sidebar build identity、SynthV 版本和 standalone/plugin 模式、Session、测试工程副本标识、前后权威投影、outcome/changed count/Undo count/verification/warnings/trace、耗时/字节、恢复步骤和最终状态。禁止把真实歌词、完整 note/curve 数组、原始 Guard/指纹写入报告。

## 13. 可直接交给下一位 Agent 的首轮提示词

```text
请接手 synthv-agent-bridge 的 codex/v3-implementation 分支。先完整阅读：
1) AGENTS.md；
2) docs/CURRENT_BRANCH_HANDOFF.zh-CN.md；
3) docs/architecture-v3.md；
4) docs/v3-development-plan.md；
5) docs/superpowers/specs/2026-07-31-v3-release-validation-design.md；
6) docs/v3-test-matrix.md；
7) docs/sv2-api-coverage-v3.md。

先不要改功能。先核对当前 HEAD、上游差异和工作树，使用 Node 20/22 LTS、
npm lockfile 与 Lua 5.4 从干净 checkout 跑完整自动化门禁，并把每条命令的
真实结果写入一份新的时间戳 evidence report。之后构建并安装同一套
Node/Lua/Sidebar，确认 build coherence matched。只在已保存的 disposable
SynthV 工程副本上执行 Stage 1；遇到 native crash、意外 mutation、额外 Undo、
source drift、Guard 泄漏或 undoRequired=true 立即停止并先恢复/诊断。

当前目标是完成 v3 Alpha 发布验证和稳定版决策，不是扩大功能。所有 17 Query、
9 UI、38 write 最终必须标记 verified/unsupported/experimental。特别优先处理
历史 transaction 0xc0000005 风险。不要解析 .svp，不要猜 Vocal/Vocal Mode，
不要把 singleUndoRecord 写成自动回滚，不要启用 Snapshot cache，除非新的测量
和 ADR 明确支持。完成一轮后汇报：测试证据、阻塞项、风险等级、建议的下一
个最小改动；未经我确认不要发布 stable、push、开 PR 或在真实用户工程写入。
```

## 14. 本次实际验证记录

本节应反映生成本报告这一轮真正运行过的命令，不能用历史 CI 结果代替。完成最终验证后更新：

| 命令 | 结果 |
|---|---|
| `npm run check` | `PASS`：exit 0；216 tests，216 pass，0 fail，0 skipped；总测试阶段约 58.96 s，整条命令约 98.2 s |
| `node --check scripts/clean.mjs` | `PASS`：exit 0 |
| `node --check scripts/install-synthv-bridge.mjs` | `PASS`：exit 0 |
| `luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua` | `BLOCKED`：exit 1；本机找不到 `luac5.4`，未产生 Lua 语法结论 |
| `git diff --check` | `PASS`：exit 0；另行检查本报告 55 个 Markdown 链接全部有本地目标、无缺失引用 |
| `npm run check:api-coverage` | `PASS`：exit 0；23 official classes、370 methods、215 semantic evidence、64/64 live Actions classified、38 semantic writes、0 errors |
| `npm run benchmark:v3` | `PASS`：exit 0；6-tool catalog 4,336 B；64-note synthetic Query 4,757 B、projection p95 1.834 ms；Command ack 129 B、projection p95 0.013 ms。此为未连接 SynthV 的 synthetic fixture，不是宿主延迟证据 |
| SynthV 真机 Stage 1 | `NOT RUN` |
