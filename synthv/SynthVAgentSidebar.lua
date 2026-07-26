-- SynthV Agent Bridge side panel
-- Persistent review UI for Synthesizer V Studio 2 Pro.
-- SPDX-License-Identifier: Apache-2.0

local SCRIPT_NAME = "SynthV Agent"
local SIDEBAR_VERSION = "0.1.4"
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
local CLIENT_STATUS_FILE = PREFIX .. ".sidebar.client-status.txt"

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
local selectionValue = SV:create("WidgetValue")
local instructionValue = SV:create("WidgetValue")
local previewValue = SV:create("WidgetValue")
local activityValue = SV:create("WidgetValue")
local refreshButtonValue = SV:create("WidgetValue")
local submitButtonValue = SV:create("WidgetValue")
local clearButtonValue = SV:create("WidgetValue")
local applyButtonValue = SV:create("WidgetValue")
local dismissButtonValue = SV:create("WidgetValue")
local undoHelpButtonValue = SV:create("WidgetValue")

bridgeStatusValue:setEnabled(false)
clientStatusValue:setEnabled(false)
selectionValue:setEnabled(false)
previewValue:setEnabled(false)
activityValue:setEnabled(false)
instructionValue:setValue("")

local bridgeConnected = false
local clientConnected = false
local currentPlanId = nil
local currentPlanStatus = nil
local lastStatusText = nil
local lastSelectionText = nil
local lastPreviewRaw = nil
local lastActivityRaw = nil

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
        lastStatusText = updated
        bridgeStatusValue:setValue(updatedBridge)
        clientStatusValue:setValue(updatedClient)
    end
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
    lastPreviewRaw = raw
    if not raw or not raw:match("^synthv%-agent%-bridge%-sidebar%-preview%-v1\r?\n") then
        currentPlanId = nil
        currentPlanStatus = nil
        previewValue:setValue(text("暂无待确认的变更。", "No change is awaiting confirmation."))
        applyButtonValue:setEnabled(false)
        dismissButtonValue:setEnabled(false)
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

local function refreshAll()
    updateStatus()
    updateSelection()
    updatePreview()
    updateActivity()
    submitButtonValue:setEnabled(trim(tostring(instructionValue:getValue() or "")) ~= "")
end

local function showMessage(message)
    safeCall(function()
        SV:showMessageBoxAsync(SCRIPT_NAME, message)
    end)
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

    local prompt = table.concat({
        text(
            "请处理 SynthV Agent Bridge 侧边栏中刚提交的请求。",
            "Please handle the request just submitted from the SynthV Agent Bridge side panel."
        ),
        text(
            "调用 sidebar_get_request 读取请求，重新读取当前 SynthV 状态并使用最新指纹；不要直接写入工程，而是调用 sidebar_publish_preview 将一项完整变更发回侧边栏等待我确认。",
            "Call sidebar_get_request, re-read the current SynthV state and use fresh fingerprints. Do not write to the project directly; call sidebar_publish_preview with one complete change for my confirmation."
        ),
        text("请求 ID：", "Request ID: ") .. requestId,
        "",
        text("指令：", "Instruction:"),
        instruction
    }, "\n")
    SV:setHostClipboard(prompt)
    instructionValue:setValue("")
    submitButtonValue:setEnabled(false)
    activityValue:setValue(
        text(
            "请求已排队，并已复制到剪贴板。请粘贴到 Codex 发送。",
            "Request queued and copied. Paste it into Codex to send."
        )
    )
end

local function writeCommand(operation)
    if not currentPlanId then
        return
    end
    local content = table.concat({
        "synthv-agent-bridge-sidebar-command-v1",
        "operation=" .. operation,
        "planId=" .. currentPlanId,
        "createdAtEpochMs=" .. tostring(os.time() * 1000),
        ""
    }, "\n")
    local wrote, writeError = writeFileAtomically(COMMAND_FILE, content)
    if not wrote then
        showMessage(
            text("无法发送侧边栏命令：", "Unable to send the sidebar command: ")
                .. tostring(writeError)
        )
        return
    end
    applyButtonValue:setEnabled(false)
    dismissButtonValue:setEnabled(false)
    if operation == "apply" then
        previewValue:setValue(text("正在提交变更…", "Submitting the change…"))
    else
        previewValue:setValue(text("正在放弃预览…", "Dismissing the preview…"))
    end
end

refreshButtonValue:setValueChangeCallback(refreshAll)
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
        writeCommand("apply")
    end
end)
dismissButtonValue:setValueChangeCallback(function()
    if currentPlanId and currentPlanStatus ~= "applying" then
        writeCommand("dismiss")
    end
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
        versionNumber = 4,
        minEditorVersion = MIN_EDITOR_VERSION,
        type = "SidePanelSection"
    }
end

function getTranslations(_languageCode)
    return {}
end

function getSidePanelSectionState()
    return {
        title = SCRIPT_NAME .. " v" .. SIDEBAR_VERSION,
        rows = {
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
                type = "Label",
                text = text("当前上下文", "Current context")
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "TextArea",
                        value = selectionValue,
                        height = 86,
                        width = 1.0
                    }
                }
            },
            {
                type = "Label",
                text = text("给 Codex 的指令", "Instruction for Codex")
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "TextArea",
                        value = instructionValue,
                        height = 82,
                        width = 1.0
                    }
                }
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "Button",
                        text = text("复制并排队", "Copy & queue"),
                        value = submitButtonValue,
                        width = 0.72
                    },
                    {
                        type = "Button",
                        text = text("清空", "Clear"),
                        value = clearButtonValue,
                        width = 0.28
                    }
                }
            },
            {
                type = "Label",
                text = text("变更预览", "Change preview")
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "TextArea",
                        value = previewValue,
                        height = 116,
                        width = 1.0
                    }
                }
            },
            {
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
            },
            {
                type = "Label",
                text = text("最近操作", "Latest activity")
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "TextArea",
                        value = activityValue,
                        height = 96,
                        width = 1.0
                    }
                }
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "Button",
                        text = text("撤销说明", "Undo help"),
                        value = undoHelpButtonValue,
                        width = 1.0
                    }
                }
            }
        }
    }
end

refreshAll()
poll()
