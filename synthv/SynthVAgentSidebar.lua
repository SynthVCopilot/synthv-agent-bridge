-- SynthV Agent Bridge connection side panel
-- SPDX-License-Identifier: Apache-2.0

local SCRIPT_NAME = "SynthV Agent"
local SIDEBAR_VERSION = "0.3.0"
local SIDEBAR_BUILD_ID = "__SYNTHV_AGENT_SIDEBAR_BUILD_ID__"
local MIN_EDITOR_VERSION = 131330 -- Synthesizer V Studio 2.1.2
local POLL_INTERVAL_MS = 500
local BRIDGE_STALE_AFTER_MS = 7000
local BRIDGE_HANDSHAKE_TIMEOUT_MS = 3000
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
local RELOAD_FILE = PREFIX .. ".reload"
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

local function lineValue(content, key)
    if not content then
        return nil
    end
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

local function freshClientStatus(content, maximumAgeMs)
    local state = lineValue(content, "state")
    local updatedAt = tonumber(lineValue(content, "updatedAtEpochMs") or "")
    if state ~= "running" or not updatedAt then
        return false
    end
    return math.max(0, os.time() * 1000 - updatedAt) <= maximumAgeMs
end

local lastRuntimeStatusSecond = -1
local lastRuntimeStatusSignature = nil

local function runtimeStatusValue(value, maximum)
    return tostring(value or "")
        :gsub("[\r\n]+", " ")
        :sub(1, maximum)
end

local function writeRuntimeStatus(state, failureMessage)
    local currentSecond = os.time()
    local signature = state .. "\0" .. runtimeStatusValue(failureMessage, 512)
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
    if failureMessage ~= nil then
        lines[#lines + 1] = "failureStage=status"
        lines[#lines + 1] = "failureMessage=" .. runtimeStatusValue(failureMessage, 512)
    end
    lines[#lines + 1] = ""
    writeFileAtomically(RUNTIME_STATUS_FILE, table.concat(lines, "\n"))
end

local bridgeStatusValue = SV:create("WidgetValue")
local clientStatusValue = SV:create("WidgetValue")
local restartBridgeButtonValue = SV:create("WidgetValue")

bridgeStatusValue:setEnabled(false)
clientStatusValue:setEnabled(false)
restartBridgeButtonValue:setEnabled(false)

local bridgeConnected = false
local initialBridgeStatus = readFile(STATUS_FILE)
local bridgeHeartbeatBaseline = jsonNumberValue(initialBridgeStatus, "updatedAtEpochMs")
local bridgeSessionBaseline = jsonStringValue(initialBridgeStatus, "sessionToken")
local bridgeHandshakeStartedAt = os.time() * 1000
local bridgePhase = "checking"
local lastStatusText = nil

local function beginBridgeHandshake(phase, bridgeStatus)
    bridgeStatus = bridgeStatus or readFile(STATUS_FILE)
    bridgeHeartbeatBaseline = jsonNumberValue(bridgeStatus, "updatedAtEpochMs")
    bridgeSessionBaseline = jsonStringValue(bridgeStatus, "sessionToken")
    bridgeHandshakeStartedAt = os.time() * 1000
    bridgePhase = phase or "checking"
    bridgeConnected = false
    restartBridgeButtonValue:setEnabled(false)
    lastStatusText = nil
end

local function updateStatus()
    local bridgeStatus = readFile(STATUS_FILE)
    local bridgeState = jsonStringValue(bridgeStatus, "state")
    local bridgeUpdatedAt = jsonNumberValue(bridgeStatus, "updatedAtEpochMs")
    local bridgeSessionToken = jsonStringValue(bridgeStatus, "sessionToken")
    local bridgeVersion = jsonStringValue(bridgeStatus, "bridgeVersion") or "?"
    local nowEpochMs = os.time() * 1000
    local bridgeAge = bridgeUpdatedAt
        and math.max(0, nowEpochMs - bridgeUpdatedAt)
        or math.huge
    local bridgeFresh = bridgeState == "running"
        and bridgeAge <= BRIDGE_STALE_AFTER_MS
    local heartbeatAdvanced = bridgeUpdatedAt ~= nil
        and (bridgeHeartbeatBaseline == nil or bridgeUpdatedAt > bridgeHeartbeatBaseline)
    local sessionChanged = bridgeSessionToken ~= nil
        and bridgeSessionBaseline ~= nil
        and bridgeSessionToken ~= bridgeSessionBaseline

    if bridgeState == "error" then
        bridgePhase = "error"
        bridgeConnected = false
    elseif not bridgeFresh then
        bridgePhase = "offline"
        bridgeConnected = false
    elseif bridgePhase == "online" then
        bridgeConnected = true
    elseif bridgePhase == "restarting"
        and (sessionChanged or (bridgeSessionBaseline == nil and heartbeatAdvanced)) then
        bridgePhase = "online"
        bridgeConnected = true
    elseif bridgePhase ~= "restarting" and (heartbeatAdvanced or sessionChanged) then
        bridgePhase = "online"
        bridgeConnected = true
    elseif nowEpochMs - bridgeHandshakeStartedAt > BRIDGE_HANDSHAKE_TIMEOUT_MS then
        bridgePhase = "offline"
        bridgeConnected = false
    else
        bridgeConnected = false
    end

    if bridgeUpdatedAt ~= nil and bridgeConnected then
        bridgeHeartbeatBaseline = bridgeUpdatedAt
        bridgeSessionBaseline = bridgeSessionToken
    end
    restartBridgeButtonValue:setEnabled(bridgeConnected)

    local clientStatus = readFile(CLIENT_STATUS_FILE)
    local clientConnected = freshClientStatus(clientStatus, 5000)
    local clientVersion = lineValue(clientStatus, "version") or "?"
    local updatedBridge
    if bridgeConnected then
        updatedBridge = string.format(
            text("● Bridge（B） · v%s", "● Bridge (B) · v%s"),
            bridgeVersion
        )
    elseif bridgePhase == "checking" then
        updatedBridge = text("◷ Bridge（B） · 检测中", "◷ Bridge (B) · checking")
    elseif bridgePhase == "restarting" then
        updatedBridge = text("◷ Bridge（B） · 重启中", "◷ Bridge (B) · restarting")
    elseif bridgePhase == "error" then
        updatedBridge = text("! Bridge（B） · 错误", "! Bridge (B) · error")
    else
        updatedBridge = text("○ Bridge（B） · 离线", "○ Bridge (B) · offline")
    end
    local updatedClient = clientConnected
        and string.format(
            text("● MCP（M） · v%s", "● MCP (M) · v%s"),
            clientVersion
        )
        or text("○ MCP（M） · 离线", "○ MCP (M) · offline")
    local updated = updatedBridge .. "\n" .. updatedClient
    if updated ~= lastStatusText then
        bridgeStatusValue:setValue(updatedBridge)
        clientStatusValue:setValue(updatedClient)
        lastStatusText = updated
    end
end

local function showMessage(message)
    safeCall(function()
        SV:showMessageBoxAsync(SCRIPT_NAME, message)
    end)
end

local function restartBridge()
    if not bridgeConnected then
        showMessage(text(
            "Bridge 尚未确认在线。请运行“脚本 → SynthV Agent Bridge → Start SynthV Agent Bridge”。",
            "Bridge is not confirmed online. Run Scripts > SynthV Agent Bridge > Start SynthV Agent Bridge."
        ))
        return
    end
    local bridgeStatus = readFile(STATUS_FILE)
    local wrote, writeError = writeFileAtomically(
        RELOAD_FILE,
        table.concat({
            "synthv-agent-bridge-reload-v1",
            "requestedAtEpochMs=" .. tostring(os.time() * 1000),
            "source=sidebar",
            ""
        }, "\n")
    )
    if not wrote then
        showMessage(text("无法请求重启 Bridge：", "Unable to request Bridge restart: ")
            .. tostring(writeError or text("未知错误", "unknown error")))
        return
    end
    beginBridgeHandshake("restarting", bridgeStatus)
    updateStatus()
end

restartBridgeButtonValue:setValueChangeCallback(restartBridge)

local function poll()
    local ok, errorMessage = pcall(updateStatus)
    if ok then
        writeRuntimeStatus("running")
    else
        writeRuntimeStatus("error", errorMessage)
    end
    SV:setTimeout(POLL_INTERVAL_MS, poll)
end

function getClientInfo()
    return {
        name = SCRIPT_NAME,
        author = "Pengjie Zhou",
        category = "SynthV Agent Bridge",
        versionNumber = 10,
        minEditorVersion = MIN_EDITOR_VERSION,
        type = "SidePanelSection"
    }
end

function getTranslations(_languageCode)
    return {}
end

function getSidePanelSectionState()
    return {
        title = string.format("SYNTHV AGENT v%s", SIDEBAR_VERSION),
        rows = {
            {
                type = "Container",
                columns = {
                    {
                        type = "TextBox",
                        value = bridgeStatusValue,
                        width = 1.0
                    }
                }
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "TextBox",
                        value = clientStatusValue,
                        width = 1.0
                    }
                }
            },
            {
                type = "Container",
                columns = {
                    {
                        type = "Button",
                        text = text("重启 Bridge", "Restart Bridge"),
                        value = restartBridgeButtonValue,
                        width = 1.0
                    }
                }
            },
            {
                type = "Label",
                text = text(
                    "中止所有运行脚本后，状态会停留在",
                    "After aborting all running scripts,"
                )
            },
            {
                type = "Label",
                text = text(
                    "最后一次结果，状态不可信。",
                    "status stays at its last result and is unreliable."
                )
            },
            {
                type = "Label",
                text = text(
                    "建议使用 Stop SynthV Agent Bridge",
                    "Use Stop SynthV Agent Bridge"
                )
            },
            {
                type = "Label",
                text = text(
                    "单独停止 Bridge。",
                    "to stop only the Bridge."
                )
            }
        }
    }
end

poll()
