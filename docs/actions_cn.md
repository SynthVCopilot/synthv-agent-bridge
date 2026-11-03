# 动作参考

[English](actions.md) | [简体中文](actions_cn.md)

MCP 服务器只注册 6 个工具，下面所有 SynthV 动作都通过其中之一调用，没有一个是
独立的 MCP 工具。需要某个动作的参数结构时，用 `sv_describe` 加 `action` 名称
获取当前版本，不要把结构抄进提示词。

| 工具 | 执行内容 |
|---|---|
| `sv_status` | `operation`：`bridge`、`host`、`ping`、`reload` 或 `diagnostics`。 |
| `sv_describe` | 不带参数返回动作目录，带 `action` 返回单个动作的结构。 |
| `sv_query` | 读取动作。 |
| `sv_command` | 编辑、删除和事务动作。 |
| `sv_ui` | 界面动作。 |
| `sv_review` | `operation: "status"`，读取可选侧栏的状态。 |

约定：

- 轨道、音符组、音符、Smart Pitch 控制和事务步骤的索引都**从 1 开始**。
- 音符和自动化的位置是音符组内的 **blick**（每个四分音符 705,600,000），字段名
  带 `absolute` 的除外。
- 播放位置和 `*Seconds` 字段以秒为单位。

## 动作目录

有两种标记表示动作尚未完全验证：

- **已禁用：** 这 7 个动作曾导致 SynthV 2.2.1 崩溃，当前构建会在请求到达
  SynthV 之前拒绝它们，只保留结构用于诊断。
- **实验性：** 动作可以使用，但还没有通过它自己的真机验收。

### 读取（`sv_query`）

| 动作 | 用途 |
|---|---|
| `get_project_info` | 工程文件、计时、播放、宿主和当前编辑器位置。 |
| `list_tracks` | 分页列出轨道摘要，包括音符组数、音符数和混音器状态。 |
| `list_note_groups` | 分页列出库音符组及其引用数；SynthV 2.3.0+ 还会返回 `scale`。 |
| `get_track_notes` | 某条轨道的音符组和音符分页，含属性、偏移，2.3.0+ 还有音符组 `scale`。 |
| `get_group_voice` | 音符组的歌声参数、唱法和实验性的齐唱（Unison）字段。 |
| `get_note_phoneme_data` | 用户指定和计算得出的音素、音素集覆盖，以及单个音素的属性。 |
| `get_phrase_context` | 一次拿到可直接用于写入的乐句：音符、歌声、自动化摘要和诊断。 |
| `get_computed_group_data` | 计算得出的音素、说唱属性和可选的音高采样。 |
| `get_note_retakes` | 重唱（Take）数量和 Bridge 记录的 Take ID。 |
| `get_pitch_controls` | Smart Pitch 控制点和曲线。 |
| `get_automation` | 参数定义、插值方式，以及曲线摘要或某个闭区间内的点。 |
| `sample_automation` | 在指定位置采样曲线值，可选原生插值或线性插值。 |
| `get_track_mixer` | 增益、声像、静音、独奏；2.3.0+ 还有只读的 `fx`（压缩、均衡、混响、房间）。 |
| `get_time_axis` | 速度和拍号标记。 |
| `convert_time` | 在秒、四分音符和 blick 之间换算，可按网格取整。 |
| `convert_pitch` | MIDI 音高与频率互换，并判断是否为黑键。 |
| `inspect_score_file` | 不改动 SynthV 地预览本地 MusicXML 或 MIDI 文件，并返回其 SHA-256 守卫。 |

### 编辑（`sv_command`）

| 动作 | 用途 |
|---|---|
| `add_notes` | 添加音符。默认 `grouping=ensureNonMain`：目标是轨道主音符组时，会新建一个音符组来放音符。SynthV 2.3.0 会拒绝对主音符组使用 `grouping=target`。 |
| `edit_notes` | 修改起点、时长、音高、歌词、音素、微调、语言、类型、说唱重音或属性。 |
| `transform_notes` | 对一批受守卫的音符的起点、时长或音高统一偏移或缩放。 |
| `humanize_notes` | 按种子添加有上限的时值随机变化。 |
| `fit_lyrics` | 把音节和可选的音素分配给受守卫的音符。 |
| `set_note_phoneme_properties` | 修改音素序列、语言、音素集、音节均分，以及单个音素的时值或强度。 |
| `import_monophonic_score` | 从一条已预览、已确认版权的旋律导入最多 512 个音符；文件哈希必须保持一致。 |
| `generate_note_retake` | 生成时值、音高或音色方面的重唱。 |
| `activate_note_retake` | 启用默认 Take，或 Bridge 生成的某个 Take。 |
| `add_pitch_controls` | 添加 Smart Pitch 控制点或曲线。 |
| `edit_pitch_controls` | 修改受守卫的 Smart Pitch 对象。 |
| `set_automation_points` | 添加或更新曲线点，可先清除全部或某一区间。2.3.0+ 可通过 `interpolationMethod` 设置 `linear`、`cosine` 或 `cubic`。 |
| `simplify_automation` | 删除区间内无关紧要的点。 |
| `apply_expression_preset` | 应用滑入、滑出、颤音、渐强或气声预设。 |
| `apply_group_tuning` | 在一条撤销记录内，一次修改同一音符组的歌声、唱法、音符、音素和多条曲线。 |
| `set_group_voice` | 修改音符组的歌声参数和唱法。 |
| `copy_group_voice` | **实验性。** 把源音符组已存储的歌声参数和唱法轴合并到目标音符组。目标独有的值会保留，也不会重置为默认值。不会复制歌手本身，请在 SynthV 中手动选择。 |
| `update_group` | 重命名音符组、在 2.3.0+ 上设置 `scale`，或修改引用的静音、偏移、范围和歌声。 |
| `create_note_group` | 创建库音符组，可同时放入音符。 |
| `add_group_reference` | 把库音符组放到某条轨道上。 |
| `clone_group_reference` | 在另一条轨道上创建关联引用；隔离式变体**已禁用**。 |
| `clone_note_group` | **已禁用。** 把音符组深拷贝到库中。 |
| `add_track` | 新建轨道。 |
| `update_track` | 重命名、改颜色，或修改是否参与渲染面板。 |
| `clone_track` | **已禁用。** 克隆轨道的主歌声上下文。 |
| `clone_track_shell` | **已禁用。** 把轨道的主歌声上下文克隆成一条空轨道。 |
| `create_harmony_track` | **已禁用。** 克隆、移调并按音域调整，生成和声轨。 |
| `set_track_mixer` | 修改增益、声像、静音和独奏。 |
| `set_time_axis` | 添加、替换或删除速度和拍号标记。 |
| `script_data` | 在 SynthV 对象上存储带命名空间的 Bridge 元数据（键以 `synthv-agent-bridge.` 开头）。 |

### 删除（`sv_command`）

| 动作 | 用途 |
|---|---|
| `delete_notes` | 删除受守卫的音符。 |
| `delete_pitch_controls` | 删除受守卫的 Smart Pitch 对象。 |
| `clear_automation` | 清除整条曲线或某个闭区间。 |
| `delete_note_retake` | 删除一个由 Bridge 生成的非默认 Take。 |
| `delete_group_reference` | 移除一个非主音符组引用。 |
| `delete_note_group` | 删除库音符组及其全部引用。 |
| `delete_track` | 删除一条轨道（不能删除最后一条）。 |

### 界面（`sv_ui`）

| 动作 | 用途 |
|---|---|
| `get_selection` | 选中的音符组、音符、Smart Pitch 控制和自动化点。 |
| `set_selection` | 替换、追加、移除或清空选区，并返回 SynthV 实际选中的内容。 |
| `get_editor_view` | 可见的时间与数值范围，以及像素比例。 |
| `set_editor_view` | 平移或缩放钢琴卷帘或编排视图，并返回结果。 |
| `snap_position` | 按当前网格吸附一个位置。 |
| `convert_editor_coordinates` | 在时间/数值与 x/y 坐标之间换算。 |
| `playback` | 查询状态、播放、暂停、停止、跳转或循环，并返回状态和播放头。 |
| `host_clipboard` | 读写宿主剪贴板中的文本。 |
| `show_dialog` | 显示消息、输入、确认或自定义表单对话框。 |

### 事务（`sv_command`）

| 动作 | 用途 |
|---|---|
| `apply_transaction` | **已禁用。** 在一条撤销记录内执行最多 32 次写入。 |
| `rollback_transaction` | **已禁用。** 执行保存下来的反向计划。 |

## Context 与守卫

写入前必须证明目标自读取以来没有被改动过。

- 用 `sv_query` 加 `contextMode: "writeIntent"` 读取，结果里会带一个
  `contextId`。它把定位信息和指纹保存在 MCP 服务器的内存中。
- 把这个 `contextId` 传给 `sv_command`，服务器会自动补全：
  - 音符组和引用的 UUID；
  - 轨道、自动化和时间轴的指纹；
  - 音符和 Smart Pitch 的守卫。

  所以编辑音符时只需要 `noteIndex` 和 `changes`。
- `contextId` 绑定了目标类型和范围。把它用在别的目标上，或者同时传入与之冲突
  的定位或守卫，会返回 `CONTEXT_SCOPE_MISMATCH`。`readOnly` Context 永远不能
  用于写入。
- 在打开撤销记录之前，SynthV 仍会逐一核对完整指纹。
- SynthV 重启或 Bridge 重新加载时，服务器会清空所有 Context 和守卫令牌。
  之后的写入会返回 `SYNTHV_SESSION_CHANGED`；重新读取可以立即进行，并会带上
  `sessionReset`。

紧凑模式的读取会返回简短的**守卫令牌（Guard Token）**，代替冗长的指纹：

- 把音符的 `guardToken` 传给 `set_note_phoneme_properties`；
- 把曲线的令牌作为 `expectedGuardToken` 传给 `set_automation_points`。

令牌只存在于当前的 MCP 进程中，收到 `UNKNOWN_GUARD_TOKEN` 就需要重新读取。

音符指纹涵盖以下内容：

- 音符组 UUID 和音符索引；
- 起点、时长和音高；
- 微调、歌词和音素；
- 语言、类型、音高模式和说唱重音；
- 重唱数量和音符属性。

因此，旧的修改计划不会覆盖用户已经手动改过的音符。

## 安全写入

1. 只读取要修改的对象：
   - 调整乐句时，用 `get_phrase_context`；
   - 调整歌声或唱法时，用不带定位参数的 `get_group_voice`，它会定位到钢琴卷帘
     当前的音符组。
2. 构造一个小而易于检查的修改。
3. 带上那次读取得到的 `contextId` 发送，并选用能完成任务的最小动作：
   - 一次性调整同一音符组的歌声、音符和多条曲线时，用 `apply_group_tuning`；
   - 只改一类内容时，用 `edit_notes`、`set_automation_points` 等专门动作。
4. 遇到任何 `STALE_*` 结果，重新读取，不要猜。

**共享音符组。** 音符组的内容由它的全部引用共享。被引用多次的音符组，写入默认
会失败。如果确实要同时修改所有关联的位置，需要同时传入：

- `sharedGroupPolicy: "allowAllReferences"`；
- 最新读到的 `expectedReferenceCount`。

**批量大小。** `edit_notes` 和 `delete_notes` 每次最多接受 512 项，但 SynthV 在
大批量时不稳定，建议每次控制在 60 个音符左右。

**复用 Context。** 只要涉及的音符都没有变化，一次 `writeIntent` 读取可以供多个
互不重叠的批次使用。以下两种情况需要重新读取：

- 这个 Context 中的某个音符已经被修改过；
- `add_notes` 或 `delete_notes` 让后面的索引发生了移动。

这两种情况都会在写入前失败，所以 Context 复用过头只会多一次被拒绝的调用，不会
改错东西。

**撤销。** 每次成功的写入都只产生一条 SynthV 撤销记录，并返回
`verified: true`。如果失败结果报告 `undoRequired: true`，先在 SynthV 中执行一次
**编辑 → 撤销**，再重新读取或重试。

## 分页与紧凑响应

**默认上限。** 集合类读取默认分页，并返回续读信息。未限定范围、结果超过约
20,000 字符的读取会直接失败，并提示如何缩小范围，避免撑满 Agent 的上下文。

**自动化。** 默认只返回不含点的摘要，除非明确请求某个闭区间。

**轨道音符。** `get_track_notes` 会去掉重复的 blick 和四分音符位置字段。24 个
及以上音符的音符组会以 `{columns, rows}` 形式返回；传 `dense: "never"` 可以拿到
普通对象。

**字段过滤。** `sv_query.fields` 只过滤结果的顶层字段。如果一个字段都没匹配上，
会返回 `projectionWarning`，列出实际存在的字段。

**乐句读取。** 调整乐句前推荐先用 `get_phrase_context`：

- **返回内容。** 它会自动找到钢琴卷帘当前的音符组，并优先使用选中的音符。
  `include` 可以从 `notes`、`voice`、`automation`、`analysis`、
  `recommendations`、`pitchAnalysis`、`selection` 和 `diagnostics` 中选择，
  默认是 `notes`、`voice` 和 `analysis`。
- **诊断。** 会标出重叠、大跨度音高跳跃、长音、可换气的间隙和密集短音，但不会
  修改工程。
- **多区间。** `ranges` 最多接受 32 个绝对时间区间，它们共用一个 `notes` 数组。
- **区间匹配。** 默认的 `rangeMatch: "overlap"` 会保留跨过区间起点的长音；
  `"onset"` 更快，但会带上 `mayExcludeEarlierSustains: true`。
- **翻页。** 未限定范围的分页会返回 `page.cursorToken`，下次作为 `cursorToken`
  传回即可。如果边界音符已经改变，SynthV 会以 `STALE_RANGE_CURSOR` 拒绝。

**音素读取。** `get_note_phoneme_data` 可以按 `noteIndices` 或
`startSeconds`/`endSeconds` 范围过滤。只需要守卫或用户覆盖值时，传
`includeComputedPhonemes: false`，可以省掉整组音素的计算。

**紧凑模式。** `get_note_phoneme_data`、`get_automation`、`sample_automation`、
`set_note_phoneme_properties` 和 `set_automation_points` 都接受
`responseMode: "compact"`。紧凑模式下，写入只返回计数和新的守卫令牌，不返回完整
的音符或曲线。

## 与宿主相关的行为

- **数值范围来自宿主。** 自动化数值按实时的 `getDefinition().range` 校验，不同
  SynthV 版本、不同参数的范围都可能不同，例如 SynthV 2.3.0 上的 `tension` 是
  ±2。音素的位置和活跃度范围是 `0..1`，强度是 `-1..1`。
- **音素写入先试写。** 写入前会先在一个分离的副本上验证，再在打开撤销记录后于
  真实音符上再验证一次。如果声库或宿主对数值做了量化或忽略，会返回
  `HOST_POSTCONDITION_FAILED`。
- **音高自动模式。** 包括 SynthV 2.3.0 在内的部分宿主提供了
  `Note:getPitchAutoMode()`，却没有对应的 setter。真正需要修改时，会在打开撤销
  记录前返回 `UNSUPPORTED_HOST_CAPABILITY`；值已经一致时直接跳过。
- **音符语言。** `languageOverride` 接受 `mandarin`、`japanese`、`english`、
  `cantonese`、`korean` 和 `spanish`；SynthV 2.3.0+ 还接受 `french`、`german`、
  `italian` 和 `portuguese`。
- **音素集覆盖。** `phonesetOverride` 对应 SynthV 2.3.0 的 `phoneset` 属性，
  也就是 X-SAMPA 开关。
- **音符组调式。** `scale` 的根音必须来自 `SV:scaleNotes()`（只用升号，例如
  `C#`），类型必须来自 `SV:scaleTypes()`（例如 `Major`、`NaturalMinor`、
  `Dorian`）。
- **时间轴。** `set_time_axis` 替换标记的方式是先删除再添加，之后会校验结果。
- **轨道颜色。** 轨道写入接受 `#RRGGBB` 或 SynthV 原生的 `AARRGGBB`。
  `#RRGGBB` 会存成不透明的 `ffRRGGBB` 并校验；读取时返回原始值，以及
  `displayColorArgb` 和 `displayColorRgb`。

SynthV 脚本 API 与这些动作的完整对应关系见 [API 覆盖矩阵](sv2-api-coverage-v3.md)，
错误码见 [errors-v3.md](errors-v3.md)。
