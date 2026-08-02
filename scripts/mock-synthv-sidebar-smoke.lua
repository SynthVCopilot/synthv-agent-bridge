-- Minimal SynthV host mock for the connection-only native side panel.

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

local fakeNowSeconds = os.time()
os.time = function() return fakeNowSeconds end
local now = fakeNowSeconds * 1000

local function writeBridgeStatus(updatedAt, sessionToken)
    writeFile(
        prefix .. ".status.json",
        string.format(
            '{"state":"running","updatedAtEpochMs":%d,"bridgeVersion":"0.2.0","sessionToken":"%s"}\n',
            updatedAt,
            sessionToken
        )
    )
end

writeBridgeStatus(now, "session-1")
writeFile(
    prefix .. ".sidebar.client-status.txt",
    table.concat({
        "synthv-agent-bridge-sidebar-client-status-v1",
        "state=running",
        "version=0.2.0",
        "updatedAtEpochMs=" .. tostring(now),
        ""
    }, "\n")
)

local widgetCount = 0
local failBridgeStatusOnce =
    os.getenv("SIDEBAR_TEST_FAIL_BRIDGE_STATUS_ONCE") == "1"

local function makeWidgetValue()
    widgetCount = widgetCount + 1
    local widgetIndex = widgetCount
    local widget = {
        value = "",
        enabled = true,
        callback = nil
    }
    function widget:setValue(value)
        if failBridgeStatusOnce and widgetIndex == 1 then
            failBridgeStatusOnce = false
            error("simulated Bridge-status WidgetValue failure")
        end
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

local scheduledCallback = nil
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
function SV:showMessageBoxAsync() end
function SV:setTimeout(_milliseconds, callback) scheduledCallback = callback end

assert(loadfile(sidebarScript))()

if os.getenv("SIDEBAR_TEST_FAIL_BRIDGE_STATUS_ONCE") == "1" then
    local failedRuntime = readFile(prefix .. ".sidebar.runtime-status.txt")
    assert(failedRuntime:find("state=error", 1, true), "status failure was not reported")
    assert(scheduledCallback, "status failure stopped polling")
    scheduledCallback()
    local recoveredRuntime = readFile(prefix .. ".sidebar.runtime-status.txt")
    assert(failedRuntime ~= recoveredRuntime, "successful retry did not update runtime status")
    print("CASE:sidebar-bridge-status-retried")
end

local clientInfo = getClientInfo()
assert(clientInfo.type == "SidePanelSection", "side panel client type was not registered")
assert(clientInfo.versionNumber == 10, "side panel version number was not updated")

local state = getSidePanelSectionState()
assert(state.title:find("0.2.0", 1, true), "side panel title has no version")
assert(#state.rows == 7, "connection-only side panel layout changed unexpectedly")

local bridgeStatusWidget = state.rows[1].columns[1].value
local clientStatusWidget = state.rows[2].columns[1].value
local restartBridgeWidget = state.rows[3].columns[1].value
assert(bridgeStatusWidget.value:find("checking", 1, true), "cached heartbeat appeared online")
assert(clientStatusWidget.value:find("MCP (M)", 1, true), "MCP heartbeat was not displayed")
assert(state.rows[3].columns[1].text == "Restart Bridge", "Bridge restart button was not displayed")
assert(
    state.rows[4].text == "After aborting all running scripts,",
    "first Stop All warning line changed unexpectedly"
)
assert(
    state.rows[5].text == "status stays at its last result and is unreliable.",
    "second Stop All warning line changed unexpectedly"
)
assert(
    state.rows[6].text == "Use Stop SynthV Agent Bridge",
    "first dedicated Stop guidance line changed unexpectedly"
)
assert(
    state.rows[7].text == "to stop only the Bridge.",
    "second dedicated Stop guidance line changed unexpectedly"
)
assert(not restartBridgeWidget.enabled, "Bridge restart enabled before a live handshake")

fakeNowSeconds = fakeNowSeconds + 4
assert(scheduledCallback, "Bridge handshake timeout was not scheduled")
scheduledCallback()
assert(bridgeStatusWidget.value:find("offline", 1, true), "cached heartbeat did not expire")

writeBridgeStatus(now + 5000, "session-1")
scheduledCallback()
assert(bridgeStatusWidget.value:find("Bridge (B)", 1, true), "new heartbeat was not displayed")
assert(restartBridgeWidget.enabled, "Bridge restart did not enable after a live handshake")

restartBridgeWidget.callback()
assert(
    readFile(prefix .. ".reload"):find("synthv%-agent%-bridge%-reload%-v1"),
    "Bridge restart request was not written"
)
assert(bridgeStatusWidget.value:find("restarting", 1, true), "restart state was not displayed")
assert(not restartBridgeWidget.enabled, "Bridge restart remained enabled during restart")

writeBridgeStatus(now + 6000, "session-2")
scheduledCallback()
assert(bridgeStatusWidget.value:find("Bridge (B)", 1, true), "restart handshake did not complete")
assert(restartBridgeWidget.enabled, "restart did not re-enable after the new session")

assert(widgetCount == 3, "connection-only side panel created hidden legacy widgets")
print("Mock SynthV sidebar smoke test passed")
