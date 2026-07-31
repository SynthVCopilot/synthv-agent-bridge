-- SynthV Agent Bridge side panel
-- Persistent review UI for Synthesizer V Studio 2 Pro.
-- SPDX-License-Identifier: Apache-2.0

local SCRIPT_NAME = "SynthV Agent"
local SIDEBAR_VERSION = "0.2.0"
local SIDEBAR_BUILD_ID = "__SYNTHV_AGENT_SIDEBAR_BUILD_ID__"
local MIN_EDITOR_VERSION = 131330 -- Synthesizer V Studio 2.1.2
local POLL_INTERVAL_MS = 500
local MAX_TEXT_BYTES = 64 * 1024

local function safeCall(callback, fallback)
    local ok, result = pcall(callback)
    if ok and result ~= nil then
        return result
    end
    return fallback
end

local HOST_INFO = safeCall(function()
    return SV:getHostInfo()
end, {})
local IS_CHINESE = type(HOST_INFO.languageCode) == "string"
    and HOST_INFO.languageCode:lower():match("^zh") ~= nil
local PATH_SEPARATOR = HOST_INFO.osType == "Windows" and "\\" or "/"

local function text(chinese, english)
    return IS_CHINESE and chinese or english
end

local function trim(value)
    return (value:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function trimTrailingSeparators(value)
    while #value > 1 and (value:sub(-1) == "/" or value:sub(-1) == "\\") do
        value = value:sub(1, -2)
    end
    return value
end

local function joinPath(directory, fileName)
    return trimTrailingSeparators(directory) .. PATH_SEPARATOR .. fileName
end

local function resolveIpcDirectory()
    local configured = os.getenv("SYNTHV_AGENT_BRIDGE_DIR")
    if configured and configured ~= "" then
        return trimTrailingSeparators(configured)
    end
    if HOST_INFO.osType == "Windows" then
        return trimTrailingSeparators(os.getenv("TEMP") or os.getenv("TMP") or ".")
    end
    return trimTrailingSeparators(os.getenv("TMPDIR") or os.getenv("TMP") or os.getenv("TEMP") or "/tmp")
end

local IPC_DIRECTORY = resolveIpcDirectory()
local PREFIX = joinPath(IPC_DIRECTORY, "synthv-agent-bridge")
local STATUS_FILE = PREFIX .. ".status.json"
local INSTRUCTION_FILE = PREFIX .. ".sidebar.instruction.txt"
local PREVIEW_FILE = PREFIX .. ".sidebar.preview.txt"
local COMMAND_FILE = PREFIX .. ".sidebar.command.txt"
local ACTIVITY_FILE = PREFIX .. ".sidebar.activity.txt"
local STATE_FILE = PREFIX .. ".sidebar.state.txt"
local CLIENT_STATUS_FILE = PREFIX .. ".sidebar.client-status.txt"
local RUNTIME_STATUS_FILE = PREFIX .. ".sidebar.runtime-status.txt"

math.randomseed(os.time() + math.floor(os.clock() * 1000000))

local function readFile(filePath)
    local file = io.open(filePath, "rb")
    if not file then
        return nil
    end
    local content = file:read("*a")
    file:close()
    if #content > MAX_TEXT_BYTES then
        return nil
    end
    return content
end

local function removeFile(filePath)
    os.remove(filePath)
end

local function writeFileAtomically(filePath, content)
    local temporary = string.format(
        "%s.sidebar-%d-%06d.tmp",
        filePath,
        os.time(),
        math.random(0, 999999)
    )
    local file, openError = io.open(temporary, "wb")
    if not file then
        return false, openError
    end
    local wrote, writeError = file:write(content)
    file:flush()
    file:close()
    if not wrote then
        removeFile(temporary)
        return false, writeError
    end
    removeFile(filePath)
    local renamed, renameError = os.rename(temporary, filePath)
    if not renamed then
        removeFile(temporary)
        return false, renameError
    end
    return true
end

local lastRuntimeStatusSecond = -1
local lastRuntimeStatusSignature = nil

local function runtimeStatusValue(value, maximum)
    return tostring(value or "")
        :gsub("[\r\n]+", " ")
        :sub(1, maximum)
end

local function writeRuntimeStatus(state, failureStage, failureMessage)
    state = state or "running"
    local currentSecond = os.time()
    local signature = table.concat({
        state,
        runtimeStatusValue(failureStage, 64),
        runtimeStatusValue(failureMessage, 512)
    }, "\0")
    if currentSecond == lastRuntimeStatusSecond
        and signature == lastRuntimeStatusSignature then
        return
    end
    lastRuntimeStatusSecond = currentSecond
    lastRuntimeStatusSignature = signature
    local lines = {
        "synthv-agent-bridge-sidebar-runtime-v3",
        "state=" .. runtimeStatusValue(state, 32),
        "version=" .. SIDEBAR_VERSION,
        "buildId=" .. SIDEBAR_BUILD_ID,
        "updatedAtEpochMs=" .. tostring(currentSecond * 1000)
    }
    if failureStage ~= nil then
        lines[#lines + 1] =
            "failureStage=" .. runtimeStatusValue(failureStage, 64)
    end
    if failureMessage ~= nil then
        lines[#lines + 1] =
            "failureMessage=" .. runtimeStatusValue(failureMessage, 512)
    end
    lines[#lines + 1] = ""
    writeFileAtomically(RUNTIME_STATUS_FILE, table.concat(lines, "\n"))
end

local function lineValue(content, key)
    local prefix = key .. "="
    local inspected = 0
    for line in (content .. "\n"):gmatch("(.-)\r?\n") do
        inspected = inspected + 1
        if line:sub(1, #prefix) == prefix then
            return line:sub(#prefix + 1)
        end
        if inspected >= 8 then
            break
        end
    end
    return nil
end

local function bodyAfterLines(content, lineCount)
    local position = 1
    for _index = 1, lineCount do
        local lineEnd = content:find("\n", position, true)
        if not lineEnd then
            return ""
        end
        position = lineEnd + 1
    end
    return content:sub(position):gsub("\r", "")
end

local function freshState(content, maximumAgeMs)
    if not content then
        return false
    end
    local state = lineValue(content, "state")
    local updatedAt = tonumber(lineValue(content, "updatedAtEpochMs") or "")
    if state ~= "running" or not updatedAt then
        return false
    end
    return math.max(0, os.time() * 1000 - updatedAt) <= maximumAgeMs
end

local function jsonStringValue(content, key)
    if not content then
        return nil
    end
    return content:match('"' .. key .. '"%s*:%s*"([^"]*)"')
end

local function jsonNumberValue(content, key)
    if not content then
        return nil
    end
    return tonumber(content:match('"' .. key .. '"%s*:%s*(%d+)'))
end

local bridgeStatusValue = SV:create("WidgetValue")
local clientStatusValue = SV:create("WidgetValue")
local taskStateValue = SV:create("WidgetValue")
local selectionValue = SV:create("WidgetValue")
local instructionValue = SV:create("WidgetValue")
local previewValue = SV:create("WidgetValue")
local activityValue = SV:create("WidgetValue")
local refreshButtonValue = SV:create("WidgetValue")
local diagnosticsButtonValue = SV:create("WidgetValue")
local layoutButtonValue = SV:create("WidgetValue")
local submitButtonValue = SV:create("WidgetValue")
local clearButtonValue = SV:create("WidgetValue")
local cancelRequestButtonValue = SV:create("WidgetValue")
local applyButtonValue = SV:create("WidgetValue")
local dismissButtonValue = SV:create("WidgetValue")
local undoHelpButtonValue = SV:create("WidgetValue")
local clearHistoryButtonValue = SV:create("WidgetValue")

bridgeStatusValue:setEnabled(false)
clientStatusValue:setEnabled(false)
taskStateValue:setEnabled(false)
selectionValue:setEnabled(false)
previewValue:setEnabled(false)
activityValue:setEnabled(false)
instructionValue:setValue("")

local bridgeConnected = false
local clientConnected = false
local currentPlanId = nil
local currentPlanStatus = nil
local currentRequestId = nil
local currentTaskStatus = "idle"
local detailedMode = false
local lastStatusText = nil
local lastTaskStateText = nil
local lastSelectionText = nil
local lastPreviewRaw = nil
local lastActivityRaw = nil

local function refreshLayout()
    safeCall(function()
        SV:refreshSidePanel()
    end)
end

local function pitchName(pitch)
    local names = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" }
    local rounded = math.floor(pitch + 0.5)
    return names[(rounded % 12) + 1] .. tostring(math.floor(rounded / 12) - 1)
end

local function selectionSummary()
    local editor = safeCall(function()
        return SV:getMainEditor()
    end, nil)
    if not editor then
        return text("当前编辑器不可用。", "The main editor is unavailable.")
    end
    local track = safeCall(function()
        return editor:getCurrentTrack()
    end, nil)
    local reference = safeCall(function()
        return editor:getCurrentGroup()
    end, nil)
    if not track or not reference then
        return text("当前没有可用的轨道或 Group。", "No current track or group.")
    end

    local trackIndex = safeCall(function()
        return track:getIndexInParent()
    end, "?")
    local groupIndex = safeCall(function()
        return reference:getIndexInParent()
    end, "?")
    local trackName = safeCall(function()
        return track:getName()
    end, "")
    local instrumental = safeCall(function()
        return reference:isInstrumental()
    end, false)
    local group = not instrumental and safeCall(function()
        return reference:getTarget()
    end, nil) or nil
    local groupName = group and safeCall(function()
        return group:getName()
    end, "") or text("伴奏 Group", "Instrumental group")
    local selection = safeCall(function()
        return editor:getSelection()
    end, nil)
    local selectedNotes = selection and safeCall(function()
        return selection:getSelectedNotes()
    end, {}) or {}
    local selectedPitchControls = selection and safeCall(function()
        return selection:getSelectedPitchControls()
    end, {}) or {}
    local selectedPianoGroups = selection and safeCall(function()
        return selection:getSelectedGroups()
    end, {}) or {}
    local arrangementGroups = safeCall(function()
        return SV:getArrangement():getSelection():getSelectedGroups()
    end, {})

    local lines = {
        string.format(
            text("轨道 %s：%s", "Track %s: %s"),
            tostring(trackIndex),
            trackName ~= "" and trackName or text("未命名", "Untitled")
        ),
        string.format(
            text("Group %s：%s", "Group %s: %s"),
            tostring(groupIndex),
            groupName ~= "" and groupName or text("未命名", "Untitled")
        ),
        string.format(
            text("已选音符 %d 个；音高控制 %d 个", "%d notes; %d pitch controls selected"),
            #selectedNotes,
            #selectedPitchControls
        )
    }

    if #selectedNotes > 0 then
        local minimumPitch = math.huge
        local maximumPitch = -math.huge
        local minimumOnset = math.huge
        local maximumEnd = -math.huge
        local timeOffset = safeCall(function()
            return reference:getTimeOffset()
        end, 0)
        local pitchOffset = safeCall(function()
            return reference:getPitchOffset()
        end, 0)
        for index = 1, #selectedNotes do
            local note = selectedNotes[index]
            local pitch = safeCall(function()
                return note:getPitch()
            end, 0) + pitchOffset
            local groupOnset = safeCall(function()
                return note:getOnset()
            end, 0)
            local groupEnd = safeCall(function()
                return note:getEnd()
            end, groupOnset)
            local onset = groupOnset + timeOffset
            local ending = groupEnd + timeOffset
            minimumPitch = math.min(minimumPitch, pitch)
            maximumPitch = math.max(maximumPitch, pitch)
            minimumOnset = math.min(minimumOnset, onset)
            maximumEnd = math.max(maximumEnd, ending)
        end
        lines[#lines + 1] = string.format(
            text("音域 %s–%s；位置 %.2f–%.2f 拍", "Range %s–%s; quarters %.2f–%.2f"),
            pitchName(minimumPitch),
            pitchName(maximumPitch),
            SV:blick2Quarter(minimumOnset),
            SV:blick2Quarter(maximumEnd)
        )
    end
    local selectedGroupCount = #selectedPianoGroups + #arrangementGroups
    if selectedGroupCount > 0 then
        lines[#lines + 1] = string.format(
            text("另有 %d 个 Group 被选中", "%d group(s) also selected"),
            selectedGroupCount
        )
    end
    return table.concat(lines, "\n")
end

local function updateStatus()
    local bridgeStatus = readFile(STATUS_FILE)
    local bridgeState = jsonStringValue(bridgeStatus, "state")
    local bridgeUpdatedAt = jsonNumberValue(bridgeStatus, "updatedAtEpochMs")
    local bridgeVersion = jsonStringValue(bridgeStatus, "bridgeVersion") or "?"
    local bridgeAge = bridgeUpdatedAt
        and math.max(0, os.time() * 1000 - bridgeUpdatedAt)
        or math.huge
    bridgeConnected = bridgeState == "running" and bridgeAge <= 7000

    local clientStatus = readFile(CLIENT_STATUS_FILE)
    clientConnected = freshState(clientStatus, 5000)
    local clientVersion = clientStatus and lineValue(clientStatus, "version") or "?"
    local updatedBridge = bridgeConnected
        and string.format("● B %s", bridgeVersion)
        or text("○ B 离线", "○ B offline")
    local updatedClient = clientConnected
        and string.format("● M %s", clientVersion)
        or text("○ M 离线", "○ M offline")
    local updated = updatedBridge .. "\n" .. updatedClient
    if updated ~= lastStatusText then
        bridgeStatusValue:setValue(updatedBridge)
        clientStatusValue:setValue(updatedClient)
        lastStatusText = updated
    end
end

local TASK_STATUS_LABELS = {
    idle = { "○ 空闲", "○ Idle" },
    queued = { "◷ 已排队", "◷ Queued" },
    claimed = { "◷ Codex 已读取", "◷ Read by Codex" },
    stale = { "⚠ 请求待确认", "⚠ Request is stale" },
    awaiting_confirmation = { "● 等待确认", "● Awaiting confirmation" },
    applying = { "◷ 正在应用", "◷ Applying" },
    success = { "✓ 已完成", "✓ Completed" },
    error = { "! 操作失败", "! Failed" },
    dismissed = { "○ 已放弃", "○ Dismissed" },
    cancelled = { "○ 已取消", "○ Cancelled" }
}

local function updateTaskState()
    local raw = readFile(STATE_FILE)
    local status = raw and lineValue(raw, "status") or "idle"
    if not TASK_STATUS_LABELS[status] then
        status = "idle"
    end
    currentTaskStatus = status
    currentRequestId = raw and lineValue(raw, "requestId") or currentRequestId
    local translated = TASK_STATUS_LABELS[status]
    local updated = text(translated[1], translated[2])
    if updated ~= lastTaskStateText then
        taskStateValue:setValue(updated)
        lastTaskStateText = updated
    end
    cancelRequestButtonValue:setEnabled(
        status == "queued" or status == "claimed" or status == "stale"
    )
end

local function updateSelection()
    local updated = selectionSummary()
    if updated ~= lastSelectionText then
        lastSelectionText = updated
        selectionValue:setValue(updated)
    end
end

local function updatePreview()
    local raw = readFile(PREVIEW_FILE)
    if raw == lastPreviewRaw then
        applyButtonValue:setEnabled(
            currentPlanId ~= nil
                and currentPlanStatus == "pending"
                and bridgeConnected
                and clientConnected
        )
        return
    end
    local hadVisiblePreview = currentPlanId ~= nil
    lastPreviewRaw = raw
    if not raw or not raw:match("^synthv%-agent%-bridge%-sidebar%-preview%-v1\r?\n") then
        currentPlanId = nil
        currentPlanStatus = nil
        previewValue:setValue(text("暂无待确认的变更。", "No change is awaiting confirmation."))
        applyButtonValue:setEnabled(false)
        dismissButtonValue:setEnabled(false)
        if hadVisiblePreview and not detailedMode then
            refreshLayout()
        end
        return
    end
    currentPlanId = lineValue(raw, "planId")
    currentPlanStatus = lineValue(raw, "status")
    previewValue:setValue(trim(bodyAfterLines(raw, 3)))
    applyButtonValue:setEnabled(
        currentPlanId ~= nil
            and currentPlanStatus == "pending"
            and bridgeConnected
            and clientConnected
    )
    dismissButtonValue:setEnabled(currentPlanId ~= nil and currentPlanStatus ~= "applying")
    if not hadVisiblePreview and not detailedMode then
        refreshLayout()
    end
end

local function updateActivity()
    local raw = readFile(ACTIVITY_FILE)
    if raw == lastActivityRaw then
        return
    end
    lastActivityRaw = raw
    if not raw or not raw:match("^synthv%-agent%-bridge%-sidebar%-activity%-v1\r?\n") then
        activityValue:setValue(text("尚无 Bridge 操作记录。", "No Bridge operation has been recorded."))
        return
    end
    activityValue:setValue(trim(bodyAfterLines(raw, 4)))
end

local function refreshStage(stage, callback)
    local ok, errorMessage = pcall(callback)
    if not ok then
        writeRuntimeStatus("error", stage, errorMessage)
        return false
    end
    return true
end

local function refreshAll()
    local stages = {
        { "status", updateStatus },
        { "taskState", updateTaskState },
        { "selection", updateSelection },
        { "preview", updatePreview },
        { "activity", updateActivity },
        {
            "instruction",
            function()
                submitButtonValue:setEnabled(
                    trim(tostring(instructionValue:getValue() or "")) ~= ""
                )
            end
        }
    }
    for index = 1, #stages do
        if not refreshStage(stages[index][1], stages[index][2]) then
            return false
        end
    end
    writeRuntimeStatus("running")
    return true
end

local function showMessage(message)
    safeCall(function()
        SV:showMessageBoxAsync(SCRIPT_NAME, message)
    end)
end

local function ageText(updatedAt)
    if not updatedAt then
        return text("未知", "unknown")
    end
    local ageSeconds = math.max(0, math.floor((os.time() * 1000 - updatedAt) / 1000))
    return tostring(ageSeconds) .. "s"
end

local function showDiagnostics()
    local bridgeStatus = readFile(STATUS_FILE)
    local clientStatus = readFile(CLIENT_STATUS_FILE)
    local taskState = readFile(STATE_FILE)
    local bridgeVersion = jsonStringValue(bridgeStatus, "bridgeVersion") or "?"
    local bridgeUpdatedAt = jsonNumberValue(bridgeStatus, "updatedAtEpochMs")
    local clientVersion = clientStatus and lineValue(clientStatus, "version") or "?"
    local clientUpdatedAt = tonumber(
        clientStatus and lineValue(clientStatus, "updatedAtEpochMs") or ""
    )
    local message = table.concat({
        text("Bridge：", "Bridge: ")
            .. (bridgeConnected and "connected" or "offline")
            .. " · v" .. bridgeVersion
            .. " · " .. ageText(bridgeUpdatedAt),
        text("MCP：", "MCP: ")
            .. (clientConnected and "connected" or "offline")
            .. " · v" .. clientVersion
            .. " · " .. ageText(clientUpdatedAt),
        text("任务：", "Task: ") .. tostring(taskState and lineValue(taskState, "status") or "idle"),
        text("IPC：", "IPC: ") .. IPC_DIRECTORY,
        text("最后错误：", "Last error: ")
            .. tostring(clientStatus and lineValue(clientStatus, "lastErrorMessage") or text("无", "none")),
        "",
        text(
            "B 离线：运行“脚本 → SynthV Agent Bridge → Start SynthV Agent Bridge”。\nM 离线：确认 Codex MCP 已启用；只有脚本布局变化才需要“重新扫描”。",
            "B offline: run Scripts > SynthV Agent Bridge > Start SynthV Agent Bridge.\nM offline: verify the Codex MCP is enabled; use Rescan only for script layout changes."
        )
    }, "\n")
    showMessage(message)
end

local function newRequestId()
    return string.format("%d-%06d", os.time(), math.random(0, 999999))
end

local function submitInstruction()
    local instruction = trim(tostring(instructionValue:getValue() or ""))
    if instruction == "" then
        showMessage(text("请先输入希望 Codex 完成的操作。", "Enter an instruction for Codex first."))
        return
    end
    local requestId = newRequestId()
    local context = selectionSummary()
    local content = table.concat({
        "synthv-agent-bridge-sidebar-request-v1",
        "requestId=" .. requestId,
        "createdAtEpochMs=" .. tostring(os.time() * 1000),
        "context-begin",
        context,
        "context-end",
        "instruction-begin",
        instruction,
        ""
    }, "\n")
    local wrote, writeError = writeFileAtomically(INSTRUCTION_FILE, content)
    if not wrote then
        showMessage(
            text("无法提交侧边栏请求：", "Unable to submit the sidebar request: ")
                .. tostring(writeError)
        )
        return
    end
    currentRequestId = requestId
    currentTaskStatus = "queued"
    writeFileAtomically(STATE_FILE, table.concat({
        "synthv-agent-bridge-sidebar-state-v1",
        "status=queued",
        "updatedAtEpochMs=" .. tostring(os.time() * 1000),
        "requestId=" .. requestId,
        "message=" .. text("请求已排队，等待 Codex 读取。", "Queued for Codex."),
        ""
    }, "\n"))
    taskStateValue:setValue(text("◷ 已排队", "◷ Queued"))
    cancelRequestButtonValue:setEnabled(true)

    local prompt = table.concat({
        text(
            "请处理 SynthV Agent Bridge 侧边栏中刚提交的请求。",
            "Please handle the request just submitted from the SynthV Agent Bridge side panel."
        ),
        text(
            "调用 sidebar_get_request 读取请求，重新读取当前 SynthV 状态并使用最新指纹；不要直接写入工程，而是调用 sidebar_publish_preview 将一项完整变更或事务发回侧边栏等待我确认。",
            "Call sidebar_get_request, re-read the current SynthV state and use fresh fingerprints. Do not write to the project directly; call sidebar_publish_preview with one complete change or transaction for my confirmation."
        ),
        text("请求 ID：", "Request ID: ") .. requestId,
        "",
        text("指令：", "Instruction:"),
        instruction
    }, "\n")
    SV:setHostClipboard(prompt)
    submitButtonValue:setEnabled(true)
    activityValue:setValue(
        text(
            "请求已排队，并已复制到剪贴板。请粘贴到 Codex 发送。",
            "Request queued and copied. Paste it into Codex to send."
        )
    )
end

local function writeCommand(operation, planId, requestId)
    if (operation == "apply" or operation == "dismiss") and not planId then
        return
    end
    local lines = {
        "synthv-agent-bridge-sidebar-command-v1",
        "operation=" .. operation,
        "createdAtEpochMs=" .. tostring(os.time() * 1000)
    }
    if planId then lines[#lines + 1] = "planId=" .. planId end
    if requestId then lines[#lines + 1] = "requestId=" .. requestId end
    lines[#lines + 1] = ""
    local content = table.concat(lines, "\n")
    local wrote, writeError = writeFileAtomically(COMMAND_FILE, content)
    if not wrote then
        showMessage(
            text("无法发送侧边栏命令：", "Unable to send the sidebar command: ")
                .. tostring(writeError)
        )
        return
    end
    if operation == "apply" then
        applyButtonValue:setEnabled(false)
        dismissButtonValue:setEnabled(false)
        previewValue:setValue(text("正在提交变更…", "Submitting the change…"))
    elseif operation == "dismiss" then
        applyButtonValue:setEnabled(false)
        dismissButtonValue:setEnabled(false)
        previewValue:setValue(text("正在放弃预览…", "Dismissing the preview…"))
    elseif operation == "cancel_request" then
        cancelRequestButtonValue:setEnabled(false)
        taskStateValue:setValue(text("○ 正在取消…", "○ Cancelling…"))
    end
end

refreshButtonValue:setValueChangeCallback(refreshAll)
diagnosticsButtonValue:setValueChangeCallback(showDiagnostics)
layoutButtonValue:setValueChangeCallback(function()
    detailedMode = not detailedMode
    refreshLayout()
end)
instructionValue:setValueChangeCallback(function(value)
    submitButtonValue:setEnabled(trim(tostring(value or "")) ~= "")
end)
submitButtonValue:setValueChangeCallback(submitInstruction)
clearButtonValue:setValueChangeCallback(function()
    instructionValue:setValue("")
    submitButtonValue:setEnabled(false)
end)
applyButtonValue:setValueChangeCallback(function()
    if currentPlanStatus == "pending" and bridgeConnected and clientConnected then
        writeCommand("apply", currentPlanId, currentRequestId)
    end
end)
dismissButtonValue:setValueChangeCallback(function()
    if currentPlanId and currentPlanStatus ~= "applying" then
        writeCommand("dismiss", currentPlanId, currentRequestId)
    end
end)
cancelRequestButtonValue:setValueChangeCallback(function()
    if currentTaskStatus == "queued" or currentTaskStatus == "claimed"
        or currentTaskStatus == "stale" then
        writeCommand("cancel_request", nil, currentRequestId)
    end
end)
clearHistoryButtonValue:setValueChangeCallback(function()
    writeCommand("clear_history")
end)
undoHelpButtonValue:setValueChangeCallback(function()
    showMessage(
        text(
            "SynthV 脚本 API 可以创建撤销记录，但不能主动执行撤销。请先点击主编辑区，再按 Ctrl+Z；也可以使用“编辑 → 撤销”。",
            "The SynthV scripting API can create undo records but cannot invoke Undo. Click the main editor before pressing Ctrl+Z, or use Edit > Undo."
        )
    )
end)

safeCall(function()
    local selection = SV:getMainEditor():getSelection()
    selection:registerSelectionCallback(function()
        updateSelection()
    end)
    selection:registerClearCallback(function()
        updateSelection()
    end)
end)
safeCall(function()
    local selection = SV:getArrangement():getSelection()
    selection:registerSelectionCallback(function()
        updateSelection()
    end)
    selection:registerClearCallback(function()
        updateSelection()
    end)
end)

local function poll()
    refreshAll()
    SV:setTimeout(POLL_INTERVAL_MS, poll)
end

function getClientInfo()
    return {
        name = SCRIPT_NAME,
        author = "Pengjie Zhou",
        category = "SynthV Agent Bridge",
        versionNumber = 7,
        minEditorVersion = MIN_EDITOR_VERSION,
        type = "SidePanelSection"
    }
end

function getTranslations(_languageCode)
    return {}
end

function getSidePanelSectionState()
    local rows = {
        {
            type = "Label",
            text = text("连接状态", "Connection")
        },
        {
            type = "Container",
            columns = {
                {
                    type = "TextBox",
                    value = bridgeStatusValue,
                    width = 0.36
                },
                {
                    type = "TextBox",
                    value = clientStatusValue,
                    width = 0.36
                },
                {
                    type = "Button",
                    text = text("刷新", "Refresh"),
                    value = refreshButtonValue,
                    width = 0.28
                }
            }
        },
        {
            type = "Container",
            columns = {
                {
                    type = "TextBox",
                    value = taskStateValue,
                    width = 0.68
                },
                {
                    type = "Button",
                    text = text("诊断", "Details"),
                    value = diagnosticsButtonValue,
                    width = 0.32
                }
            }
        },
        {
            type = "Container",
            columns = {
                {
                    type = "Button",
                    text = detailedMode
                        and text("收起详细界面", "Hide details")
                        or text("展开详细界面", "Show details"),
                    value = layoutButtonValue,
                    width = 1.0
                }
            }
        }
    }

    if detailedMode then
        rows[#rows + 1] = {
            type = "Label",
            text = text("当前上下文", "Current context")
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "TextArea",
                    value = selectionValue,
                    height = 86,
                    width = 1.0
                }
            }
        }
        rows[#rows + 1] = {
            type = "Label",
            text = text("给 Codex 的指令", "Instruction for Codex")
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "TextArea",
                    value = instructionValue,
                    height = 82,
                    width = 1.0
                }
            }
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "Button",
                    text = text("复制并排队", "Copy & queue"),
                    value = submitButtonValue,
                    width = 0.52
                },
                {
                    type = "Button",
                    text = text("取消任务", "Cancel"),
                    value = cancelRequestButtonValue,
                    width = 0.28
                },
                {
                    type = "Button",
                    text = text("清空", "Clear"),
                    value = clearButtonValue,
                    width = 0.20
                }
            }
        }
    end

    if detailedMode or currentPlanId ~= nil then
        rows[#rows + 1] = {
            type = "Label",
            text = text("变更预览", "Change preview")
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "TextArea",
                    value = previewValue,
                    height = detailedMode and 152 or 96,
                    width = 1.0
                }
            }
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "Button",
                    text = text("应用", "Apply"),
                    value = applyButtonValue,
                    width = 0.5
                },
                {
                    type = "Button",
                    text = text("放弃", "Dismiss"),
                    value = dismissButtonValue,
                    width = 0.5
                }
            }
        }
    end

    if detailedMode then
        rows[#rows + 1] = {
            type = "Label",
            text = text("最近操作", "Latest activity")
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "TextArea",
                    value = activityValue,
                    height = 132,
                    width = 1.0
                }
            }
        }
        rows[#rows + 1] = {
            type = "Container",
            columns = {
                {
                    type = "Button",
                    text = text("撤销说明", "Undo help"),
                    value = undoHelpButtonValue,
                    width = 0.5
                },
                {
                    type = "Button",
                    text = text("清空记录", "Clear history"),
                    value = clearHistoryButtonValue,
                    width = 0.5
                }
            }
        }
    end

    return {
        title = SCRIPT_NAME .. " v" .. SIDEBAR_VERSION,
        rows = rows
    }
end

poll()
