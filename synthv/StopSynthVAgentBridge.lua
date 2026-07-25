-- SynthV Agent Bridge
-- Stops the persistent file-based IPC executor.
-- SPDX-License-Identifier: Apache-2.0

local BRIDGE_NAME = "SynthV Agent Bridge"
local PATH_SEPARATOR = package.config:sub(1, 1)

local function trim_trailing_separator(value)
    while #value > 1 do
        local last = value:sub(-1)
        if last ~= "/" and last ~= "\\" then
            break
        end
        value = value:sub(1, -2)
    end
    return value
end

local function resolve_ipc_directory()
    local configured = os.getenv("SYNTHV_AGENT_BRIDGE_DIR")
    if configured and configured ~= "" then
        return trim_trailing_separator(configured)
    end

    local candidates
    if PATH_SEPARATOR == "\\" then
        candidates = { os.getenv("TEMP"), os.getenv("TMP"), os.getenv("LOCALAPPDATA") }
    else
        candidates = { os.getenv("TMPDIR"), os.getenv("TMP"), os.getenv("TEMP"), "/tmp" }
    end

    for _, candidate in ipairs(candidates) do
        if candidate and candidate ~= "" then
            return trim_trailing_separator(candidate)
        end
    end
    return "."
end

function getClientInfo()
    return {
        name = "Stop SynthV Agent Bridge",
        author = "Pengjie Zhou",
        category = "SynthV Agent Bridge",
        versionNumber = 1,
        minEditorVersion = 0x020101,
    }
end

function getTranslations(_language_code)
    return {}
end

function main()
    local stop_file = resolve_ipc_directory() .. PATH_SEPARATOR .. "synthv-agent-bridge.stop"
    local file, error_message = io.open(stop_file, "wb")
    if not file then
        SV:showMessageBox(BRIDGE_NAME, "Could not request bridge shutdown: " .. tostring(error_message))
        SV:finish()
        return
    end
    file:write("stop\n")
    file:close()
    SV:showMessageBox(BRIDGE_NAME, "Shutdown requested. The bridge will stop on its next poll.")
    SV:finish()
end
