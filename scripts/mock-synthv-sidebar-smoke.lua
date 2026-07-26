-- Minimal SynthV host mock for the native side-panel lifecycle.

local sidebarScript = assert(os.getenv("SIDEBAR_SCRIPT"), "SIDEBAR_SCRIPT is required")
local ipcDirectory = assert(os.getenv("SYNTHV_AGENT_BRIDGE_DIR"), "SYNTHV_AGENT_BRIDGE_DIR is required")
local separator = package.config:sub(1, 1)
local prefix = ipcDirectory .. separator .. "synthv-agent-bridge"

local function writeFile(path, content)
    local file = assert(io.open(path, "wb"))
    assert(file:write(content))
    file:close()
end

local function readFile(path)
    local file = assert(io.open(path, "rb"))
    local content = file:read("*a")
    file:close()
    return content
end

local now = os.time() * 1000
writeFile(
    prefix .. ".status.json",
    string.format(
        '{"state":"running","updatedAtEpochMs":%d,"bridgeVersion":"0.1.4"}\n',
        now
    )
)
writeFile(
    prefix .. ".sidebar.client-status.txt",
    table.concat({
        "synthv-agent-bridge-sidebar-client-status-v1",
        "state=running",
        "version=0.1.4",
        "updatedAtEpochMs=" .. tostring(now),
        ""
    }, "\n")
)
writeFile(
    prefix .. ".sidebar.state.txt",
    table.concat({
        "synthv-agent-bridge-sidebar-state-v1",
        "status=idle",
        "updatedAtEpochMs=" .. tostring(now),
        ""
    }, "\n")
)

local function makeWidgetValue()
    local widget = {
        value = "",
        enabled = true,
        callback = nil
    }
    function widget:setValue(value)
        self.value = value
    end
    function widget:getValue()
        return self.value
    end
    function widget:setEnabled(enabled)
        self.enabled = enabled
    end
    function widget:getEnabled()
        return self.enabled
    end
    function widget:setValueChangeCallback(callback)
        self.callback = callback
    end
    function widget:emit(value)
        self.value = value
        if self.callback then
            self.callback(value)
        end
    end
    return widget
end

local noteOne = {}
function noteOne:getPitch() return 60 end
function noteOne:getOnset() return 0 end
function noteOne:getEnd() return 705600000 end

local noteTwo = {}
function noteTwo:getPitch() return 67 end
function noteTwo:getOnset() return 705600000 end
function noteTwo:getEnd() return 1411200000 end

local selection = {}
function selection:getSelectedNotes() return { noteOne, noteTwo } end
function selection:getSelectedPitchControls() return { {} } end
function selection:getSelectedGroups() return {} end
function selection:registerSelectionCallback(callback) self.selectionCallback = callback end
function selection:registerClearCallback(callback) self.clearCallback = callback end

local arrangementSelection = {}
function arrangementSelection:getSelectedGroups() return {} end
function arrangementSelection:registerSelectionCallback(callback) self.selectionCallback = callback end
function arrangementSelection:registerClearCallback(callback) self.clearCallback = callback end

local group = {}
function group:getName() return "Verse" end

local reference = {}
function reference:getIndexInParent() return 1 end
function reference:isInstrumental() return false end
function reference:getTarget() return group end
function reference:getTimeOffset() return 0 end
function reference:getPitchOffset() return 0 end

local track = {}
function track:getIndexInParent() return 1 end
function track:getName() return "Lead" end

local editor = {}
function editor:getCurrentTrack() return track end
function editor:getCurrentGroup() return reference end
function editor:getSelection() return selection end

local arrangement = {}
function arrangement:getSelection() return arrangementSelection end

local scheduledCallback = nil
local clipboard = nil
local lastMessage = nil
SV = {}
function SV:getHostInfo()
    return {
        osType = package.config:sub(1, 1) == "\\" and "Windows" or "Linux",
        languageCode = "en-us"
    }
end
function SV:create(kind)
    assert(kind == "WidgetValue")
    return makeWidgetValue()
end
function SV:getMainEditor() return editor end
function SV:getArrangement() return arrangement end
function SV:blick2Quarter(value) return value / 1411200000 end
function SV:setHostClipboard(value) clipboard = value end
function SV:showMessageBoxAsync(_title, message) lastMessage = message end
function SV:setTimeout(_milliseconds, callback) scheduledCallback = callback end

assert(loadfile(sidebarScript))()

local clientInfo = getClientInfo()
assert(clientInfo.type == "SidePanelSection", "side panel client type was not registered")
assert(clientInfo.versionNumber == 4, "side panel version number was not updated")

local state = getSidePanelSectionState()
assert(state.title:find("0.1.4", 1, true), "side panel title has no version")
assert(#state.rows == 14, "unexpected side panel row count")

local bridgeStatusWidget = state.rows[2].columns[1].value
local clientStatusWidget = state.rows[2].columns[2].value
local taskStateWidget = state.rows[3].columns[1].value
local diagnosticsWidget = state.rows[3].columns[2].value
local selectionWidget = state.rows[5].columns[1].value
assert(bridgeStatusWidget.value:find("B 0.1.4", 1, true), "Bridge heartbeat was not displayed")
assert(clientStatusWidget.value:find("M 0.1.4", 1, true), "MCP heartbeat was not displayed")
assert(taskStateWidget.value:find("Idle", 1, true), "task state was not displayed")
diagnosticsWidget.callback()
assert(lastMessage and lastMessage:find("IPC:", 1, true), "diagnostics did not show the IPC path")
assert(selectionWidget.value:find("2 notes", 1, true), "selected notes were not summarized")
assert(selectionWidget.value:find("C4", 1, true), "selected pitch range was not summarized")

local instructionWidget = state.rows[7].columns[1].value
local submitWidget = state.rows[8].columns[1].value
instructionWidget:emit("Transpose the selected notes down three semitones.")
assert(submitWidget.enabled, "submit button did not enable for a non-empty instruction")
assert(submitWidget.callback, "submit callback was not registered")
submitWidget.callback()
assert(
    readFile(prefix .. ".sidebar.instruction.txt"):find("instruction%-begin"),
    "sidebar instruction was not queued"
)
assert(clipboard and clipboard:find("sidebar_get_request", 1, true), "Codex handoff was not copied")

local planId = "550e8400-e29b-41d4-a716-446655440000"
writeFile(
    prefix .. ".sidebar.preview.txt",
    table.concat({
        "synthv-agent-bridge-sidebar-preview-v1",
        "planId=" .. planId,
        "status=pending",
        "Awaiting confirmation",
        "Transpose two selected notes.",
        ""
    }, "\n")
)
assert(scheduledCallback, "side panel poll was not scheduled")
scheduledCallback()

local previewWidget = state.rows[10].columns[1].value
local applyWidget = state.rows[11].columns[1].value
assert(previewWidget.value:find("Transpose two", 1, true), "preview was not displayed")
assert(applyWidget.enabled, "Apply was not enabled for a connected pending preview")
assert(applyWidget.callback, "Apply callback was not registered")
applyWidget.callback()
local command = readFile(prefix .. ".sidebar.command.txt")
assert(command:find("operation=apply", 1, true), "Apply command was not written")
assert(command:find("planId=" .. planId, 1, true), "Apply command lost its plan ID")

print("Mock SynthV sidebar smoke test passed")
