-- SynthV Agent Bridge
-- Persistent, file-based IPC executor for Synthesizer V Studio 2 Pro.
-- SPDX-License-Identifier: Apache-2.0

local RUNNING_SCRIPT_FILE = nil
if debug and debug.getinfo then
    local chunkInfo = debug.getinfo(1, "S")
    local chunkSource = chunkInfo and chunkInfo.source or nil
    if type(chunkSource) == "string" and chunkSource:sub(1, 1) == "@" then
        RUNNING_SCRIPT_FILE = chunkSource:sub(2)
    end
end

local SCRIPT_NAME = "Start SynthV Agent Bridge"
local BRIDGE_VERSION = "0.1.5"
local PROTOCOL_VERSION = 1
local CURRENT_PROTOCOL_VERSION = 2
local MIN_EDITOR_VERSION = 131330 -- Synthesizer V Studio 2.1.2
local POLL_INTERVAL_MS = 25
local HEARTBEAT_EVERY_POLLS = 40
local SESSION_CHECK_EVERY_POLLS = 10
local MAX_REQUEST_BYTES = 8 * 1024 * 1024

local json = {}
local JSON_ARRAY_MT = {}
local JSON_NULL = {}
json.null = JSON_NULL

local RUNTIME_STATE_KEY = "__SYNTHV_AGENT_BRIDGE_RUNTIME_STATE"
local runtimeState = rawget(_G, RUNTIME_STATE_KEY)
if type(runtimeState) ~= "table" then
    runtimeState = {
        selectionRevision = 0,
        latestSelectionEvent = nil,
        selectionObserversRegistered = false
    }
    rawset(_G, RUNTIME_STATE_KEY, runtimeState)
end
-- Rollback plans are intentionally scoped to one loaded Bridge session. Other
-- runtime fields survive hot reload so selection observers are not duplicated.
runtimeState.rollbackTransactions = {}
runtimeState.transactionRevision = 0

local TRANSACTION_VALIDATION_SENTINEL = {}
local transactionMode = nil

function json.array(values)
    return setmetatable(values or {}, JSON_ARRAY_MT)
end

function json.isArray(value)
    return type(value) == "table" and getmetatable(value) == JSON_ARRAY_MT
end

local function isSequentialArray(value)
    if json.isArray(value) then
        return true
    end
    if type(value) ~= "table" then
        return false
    end

    local count = 0
    local maximum = 0
    for key, _ in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
            return false
        end
        count = count + 1
        if key > maximum then
            maximum = key
        end
    end
    return count > 0 and maximum == count
end

local ESCAPE_MAP = {
    ["\""] = "\\\"",
    ["\\"] = "\\\\",
    ["\b"] = "\\b",
    ["\f"] = "\\f",
    ["\n"] = "\\n",
    ["\r"] = "\\r",
    ["\t"] = "\\t"
}

local function escapeString(value)
    return value:gsub('[%z\1-\31\\"]', function(character)
        return ESCAPE_MAP[character] or string.format("\\u%04x", string.byte(character))
    end)
end

local function encodeValue(value, stack)
    local valueType = type(value)
    if value == JSON_NULL or valueType == "nil" then
        return "null"
    elseif valueType == "boolean" then
        return value and "true" or "false"
    elseif valueType == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            error("Cannot encode a non-finite number as JSON")
        end
        return tostring(value)
    elseif valueType == "string" then
        return '"' .. escapeString(value) .. '"'
    elseif valueType ~= "table" then
        error("Cannot encode Lua type " .. valueType .. " as JSON")
    end

    if stack[value] then
        error("Cannot encode cyclic tables as JSON")
    end
    stack[value] = true

    local parts = {}
    if isSequentialArray(value) then
        for index = 1, #value do
            parts[#parts + 1] = encodeValue(value[index], stack)
        end
        stack[value] = nil
        return "[" .. table.concat(parts, ",") .. "]"
    end

    local keys = {}
    for key, _ in pairs(value) do
        if type(key) ~= "string" then
            error("JSON object keys must be strings")
        end
        keys[#keys + 1] = key
    end
    table.sort(keys)

    for _, key in ipairs(keys) do
        local encoded = encodeValue(value[key], stack)
        parts[#parts + 1] = '"' .. escapeString(key) .. '":' .. encoded
    end
    stack[value] = nil
    return "{" .. table.concat(parts, ",") .. "}"
end

function json.encode(value)
    return encodeValue(value, {})
end

local function utf8FromCodepoint(codepoint)
    if codepoint < 0 or codepoint > 0x10FFFF or (codepoint >= 0xD800 and codepoint <= 0xDFFF) then
        error("Invalid Unicode code point in JSON string")
    end
    return utf8.char(codepoint)
end

function json.decode(text)
    if type(text) ~= "string" then
        error("JSON input must be a string")
    end

    local position = 1
    local length = #text

    local function fail(message)
        error(message .. " at byte " .. position)
    end

    local function skipWhitespace()
        while position <= length do
            local byte = string.byte(text, position)
            if byte == 32 or byte == 9 or byte == 10 or byte == 13 then
                position = position + 1
            else
                break
            end
        end
    end

    local parseValue

    local function parseString()
        if text:sub(position, position) ~= '"' then
            fail("Expected string")
        end
        position = position + 1
        local chunks = {}
        local chunkStart = position

        while position <= length do
            local byte = string.byte(text, position)
            if byte == 34 then
                chunks[#chunks + 1] = text:sub(chunkStart, position - 1)
                position = position + 1
                return table.concat(chunks)
            elseif byte == 92 then
                chunks[#chunks + 1] = text:sub(chunkStart, position - 1)
                position = position + 1
                if position > length then
                    fail("Unterminated escape sequence")
                end

                local escape = text:sub(position, position)
                local simple = {
                    ['"'] = '"',
                    ['\\'] = '\\',
                    ['/'] = '/',
                    ['b'] = '\b',
                    ['f'] = '\f',
                    ['n'] = '\n',
                    ['r'] = '\r',
                    ['t'] = '\t'
                }
                if simple[escape] then
                    chunks[#chunks + 1] = simple[escape]
                    position = position + 1
                elseif escape == "u" then
                    local hex = text:sub(position + 1, position + 4)
                    if #hex ~= 4 or not hex:match("^[0-9A-Fa-f]+$") then
                        fail("Invalid Unicode escape")
                    end
                    local codepoint = tonumber(hex, 16)
                    position = position + 5

                    if codepoint >= 0xD800 and codepoint <= 0xDBFF then
                        if text:sub(position, position + 1) ~= "\\u" then
                            fail("High surrogate must be followed by a low surrogate")
                        end
                        local lowHex = text:sub(position + 2, position + 5)
                        if #lowHex ~= 4 or not lowHex:match("^[0-9A-Fa-f]+$") then
                            fail("Invalid low-surrogate escape")
                        end
                        local low = tonumber(lowHex, 16)
                        if low < 0xDC00 or low > 0xDFFF then
                            fail("Invalid low surrogate")
                        end
                        codepoint = 0x10000 + (codepoint - 0xD800) * 0x400 + (low - 0xDC00)
                        position = position + 6
                    end
                    chunks[#chunks + 1] = utf8FromCodepoint(codepoint)
                else
                    fail("Invalid escape sequence")
                end
                chunkStart = position
            elseif byte < 32 then
                fail("Unescaped control character in string")
            else
                position = position + 1
            end
        end
        fail("Unterminated string")
    end

    local function parseNumber()
        local start = position
        if text:sub(position, position) == "-" then
            position = position + 1
        end

        if text:sub(position, position) == "0" then
            position = position + 1
        else
            local digitsStart = position
            while text:sub(position, position):match("%d") do
                position = position + 1
            end
            if position == digitsStart then
                fail("Invalid number")
            end
        end

        if text:sub(position, position) == "." then
            position = position + 1
            local fractionStart = position
            while text:sub(position, position):match("%d") do
                position = position + 1
            end
            if position == fractionStart then
                fail("Invalid number fraction")
            end
        end

        local exponent = text:sub(position, position)
        if exponent == "e" or exponent == "E" then
            position = position + 1
            local sign = text:sub(position, position)
            if sign == "+" or sign == "-" then
                position = position + 1
            end
            local exponentStart = position
            while text:sub(position, position):match("%d") do
                position = position + 1
            end
            if position == exponentStart then
                fail("Invalid number exponent")
            end
        end

        local number = tonumber(text:sub(start, position - 1))
        if number == nil then
            fail("Invalid number")
        end
        return number
    end

    local function parseArray()
        position = position + 1
        skipWhitespace()
        local result = json.array()
        if text:sub(position, position) == "]" then
            position = position + 1
            return result
        end

        while true do
            result[#result + 1] = parseValue()
            skipWhitespace()
            local delimiter = text:sub(position, position)
            if delimiter == "]" then
                position = position + 1
                return result
            elseif delimiter ~= "," then
                fail("Expected ',' or ']' in array")
            end
            position = position + 1
            skipWhitespace()
        end
    end

    local function parseObject()
        position = position + 1
        skipWhitespace()
        local result = {}
        if text:sub(position, position) == "}" then
            position = position + 1
            return result
        end

        while true do
            if text:sub(position, position) ~= '"' then
                fail("Expected object key")
            end
            local key = parseString()
            skipWhitespace()
            if text:sub(position, position) ~= ":" then
                fail("Expected ':' after object key")
            end
            position = position + 1
            skipWhitespace()
            result[key] = parseValue()
            skipWhitespace()
            local delimiter = text:sub(position, position)
            if delimiter == "}" then
                position = position + 1
                return result
            elseif delimiter ~= "," then
                fail("Expected ',' or '}' in object")
            end
            position = position + 1
            skipWhitespace()
        end
    end

    function parseValue()
        skipWhitespace()
        local character = text:sub(position, position)
        if character == '"' then
            return parseString()
        elseif character == "{" then
            return parseObject()
        elseif character == "[" then
            return parseArray()
        elseif character == "-" or character:match("%d") then
            return parseNumber()
        elseif text:sub(position, position + 3) == "true" then
            position = position + 4
            return true
        elseif text:sub(position, position + 4) == "false" then
            position = position + 5
            return false
        elseif text:sub(position, position + 3) == "null" then
            position = position + 4
            return JSON_NULL
        end
        fail("Unexpected token")
    end

    local value = parseValue()
    skipWhitespace()
    if position <= length then
        fail("Trailing data after JSON value")
    end
    return value
end

local function getClientHostInfo()
    local ok, hostInfo = pcall(function()
        return SV:getHostInfo()
    end)
    if ok and type(hostInfo) == "table" then
        return hostInfo
    end
    return {}
end

local HOST_INFO = getClientHostInfo()
local PATH_SEPARATOR = HOST_INFO.osType == "Windows" and "\\" or "/"

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
local REQUEST_FILE = PREFIX .. ".request.json"
local PROCESSING_FILE = PREFIX .. ".processing.json"
local RESPONSE_FILE = PREFIX .. ".response.json"
local STATUS_FILE = PREFIX .. ".status.json"
local STOP_FILE = PREFIX .. ".stop"
local RELOAD_FILE = PREFIX .. ".reload"
local INSTALL_FILE = PREFIX .. ".install.json"
local SESSION_FILE = PREFIX .. ".session.json"
local SIDEBAR_ACTIVITY_FILE = PREFIX .. ".sidebar.activity.txt"
local SIDEBAR_HISTORY_FILE = PREFIX .. ".sidebar.history.json"

math.randomseed(os.time() + math.floor(os.clock() * 1000000))
local SESSION_TOKEN = string.format("%d-%d-%06d", os.time(), math.floor(os.clock() * 1000000), math.random(0, 999999))

local function fileExists(filePath)
    local file = io.open(filePath, "rb")
    if file then
        file:close()
        return true
    end
    return false
end

local function readFile(filePath)
    local file, openError = io.open(filePath, "rb")
    if not file then
        return nil, openError
    end
    local content = file:read("*a")
    file:close()
    if #content > MAX_REQUEST_BYTES then
        return nil, "File exceeds the maximum supported request size"
    end
    return content
end

local function removeFile(filePath)
    if fileExists(filePath) then
        os.remove(filePath)
    end
end

local function writeFileAtomically(filePath, content)
    local temporary = string.format("%s.%s.%06d.tmp", filePath, SESSION_TOKEN, math.random(0, 999999))
    local file, openError = io.open(temporary, "wb")
    if not file then
        return false, openError
    end

    local ok, writeError = file:write(content)
    file:flush()
    file:close()
    if not ok then
        removeFile(temporary)
        return false, writeError
    end

    -- Lua's os.rename does not replace an existing destination on Windows.
    removeFile(filePath)
    local renamed, renameError = os.rename(temporary, filePath)
    if not renamed then
        removeFile(temporary)
        return false, renameError
    end
    return true
end

local function writeJsonAtomically(filePath, value)
    local ok, encoded = pcall(json.encode, value)
    if not ok then
        return false, encoded
    end
    return writeFileAtomically(filePath, encoded .. "\n")
end

local function readJson(filePath)
    local content, readError = readFile(filePath)
    if content == nil then
        return nil, readError
    end
    local ok, value = pcall(json.decode, content)
    if not ok then
        return nil, value
    end
    return value
end

local BRIDGE_ERROR_MT = {}

local function raiseBridgeError(code, message, details)
    error(setmetatable({
        code = code,
        message = message,
        details = details
    }, BRIDGE_ERROR_MT), 0)
end

local function isObject(value)
    return type(value) == "table" and not json.isArray(value)
end

local function isProvided(value)
    return value ~= nil and value ~= JSON_NULL
end

local function requireObject(value, name)
    if not isObject(value) then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be a JSON object")
    end
    return value
end

local function requireArray(value, name, minimum, maximum)
    if type(value) ~= "table" or not json.isArray(value) then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be a JSON array")
    end
    if minimum and #value < minimum then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must contain at least " .. minimum .. " item(s)")
    end
    if maximum and #value > maximum then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must contain no more than " .. maximum .. " item(s)")
    end
    return value
end

local function requireString(value, name, allowEmpty)
    if type(value) ~= "string" or (not allowEmpty and value == "") then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be " .. (allowEmpty and "a string" or "a non-empty string"))
    end
    return value
end

local function requireBoolean(value, name)
    if type(value) ~= "boolean" then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be a boolean")
    end
    return value
end

local function requireFiniteNumber(value, name, minimum, maximum)
    if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be a finite number")
    end
    if minimum and value < minimum then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be at least " .. minimum)
    end
    if maximum and value > maximum then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be at most " .. maximum)
    end
    return value
end

local function requireInteger(value, name, minimum, maximum)
    value = requireFiniteNumber(value, name, minimum, maximum)
    if value % 1 ~= 0 then
        raiseBridgeError("INVALID_ARGUMENT", name .. " must be an integer")
    end
    return value
end

local function optionalInteger(value, name, minimum, maximum, defaultValue)
    if not isProvided(value) then
        return defaultValue
    end
    return requireInteger(value, name, minimum, maximum)
end

local function optionalString(value, name, allowEmpty)
    if not isProvided(value) then
        return nil
    end
    return requireString(value, name, allowEmpty)
end

local function optionalNumber(value, name, minimum, maximum)
    if not isProvided(value) then
        return nil
    end
    return requireFiniteNumber(value, name, minimum, maximum)
end

local function optionalBoolean(value, name)
    if not isProvided(value) then
        return nil
    end
    return requireBoolean(value, name)
end

local function responseMode(payload)
    local mode = optionalString(payload.responseMode, "responseMode", false) or "full"
    if mode ~= "full" and mode ~= "compact" then
        raiseBridgeError("INVALID_ARGUMENT", "responseMode must be full or compact")
    end
    return mode
end

local function safeCall(callback, fallback)
    local ok, result = pcall(callback)
    if ok then
        return result
    end
    return fallback
end

local function normalizeDisplayColor(value, name)
    value = requireString(value, name, false)
    local hex = value:gsub("^#", "")
    if not hex:match("^[0-9A-Fa-f]+$") or (#hex ~= 6 and #hex ~= 8) then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            name .. " must use #RRGGBB or AARRGGBB format"
        )
    end
    if #hex == 6 then
        hex = "ff" .. hex
    end
    return hex:lower()
end

local function describeDisplayColor(raw)
    local result = {
        displayColor = raw
    }
    if type(raw) ~= "string" then
        return result
    end

    local hex = raw:gsub("^#", "")
    if not hex:match("^[0-9A-Fa-f]+$") then
        return result
    end
    if #hex == 6 then
        result.displayColorArgb = ("ff" .. hex):lower()
        result.displayColorRgb = ("#" .. hex):lower()
    elseif #hex == 8 then
        result.displayColorArgb = hex:lower()
        result.displayColorRgb = ("#" .. hex:sub(3)):lower()
    end
    return result
end

local function setDisplayColorVerified(track, color, path)
    local writeOk, writeError = pcall(function()
        track:setDisplayColor(color)
    end)
    if not writeOk then
        raiseBridgeError(
            "UNSUPPORTED_HOST_CAPABILITY",
            "This SynthV Lua host rejected the track display color",
            {
                capability = "Track.setDisplayColor",
                field = path,
                requestedArgb = color,
                cause = tostring(writeError)
            }
        )
    end

    local raw = safeCall(function()
        return track:getDisplayColor()
    end, "")
    local observed = describeDisplayColor(raw)
    if observed.displayColorArgb ~= color then
        raiseBridgeError(
            "HOST_POSTCONDITION_FAILED",
            "SynthV did not retain the requested track display color",
            {
                field = path,
                requestedArgb = color,
                actualRaw = raw,
                actualArgb = observed.displayColorArgb or JSON_NULL
            }
        )
    end

end

local function copyHostInfo()
    local result = {}
    local fields = {
        "osType",
        "osName",
        "hostName",
        "hostVersion",
        "hostVersionNumber",
        "languageCode"
    }
    for _, field in ipairs(fields) do
        if HOST_INFO[field] ~= nil then
            result[field] = HOST_INFO[field]
        end
    end
    return result
end

local function currentProjectFile()
    return safeCall(function()
        return SV:getProject():getFileName() or ""
    end, "")
end

local function writeStatus(state, message)
    local status = {
        protocolVersion = PROTOCOL_VERSION,
        protocolVersions = json.array({
            PROTOCOL_VERSION,
            CURRENT_PROTOCOL_VERSION
        }),
        preferredProtocolVersion = CURRENT_PROTOCOL_VERSION,
        state = state,
        updatedAtEpochMs = os.time() * 1000,
        bridgeVersion = BRIDGE_VERSION,
        host = copyHostInfo(),
        projectFile = currentProjectFile(),
        ipcDirectory = IPC_DIRECTORY,
        sessionToken = SESSION_TOKEN
    }
    if message then
        status.message = message
    end
    local ok, statusError = writeJsonAtomically(STATUS_FILE, status)
    if not ok then
        return false, statusError
    end
    return true
end

local function writeSessionFile()
    return writeJsonAtomically(SESSION_FILE, {
        token = SESSION_TOKEN,
        startedAtEpochMs = os.time() * 1000,
        bridgeVersion = BRIDGE_VERSION
    })
end

local function ownsSession()
    local session = readJson(SESSION_FILE)
    return isObject(session) and session.token == SESSION_TOKEN
end

local function isoTimestamp()
    return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function writeSidebarActivity(action)
    local now = os.time() * 1000
    local history = readJson(SIDEBAR_HISTORY_FILE)
    if not json.isArray(history) then history = json.array() end
    history[#history + 1] = {
        id = SESSION_TOKEN .. "-" .. tostring(now),
        status = "success",
        action = action,
        summary = action,
        updatedAtEpochMs = now
    }
    while #history > 20 do table.remove(history, 1) end
    writeJsonAtomically(SIDEBAR_HISTORY_FILE, history)

    local lines = {
        "synthv-agent-bridge-sidebar-activity-v1",
        "status=success",
        "action=" .. action,
        "updatedAtEpochMs=" .. tostring(now),
        "最近操作：已完成",
        action,
        "撤销：先点击 SynthV 主编辑区，再按 Ctrl+Z；也可使用“编辑 → 撤销”。"
    }
    if #history > 1 then
        lines[#lines + 1] = ""
        lines[#lines + 1] = "历史："
        for index = math.max(1, #history - 5), #history - 1 do
            lines[#lines + 1] = "✓ " .. tostring(history[index].summary)
        end
    end
    lines[#lines + 1] = ""
    local content = table.concat(lines, "\n")
    writeFileAtomically(SIDEBAR_ACTIVITY_FILE, content)
end

local function normalizeError(errorValue)
    if type(errorValue) == "table" and getmetatable(errorValue) == BRIDGE_ERROR_MT then
        return errorValue
    end

    local message = tostring(errorValue)
    local details = nil
    if debug and debug.traceback then
        details = { traceback = debug.traceback(message, 2) }
    end
    return {
        code = "INTERNAL_ERROR",
        message = message,
        details = details
    }
end

local function writeResponse(requestId, ok, value, wireVersion)
    if wireVersion == CURRENT_PROTOCOL_VERSION then
        local response = {
            v = CURRENT_PROTOCOL_VERSION,
            id = requestId
        }
        if ok then
            response.r = value == nil and JSON_NULL or value
        else
            response.e = {
                code = value.code or "INTERNAL_ERROR",
                message = value.message or "Unknown bridge error"
            }
            if value.details ~= nil then
                response.e.details = value.details
            end
        end
        local wrote, writeError = writeJsonAtomically(RESPONSE_FILE, response)
        if not wrote then
            writeStatus("error", "Unable to write response: " .. tostring(writeError))
        end
        return
    end

    local response = {
        protocolVersion = PROTOCOL_VERSION,
        requestId = requestId,
        completedAt = isoTimestamp(),
        ok = ok
    }
    if ok then
        response.result = value
    else
        response.error = {
            code = value.code or "INTERNAL_ERROR",
            message = value.message or "Unknown bridge error"
        }
        if value.details ~= nil then
            response.error.details = value.details
        end
    end

    local wrote, writeError = writeJsonAtomically(RESPONSE_FILE, response)
    if not wrote then
        writeStatus("error", "Unable to write response: " .. tostring(writeError))
    end
end

local function getProject()
    local project = SV:getProject()
    if not project then
        raiseBridgeError("PROJECT_UNAVAILABLE", "No Synthesizer V project is open")
    end
    return project
end

local function createUndoRecord(project)
    if transactionMode == "validate" then
        error(TRANSACTION_VALIDATION_SENTINEL, 0)
    end
    if transactionMode == "execute" then
        return
    end
    project:newUndoRecord()
end

local function resolveTrack(payload)
    local project = getProject()
    local trackIndex = requireInteger(payload.trackIndex, "trackIndex", 1, project:getNumTracks())
    local track = project:getTrack(trackIndex)
    if not track then
        raiseBridgeError("TRACK_NOT_FOUND", "Track does not exist", { trackIndex = trackIndex })
    end
    return project, track, trackIndex
end

local function resolveReference(payload)
    local project, track, trackIndex = resolveTrack(payload)
    local groupIndex = optionalInteger(payload.groupIndex, "groupIndex", 1, track:getNumGroups(), 1)
    local reference = track:getGroupReference(groupIndex)
    if not reference then
        raiseBridgeError("GROUP_NOT_FOUND", "Group reference does not exist", {
            trackIndex = trackIndex,
            groupIndex = groupIndex
        })
    end

    local instrumental = reference:isInstrumental()
    local group = instrumental and nil or reference:getTarget()

    local expectedUuid = optionalString(payload.groupUuid, "groupUuid", false)
    if expectedUuid then
        local actualUuid = group and group:getUUID() or nil
        if expectedUuid ~= actualUuid then
            raiseBridgeError("STALE_GROUP", "groupUuid no longer matches the target group", {
                expected = expectedUuid,
                actual = actualUuid or JSON_NULL,
                trackIndex = trackIndex,
                groupIndex = groupIndex
            })
        end
    end

    return project, track, trackIndex, reference, group, groupIndex
end

local function resolveGroup(payload)
    local project, track, trackIndex, reference, group, groupIndex = resolveReference(payload)
    if reference:isInstrumental() then
        raiseBridgeError("INSTRUMENTAL_GROUP", "The selected group is an instrumental audio group")
    end
    if not group then
        raiseBridgeError("GROUP_NOT_FOUND", "The selected group has no note-group target")
    end
    return project, track, trackIndex, reference, group, groupIndex
end

local function serializeMixer(track)
    local mixer = track:getMixer()
    return {
        gainDecibel = mixer:getGainDecibel(),
        pan = mixer:getPan(),
        muted = mixer:isMuted(),
        solo = mixer:isSolo()
    }
end

local function sanitizeForJson(value, seen)
    if value == nil then
        return JSON_NULL
    end

    local valueType = type(value)
    if valueType == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return JSON_NULL
        end
        return value
    elseif valueType == "string" or valueType == "boolean" then
        return value
    elseif valueType ~= "table" then
        return tostring(value)
    end

    seen = seen or {}
    if seen[value] then
        return "<cycle>"
    end
    seen[value] = true

    local result
    if isSequentialArray(value) then
        result = json.array()
        for index = 1, #value do
            result[index] = sanitizeForJson(value[index], seen)
        end
    else
        result = {}
        for key, child in pairs(value) do
            if type(key) == "string" then
                result[key] = sanitizeForJson(child, seen)
            end
        end
    end

    seen[value] = nil
    return result
end

local function makeNoteFingerprint(groupUuid, noteIndex, note, encodedAttributes)
    local lyrics = note:getLyrics() or ""
    local phonemes = note:getPhonemes() or ""
    local attributes = encodedAttributes
        or json.encode(sanitizeForJson(note:getAttributes()))
    local languageOverride = safeCall(function()
        return note:getLanguageOverride()
    end, "") or ""
    local musicalType = safeCall(function()
        return note:getMusicalType()
    end, "") or ""
    local pitchAutoMode = safeCall(function()
        return note:getPitchAutoMode()
    end, nil)
    local rapAccent = safeCall(function()
        return note:getRapAccent()
    end, "") or ""
    local retakeCount = safeCall(function()
        return note:getRetakes():getNumTakes()
    end, 0) or 0
    local parts = {
        groupUuid,
        tostring(noteIndex),
        tostring(note:getOnset()),
        tostring(note:getDuration()),
        tostring(note:getPitch()),
        tostring(note:getDetune()),
        tostring(#lyrics) .. ":" .. lyrics,
        tostring(#phonemes) .. ":" .. phonemes,
        tostring(#languageOverride) .. ":" .. languageOverride,
        tostring(#musicalType) .. ":" .. musicalType,
        tostring(pitchAutoMode),
        tostring(#rapAccent) .. ":" .. rapAccent,
        tostring(retakeCount),
        tostring(#attributes) .. ":" .. attributes
    }
    return table.concat(parts, "|")
end

local function serializeNote(group, reference, note, noteIndex)
    local groupUuid = group:getUUID()
    local sanitizedAttributes = sanitizeForJson(note:getAttributes())
    local encodedAttributes = json.encode(sanitizedAttributes)
    local localOnset = note:getOnset()
    local localEnd = note:getEnd()
    local localPitch = note:getPitch()
    local absoluteOnset = localOnset + reference:getTimeOffset()
    local absoluteEnd = localEnd + reference:getTimeOffset()
    local absolutePitch = localPitch + reference:getPitchOffset()
    local timeAxis = getProject():getTimeAxis()
    local absoluteOnsetSeconds = timeAxis:getSecondsFromBlick(absoluteOnset)
    local absoluteEndSeconds = timeAxis:getSecondsFromBlick(absoluteEnd)

    local result = {
        noteIndex = noteIndex,
        fingerprint = makeNoteFingerprint(
            groupUuid,
            noteIndex,
            note,
            encodedAttributes
        ),
        onset = localOnset,
        duration = note:getDuration(),
        endPosition = localEnd,
        pitch = localPitch,
        lyrics = note:getLyrics(),
        phonemes = note:getPhonemes(),
        detune = note:getDetune(),
        attributes = sanitizedAttributes,
        absoluteOnset = absoluteOnset,
        absoluteEnd = absoluteEnd,
        absolutePitch = absolutePitch,
        onsetQuarters = SV:blick2Quarter(localOnset),
        durationQuarters = SV:blick2Quarter(note:getDuration()),
        absoluteOnsetSeconds = absoluteOnsetSeconds,
        absoluteEndSeconds = absoluteEndSeconds,
        absoluteDurationSeconds = absoluteEndSeconds - absoluteOnsetSeconds
    }

    local languageOverride = safeCall(function()
        return note:getLanguageOverride()
    end, nil)
    if languageOverride ~= nil then
        result.languageOverride = languageOverride
    end

    local musicalType = safeCall(function()
        return note:getMusicalType()
    end, nil)
    if musicalType ~= nil then
        result.musicalType = musicalType
    end

    local pitchAutoMode = safeCall(function()
        return note:getPitchAutoMode()
    end, nil)
    if pitchAutoMode ~= nil then
        result.pitchAutoMode = pitchAutoMode
    end

    local rapAccent = safeCall(function()
        return note:getRapAccent()
    end, nil)
    if rapAccent ~= nil then
        result.rapAccent = rapAccent
    end

    local retakeCount = safeCall(function()
        return note:getRetakes():getNumTakes()
    end, nil)
    if retakeCount ~= nil then
        result.retakeCount = retakeCount
    end

    return result
end

local function countTrackNotes(track)
    local count = 0
    for groupIndex = 1, track:getNumGroups() do
        local reference = track:getGroupReference(groupIndex)
        if reference and not reference:isInstrumental() then
            local group = reference:getTarget()
            if group then
                count = count + group:getNumNotes()
            end
        end
    end
    return count
end

local function getMainGroupUuid(track)
    local reference = track:getGroupReference(1)
    if reference and not reference:isInstrumental() then
        local group = reference:getTarget()
        if group then
            return group:getUUID()
        end
    end
    return nil
end

local function makeTrackFingerprint(track)
    local mainGroupUuid = getMainGroupUuid(track)
    if mainGroupUuid then
        return "main-group:" .. mainGroupUuid
    end
    return table.concat({
        "fallback",
        track:getName() or "",
        tostring(track:getNumGroups()),
        tostring(track:getDuration())
    }, "|")
end

local function validateTrackFingerprint(track, expectedFingerprint, trackIndex)
    if transactionMode == "execute" or not expectedFingerprint then
        return
    end
    local actual = makeTrackFingerprint(track)
    if actual ~= expectedFingerprint then
        raiseBridgeError("STALE_TRACK", "trackFingerprint no longer matches trackIndex", {
            trackIndex = trackIndex,
            expected = expectedFingerprint,
            actual = actual
        })
    end
end

local function serializeMainGroupLocator(track, trackIndex)
    local reference = track:getGroupReference(1)
    if not reference or reference:isInstrumental() or not reference:getTarget() then
        return JSON_NULL
    end
    return {
        trackIndex = trackIndex,
        groupIndex = 1,
        groupUuid = reference:getTarget():getUUID()
    }
end

local function makeReferenceFingerprint(reference)
    local instrumental = reference:isInstrumental()
    local targetUuid = nil
    if not instrumental then
        local target = reference:getTarget()
        targetUuid = target and target:getUUID() or ""
    end
    return table.concat({
        instrumental and "instrumental" or "vocal",
        targetUuid or "",
        tostring(safeCall(function()
            return reference:isMain()
        end, false)),
        tostring(safeCall(function()
            return reference:isMuted()
        end, false)),
        tostring(safeCall(function()
            return reference:getTimeOffset()
        end, 0)),
        tostring(safeCall(function()
            return reference:getPitchOffset()
        end, 0)),
        tostring(safeCall(function()
            return reference:getOnset()
        end, 0)),
        tostring(safeCall(function()
            return reference:getDuration()
        end, 0)),
        json.encode(sanitizeForJson(safeCall(function()
            return reference:getVoice()
        end, {})))
    }, "|")
end

local function serializePitchControl(group, control, controlIndex)
    local position = control:getPosition()
    local pitch = control:getPitch()
    local pointsOk, rawPoints = pcall(function()
        return control:getPoints()
    end)
    local result = {
        pitchControlIndex = controlIndex,
        kind = pointsOk and "curve" or "point",
        position = position,
        pitch = pitch
    }
    if pointsOk then
        local points = json.array()
        for index = 1, #rawPoints do
            points[#points + 1] = {
                offset = rawPoints[index][1],
                value = rawPoints[index][2]
            }
        end
        result.points = points
    end
    result.fingerprint = table.concat({
        group:getUUID(),
        tostring(controlIndex),
        result.kind,
        tostring(position),
        tostring(pitch),
        result.points and json.encode(result.points) or ""
    }, "|")
    return result
end

local function serializePitchControls(group)
    local controls = json.array()
    local count = safeCall(function()
        return group:getNumPitchControls()
    end, 0)
    for controlIndex = 1, count do
        controls[#controls + 1] =
            serializePitchControl(group, group:getPitchControl(controlIndex), controlIndex)
    end
    return controls
end

local function makeLibraryGroupFingerprint(group)
    local noteFingerprints = json.array()
    for noteIndex = 1, group:getNumNotes() do
        noteFingerprints[#noteFingerprints + 1] =
            makeNoteFingerprint(group:getUUID(), noteIndex, group:getNote(noteIndex))
    end
    return json.encode({
        groupUuid = group:getUUID(),
        name = group:getName(),
        notes = noteFingerprints,
        pitchControls = serializePitchControls(group)
    })
end

local function countGroupReferences(project, group)
    local count = 0
    local groupUuid = group:getUUID()
    for trackIndex = 1, project:getNumTracks() do
        local track = project:getTrack(trackIndex)
        for groupIndex = 1, track:getNumGroups() do
            local reference = track:getGroupReference(groupIndex)
            if reference and not reference:isInstrumental() then
                local target = reference:getTarget()
                if target and target:getUUID() == groupUuid then
                    count = count + 1
                end
            end
        end
    end
    return count
end

local function serializeLibraryGroup(project, group, libraryIndex)
    return {
        libraryIndex = libraryIndex,
        groupUuid = group:getUUID(),
        fingerprint = makeLibraryGroupFingerprint(group),
        name = group:getName(),
        noteCount = group:getNumNotes(),
        pitchControlCount = safeCall(function()
            return group:getNumPitchControls()
        end, 0),
        referenceCount = countGroupReferences(project, group)
    }
end

local function serializeTrackSummary(track, trackIndex)
    local rawDisplayColor = safeCall(function()
        return track:getDisplayColor()
    end, "")
    local color = describeDisplayColor(rawDisplayColor)
    local result = {
        trackIndex = trackIndex,
        fingerprint = makeTrackFingerprint(track),
        mainGroupUuid = getMainGroupUuid(track),
        name = track:getName(),
        displayColor = color.displayColor,
        displayOrder = safeCall(function()
            return track:getDisplayOrder()
        end, trackIndex),
        duration = track:getDuration(),
        groupCount = track:getNumGroups(),
        noteCount = countTrackNotes(track),
        bounced = safeCall(function()
            return track:isBounced()
        end, false),
        mixer = serializeMixer(track)
    }
    if color.displayColorArgb then
        result.displayColorArgb = color.displayColorArgb
    end
    if color.displayColorRgb then
        result.displayColorRgb = color.displayColorRgb
    end
    return result
end

local function serializeGroup(reference, groupIndex, offset, limit)
    local result = {
        groupIndex = groupIndex,
        referenceFingerprint = makeReferenceFingerprint(reference),
        instrumental = reference:isInstrumental(),
        main = reference:isMain(),
        muted = safeCall(function()
            return reference:isMuted()
        end, false),
        timeOffset = safeCall(function()
            return reference:getTimeOffset()
        end, 0),
        pitchOffset = safeCall(function()
            return reference:getPitchOffset()
        end, 0),
        onset = safeCall(function()
            return reference:getOnset()
        end, 0),
        duration = safeCall(function()
            return reference:getDuration()
        end, 0),
        endPosition = safeCall(function()
            return reference:getEnd()
        end, 0)
    }

    if result.instrumental then
        result.noteCount = 0
        result.notes = json.array()
        result.returnedNoteOffset = 0
        result.returnedNoteCount = 0
        result.hasMore = false
        return result
    end

    local group = reference:getTarget()
    if not group then
        raiseBridgeError("GROUP_NOT_FOUND", "A vocal group reference has no target", {
            groupIndex = groupIndex
        })
    end

    local noteCount = group:getNumNotes()
    local startIndex = math.min(noteCount + 1, offset + 1)
    local endIndex = math.min(noteCount, offset + limit)
    local notes = json.array()
    for noteIndex = startIndex, endIndex do
        notes[#notes + 1] = serializeNote(group, reference, group:getNote(noteIndex), noteIndex)
    end

    result.groupUuid = group:getUUID()
    result.name = group:getName()
    result.noteCount = noteCount
    result.pitchControlCount = safeCall(function()
        return group:getNumPitchControls()
    end, 0)
    result.voice = safeCall(function()
        return reference:getVoice()
    end, {})
    result.returnedNoteOffset = offset
    result.returnedNoteCount = #notes
    result.hasMore = endIndex < noteCount
    result.notes = notes
    return result
end

local GROUP_VOICE_PARAMETERS = {
    loudness = { hostKey = "paramLoudness", minimum = -48, maximum = 12 },
    tension = { hostKey = "paramTension", minimum = -1, maximum = 1 },
    breathiness = { hostKey = "paramBreathiness", minimum = -1, maximum = 1 },
    gender = { hostKey = "paramGender", minimum = -1, maximum = 1 },
    toneShift = { hostKey = "paramToneShift", minimum = -1, maximum = 1 }
}

local function valueOrNull(value)
    if value == nil then
        return JSON_NULL
    end
    return value
end

local function inspectPhonemeCapabilities(group)
    if group:getNumNotes() < 1 then
        return {
            strengthRetained = JSON_NULL,
            reason = "no_notes"
        }
    end
    local ok, retained = pcall(function()
        local candidate = group:getNote(1):clone()
        local rawAttributes = candidate:getAttributes()
        if type(rawAttributes) ~= "table" then
            rawAttributes = {}
        end
        local phonemes = json.array()
        if type(rawAttributes.phonemes) == "table" then
            phonemes = sanitizeForJson(rawAttributes.phonemes)
        end
        if type(phonemes[1]) ~= "table" then
            phonemes[1] = {}
        end
        local current = type(phonemes[1].strength) == "number"
            and phonemes[1].strength
            or 1
        local probe = current <= 0.9 and 1.2 or 0.8
        phonemes[1].strength = probe
        candidate:setAttributes({ phonemes = phonemes })
        local retainedAttributes = candidate:getAttributes()
        local retainedPhonemes = type(retainedAttributes) == "table"
            and retainedAttributes.phonemes
            or nil
        local actual = type(retainedPhonemes) == "table"
            and type(retainedPhonemes[1]) == "table"
            and retainedPhonemes[1].strength
            or nil
        return type(actual) == "number" and math.abs(actual - probe) <= 0.000001
    end)
    if not ok then
        return {
            strengthRetained = false,
            reason = "host_rejected_probe"
        }
    end
    return {
        strengthRetained = retained == true,
        reason = retained == true and "verified_on_clone" or "host_changed_value"
    }
end

local function serializeGroupVoice(reference, trackIndex, groupIndex)
    if reference:isInstrumental() then
        raiseBridgeError("INVALID_ARGUMENT", "Instrumental references do not expose vocal voice properties")
    end
    local group = reference:getTarget()
    if not group then
        raiseBridgeError("GROUP_NOT_FOUND", "A vocal group reference has no target", {
            trackIndex = trackIndex,
            groupIndex = groupIndex
        })
    end

    local rawVoice = safeCall(function()
        return reference:getVoice()
    end, {})
    if type(rawVoice) ~= "table" then
        rawVoice = {}
    end

    local parameters = {}
    for publicName, definition in pairs(GROUP_VOICE_PARAMETERS) do
        parameters[publicName] = valueOrNull(rawVoice[definition.hostKey])
    end

    local rawVocalModes = rawVoice.vocalModeParams
    local vocalModes = {}
    if type(rawVocalModes) == "table" then
        vocalModes = sanitizeForJson(rawVocalModes)
    end

    local singersPresent = type(rawVoice.singers) == "number"
    local spacingPresent = type(rawVoice.spacing) == "number"
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        referenceFingerprint = makeReferenceFingerprint(reference),
        parameters = parameters,
        vocalModes = vocalModes,
        experimentalUnison = {
            documented = false,
            singersFieldPresent = singersPresent,
            spacingFieldPresent = spacingPresent,
            singers = singersPresent and rawVoice.singers or JSON_NULL,
            spacing = spacingPresent and rawVoice.spacing or JSON_NULL
        },
        phonemeCapabilities = inspectPhonemeCapabilities(group),
        rawVoice = sanitizeForJson(rawVoice)
    }
end

local function numbersMatch(left, right)
    return type(left) == "number"
        and type(right) == "number"
        and math.abs(left - right) <= 0.000001
end

local function jsonValuesMatch(expected, actual, path)
    local expectedType = type(expected)
    local actualType = type(actual)
    if expectedType == "number" or actualType == "number" then
        if numbersMatch(expected, actual) then
            return true
        end
        return false, path, expected, actual
    end
    if expectedType ~= actualType then
        return false, path, expected, actual
    end
    if expectedType ~= "table" then
        if expected == actual then
            return true
        end
        return false, path, expected, actual
    end
    for key, expectedChild in pairs(expected) do
        local childPath = path .. "." .. tostring(key)
        if actual[key] == nil then
            return false, childPath, expectedChild, nil
        end
        local matches, mismatchPath, expectedValue, actualValue =
            jsonValuesMatch(expectedChild, actual[key], childPath)
        if not matches then
            return false, mismatchPath, expectedValue, actualValue
        end
    end
    for key, actualChild in pairs(actual) do
        if expected[key] == nil then
            return false, path .. "." .. tostring(key), nil, actualChild
        end
    end
    return true
end

local function verifyVocalModeSnapshot(rawVoice, expectedModes, errorCode)
    if expectedModes == nil then
        return
    end
    local actualModes = type(rawVoice) == "table"
        and sanitizeForJson(rawVoice.vocalModeParams)
        or nil
    local matches, field, expectedValue, actualValue =
        jsonValuesMatch(expectedModes, actualModes, "vocalModes")
    if not matches then
        raiseBridgeError(
            errorCode,
            "SynthV changed an unrequested Vocal Mode value",
            {
                field = field,
                expectedValue = valueOrNull(expectedValue),
                actualValue = valueOrNull(actualValue)
            }
        )
    end
end

local function verifyGroupVoiceChecks(rawVoice, checks, errorCode)
    if type(rawVoice) ~= "table" then
        raiseBridgeError(errorCode, "SynthV did not return voice properties after the update")
    end
    for index = 1, #checks do
        local check = checks[index]
        local actual
        if check.kind == "parameter" or check.kind == "unison" then
            actual = rawVoice[check.hostKey]
        else
            local vocalModes = rawVoice.vocalModeParams
            local mode = type(vocalModes) == "table" and vocalModes[check.modeName] or nil
            actual = type(mode) == "table" and mode[check.axis] or nil
        end
        if not numbersMatch(actual, check.expected) then
            raiseBridgeError(
                check.experimental and "UNSUPPORTED_HOST_CAPABILITY" or errorCode,
                "SynthV did not retain a requested group voice value",
                {
                    field = check.path,
                    requestedValue = check.expected,
                    actualValue = valueOrNull(actual),
                    experimental = check.experimental or false
                }
            )
        end
    end
end

local function prepareGroupVoiceUpdate(reference, payload)
    local currentVoice = safeCall(function()
        return reference:getVoice()
    end, {})
    if type(currentVoice) ~= "table" then
        currentVoice = {}
    end

    local voiceUpdate = {}
    local checks = {}
    local expectedVocalModes = nil
    local completeVocalModeUpdate = nil

    if isProvided(payload.parameters) then
        local parameters = requireObject(payload.parameters, "parameters")
        for key, _value in pairs(parameters) do
            if not GROUP_VOICE_PARAMETERS[key] then
                raiseBridgeError("INVALID_ARGUMENT", "parameters contains an unsupported field", {
                    field = key
                })
            end
        end
        for publicName, definition in pairs(GROUP_VOICE_PARAMETERS) do
            if isProvided(parameters[publicName]) then
                local value = requireFiniteNumber(
                    parameters[publicName],
                    "parameters." .. publicName,
                    definition.minimum,
                    definition.maximum
                )
                voiceUpdate[definition.hostKey] = value
                checks[#checks + 1] = {
                    kind = "parameter",
                    hostKey = definition.hostKey,
                    expected = value,
                    path = "parameters." .. publicName
                }
            end
        end
    end

    if isProvided(payload.vocalModes) then
        local updates = requireArray(payload.vocalModes, "vocalModes", 1, 64)
        local currentModes = currentVoice.vocalModeParams
        if type(currentModes) ~= "table" then
            raiseBridgeError(
                "UNSUPPORTED_HOST_CAPABILITY",
                "The current voice does not expose Vocal Mode properties"
            )
        end
        local mergedModes = sanitizeForJson(currentModes)
        local sparseModes = {}
        local seenModes = {}
        for index = 1, #updates do
            local path = "vocalModes[" .. index .. "]"
            local update = requireObject(updates[index], path)
            for key, _value in pairs(update) do
                if key ~= "name" and key ~= "pitch" and key ~= "timbre" and key ~= "pronunciation" then
                    raiseBridgeError("INVALID_ARGUMENT", path .. " contains an unsupported field", {
                        field = key
                    })
                end
            end
            local modeName = requireString(update.name, path .. ".name", false)
            if seenModes[modeName] then
                raiseBridgeError("INVALID_ARGUMENT", "The same Vocal Mode appears more than once", {
                    name = modeName
                })
            end
            seenModes[modeName] = true
            local currentMode = currentModes[modeName]
            if type(currentMode) ~= "table" then
                raiseBridgeError("VOCAL_MODE_NOT_FOUND", "The current voice does not expose this Vocal Mode", {
                    name = modeName
                })
            end
            local mergedMode = sanitizeForJson(currentMode)
            local sparseMode = {}
            local changed = false
            for _, axis in ipairs({ "pitch", "timbre", "pronunciation" }) do
                if isProvided(update[axis]) then
                    local value = requireFiniteNumber(update[axis], path .. "." .. axis, 0)
                    sparseMode[axis] = value
                    mergedMode[axis] = value
                    checks[#checks + 1] = {
                        kind = "vocalMode",
                        modeName = modeName,
                        axis = axis,
                        expected = value,
                        path = path .. "." .. axis
                    }
                    changed = true
                end
            end
            if not changed then
                raiseBridgeError("INVALID_ARGUMENT", path .. " must change at least one Vocal Mode axis")
            end
            sparseModes[modeName] = sparseMode
            mergedModes[modeName] = mergedMode
        end
        voiceUpdate.vocalModeParams = sparseModes
        expectedVocalModes = mergedModes
        completeVocalModeUpdate = mergedModes
    end

    if isProvided(payload.experimentalUnison) then
        local unison = requireObject(payload.experimentalUnison, "experimentalUnison")
        for key, _value in pairs(unison) do
            if key ~= "singers" and key ~= "spacing" then
                raiseBridgeError("INVALID_ARGUMENT", "experimentalUnison contains an unsupported field", {
                    field = key
                })
            end
        end
        if isProvided(unison.singers) then
            if type(currentVoice.singers) ~= "number" then
                raiseBridgeError(
                    "UNSUPPORTED_HOST_CAPABILITY",
                    "The current SynthV host does not return the experimental singers field"
                )
            end
            local singers = requireInteger(unison.singers, "experimentalUnison.singers", 1, 128)
            voiceUpdate.singers = singers
            checks[#checks + 1] = {
                kind = "unison",
                hostKey = "singers",
                expected = singers,
                path = "experimentalUnison.singers",
                experimental = true
            }
        end
        if isProvided(unison.spacing) then
            if type(currentVoice.spacing) ~= "number" then
                raiseBridgeError(
                    "UNSUPPORTED_HOST_CAPABILITY",
                    "The current SynthV host does not return the experimental spacing field"
                )
            end
            local spacing = requireFiniteNumber(unison.spacing, "experimentalUnison.spacing", 0, 1)
            voiceUpdate.spacing = spacing
            checks[#checks + 1] = {
                kind = "unison",
                hostKey = "spacing",
                expected = spacing,
                path = "experimentalUnison.spacing",
                experimental = true
            }
        end
    end

    if next(voiceUpdate) == nil then
        raiseBridgeError("INVALID_ARGUMENT", "At least one group voice field must be supplied")
    end

    local function validateCandidate(candidateUpdate)
        local candidate = reference:clone()
        local valid, validationError = pcall(function()
            candidate:setVoice(candidateUpdate)
        end)
        if not valid then
            return false, setmetatable({
                code = "INVALID_ARGUMENT",
                message = "SynthV rejected the requested group voice changes",
                details = {
                    cause = tostring(validationError)
                }
            }, BRIDGE_ERROR_MT)
        end
        local candidateVoice = safeCall(function()
            return candidate:getVoice()
        end, nil)
        local verified, verificationError = pcall(function()
            verifyGroupVoiceChecks(candidateVoice, checks, "HOST_POSTCONDITION_FAILED")
            verifyVocalModeSnapshot(
                candidateVoice,
                expectedVocalModes,
                "HOST_POSTCONDITION_FAILED"
            )
        end)
        if not verified then
            return false, verificationError
        end
        return true
    end

    local valid, validationError = validateCandidate(voiceUpdate)
    if not valid and completeVocalModeUpdate ~= nil then
        local completeUpdate = {}
        for key, value in pairs(voiceUpdate) do
            completeUpdate[key] = value
        end
        completeUpdate.vocalModeParams = completeVocalModeUpdate
        local completeValid, completeError = validateCandidate(completeUpdate)
        if completeValid then
            return completeUpdate, checks, expectedVocalModes
        end
        validationError = completeError or validationError
    end
    if not valid then
        error(validationError, 0)
    end

    return voiceUpdate, checks, expectedVocalModes
end

local function serializeAutomation(group, parameterName)
    local ok, automationOrError = pcall(function()
        return group:getParameter(parameterName)
    end)
    if not ok or not automationOrError then
        raiseBridgeError("PARAMETER_NOT_FOUND", "SynthV does not expose this automation parameter", {
            parameter = parameterName,
            cause = ok and nil or tostring(automationOrError)
        })
    end

    local automation = automationOrError
    local definition = automation:getDefinition()
    local rawPoints = automation:getAllPoints()
    local points = json.array()
    for index = 1, #rawPoints do
        local point = rawPoints[index]
        points[#points + 1] = {
            position = point[1],
            value = point[2]
        }
    end

    local parameterType = automation:getType()
    local interpolation = automation:getInterpolationMethod()
    local fingerprint = table.concat({
        group:getUUID(),
        parameterType,
        interpolation,
        json.encode(points)
    }, "|")

    return automation, {
        parameter = parameterType,
        interpolation = interpolation,
        definition = definition,
        fingerprint = fingerprint,
        pointCount = #points,
        points = points
    }
end

local function serializeTimeAxis(timeAxis)
    local rawTempoMarks = timeAxis:getAllTempoMarks()
    local tempoMarks = json.array()
    for index = 1, #rawTempoMarks do
        local mark = rawTempoMarks[index]
        tempoMarks[#tempoMarks + 1] = {
            position = mark.position,
            positionSeconds = mark.positionSeconds,
            bpm = mark.bpm
        }
    end

    local rawMeasureMarks = timeAxis:getAllMeasureMarks()
    local measureMarks = json.array()
    for index = 1, #rawMeasureMarks do
        local mark = rawMeasureMarks[index]
        measureMarks[#measureMarks + 1] = {
            measure = mark.position,
            position = mark.position,
            positionBlick = mark.positionBlick,
            numerator = mark.numerator,
            denominator = mark.denominator
        }
    end

    return {
        fingerprint = json.encode({
            tempoMarks = tempoMarks,
            measureMarks = measureMarks
        }),
        tempoMarkCount = #tempoMarks,
        tempoMarks = tempoMarks,
        measureMarkCount = #measureMarks,
        measureMarks = measureMarks
    }
end

local function validateExpectedFingerprint(actual, expected, staleCode, message)
    if transactionMode ~= "execute" and expected and actual ~= expected then
        raiseBridgeError(staleCode, message, {
            expected = expected,
            actual = actual
        })
    end
end

local function validateReferenceFingerprint(reference, expected, trackIndex, groupIndex)
    if transactionMode == "execute" or not expected then
        return
    end
    local actual = makeReferenceFingerprint(reference)
    if actual ~= expected then
        raiseBridgeError("STALE_GROUP_REFERENCE", "The group reference changed after it was read", {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            expected = expected,
            actual = actual
        })
    end
end

local function resolveLibraryGroup(payload)
    local project = getProject()
    local group = nil
    local libraryIndex = nil
    if isProvided(payload.groupUuid) then
        local groupUuid = requireString(payload.groupUuid, "groupUuid", false)
        group = safeCall(function()
            return project:getNoteGroup(groupUuid)
        end, nil)
        if group then
            libraryIndex = safeCall(function()
                return group:getIndexInParent()
            end, nil)
        end
    elseif isProvided(payload.libraryIndex) then
        libraryIndex = requireInteger(
            payload.libraryIndex,
            "libraryIndex",
            1,
            project:getNumNoteGroupsInLibrary()
        )
        group = project:getNoteGroup(libraryIndex)
    else
        raiseBridgeError("INVALID_ARGUMENT", "Supply groupUuid or libraryIndex")
    end

    if not group then
        raiseBridgeError("GROUP_NOT_FOUND", "The note group is not present in the project library")
    end
    if not libraryIndex then
        local groupUuid = group:getUUID()
        for index = 1, project:getNumNoteGroupsInLibrary() do
            if project:getNoteGroup(index):getUUID() == groupUuid then
                libraryIndex = index
                break
            end
        end
    end

    validateExpectedFingerprint(
        makeLibraryGroupFingerprint(group),
        optionalString(payload.expectedFingerprint, "expectedFingerprint", false),
        "STALE_LIBRARY_GROUP",
        "The library note group changed after it was read"
    )
    return project, group, libraryIndex
end

local function resolvePitchControl(payload)
    local project, track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local count = group:getNumPitchControls()
    local controlIndex = requireInteger(payload.pitchControlIndex, "pitchControlIndex", 1, count)
    local control = group:getPitchControl(controlIndex)
    local serialized = serializePitchControl(group, control, controlIndex)
    validateExpectedFingerprint(
        serialized.fingerprint,
        optionalString(payload.fingerprint, "fingerprint", false),
        "STALE_PITCH_CONTROL",
        "The pitch control changed after it was read"
    )
    return project, track, trackIndex, reference, group, groupIndex, control, controlIndex, serialized
end

local function locateReference(reference)
    if not reference then
        return nil
    end

    local parentTrack = safeCall(function()
        return reference:getParent()
    end, nil)
    if parentTrack then
        local trackIndex = safeCall(function()
            return parentTrack:getIndexInParent()
        end, nil)
        local groupIndex = safeCall(function()
            return reference:getIndexInParent()
        end, nil)
        if trackIndex and groupIndex then
            return {
                trackIndex = trackIndex,
                groupIndex = groupIndex,
                groupUuid = reference:isInstrumental() and nil or reference:getTarget():getUUID(),
                instrumental = reference:isInstrumental(),
                main = reference:isMain()
            }
        end
    end

    local project = getProject()
    for trackIndex = 1, project:getNumTracks() do
        local track = project:getTrack(trackIndex)
        for groupIndex = 1, track:getNumGroups() do
            local candidate = track:getGroupReference(groupIndex)
            if candidate == reference then
                return {
                    trackIndex = trackIndex,
                    groupIndex = groupIndex,
                    groupUuid = candidate:isInstrumental() and nil or candidate:getTarget():getUUID(),
                    instrumental = candidate:isInstrumental(),
                    main = candidate:isMain()
                }
            end
        end
    end
    return nil
end

local function locatorsMatch(left, right)
    if not left or not right then
        return false
    end
    return left.trackIndex == right.trackIndex
        and left.groupIndex == right.groupIndex
        and left.groupUuid == right.groupUuid
end

local function getTargetSelectionContext(reference, group)
    local target = locateReference(reference)
    local mainEditor = SV:getMainEditor()
    local currentReference = safeCall(function()
        return mainEditor:getCurrentGroup()
    end, nil)
    local current = locateReference(currentReference)
    local pianoRollSelected = false
    local arrangementSelected = false
    local selectedNoteIndices = {}

    local pianoRollSelection = safeCall(function()
        return mainEditor:getSelection()
    end, nil)
    if pianoRollSelection then
        local selectedGroups = safeCall(function()
            return pianoRollSelection:getSelectedGroups()
        end, {})
        for index = 1, #selectedGroups do
            if locatorsMatch(target, locateReference(selectedGroups[index])) then
                pianoRollSelected = true
                break
            end
        end
        if group and locatorsMatch(target, current) then
            local selectedNotes = safeCall(function()
                return pianoRollSelection:getSelectedNotes()
            end, {})
            for index = 1, #selectedNotes do
                local noteIndex = safeCall(function()
                    return selectedNotes[index]:getIndexInParent()
                end, nil)
                if type(noteIndex) == "number" then
                    selectedNoteIndices[noteIndex] = true
                end
            end
        end
    end

    local arrangementSelection = safeCall(function()
        return SV:getArrangement():getSelection()
    end, nil)
    if arrangementSelection then
        local selectedGroups = safeCall(function()
            return arrangementSelection:getSelectedGroups()
        end, {})
        for index = 1, #selectedGroups do
            if locatorsMatch(target, locateReference(selectedGroups[index])) then
                arrangementSelected = true
                break
            end
        end
    end

    local selectedNoteCount = 0
    for _noteIndex, _selected in pairs(selectedNoteIndices) do
        selectedNoteCount = selectedNoteCount + 1
    end
    local currentEditorGroup = locatorsMatch(target, current)
    return {
        currentEditorGroup = currentEditorGroup,
        pianoRollGroupSelected = pianoRollSelected,
        arrangementGroupSelected = arrangementSelected,
        targetGroupSelected =
            currentEditorGroup or pianoRollSelected or arrangementSelected,
        selectedNoteCount = selectedNoteCount
    }, selectedNoteIndices
end

local function validateCurrentEditorGroupGuard(payload, reference, group)
    local requireCurrentEditorGroup =
        optionalBoolean(payload.requireCurrentEditorGroup, "requireCurrentEditorGroup")
    local context, selectedNoteIndices = getTargetSelectionContext(reference, group)
    if requireCurrentEditorGroup == true and not context.currentEditorGroup then
        raiseBridgeError(
            "SELECTION_MISMATCH",
            "The target group is not the current piano-roll group",
            {
                target = locateReference(reference),
                selectionContext = context
            }
        )
    end
    return context, selectedNoteIndices
end

local function validateFingerprint(group, noteIndex, expectedFingerprint)
    local noteCount = group:getNumNotes()
    requireInteger(noteIndex, "noteIndex", 1, noteCount)
    local note = group:getNote(noteIndex)
    if transactionMode == "execute" then
        return note
    end
    local actual = makeNoteFingerprint(group:getUUID(), noteIndex, note)
    if actual ~= expectedFingerprint then
        raiseBridgeError("STALE_NOTE", "The note changed after it was read; read the group again before writing", {
            noteIndex = noteIndex,
            expected = expectedFingerprint,
            actual = actual
        })
    end
    return note
end

local NOTE_CHANGE_KEYS = {
    onset = true,
    duration = true,
    pitch = true,
    lyrics = true,
    phonemes = true,
    detune = true,
    languageOverride = true,
    musicalType = true,
    pitchAutoMode = true,
    rapAccent = true,
    attributes = true
}

local function applyPitchAutoMode(note, value, path)
    local readOk, currentValue = pcall(function()
        return note:getPitchAutoMode()
    end)
    if readOk and type(currentValue) == "boolean" and currentValue == value then
        return
    end

    local setterAvailable = safeCall(function()
        return type(note.setPitchAutoMode) == "function"
    end, false)
    if not setterAvailable then
        raiseBridgeError(
            "UNSUPPORTED_HOST_CAPABILITY",
            "This SynthV Lua host cannot change pitchAutoMode",
            {
                capability = "Note.setPitchAutoMode",
                field = path,
                requestedValue = value,
                currentValue = readOk and currentValue or JSON_NULL
            }
        )
    end

    local writeOk, writeError = pcall(function()
        note:setPitchAutoMode(value)
    end)
    if not writeOk then
        raiseBridgeError(
            "UNSUPPORTED_HOST_CAPABILITY",
            "This SynthV Lua host rejected a pitchAutoMode change",
            {
                capability = "Note.setPitchAutoMode",
                field = path,
                requestedValue = value,
                cause = tostring(writeError)
            }
        )
    end

    local verifyOk, actualValue = pcall(function()
        return note:getPitchAutoMode()
    end)
    if verifyOk and type(actualValue) == "boolean" and actualValue ~= value then
        raiseBridgeError(
            "HOST_POSTCONDITION_FAILED",
            "SynthV did not retain the requested pitchAutoMode value",
            {
                capability = "Note.setPitchAutoMode",
                field = path,
                requestedValue = value,
                actualValue = actualValue
            }
        )
    end
end

local function applyPreparedNoteChanges(note, changes, path)
    if changes.onset ~= nil and changes.duration ~= nil then
        note:setTimeRange(changes.onset, changes.duration)
    else
        if changes.onset ~= nil then
            note:setOnset(changes.onset)
        end
        if changes.duration ~= nil then
            note:setDuration(changes.duration)
        end
    end
    if changes.pitch ~= nil then
        note:setPitch(changes.pitch)
    end
    if changes.lyrics ~= nil then
        note:setLyrics(changes.lyrics)
    end
    if changes.phonemes ~= nil then
        note:setPhonemes(changes.phonemes)
    end
    if changes.detune ~= nil then
        note:setDetune(changes.detune)
    end
    if changes.languageOverride ~= nil then
        note:setLanguageOverride(changes.languageOverride)
    end
    if changes.musicalType ~= nil then
        note:setMusicalType(changes.musicalType)
    end
    if changes.pitchAutoMode ~= nil then
        applyPitchAutoMode(note, changes.pitchAutoMode, path .. ".pitchAutoMode")
    end
    if changes.rapAccent ~= nil then
        note:setRapAccent(changes.rapAccent)
    end
    if changes.attributes ~= nil then
        note:setAttributes(changes.attributes)
    end
end

local function prepareNoteChanges(note, changes, path)
    changes = requireObject(changes, path)
    for key, _value in pairs(changes) do
        if not NOTE_CHANGE_KEYS[key] then
            raiseBridgeError("INVALID_ARGUMENT", path .. " contains an unsupported field", {
                field = key
            })
        end
    end

    local prepared = {}
    if isProvided(changes.onset) then
        prepared.onset = requireInteger(changes.onset, path .. ".onset", 0)
    end
    if isProvided(changes.duration) then
        prepared.duration = requireInteger(changes.duration, path .. ".duration", 1)
    end
    if isProvided(changes.pitch) then
        prepared.pitch = requireInteger(changes.pitch, path .. ".pitch", 0, 127)
    end
    if isProvided(changes.lyrics) then
        prepared.lyrics = requireString(changes.lyrics, path .. ".lyrics", true)
    end
    if isProvided(changes.phonemes) then
        prepared.phonemes = requireString(changes.phonemes, path .. ".phonemes", true)
    end
    if isProvided(changes.detune) then
        prepared.detune = requireFiniteNumber(changes.detune, path .. ".detune")
    end
    if isProvided(changes.languageOverride) then
        local languageOverride = requireString(changes.languageOverride, path .. ".languageOverride", true)
        local allowedLanguages = {
            [""] = true,
            mandarin = true,
            japanese = true,
            english = true,
            cantonese = true
        }
        if not allowedLanguages[languageOverride] then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".languageOverride is unsupported")
        end
        prepared.languageOverride = languageOverride
    end
    if isProvided(changes.musicalType) then
        local musicalType = requireString(changes.musicalType, path .. ".musicalType", false)
        if musicalType ~= "sing" and musicalType ~= "rap" then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".musicalType must be sing or rap")
        end
        prepared.musicalType = musicalType
    end
    if isProvided(changes.pitchAutoMode) then
        prepared.pitchAutoMode = requireBoolean(changes.pitchAutoMode, path .. ".pitchAutoMode")
    end
    if isProvided(changes.rapAccent) then
        local rapAccent = requireString(changes.rapAccent, path .. ".rapAccent", true)
        if rapAccent ~= "" and not rapAccent:match("^[1-5]$") then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".rapAccent must be empty or 1..5")
        end
        prepared.rapAccent = rapAccent
    end
    if isProvided(changes.attributes) then
        prepared.attributes = requireObject(changes.attributes, path .. ".attributes")
    end

    if next(prepared) == nil then
        raiseBridgeError("INVALID_ARGUMENT", "Each edit must contain at least one changed field")
    end

    -- Validate the complete mutation against SynthV before creating an undo
    -- record or touching any project-owned note. This keeps a malformed batch
    -- from partially applying when a later setter rejects a value.
    local candidate = note:clone()
    local ok, validationError = pcall(function()
        applyPreparedNoteChanges(candidate, prepared, path)
    end)
    if not ok then
        if type(validationError) == "table" and getmetatable(validationError) == BRIDGE_ERROR_MT then
            error(validationError, 0)
        end
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested note changes", {
            cause = tostring(validationError)
        })
    end

    return prepared
end

local PHONEME_ATTRIBUTE_KEYS = {
    leftOffset = true,
    position = true,
    activity = true,
    strength = true
}

local function preparePhonemeAttributes(value, path)
    local input = requireArray(value, path, 0, 256)
    local result = json.array()
    for index = 1, #input do
        local attributePath = path .. "[" .. index .. "]"
        local attribute = requireObject(input[index], attributePath)
        local prepared = {}
        for key, rawValue in pairs(attribute) do
            if not PHONEME_ATTRIBUTE_KEYS[key] then
                raiseBridgeError("INVALID_ARGUMENT", attributePath .. " contains an unsupported field", {
                    field = key
                })
            end
            prepared[key] = requireFiniteNumber(rawValue, attributePath .. "." .. key)
        end
        if next(prepared) == nil then
            raiseBridgeError("INVALID_ARGUMENT", attributePath .. " must change at least one field")
        end
        result[#result + 1] = prepared
    end
    return result
end

local function verifyPhonemePostconditions(note, prepared, path, phase)
    local function fail(field, requestedValue, actualValue)
        raiseBridgeError(
            "HOST_POSTCONDITION_FAILED",
            "SynthV did not retain a requested phoneme property",
            {
                capability = "Note.phonemeProperties",
                field = field,
                phase = phase,
                requestedValue = valueOrNull(requestedValue),
                actualValue = valueOrNull(actualValue)
            }
        )
    end

    if prepared.phonemes ~= nil then
        local actual = note:getPhonemes()
        if actual ~= prepared.phonemes then
            fail(path .. ".phonemeSequence", prepared.phonemes, actual)
        end
    end
    if prepared.languageOverride ~= nil then
        local actual = safeCall(function()
            return note:getLanguageOverride()
        end, nil)
        if actual ~= prepared.languageOverride then
            fail(path .. ".languageOverride", prepared.languageOverride, actual)
        end
    end
    if prepared.attributes == nil then
        return
    end

    local actualAttributes = note:getAttributes()
    if type(actualAttributes) ~= "table" then
        fail(path .. ".attributes", prepared.attributes, actualAttributes)
    end
    for key, expected in pairs(prepared.attributes) do
        if key ~= "phonemes" then
            local actual = actualAttributes[key]
            local matches = type(expected) == "number"
                and numbersMatch(expected, actual)
                or actual == expected
            if not matches then
                fail(path .. "." .. key, expected, actual)
            end
        else
            local actualPhonemes = actualAttributes.phonemes
            if type(actualPhonemes) ~= "table" then
                fail(path .. ".phonemeAttributes", expected, actualPhonemes)
            end
            if #actualPhonemes ~= #expected then
                fail(
                    path .. ".phonemeAttributes.length",
                    #expected,
                    #actualPhonemes
                )
            end
            for phonemeIndex = 1, #expected do
                local expectedPhoneme = expected[phonemeIndex]
                local actualPhoneme = actualPhonemes[phonemeIndex]
                if type(actualPhoneme) ~= "table" then
                    fail(
                        path .. ".phonemeAttributes[" .. phonemeIndex .. "]",
                        expectedPhoneme,
                        actualPhoneme
                    )
                end
                for attribute, expectedValue in pairs(expectedPhoneme) do
                    local actualValue = actualPhoneme[attribute]
                    if not numbersMatch(expectedValue, actualValue) then
                        fail(
                            path .. ".phonemeAttributes[" .. phonemeIndex .. "]." .. attribute,
                            expectedValue,
                            actualValue
                        )
                    end
                end
            end
        end
    end
end

local function preparePhonemePropertyChanges(note, changes, path)
    changes = requireObject(changes, path)
    local allowedKeys = {
        phonemeSequence = true,
        languageOverride = true,
        phonesetOverride = true,
        evenSyllableDuration = true,
        phonemeAttributes = true
    }
    for key, _value in pairs(changes) do
        if not allowedKeys[key] then
            raiseBridgeError("INVALID_ARGUMENT", path .. " contains an unsupported field", {
                field = key
            })
        end
    end

    local mapped = {}
    if isProvided(changes.phonemeSequence) then
        local phonemeSequence = requireString(changes.phonemeSequence, path .. ".phonemeSequence", true)
        if #phonemeSequence > 4000 then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".phonemeSequence must be at most 4000 bytes")
        end
        mapped.phonemes = phonemeSequence
    end
    if isProvided(changes.languageOverride) then
        mapped.languageOverride = changes.languageOverride
    end

    local attributes = {}
    if isProvided(changes.phonesetOverride) then
        local phonesetOverride = requireString(
            changes.phonesetOverride,
            path .. ".phonesetOverride",
            true
        )
        if #phonesetOverride > 200 then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".phonesetOverride must be at most 200 bytes")
        end
        attributes.phonesetOverride = phonesetOverride
    end
    if isProvided(changes.evenSyllableDuration) then
        attributes.evenSyllableDuration = requireBoolean(
            changes.evenSyllableDuration,
            path .. ".evenSyllableDuration"
        )
    end
    if isProvided(changes.phonemeAttributes) then
        attributes.phonemes = preparePhonemeAttributes(
            changes.phonemeAttributes,
            path .. ".phonemeAttributes"
        )
    end
    if next(attributes) ~= nil then
        mapped.attributes = attributes
    end
    if next(mapped) == nil then
        raiseBridgeError("INVALID_ARGUMENT", path .. " must change at least one phoneme property")
    end
    local prepared = prepareNoteChanges(note, mapped, path)
    local candidate = note:clone()
    applyPreparedNoteChanges(candidate, prepared, path)
    verifyPhonemePostconditions(candidate, prepared, path, "preflight")
    return prepared
end

local function createNoteFromInput(input, path)
    input = requireObject(input, path)
    local note = SV:create("Note")
    note:setTimeRange(
        requireInteger(input.onset, path .. ".onset", 0),
        requireInteger(input.duration, path .. ".duration", 1)
    )
    note:setPitch(requireInteger(input.pitch, path .. ".pitch", 0, 127))
    note:setLyrics(optionalString(input.lyrics, path .. ".lyrics", true) or "la")
    if isProvided(input.phonemes) then
        note:setPhonemes(requireString(input.phonemes, path .. ".phonemes", true))
    end
    if isProvided(input.detune) then
        note:setDetune(requireFiniteNumber(input.detune, path .. ".detune"))
    end
    if isProvided(input.languageOverride) then
        local languageOverride = requireString(input.languageOverride, path .. ".languageOverride", true)
        local allowedLanguages = {
            [""] = true,
            mandarin = true,
            japanese = true,
            english = true,
            cantonese = true
        }
        if not allowedLanguages[languageOverride] then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".languageOverride is unsupported")
        end
        note:setLanguageOverride(languageOverride)
    end
    if isProvided(input.musicalType) then
        local musicalType = requireString(input.musicalType, path .. ".musicalType", false)
        if musicalType ~= "sing" and musicalType ~= "rap" then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".musicalType must be sing or rap")
        end
        note:setMusicalType(musicalType)
    end
    if isProvided(input.pitchAutoMode) then
        applyPitchAutoMode(
            note,
            requireBoolean(input.pitchAutoMode, path .. ".pitchAutoMode"),
            path .. ".pitchAutoMode"
        )
    end
    if isProvided(input.rapAccent) then
        local rapAccent = requireString(input.rapAccent, path .. ".rapAccent", true)
        if rapAccent ~= "" and not rapAccent:match("^[1-5]$") then
            raiseBridgeError("INVALID_ARGUMENT", path .. ".rapAccent must be empty or 1..5")
        end
        note:setRapAccent(rapAccent)
    end
    if isProvided(input.attributes) then
        note:setAttributes(requireObject(input.attributes, path .. ".attributes"))
    end
    return note
end

local function preparePitchControlInput(input, path, expectedKind)
    input = requireObject(input, path)
    local kind = expectedKind or requireString(input.kind, path .. ".kind", false)
    if kind ~= "point" and kind ~= "curve" then
        raiseBridgeError("INVALID_ARGUMENT", path .. ".kind must be point or curve")
    end
    local prepared = {
        kind = kind,
        position = requireInteger(input.position, path .. ".position", 0),
        pitch = requireFiniteNumber(input.pitch, path .. ".pitch", -127, 127)
    }
    if kind == "curve" then
        local rawPoints = requireArray(input.points, path .. ".points", 0, 10000)
        local points = {}
        for pointIndex = 1, #rawPoints do
            local point = requireObject(rawPoints[pointIndex], path .. ".points[" .. pointIndex .. "]")
            points[#points + 1] = {
                requireInteger(point.offset, path .. ".points[" .. pointIndex .. "].offset"),
                requireFiniteNumber(point.value, path .. ".points[" .. pointIndex .. "].value", -127, 127)
            }
        end
        table.sort(points, function(left, right)
            return left[1] < right[1]
        end)
        prepared.points = points
    elseif isProvided(input.points) then
        raiseBridgeError("INVALID_ARGUMENT", path .. ".points is only valid for curve controls")
    end
    return prepared
end

local function createPitchControl(prepared)
    local objectType = prepared.kind == "curve" and "PitchControlCurve" or "PitchControlPoint"
    local control = SV:create(objectType)
    control:setPosition(prepared.position)
    control:setPitch(prepared.pitch)
    if prepared.kind == "curve" then
        control:setPoints(prepared.points)
    end
    return control
end

local function applyPitchControlChanges(control, changes, kind, path)
    changes = requireObject(changes, path)
    local supported = {
        position = true,
        pitch = true,
        points = kind == "curve"
    }
    for key, _value in pairs(changes) do
        if not supported[key] then
            raiseBridgeError("INVALID_ARGUMENT", path .. " contains an unsupported field", {
                field = key
            })
        end
    end
    local prepared = {}
    if isProvided(changes.position) then
        prepared.position = requireInteger(changes.position, path .. ".position", 0)
    end
    if isProvided(changes.pitch) then
        prepared.pitch = requireFiniteNumber(changes.pitch, path .. ".pitch", -127, 127)
    end
    if isProvided(changes.points) then
        local rawPoints = requireArray(changes.points, path .. ".points", 0, 10000)
        local points = {}
        for pointIndex = 1, #rawPoints do
            local point = requireObject(rawPoints[pointIndex], path .. ".points[" .. pointIndex .. "]")
            points[#points + 1] = {
                requireInteger(point.offset, path .. ".points[" .. pointIndex .. "].offset"),
                requireFiniteNumber(point.value, path .. ".points[" .. pointIndex .. "].value", -127, 127)
            }
        end
        table.sort(points, function(left, right)
            return left[1] < right[1]
        end)
        prepared.points = points
    end
    if next(prepared) == nil then
        raiseBridgeError("INVALID_ARGUMENT", path .. " must change at least one field")
    end

    local function apply(target)
        if prepared.position ~= nil then
            target:setPosition(prepared.position)
        end
        if prepared.pitch ~= nil then
            target:setPitch(prepared.pitch)
        end
        if prepared.points ~= nil then
            target:setPoints(prepared.points)
        end
    end
    local candidate = control:clone()
    local ok, validationError = pcall(function()
        apply(candidate)
    end)
    if not ok then
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested pitch-control changes", {
            cause = tostring(validationError)
        })
    end
    return apply
end

local function getNavigation(viewName)
    local view
    if viewName == "mainEditor" then
        view = SV:getMainEditor()
    elseif viewName == "arrangement" then
        view = SV:getArrangement()
    else
        raiseBridgeError("INVALID_ARGUMENT", "view must be mainEditor or arrangement")
    end
    local navigation = safeCall(function()
        return view:getNavigation()
    end, nil)
    if not navigation then
        raiseBridgeError("UNSUPPORTED_HOST_CAPABILITY", "This SynthV host does not expose editor navigation", {
            capability = viewName .. ".getNavigation"
        })
    end
    return navigation
end

local function serializeNavigation(viewName, navigation)
    return {
        view = viewName,
        timeViewRange = sanitizeForJson(navigation:getTimeViewRange()),
        valueViewRange = sanitizeForJson(navigation:getValueViewRange()),
        timePixelsPerBlick = navigation:getTimePxPerUnit(),
        valuePixelsPerUnit = navigation:getValuePxPerUnit()
    }
end

local RETAKE_IDS_KEY = "synthv-agent-bridge.retakeIds"

local function getTrackedRetakeIds(retakes)
    local raw = safeCall(function()
        return retakes:getScriptData(RETAKE_IDS_KEY)
    end, nil)
    local result = json.array()
    if type(raw) == "table" then
        for index = 1, #raw do
            if type(raw[index]) == "number" then
                result[#result + 1] = raw[index]
            end
        end
    end
    return result
end

local function hasTrackedRetakeId(ids, takeId)
    if takeId == 0 then
        return true
    end
    for index = 1, #ids do
        if ids[index] == takeId then
            return true
        end
    end
    return false
end

local function resolveRetakeNote(payload, requireFingerprint)
    local project, track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local noteIndex = requireInteger(payload.noteIndex, "noteIndex", 1, group:getNumNotes())
    local note
    if requireFingerprint then
        note = validateFingerprint(
            group,
            noteIndex,
            requireString(payload.fingerprint, "fingerprint", false)
        )
    else
        note = group:getNote(noteIndex)
    end
    local retakes = note:getRetakes()
    return project, track, trackIndex, reference, group, groupIndex, note, noteIndex, retakes
end

local function serializeRetakes(group, note, noteIndex, retakes)
    return {
        noteIndex = noteIndex,
        noteFingerprint = makeNoteFingerprint(group:getUUID(), noteIndex, note),
        takeCount = retakes:getNumTakes(),
        trackedTakeIds = getTrackedRetakeIds(retakes),
        defaultTakeId = 0
    }
end

local SCRIPT_DATA_PREFIX = "synthv-agent-bridge."

local function registerSelectionObservers()
    if runtimeState.selectionObserversRegistered then
        return
    end
    local function attach(selection, source)
        if not selection then return end
        safeCall(function()
            selection:registerSelectionCallback(function(selectionType, isSelected)
                runtimeState.selectionRevision = runtimeState.selectionRevision + 1
                runtimeState.latestSelectionEvent = {
                    source = source,
                    event = "selection",
                    selectionType = selectionType,
                    selected = isSelected,
                    revision = runtimeState.selectionRevision
                }
            end)
        end)
        safeCall(function()
            selection:registerClearCallback(function(selectionType)
                runtimeState.selectionRevision = runtimeState.selectionRevision + 1
                runtimeState.latestSelectionEvent = {
                    source = source,
                    event = "clear",
                    selectionType = selectionType,
                    revision = runtimeState.selectionRevision
                }
            end)
        end)
    end
    attach(SV:getMainEditor():getSelection(), "pianoRoll")
    attach(SV:getArrangement():getSelection(), "arrangement")
    runtimeState.selectionObserversRegistered = true
end

local function resolveScriptDataObject(payload)
    local objectType = requireString(payload.objectType, "objectType", false)
    local writing = payload.operation == "set" or payload.operation == "remove"
    if objectType == "project" then
        local project = getProject()
        return project, project, {}
    elseif objectType == "timeAxis" then
        local project = getProject()
        return project, project:getTimeAxis(), {}
    elseif objectType == "track" or objectType == "mixer" then
        local project, track, trackIndex = resolveTrack(payload)
        local trackFingerprint = optionalString(payload.trackFingerprint, "trackFingerprint", false)
        if writing and not trackFingerprint then
            raiseBridgeError("INVALID_ARGUMENT", "trackFingerprint is required for metadata writes")
        end
        validateTrackFingerprint(
            track,
            trackFingerprint,
            trackIndex
        )
        return project, objectType == "mixer" and track:getMixer() or track, {
            trackIndex = trackIndex
        }
    elseif objectType == "group" or objectType == "reference" then
        local project, _track, trackIndex, reference, group, groupIndex = resolveReference(payload)
        local referenceFingerprint =
            optionalString(payload.referenceFingerprint, "referenceFingerprint", false)
        if writing and objectType == "reference" and not referenceFingerprint then
            raiseBridgeError("INVALID_ARGUMENT", "referenceFingerprint is required for metadata writes")
        end
        if writing and objectType == "group" and not isProvided(payload.groupUuid) then
            raiseBridgeError("INVALID_ARGUMENT", "groupUuid is required for metadata writes")
        end
        validateReferenceFingerprint(
            reference,
            referenceFingerprint,
            trackIndex,
            groupIndex
        )
        if objectType == "group" and not group then
            raiseBridgeError("INSTRUMENTAL_GROUP", "Instrumental references have no note-group object")
        end
        return project, objectType == "reference" and reference or group, {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = group and group:getUUID() or JSON_NULL
        }
    elseif objectType == "note" or objectType == "retakes" then
        local requireFingerprint = objectType == "note" or writing or isProvided(payload.fingerprint)
        local project, _track, trackIndex, _reference, group, groupIndex, note, noteIndex, retakes =
            resolveRetakeNote(payload, requireFingerprint)
        return project, objectType == "retakes" and retakes or note, {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = group:getUUID(),
            noteIndex = noteIndex
        }
    elseif objectType == "automation" then
        local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
        local parameter = requireString(payload.parameter, "parameter", false)
        local automation, serialized = serializeAutomation(group, parameter)
        if writing and not isProvided(payload.expectedFingerprint) then
            raiseBridgeError("INVALID_ARGUMENT", "expectedFingerprint is required for metadata writes")
        end
        validateExpectedFingerprint(
            serialized.fingerprint,
            optionalString(payload.expectedFingerprint, "expectedFingerprint", false),
            "STALE_AUTOMATION",
            "The automation curve changed after it was read"
        )
        return project, automation, {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = group:getUUID(),
            parameter = automation:getType()
        }
    elseif objectType == "pitchControl" then
        if writing and not isProvided(payload.fingerprint) then
            raiseBridgeError("INVALID_ARGUMENT", "fingerprint is required for metadata writes")
        end
        local project, _track, trackIndex, _reference, group, groupIndex, control, controlIndex =
            resolvePitchControl(payload)
        return project, control, {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = group:getUUID(),
            pitchControlIndex = controlIndex
        }
    end
    raiseBridgeError(
        "INVALID_ARGUMENT",
        "objectType must be project, timeAxis, track, mixer, group, reference, note, retakes, automation, or pitchControl"
    )
end

local PROJECT_WRITE_ACTIONS = nil
local handlers = {}
local reloadRequested = nil

local function resolveReloadScriptFile()
    local install = readJson(INSTALL_FILE)
    if isObject(install) and type(install.scriptFile) == "string" then
        local scriptFile = install.scriptFile
        if scriptFile:match("[/\\]SynthVAgentBridge%.lua$") and fileExists(scriptFile) then
            return scriptFile
        end
    end
    if type(RUNNING_SCRIPT_FILE) == "string"
        and RUNNING_SCRIPT_FILE ~= ""
        and RUNNING_SCRIPT_FILE:match("[/\\]SynthVAgentBridge%.lua$")
        and fileExists(RUNNING_SCRIPT_FILE)
    then
        return RUNNING_SCRIPT_FILE
    end
    return nil
end

local function prepareHotReload()
    if reloadRequested ~= nil then
        return reloadRequested
    end
    local scriptFile = resolveReloadScriptFile()
    if scriptFile == nil then
        raiseBridgeError(
            "UNSUPPORTED_HOST_CAPABILITY",
            "No verified installed Bridge script path is available; run the installer again"
        )
    end
    if type(loadfile) ~= "function" then
        raiseBridgeError(
            "UNSUPPORTED_HOST_CAPABILITY",
            "The SynthV Lua host does not expose loadfile()"
        )
    end
    local loader, loadError = loadfile(scriptFile)
    if not loader then
        raiseBridgeError("RELOAD_FAILED", "The installed Bridge script could not be compiled", {
            cause = tostring(loadError)
        })
    end
    reloadRequested = {
        loader = loader,
        scriptFile = scriptFile
    }
    return reloadRequested
end

function handlers.ping(_payload)
    return {
        bridgeVersion = BRIDGE_VERSION,
        protocolVersion = PROTOCOL_VERSION,
        sessionToken = SESSION_TOKEN,
        projectFile = currentProjectFile(),
        timestamp = isoTimestamp()
    }
end

function handlers.reload_bridge(payload)
    payload = requireObject(payload, "payload")
    for key, _value in pairs(payload) do
        raiseBridgeError("INVALID_ARGUMENT", "reload_bridge does not accept payload fields", {
            field = key
        })
    end
    local request = prepareHotReload()
    return {
        reloading = true,
        bridgeVersion = BRIDGE_VERSION,
        sessionToken = SESSION_TOKEN,
        scriptFile = request.scriptFile
    }
end

function handlers.get_host_info(_payload)
    return {
        bridgeVersion = BRIDGE_VERSION,
        protocolVersion = PROTOCOL_VERSION,
        host = copyHostInfo(),
        projectFile = currentProjectFile(),
        ipcDirectory = IPC_DIRECTORY
    }
end

function handlers.host_clipboard(payload)
    payload = requireObject(payload, "payload")
    local operation = requireString(payload.operation, "operation", false)
    if operation == "read" then
        return {
            operation = operation,
            text = SV:getHostClipboard()
        }
    elseif operation == "write" then
        local text = requireString(payload.text, "text", true)
        SV:setHostClipboard(text)
        return {
            operation = operation,
            characterCount = #text
        }
    end
    raiseBridgeError("INVALID_ARGUMENT", "operation must be read or write")
end

function handlers.show_dialog(payload)
    payload = requireObject(payload, "payload")
    local kind = requireString(payload.kind, "kind", false)
    local result
    if kind == "custom" then
        result = SV:showCustomDialog(requireObject(payload.form, "form"))
    else
        local title = requireString(payload.title, "title", true)
        local message = requireString(payload.message, "message", true)
        if kind == "message" then
            SV:showMessageBox(title, message)
            result = true
        elseif kind == "input" then
            result = SV:showInputBox(
                title,
                message,
                optionalString(payload.defaultText, "defaultText", true) or ""
            )
        elseif kind == "okCancel" then
            result = SV:showOkCancelBox(title, message)
        elseif kind == "yesNoCancel" then
            result = SV:showYesNoCancelBox(title, message)
        else
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "kind must be message, input, okCancel, yesNoCancel, or custom"
            )
        end
    end
    return {
        kind = kind,
        result = sanitizeForJson(result)
    }
end

function handlers.convert_pitch(payload)
    payload = requireObject(payload, "payload")
    local supplied = 0
    local pitch
    local frequency
    if isProvided(payload.pitch) then
        supplied = supplied + 1
        pitch = requireFiniteNumber(payload.pitch, "pitch")
        -- SynthV 2.2.1 on Windows does not expose the documented
        -- pitch2freq method to Lua, although freq2Pitch is available.
        -- Prefer either host spelling when present and use the exact
        -- equal-temperament inverse as a compatibility fallback.
        frequency = safeCall(function()
            return SV:pitch2freq(pitch)
        end, nil)
        if frequency == nil then
            frequency = safeCall(function()
                return SV:pitch2Freq(pitch)
            end, nil)
        end
        if frequency == nil then
            frequency = 440 * (2 ^ ((pitch - 69) / 12))
        end
    end
    if isProvided(payload.frequency) then
        supplied = supplied + 1
        frequency = requireFiniteNumber(payload.frequency, "frequency", 0.000001)
        pitch = SV:freq2Pitch(frequency)
    end
    if supplied ~= 1 then
        raiseBridgeError("INVALID_ARGUMENT", "Supply exactly one of pitch or frequency")
    end
    return {
        pitch = pitch,
        frequency = frequency,
        nearestMidiPitch = math.floor(pitch + 0.5),
        blackKey = SV:blackKey(math.floor(pitch + 0.5))
    }
end

function handlers.get_project_info(_payload)
    local project = getProject()
    local timeAxis = project:getTimeAxis()
    local playback = SV:getPlayback()
    local mainEditor = SV:getMainEditor()
    local currentTrack = safeCall(function()
        return mainEditor:getCurrentTrack()
    end, nil)
    local currentReference = safeCall(function()
        return mainEditor:getCurrentGroup()
    end, nil)
    local currentGroup = locateReference(currentReference)

    local tempoMark = safeCall(function()
        return timeAxis:getTempoMarkAt(0)
    end, nil)
    local measureMark = safeCall(function()
        return timeAxis:getMeasureMarkAtBlick(0)
    end, nil)

    local result = {
        fileName = project:getFileName() or "",
        durationBlicks = project:getDuration(),
        durationSeconds = timeAxis:getSecondsFromBlick(project:getDuration()),
        trackCount = project:getNumTracks(),
        quarterBlicks = SV.QUARTER,
        host = copyHostInfo(),
        playback = {
            status = playback:getStatus(),
            playheadSeconds = playback:getPlayhead()
        },
        currentEditor = {
            trackIndex = currentTrack and safeCall(function()
                return currentTrack:getIndexInParent()
            end, nil) or nil,
            group = currentGroup
        }
    }

    if tempoMark then
        result.tempoAtStart = {
            position = tempoMark.position or 0,
            bpm = tempoMark.bpm
        }
    end
    if measureMark then
        result.measureAtStart = {
            position = measureMark.position or 0,
            measure = measureMark.measure,
            numerator = measureMark.numerator,
            denominator = measureMark.denominator
        }
    end
    return result
end

function handlers.get_time_axis(_payload)
    local project = getProject()
    local result = serializeTimeAxis(project:getTimeAxis())
    result.projectFile = project:getFileName() or ""
    result.projectDurationBlicks = project:getDuration()
    result.projectDurationSeconds = project:getTimeAxis():getSecondsFromBlick(project:getDuration())
    return result
end

function handlers.convert_time(payload)
    payload = requireObject(payload, "payload")
    local project = getProject()
    local timeAxis = project:getTimeAxis()
    local supplied = 0
    local blicks = nil

    if isProvided(payload.blicks) then
        supplied = supplied + 1
        blicks = requireInteger(payload.blicks, "blicks", 0)
    end
    if isProvided(payload.quarters) then
        supplied = supplied + 1
        local quarters = requireFiniteNumber(payload.quarters, "quarters", 0)
        blicks = math.floor(quarters * SV.QUARTER + 0.5)
    end
    if isProvided(payload.seconds) then
        supplied = supplied + 1
        local seconds = requireFiniteNumber(payload.seconds, "seconds", 0)
        blicks = timeAxis:getBlickFromSeconds(seconds)
    end
    if supplied ~= 1 then
        raiseBridgeError("INVALID_ARGUMENT", "Supply exactly one of blicks, quarters, or seconds")
    end

    local tempoMark = timeAxis:getTempoMarkAt(blicks)
    local measureMark = timeAxis:getMeasureMarkAtBlick(blicks)
    local result = {
        blicks = blicks,
        quarters = SV:blick2Quarter(blicks),
        seconds = timeAxis:getSecondsFromBlick(blicks),
        measure = timeAxis:getMeasureAt(blicks),
        effectiveTempo = sanitizeForJson(tempoMark),
        effectiveMeasure = sanitizeForJson(measureMark)
    }
    if isProvided(payload.roundInterval) then
        local interval = requireInteger(payload.roundInterval, "roundInterval", 1)
        result.roundInterval = interval
        result.roundedBlicks = SV:blickRoundTo(blicks, interval)
        result.intervalIndex = SV:blickRoundDiv(blicks, interval)
    end
    return result
end

function handlers.set_time_axis(payload)
    payload = requireObject(payload, "payload")
    local project = getProject()
    local timeAxis = project:getTimeAxis()
    local before = serializeTimeAxis(timeAxis)
    local expectedFingerprint = optionalString(payload.expectedFingerprint, "expectedFingerprint", false)
    validateExpectedFingerprint(
        before.fingerprint,
        expectedFingerprint,
        "STALE_TIME_AXIS",
        "The tempo or time-signature map changed after it was read"
    )

    local tempoMarks = isProvided(payload.tempoMarks)
        and requireArray(payload.tempoMarks, "tempoMarks", 0, 1000) or json.array()
    local removeTempoPositions = isProvided(payload.removeTempoPositions)
        and requireArray(payload.removeTempoPositions, "removeTempoPositions", 0, 1000) or json.array()
    local measureMarks = isProvided(payload.measureMarks)
        and requireArray(payload.measureMarks, "measureMarks", 0, 1000) or json.array()
    local removeMeasurePositions = isProvided(payload.removeMeasurePositions)
        and requireArray(payload.removeMeasurePositions, "removeMeasurePositions", 0, 1000) or json.array()

    if #tempoMarks + #removeTempoPositions + #measureMarks + #removeMeasurePositions == 0 then
        raiseBridgeError("INVALID_ARGUMENT", "At least one time-axis operation must be supplied")
    end

    local preparedTempoMarks = {}
    local tempoAdditionsByPosition = {}
    for index = 1, #tempoMarks do
        local mark = requireObject(tempoMarks[index], "tempoMarks[" .. index .. "]")
        local preparedMark = {
            position = requireInteger(mark.position, "tempoMarks[" .. index .. "].position", 0),
            bpm = requireFiniteNumber(mark.bpm, "tempoMarks[" .. index .. "].bpm", 1, 1000)
        }
        if tempoAdditionsByPosition[preparedMark.position] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "tempoMarks contains the same position more than once",
                { position = preparedMark.position }
            )
        end
        tempoAdditionsByPosition[preparedMark.position] = preparedMark
        preparedTempoMarks[#preparedTempoMarks + 1] = preparedMark
    end

    local preparedRemoveTempoPositions = {}
    local tempoRemovalsByPosition = {}
    for index = 1, #removeTempoPositions do
        local position =
            requireInteger(removeTempoPositions[index], "removeTempoPositions[" .. index .. "]", 0)
        if tempoRemovalsByPosition[position] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "removeTempoPositions contains the same position more than once",
                { position = position }
            )
        end
        tempoRemovalsByPosition[position] = true
        preparedRemoveTempoPositions[#preparedRemoveTempoPositions + 1] = position
    end

    local allowedDenominators = {
        [1] = true,
        [2] = true,
        [4] = true,
        [8] = true,
        [16] = true,
        [32] = true,
        [64] = true
    }
    local preparedMeasureMarks = {}
    local measureAdditionsByPosition = {}
    for index = 1, #measureMarks do
        local mark = requireObject(measureMarks[index], "measureMarks[" .. index .. "]")
        local denominator = requireInteger(mark.denominator, "measureMarks[" .. index .. "].denominator", 1, 64)
        if not allowedDenominators[denominator] then
            raiseBridgeError("INVALID_ARGUMENT", "Time-signature denominator must be a power of two from 1 to 64")
        end
        local preparedMark = {
            measure = requireInteger(mark.measure, "measureMarks[" .. index .. "].measure", 0),
            numerator = requireInteger(mark.numerator, "measureMarks[" .. index .. "].numerator", 1, 32),
            denominator = denominator
        }
        if measureAdditionsByPosition[preparedMark.measure] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "measureMarks contains the same measure more than once",
                { measure = preparedMark.measure }
            )
        end
        measureAdditionsByPosition[preparedMark.measure] = preparedMark
        preparedMeasureMarks[#preparedMeasureMarks + 1] = preparedMark
    end

    local preparedRemoveMeasurePositions = {}
    local measureRemovalsByPosition = {}
    for index = 1, #removeMeasurePositions do
        local measure =
            requireInteger(removeMeasurePositions[index], "removeMeasurePositions[" .. index .. "]", 0)
        if measureRemovalsByPosition[measure] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "removeMeasurePositions contains the same measure more than once",
                { measure = measure }
            )
        end
        measureRemovalsByPosition[measure] = true
        preparedRemoveMeasurePositions[#preparedRemoveMeasurePositions + 1] = measure
    end

    if tempoRemovalsByPosition[0] and not tempoAdditionsByPosition[0] then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "The initial tempo mark can only be removed when a replacement at position 0 is supplied"
        )
    end
    if measureRemovalsByPosition[0] and not measureAdditionsByPosition[0] then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "The initial time-signature mark can only be removed when a replacement at measure 0 is supplied"
        )
    end

    local function applyOperations(target)
        for index = 1, #preparedRemoveTempoPositions do
            target:removeTempoMark(preparedRemoveTempoPositions[index])
        end
        for index = 1, #preparedRemoveMeasurePositions do
            target:removeMeasureMark(preparedRemoveMeasurePositions[index])
        end
        for index = 1, #preparedTempoMarks do
            local mark = preparedTempoMarks[index]
            -- SynthV 2.2.1 can silently keep the old value when addTempoMark
            -- targets an occupied position, despite the public API describing
            -- this operation as an update. Remove first for deterministic
            -- replacement semantics.
            target:removeTempoMark(mark.position)
            target:addTempoMark(mark.position, mark.bpm)
        end
        for index = 1, #preparedMeasureMarks do
            local mark = preparedMeasureMarks[index]
            target:removeMeasureMark(mark.measure)
            target:addMeasureMark(mark.measure, mark.numerator, mark.denominator)
        end
    end

    local function assertPostconditions(serialized, errorCode, phase)
        local temposByPosition = {}
        for index = 1, #serialized.tempoMarks do
            local mark = serialized.tempoMarks[index]
            temposByPosition[mark.position] = mark
        end
        local measuresByPosition = {}
        for index = 1, #serialized.measureMarks do
            local mark = serialized.measureMarks[index]
            measuresByPosition[mark.measure] = mark
        end

        for position, expected in pairs(tempoAdditionsByPosition) do
            local actual = temposByPosition[position]
            if not actual or math.abs(actual.bpm - expected.bpm) > 0.000001 then
                raiseBridgeError(
                    errorCode,
                    "SynthV did not apply the requested tempo mark",
                    {
                        phase = phase,
                        position = position,
                        expectedBpm = expected.bpm,
                        actualBpm = actual and actual.bpm or JSON_NULL
                    }
                )
            end
        end
        for position, _value in pairs(tempoRemovalsByPosition) do
            if not tempoAdditionsByPosition[position] and temposByPosition[position] then
                raiseBridgeError(
                    errorCode,
                    "SynthV did not remove the requested tempo mark",
                    { phase = phase, position = position }
                )
            end
        end
        for measure, expected in pairs(measureAdditionsByPosition) do
            local actual = measuresByPosition[measure]
            if not actual or
                actual.numerator ~= expected.numerator or
                actual.denominator ~= expected.denominator then
                raiseBridgeError(
                    errorCode,
                    "SynthV did not apply the requested time-signature mark",
                    {
                        phase = phase,
                        measure = measure,
                        expectedNumerator = expected.numerator,
                        expectedDenominator = expected.denominator,
                        actualNumerator = actual and actual.numerator or JSON_NULL,
                        actualDenominator = actual and actual.denominator or JSON_NULL
                    }
                )
            end
        end
        for measure, _value in pairs(measureRemovalsByPosition) do
            if not measureAdditionsByPosition[measure] and measuresByPosition[measure] then
                raiseBridgeError(
                    errorCode,
                    "SynthV did not remove the requested time-signature mark",
                    { phase = phase, measure = measure }
                )
            end
        end
    end

    local candidate = timeAxis:clone()
    local valid, validationError = pcall(function()
        applyOperations(candidate)
        assertPostconditions(serializeTimeAxis(candidate), "INVALID_ARGUMENT", "validation")
    end)
    if not valid then
        if type(validationError) == "table" and getmetatable(validationError) == BRIDGE_ERROR_MT then
            error(validationError, 0)
        end
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested time-axis edits", {
            cause = tostring(validationError)
        })
    end

    createUndoRecord(project)
    applyOperations(timeAxis)
    local result = serializeTimeAxis(timeAxis)
    assertPostconditions(result, "HOST_POSTCONDITION_FAILED", "project")
    result.appliedOperationCount =
        #preparedTempoMarks + #preparedRemoveTempoPositions +
        #preparedMeasureMarks + #preparedRemoveMeasurePositions
    result.verified = true
    return result
end

function handlers.list_tracks(_payload)
    local project = getProject()
    local tracks = json.array()
    for trackIndex = 1, project:getNumTracks() do
        tracks[#tracks + 1] = serializeTrackSummary(project:getTrack(trackIndex), trackIndex)
    end
    return {
        trackCount = #tracks,
        tracks = tracks
    }
end

function handlers.list_note_groups(_payload)
    local project = getProject()
    local groups = json.array()
    for libraryIndex = 1, project:getNumNoteGroupsInLibrary() do
        groups[#groups + 1] =
            serializeLibraryGroup(project, project:getNoteGroup(libraryIndex), libraryIndex)
    end
    return {
        groupCount = #groups,
        groups = groups
    }
end

function handlers.create_note_group(payload)
    payload = requireObject(payload, "payload")
    local project = getProject()
    local name = optionalString(payload.name, "name", false) or "New Group"
    local suggestedIndex = optionalInteger(
        payload.suggestedIndex,
        "suggestedIndex",
        1,
        project:getNumNoteGroupsInLibrary() + 1
    )
    local noteInputs = isProvided(payload.notes)
        and requireArray(payload.notes, "notes", 0, 512) or json.array()
    local group = SV:create("NoteGroup")
    group:setName(name)
    for noteIndex = 1, #noteInputs do
        group:addNote(createNoteFromInput(noteInputs[noteIndex], "notes[" .. noteIndex .. "]"))
    end

    createUndoRecord(project)
    local libraryIndex = project:addNoteGroup(group, suggestedIndex)
    if type(libraryIndex) ~= "number" then
        libraryIndex = group:getIndexInParent()
    end
    return serializeLibraryGroup(project, group, libraryIndex)
end

function handlers.clone_note_group(payload)
    payload = requireObject(payload, "payload")
    local project
    local sourceGroup
    local sourceDescription
    if isProvided(payload.trackIndex) then
        local _track
        local _reference
        local trackIndex
        local groupIndex
        project, _track, trackIndex, _reference, sourceGroup, groupIndex = resolveGroup(payload)
        sourceDescription = {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = sourceGroup:getUUID()
        }
    else
        local libraryIndex
        project, sourceGroup, libraryIndex = resolveLibraryGroup(payload)
        sourceDescription = {
            libraryIndex = libraryIndex,
            groupUuid = sourceGroup:getUUID()
        }
    end

    local cloned = sourceGroup:clone()
    local name = optionalString(payload.name, "name", false)
    if name then
        cloned:setName(name)
    end
    local suggestedIndex = optionalInteger(
        payload.suggestedIndex,
        "suggestedIndex",
        1,
        project:getNumNoteGroupsInLibrary() + 1
    )
    createUndoRecord(project)
    local libraryIndex = project:addNoteGroup(cloned, suggestedIndex)
    if type(libraryIndex) ~= "number" then
        libraryIndex = cloned:getIndexInParent()
    end
    local result = serializeLibraryGroup(project, cloned, libraryIndex)
    result.source = sourceDescription
    return result
end

function handlers.delete_note_group(payload)
    payload = requireObject(payload, "payload")
    local project, group, libraryIndex = resolveLibraryGroup(payload)
    local deleted = serializeLibraryGroup(project, group, libraryIndex)
    createUndoRecord(project)
    project:removeNoteGroup(libraryIndex)
    return {
        deletedGroup = deleted,
        removedReferenceCount = deleted.referenceCount,
        groupCount = project:getNumNoteGroupsInLibrary()
    }
end

function handlers.add_group_reference(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex = resolveTrack(payload)
    validateTrackFingerprint(
        track,
        optionalString(payload.trackFingerprint, "trackFingerprint", false),
        trackIndex
    )
    local _sameProject, group = resolveLibraryGroup({
        groupUuid = payload.targetGroupUuid,
        libraryIndex = payload.targetLibraryIndex,
        expectedFingerprint = payload.targetFingerprint
    })
    local reference = SV:create("NoteGroupReference")
    reference:setTarget(group)
    local timeOffset = optionalInteger(payload.timeOffset, "timeOffset", 0)
    local pitchOffset = optionalInteger(payload.pitchOffset, "pitchOffset", -127, 127)
    local muted = optionalBoolean(payload.muted, "muted")
    local voice = isProvided(payload.voice) and requireObject(payload.voice, "voice") or nil
    local timeRange = nil
    if isProvided(payload.timeRange) then
        local rawRange = requireObject(payload.timeRange, "timeRange")
        timeRange = {
            onset = requireInteger(rawRange.onset, "timeRange.onset", 0),
            duration = requireInteger(rawRange.duration, "timeRange.duration", 1)
        }
    end
    if timeOffset ~= nil then reference:setTimeOffset(timeOffset) end
    if pitchOffset ~= nil then reference:setPitchOffset(pitchOffset) end
    if muted ~= nil then reference:setMuted(muted) end
    if voice ~= nil then reference:setVoice(voice) end
    if timeRange ~= nil then reference:setTimeRange(timeRange.onset, timeRange.duration) end

    createUndoRecord(project)
    local groupIndex = track:addGroupReference(reference)
    if type(groupIndex) ~= "number" then
        groupIndex = reference:getIndexInParent()
    end
    return {
        trackIndex = trackIndex,
        group = serializeGroup(reference, groupIndex, 0, 0),
        track = serializeTrackSummary(track, trackIndex)
    }
end

function handlers.clone_group_reference(payload)
    payload = requireObject(payload, "payload")
    local project, _sourceTrack, sourceTrackIndex, sourceReference, sourceGroup, sourceGroupIndex =
        resolveGroup({
            trackIndex = payload.sourceTrackIndex,
            groupIndex = payload.sourceGroupIndex,
            groupUuid = payload.sourceGroupUuid
        })
    validateReferenceFingerprint(
        sourceReference,
        optionalString(payload.sourceReferenceFingerprint, "sourceReferenceFingerprint", false),
        sourceTrackIndex,
        sourceGroupIndex
    )
    local _sameProject, targetTrack, targetTrackIndex = resolveTrack({
        trackIndex = payload.targetTrackIndex
    })
    validateTrackFingerprint(
        targetTrack,
        optionalString(payload.targetTrackFingerprint, "targetTrackFingerprint", false),
        targetTrackIndex
    )
    local linked = optionalBoolean(payload.linked, "linked")
    if linked == nil then linked = true end
    if linked and sourceReference:isMain() then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "A track main group cannot be linked directly; use linked=false to create a library copy"
        )
    end

    local targetGroup = sourceGroup
    local reference
    if linked then
        reference = sourceReference:clone()
    else
        targetGroup = sourceGroup:clone()
        local name = optionalString(payload.name, "name", false)
        if name then targetGroup:setName(name) end
        reference = SV:create("NoteGroupReference")
        reference:setTarget(targetGroup)
        reference:setTimeOffset(sourceReference:getTimeOffset())
        reference:setPitchOffset(sourceReference:getPitchOffset())
        reference:setMuted(sourceReference:isMuted())
        reference:setVoice(sourceReference:getVoice())
        reference:setTimeRange(sourceReference:getOnset(), sourceReference:getDuration())
    end

    createUndoRecord(project)
    local libraryIndex = nil
    if not linked then
        libraryIndex = project:addNoteGroup(targetGroup)
        if type(libraryIndex) ~= "number" then
            libraryIndex = targetGroup:getIndexInParent()
        end
    end
    local targetGroupIndex = targetTrack:addGroupReference(reference)
    if type(targetGroupIndex) ~= "number" then
        targetGroupIndex = reference:getIndexInParent()
    end
    return {
        linked = linked,
        sourceTrackIndex = sourceTrackIndex,
        sourceGroupIndex = sourceGroupIndex,
        targetTrackIndex = targetTrackIndex,
        libraryIndex = libraryIndex or JSON_NULL,
        group = serializeGroup(reference, targetGroupIndex, 0, 0)
    }
end

function handlers.get_track_notes(payload)
    requireObject(payload, "payload")
    local project, track, trackIndex = resolveTrack(payload)
    local offset = optionalInteger(payload.offset, "offset", 0, nil, 0)
    local limit = optionalInteger(payload.limit, "limit", 1, 5000, 1000)
    local groups = json.array()
    for groupIndex = 1, track:getNumGroups() do
        groups[#groups + 1] = serializeGroup(track:getGroupReference(groupIndex), groupIndex, offset, limit)
    end
    return {
        projectFile = project:getFileName() or "",
        track = serializeTrackSummary(track, trackIndex),
        groups = groups
    }
end

function handlers.get_group_voice(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local result = serializeGroupVoice(reference, trackIndex, groupIndex)
    result.selectionContext = getTargetSelectionContext(reference, group)
    return result
end

local function requestedRangeMatch(payload)
    local rangeMatch =
        optionalString(payload.rangeMatch, "rangeMatch", false) or "overlap"
    if rangeMatch ~= "overlap" and rangeMatch ~= "onset" then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "rangeMatch must be overlap or onset"
        )
    end
    return rangeMatch
end

local function findFirstNoteOnsetAtLeast(
    group,
    timeOffset,
    targetPosition
)
    local left = 1
    local right = group:getNumNotes() + 1
    local inspectedCount = 0
    while left < right do
        local middle = math.floor((left + right) / 2)
        local note = group:getNote(middle)
        inspectedCount = inspectedCount + 1
        if note:getOnset() + timeOffset < targetPosition then
            left = middle + 1
        else
            right = middle
        end
    end
    return left, inspectedCount
end

function handlers.get_note_phoneme_data(payload)
    payload = requireObject(payload, "payload")
    local mode = responseMode(payload)
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local offset = optionalInteger(payload.offset, "offset", 0, nil, 0)
    local limit = optionalInteger(payload.limit, "limit", 1, 1000, 1000)
    local includeComputedPhonemes = optionalBoolean(
        payload.includeComputedPhonemes,
        "includeComputedPhonemes"
    )
    if includeComputedPhonemes == nil then
        includeComputedPhonemes = true
    end
    local includeRawAttributes = optionalBoolean(
        payload.includeRawAttributes,
        "includeRawAttributes"
    )
    if includeRawAttributes == nil then
        includeRawAttributes = mode == "full"
    end
    local includeComputedAttributes = optionalBoolean(
        payload.includeComputedAttributes,
        "includeComputedAttributes"
    )
    if includeComputedAttributes == nil then
        includeComputedAttributes = mode == "full"
    end
    local includePitch = optionalBoolean(payload.includePitch, "includePitch")
    if includePitch == nil then
        includePitch = false
    end

    local hasStartSeconds = isProvided(payload.startSeconds)
    local hasEndSeconds = isProvided(payload.endSeconds)
    if hasStartSeconds ~= hasEndSeconds then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "startSeconds and endSeconds must be supplied together"
        )
    end
    local startSeconds = nil
    local endSeconds = nil
    local startBlick = nil
    local endBlick = nil
    local timeAxis = nil
    local rangeMatch = requestedRangeMatch(payload)
    if hasStartSeconds then
        startSeconds = requireFiniteNumber(payload.startSeconds, "startSeconds", 0)
        endSeconds = requireFiniteNumber(payload.endSeconds, "endSeconds", startSeconds)
        timeAxis = project:getTimeAxis()
        startBlick = timeAxis:getBlickFromSeconds(startSeconds)
        endBlick = timeAxis:getBlickFromSeconds(endSeconds)
    end

    local noteCount = group:getNumNotes()
    local requestedNoteIndices = nil
    if isProvided(payload.noteIndices) then
        local values = requireArray(payload.noteIndices, "noteIndices", 0, 512)
        local seenNoteIndices = {}
        requestedNoteIndices = json.array()
        for index = 1, #values do
            local noteIndex = requireInteger(
                values[index],
                "noteIndices[" .. index .. "]",
                1,
                noteCount
            )
            if not seenNoteIndices[noteIndex] then
                seenNoteIndices[noteIndex] = true
                requestedNoteIndices[#requestedNoteIndices + 1] = noteIndex
            end
        end
        table.sort(requestedNoteIndices)
    end

    local computedPhonemes = json.array()
    if includeComputedPhonemes then
        computedPhonemes = SV:getPhonemesForGroup(reference)
    end
    local computedAttributes = json.array()
    if includeComputedAttributes then
        computedAttributes = SV:getComputedAttributesForGroup(reference)
    end
    local selectionContext, selectedNoteIndices =
        getTargetSelectionContext(reference, group)
    local notes = json.array()
    local matchedNoteCount = 0
    local scannedNoteCount = 0
    local timeOffset = reference:getTimeOffset()
    local groupUuid = group:getUUID()
    local scanMode = "page_projection"
    if requestedNoteIndices ~= nil then
        scanMode = hasStartSeconds and "index_time_range" or "index_projection"
    elseif hasStartSeconds then
        scanMode = rangeMatch == "onset"
            and "onset_binary"
            or "time_range"
    end

    local function serializeMatchedNote(
        noteIndex,
        note,
        absoluteOnset,
        absoluteEnd
    )
        local attributeValue = note:getAttributes()
        local sanitizedAttributeValue = sanitizeForJson(attributeValue)
        local rawAttributes = type(attributeValue) == "table"
            and attributeValue
            or {}
        local sanitizedAttributes = type(attributeValue) == "table"
            and sanitizedAttributeValue
            or {}
        local encodedAttributes = json.encode(sanitizedAttributeValue)
        local phonemeAttributes = json.array()
        if type(sanitizedAttributes.phonemes) == "table" then
            for index = 1, #sanitizedAttributes.phonemes do
                phonemeAttributes[index] = sanitizedAttributes.phonemes[index]
            end
        end

        local serialized = {
            noteIndex = noteIndex,
            selected = selectedNoteIndices[noteIndex] == true,
            fingerprint = makeNoteFingerprint(
                groupUuid,
                noteIndex,
                note,
                encodedAttributes
            ),
            lyrics = note:getLyrics(),
            phonemeSequence = note:getPhonemes(),
            languageOverride = safeCall(function()
                return note:getLanguageOverride()
            end, ""),
            phonesetOverride = valueOrNull(rawAttributes.phonesetOverride),
            evenSyllableDuration = valueOrNull(
                rawAttributes.evenSyllableDuration
            ),
            phonemeAttributes = phonemeAttributes
        }
        if includeComputedPhonemes then
            serialized.computedPhonemes =
                valueOrNull(computedPhonemes[noteIndex])
        end
        if includeRawAttributes then
            serialized.attributes = sanitizedAttributes
        end
        if includeComputedAttributes then
            serialized.computedAttributes =
                valueOrNull(sanitizeForJson(computedAttributes[noteIndex]))
        end
        if mode == "compact" then
            if timeAxis == nil then
                timeAxis = project:getTimeAxis()
            end
            local absoluteOnsetSeconds =
                timeAxis:getSecondsFromBlick(absoluteOnset)
            local absoluteEndSeconds =
                timeAxis:getSecondsFromBlick(absoluteEnd)
            serialized.onset = note:getOnset()
            serialized.duration = note:getDuration()
            serialized.absoluteOnset = absoluteOnset
            serialized.absoluteOnsetSeconds = absoluteOnsetSeconds
            serialized.absoluteEndSeconds = absoluteEndSeconds
            serialized.absoluteDurationSeconds =
                absoluteEndSeconds - absoluteOnsetSeconds
        end
        if includePitch then
            serialized.pitch = note:getPitch()
            serialized.absolutePitch =
                note:getPitch() + reference:getPitchOffset()
            serialized.detune = note:getDetune()
        end
        notes[#notes + 1] = serialized
    end

    if not hasStartSeconds then
        local sourceCount = requestedNoteIndices ~= nil
            and #requestedNoteIndices
            or noteCount
        matchedNoteCount = sourceCount
        local firstResult = math.min(offset + 1, sourceCount + 1)
        local lastResult = math.min(offset + limit, sourceCount)
        for sourceIndex = firstResult, lastResult do
            local noteIndex = requestedNoteIndices ~= nil
                and requestedNoteIndices[sourceIndex]
                or sourceIndex
            local note = group:getNote(noteIndex)
            scannedNoteCount = scannedNoteCount + 1
            serializeMatchedNote(
                noteIndex,
                note,
                note:getOnset() + timeOffset,
                note:getEnd() + timeOffset
            )
        end
    else
        local sourceCount = requestedNoteIndices ~= nil
            and #requestedNoteIndices
            or noteCount
        local firstSourceIndex = 1
        if rangeMatch == "onset" and requestedNoteIndices == nil then
            firstSourceIndex, scannedNoteCount =
                findFirstNoteOnsetAtLeast(group, timeOffset, startBlick)
        elseif rangeMatch == "onset" then
            scanMode = "index_onset_range"
        end
        for sourceIndex = firstSourceIndex, sourceCount do
            local noteIndex = requestedNoteIndices ~= nil
                and requestedNoteIndices[sourceIndex]
                or sourceIndex
            local note = group:getNote(noteIndex)
            scannedNoteCount = scannedNoteCount + 1
            local absoluteOnset = note:getOnset() + timeOffset
            if absoluteOnset > endBlick then
                break
            end
            local absoluteEnd = note:getEnd() + timeOffset
            local matchesRange = rangeMatch == "onset"
                and absoluteOnset >= startBlick
                or absoluteEnd >= startBlick
            if matchesRange then
                matchedNoteCount = matchedNoteCount + 1
                if matchedNoteCount > offset and #notes < limit then
                    serializeMatchedNote(
                        noteIndex,
                        note,
                        absoluteOnset,
                        absoluteEnd
                    )
                end
            end
        end
    end

    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = groupUuid,
        selectionContext = selectionContext,
        noteCount = noteCount,
        matchedNoteCount = matchedNoteCount,
        returnedNoteOffset = offset,
        returnedNoteCount = #notes,
        hasMore = matchedNoteCount > offset + #notes,
        computedPhonemesIncluded = includeComputedPhonemes,
        phonemesPending = includeComputedPhonemes
            and noteCount > 0
            and #computedPhonemes == 0,
        attributesPending = includeComputedAttributes
            and noteCount > 0
            and #computedAttributes == 0,
        scanMode = scanMode,
        scannedNoteCount = scannedNoteCount,
        rangeMatch = hasStartSeconds and rangeMatch or JSON_NULL,
        coverage = hasStartSeconds
            and (rangeMatch == "onset" and "onset_only" or "complete_overlap")
            or "explicit_notes",
        mayExcludeEarlierSustains =
            hasStartSeconds and rangeMatch == "onset" or false,
        responseMode = mode,
        notes = notes
    }
end

local function roundedMetric(value)
    if type(value) ~= "number" then
        return JSON_NULL
    end
    if value >= 0 then
        return math.floor(value * 10000 + 0.5) / 10000
    end
    return math.ceil(value * 10000 - 0.5) / 10000
end

local function compactPhraseNoteDefaults(notes)
    for index = 1, #notes do
        local note = notes[index]
        note.absoluteOnsetSeconds =
            roundedMetric(note.absoluteOnsetSeconds)
        note.absoluteEndSeconds =
            roundedMetric(note.absoluteEndSeconds)
        note.absoluteDurationSeconds =
            roundedMetric(note.absoluteDurationSeconds)
        if note.selected == false then
            note.selected = nil
        end
        if note.detune == 0 then
            note.detune = nil
        end
        if note.phonemeSequence == "" then
            note.phonemeSequence = nil
        end
        if note.languageOverride == "" then
            note.languageOverride = nil
        end
        if note.phonesetOverride == JSON_NULL
            or note.phonesetOverride == "" then
            note.phonesetOverride = nil
        end
        if note.evenSyllableDuration == JSON_NULL
            or note.evenSyllableDuration == true then
            note.evenSyllableDuration = nil
        end
        if type(note.phonemeAttributes) == "table"
            and #note.phonemeAttributes == 0 then
            note.phonemeAttributes = nil
        end
    end
end

local function analyzePhraseNotes(notes, breathGapSeconds, recommendationLimit)
    local analysis = {
        noteCount = #notes,
        startPosition = JSON_NULL,
        endPosition = JSON_NULL,
        startSeconds = JSON_NULL,
        endSeconds = JSON_NULL,
        durationSeconds = 0,
        voicedDurationSeconds = 0,
        meanNoteDurationSeconds = JSON_NULL,
        minimumPitch = JSON_NULL,
        maximumPitch = JSON_NULL,
        pitchRangeSemitones = JSON_NULL,
        meanPitch = JSON_NULL,
        gapCount = 0,
        breathGapCount = 0,
        overlapCount = 0,
        largeLeapCount = 0,
        sustainedNoteCount = 0,
        shortNoteCount = 0
    }
    local recommendations = json.array()
    if #notes == 0 then
        return analysis, recommendations
    end

    local gaps = json.array()
    local overlaps = json.array()
    local leaps = json.array()
    local sustains = json.array()
    local shortNotes = json.array()
    local minimumPitch = nil
    local maximumPitch = nil
    local pitchTotal = 0
    local phraseStart = nil
    local phraseEnd = nil
    local phraseStartSeconds = nil
    local phraseEndSeconds = nil
    local voicedDurationSeconds = 0
    local previous = nil

    for index = 1, #notes do
        local note = notes[index]
        local pitch = note.absolutePitch
        local onset = note.absoluteOnset
        local ending = onset + note.duration
        local onsetSeconds = note.absoluteOnsetSeconds
        local endSeconds = note.absoluteEndSeconds
        local durationSeconds = note.absoluteDurationSeconds
        phraseStart = phraseStart == nil and onset or math.min(phraseStart, onset)
        phraseEnd = phraseEnd == nil and ending or math.max(phraseEnd, ending)
        phraseStartSeconds = phraseStartSeconds == nil
            and onsetSeconds
            or math.min(phraseStartSeconds, onsetSeconds)
        phraseEndSeconds = phraseEndSeconds == nil
            and endSeconds
            or math.max(phraseEndSeconds, endSeconds)
        voicedDurationSeconds = voicedDurationSeconds + durationSeconds
        minimumPitch = minimumPitch == nil and pitch or math.min(minimumPitch, pitch)
        maximumPitch = maximumPitch == nil and pitch or math.max(maximumPitch, pitch)
        pitchTotal = pitchTotal + pitch

        if durationSeconds >= 0.75 then
            analysis.sustainedNoteCount = analysis.sustainedNoteCount + 1
            sustains[#sustains + 1] = {
                noteIndex = note.noteIndex,
                durationSeconds = roundedMetric(durationSeconds)
            }
        elseif durationSeconds <= 0.18 then
            analysis.shortNoteCount = analysis.shortNoteCount + 1
            shortNotes[#shortNotes + 1] = {
                noteIndex = note.noteIndex,
                durationSeconds = roundedMetric(durationSeconds)
            }
        end

        if previous ~= nil then
            local gapSeconds = onsetSeconds - previous.absoluteEndSeconds
            local interval = math.abs(pitch - previous.absolutePitch)
            if gapSeconds > 0 then
                analysis.gapCount = analysis.gapCount + 1
                if gapSeconds >= breathGapSeconds then
                    analysis.breathGapCount = analysis.breathGapCount + 1
                    gaps[#gaps + 1] = {
                        afterNoteIndex = previous.noteIndex,
                        beforeNoteIndex = note.noteIndex,
                        gapSeconds = roundedMetric(gapSeconds)
                    }
                end
            elseif gapSeconds < -0.02 then
                analysis.overlapCount = analysis.overlapCount + 1
                overlaps[#overlaps + 1] = {
                    noteIndices = json.array({
                        previous.noteIndex,
                        note.noteIndex
                    }),
                    overlapSeconds = roundedMetric(-gapSeconds)
                }
            end
            if interval >= 5 then
                analysis.largeLeapCount = analysis.largeLeapCount + 1
                leaps[#leaps + 1] = {
                    noteIndices = json.array({
                        previous.noteIndex,
                        note.noteIndex
                    }),
                    intervalSemitones = roundedMetric(interval)
                }
            end
        end
        previous = note
    end

    analysis.startPosition = phraseStart
    analysis.endPosition = phraseEnd
    analysis.startSeconds = roundedMetric(phraseStartSeconds)
    analysis.endSeconds = roundedMetric(phraseEndSeconds)
    analysis.durationSeconds = roundedMetric(
        phraseEndSeconds - phraseStartSeconds
    )
    analysis.voicedDurationSeconds = roundedMetric(voicedDurationSeconds)
    analysis.meanNoteDurationSeconds = roundedMetric(
        voicedDurationSeconds / #notes
    )
    analysis.minimumPitch = minimumPitch
    analysis.maximumPitch = maximumPitch
    analysis.pitchRangeSemitones = roundedMetric(maximumPitch - minimumPitch)
    analysis.meanPitch = roundedMetric(pitchTotal / #notes)

    local function appendRecommendations(candidates, kind, priority)
        for index = 1, #candidates do
            if #recommendations >= recommendationLimit then
                return
            end
            local recommendation = {
                kind = kind,
                priority = priority
            }
            for key, value in pairs(candidates[index]) do
                recommendation[key] = value
            end
            recommendations[#recommendations + 1] = recommendation
        end
    end

    appendRecommendations(overlaps, "timing_overlap", "high")
    appendRecommendations(leaps, "pitch_transition", "medium")
    appendRecommendations(sustains, "sustain_expression", "medium")
    appendRecommendations(gaps, "breath_opportunity", "low")
    appendRecommendations(shortNotes, "dense_articulation", "low")
    return analysis, recommendations
end

local function serializePhraseVoice(reference, trackIndex, groupIndex)
    local rawVoice = safeCall(function()
        return reference:getVoice()
    end, {})
    if type(rawVoice) ~= "table" then
        rawVoice = {}
    end
    local parameters = {}
    for publicName, definition in pairs(GROUP_VOICE_PARAMETERS) do
        parameters[publicName] = valueOrNull(rawVoice[definition.hostKey])
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        referenceFingerprint = makeReferenceFingerprint(reference),
        parameters = parameters,
        vocalModes = type(rawVoice.vocalModeParams) == "table"
            and sanitizeForJson(rawVoice.vocalModeParams)
            or {}
    }
end

local function summarizePhraseAutomationRange(
    automation,
    serialized,
    beginPosition,
    endPosition
)
    local rawPoints = automation:getPoints(beginPosition, endPosition)
    local middlePosition = math.floor((beginPosition + endPosition) / 2)
    local startValue = automation:get(beginPosition)
    local middleValue = automation:get(middlePosition)
    local endValue = automation:get(endPosition)
    local minimumValue = math.min(startValue, middleValue, endValue)
    local maximumValue = math.max(startValue, middleValue, endValue)
    for index = 1, #rawPoints do
        minimumValue = math.min(minimumValue, rawPoints[index][2])
        maximumValue = math.max(maximumValue, rawPoints[index][2])
    end
    return {
        parameter = serialized.parameter,
        interpolation = serialized.interpolation,
        fingerprint = serialized.fingerprint,
        totalPointCount = serialized.pointCount,
        pointCountInRange = #rawPoints,
        samples = {
            start = roundedMetric(startValue),
            middle = roundedMetric(middleValue),
            ending = roundedMetric(endValue)
        },
        minimum = roundedMetric(minimumValue),
        maximum = roundedMetric(maximumValue),
        range = roundedMetric(maximumValue - minimumValue)
    }
end

local function summarizePhraseAutomation(
    group,
    parameterName,
    beginPosition,
    endPosition
)
    local automation, serialized = serializeAutomation(group, parameterName)
    return summarizePhraseAutomationRange(
        automation,
        serialized,
        beginPosition,
        endPosition
    )
end

local function summarizeComputedPitch(
    reference,
    startPosition,
    endPosition,
    frames
)
    if frames <= 0 or startPosition == JSON_NULL or endPosition == JSON_NULL then
        return {
            included = false
        }
    end
    local interval = frames == 1
        and math.max(1, endPosition - startPosition)
        or math.max(1, math.floor((endPosition - startPosition) / (frames - 1)))
    local rawPitch = SV:getComputedPitchForGroup(
        reference,
        startPosition,
        interval,
        frames
    )
    local minimumPitch = nil
    local maximumPitch = nil
    local pitchTotal = 0
    local voicedFrames = 0
    for index = 1, frames do
        local value = rawPitch[index]
        if type(value) == "number" then
            minimumPitch = minimumPitch == nil
                and value
                or math.min(minimumPitch, value)
            maximumPitch = maximumPitch == nil
                and value
                or math.max(maximumPitch, value)
            pitchTotal = pitchTotal + value
            voicedFrames = voicedFrames + 1
        end
    end
    return {
        included = true,
        requestedFrames = frames,
        returnedFrames = #rawPitch,
        voicedFrames = voicedFrames,
        pending = #rawPitch == 0,
        interval = interval,
        minimumPitch = roundedMetric(minimumPitch),
        maximumPitch = roundedMetric(maximumPitch),
        pitchRangeSemitones = minimumPitch ~= nil
            and roundedMetric(maximumPitch - minimumPitch)
            or JSON_NULL,
        meanPitch = voicedFrames > 0
            and roundedMetric(pitchTotal / voicedFrames)
            or JSON_NULL
    }
end

local function applyPhrasePageCursor(payload, group)
    if not isProvided(payload.pageCursor) then
        return false
    end
    if isProvided(payload.noteIndices)
        or isProvided(payload.startSeconds)
        or isProvided(payload.endSeconds)
        or isProvided(payload.ranges) then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "pageCursor cannot be combined with notes or time ranges"
        )
    end
    local suppliedOffset = optionalInteger(
        payload.offset,
        "offset",
        0,
        nil,
        0
    )
    if suppliedOffset ~= 0 then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "pageCursor cannot be combined with a non-zero offset"
        )
    end
    local cursor = requireObject(payload.pageCursor, "pageCursor")
    local noteCount = group:getNumNotes()
    local anchorNoteIndex = requireInteger(
        cursor.anchorNoteIndex,
        "pageCursor.anchorNoteIndex",
        1,
        noteCount
    )
    local nextNoteIndex = requireInteger(
        cursor.nextNoteIndex,
        "pageCursor.nextNoteIndex",
        1,
        noteCount
    )
    if nextNoteIndex ~= anchorNoteIndex + 1 then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "pageCursor.nextNoteIndex must immediately follow its anchor"
        )
    end
    local expectedFingerprint = requireString(
        cursor.fingerprint,
        "pageCursor.fingerprint",
        false
    )
    local anchorNote = group:getNote(anchorNoteIndex)
    local actualFingerprint = makeNoteFingerprint(
        group:getUUID(),
        anchorNoteIndex,
        anchorNote
    )
    if actualFingerprint ~= expectedFingerprint then
        raiseBridgeError(
            "STALE_RANGE_CURSOR",
            "The range cursor boundary changed; read the page again.",
            {
                anchorNoteIndex = anchorNoteIndex,
                nextNoteIndex = nextNoteIndex
            }
        )
    end
    payload.offset = nextNoteIndex - 1
    payload.preferSelectedNotes = false
    return true
end

local function collectPhraseRanges(
    payload,
    project,
    reference,
    group
)
    if not isProvided(payload.ranges) then
        return nil
    end
    if isProvided(payload.noteIndices)
        or isProvided(payload.startSeconds)
        or isProvided(payload.endSeconds)
        or isProvided(payload.pageCursor) then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "ranges cannot be combined with noteIndices, a top-level time range, or pageCursor"
        )
    end
    local suppliedOffset = optionalInteger(
        payload.offset,
        "offset",
        0,
        nil,
        0
    )
    if suppliedOffset ~= 0 then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "ranges cannot be combined with a non-zero offset"
        )
    end

    local values = requireArray(payload.ranges, "ranges", 1, 32)
    local timeAxis = project:getTimeAxis()
    local timeOffset = reference:getTimeOffset()
    local rangeMatch = requestedRangeMatch(payload)
    local ranges = json.array()
    local minimumStart = nil
    local maximumEnd = nil
    local minimumStartSeconds = nil
    local maximumEndSeconds = nil
    for index = 1, #values do
        local value = requireObject(values[index], "ranges[" .. index .. "]")
        local startSeconds = requireFiniteNumber(
            value.startSeconds,
            "ranges[" .. index .. "].startSeconds",
            0
        )
        local endSeconds = requireFiniteNumber(
            value.endSeconds,
            "ranges[" .. index .. "].endSeconds",
            startSeconds
        )
        local startPosition = timeAxis:getBlickFromSeconds(startSeconds)
        local endPosition = timeAxis:getBlickFromSeconds(endSeconds)
        local range = {
            rangeIndex = index,
            startSeconds = startSeconds,
            endSeconds = endSeconds,
            startPosition = startPosition,
            endPosition = endPosition,
            beginGroupPosition = math.max(0, startPosition - timeOffset),
            endGroupPosition = math.max(0, endPosition - timeOffset),
            noteIndices = json.array()
        }
        if isProvided(value.label) then
            range.label = requireString(
                value.label,
                "ranges[" .. index .. "].label",
                false
            )
        end
        ranges[#ranges + 1] = range
        minimumStart = minimumStart == nil
            and startPosition
            or math.min(minimumStart, startPosition)
        maximumEnd = maximumEnd == nil
            and endPosition
            or math.max(maximumEnd, endPosition)
        minimumStartSeconds = minimumStartSeconds == nil
            and startSeconds
            or math.min(minimumStartSeconds, startSeconds)
        maximumEndSeconds = maximumEndSeconds == nil
            and endSeconds
            or math.max(maximumEndSeconds, endSeconds)
    end

    local firstNoteIndex = 1
    local scannedNoteCount = 0
    if rangeMatch == "onset" then
        firstNoteIndex, scannedNoteCount = findFirstNoteOnsetAtLeast(
            group,
            timeOffset,
            minimumStart
        )
    end
    local matched = {}
    local noteIndices = json.array()
    for noteIndex = firstNoteIndex, group:getNumNotes() do
        local note = group:getNote(noteIndex)
        scannedNoteCount = scannedNoteCount + 1
        local absoluteOnset = note:getOnset() + timeOffset
        if absoluteOnset > maximumEnd then
            break
        end
        local absoluteEnd = note:getEnd() + timeOffset
        for rangeIndex = 1, #ranges do
            local range = ranges[rangeIndex]
            local matches = rangeMatch == "onset"
                and absoluteOnset >= range.startPosition
                or absoluteEnd >= range.startPosition
            if matches and absoluteOnset <= range.endPosition then
                range.noteIndices[#range.noteIndices + 1] = noteIndex
                if not matched[noteIndex] then
                    matched[noteIndex] = true
                    noteIndices[#noteIndices + 1] = noteIndex
                    if #noteIndices > 256 then
                        raiseBridgeError(
                            "RANGE_RESULT_LIMIT_EXCEEDED",
                            "The combined ranges match more than 256 notes; split the request into smaller batches."
                        )
                    end
                end
            end
        end
    end
    return {
        ranges = ranges,
        noteIndices = noteIndices,
        rangeMatch = rangeMatch,
        scannedNoteCount = scannedNoteCount,
        minimumStart = minimumStart,
        maximumEnd = maximumEnd,
        minimumStartSeconds = minimumStartSeconds,
        maximumEndSeconds = maximumEndSeconds
    }
end

local PHRASE_INCLUDE_KEYS = {
    notes = true,
    voice = true,
    automation = true,
    analysis = true,
    recommendations = true,
    pitchAnalysis = true,
    selection = true,
    diagnostics = true
}

local function phraseIncludes(payload)
    if not isProvided(payload.include) then
        return {
            notes = true,
            voice = true,
            automation = true,
            analysis = true,
            recommendations = true,
            pitchAnalysis = true,
            selection = true,
            diagnostics = true
        }
    end
    local requested = requireArray(payload.include, "include", 0, 8)
    local result = {}
    for index = 1, #requested do
        local name = requireString(
            requested[index],
            "include[" .. index .. "]",
            false
        )
        if not PHRASE_INCLUDE_KEYS[name] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "Unsupported get_phrase_context include field",
                { include = name }
            )
        end
        if result[name] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "get_phrase_context include contains a duplicate",
                { include = name }
            )
        end
        result[name] = true
    end
    return result
end

local function phraseBounds(notes)
    local result = {
        startPosition = JSON_NULL,
        endPosition = JSON_NULL,
        startSeconds = JSON_NULL,
        endSeconds = JSON_NULL
    }
    for index = 1, #notes do
        local note = notes[index]
        local onset = note.absoluteOnset
        local ending = note.absoluteEnd or (onset + note.duration)
        local onsetSeconds = note.absoluteOnsetSeconds
        local endSeconds = note.absoluteEndSeconds
        result.startPosition = result.startPosition == JSON_NULL
            and onset
            or math.min(result.startPosition, onset)
        result.endPosition = result.endPosition == JSON_NULL
            and ending
            or math.max(result.endPosition, ending)
        result.startSeconds = result.startSeconds == JSON_NULL
            and onsetSeconds
            or math.min(result.startSeconds, onsetSeconds)
        result.endSeconds = result.endSeconds == JSON_NULL
            and endSeconds
            or math.max(result.endSeconds, endSeconds)
    end
    return result
end

function handlers.get_phrase_context(payload)
    payload = requireObject(payload, "payload")
    local phrasePayload = {}
    for key, value in pairs(payload) do
        phrasePayload[key] = value
    end
    local includes = phraseIncludes(phrasePayload)

    local locatorSource = "explicit"
    if not isProvided(phrasePayload.trackIndex) then
        if isProvided(phrasePayload.groupIndex)
            or isProvided(phrasePayload.groupUuid) then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "groupIndex/groupUuid require trackIndex, or omit all locators to use the current piano-roll Group"
            )
        end
        local currentReference = safeCall(function()
            return SV:getMainEditor():getCurrentGroup()
        end, nil)
        local current = locateReference(currentReference)
        if not current or current.instrumental then
            raiseBridgeError(
                "GROUP_NOT_FOUND",
                "The piano roll does not have a current vocal Group"
            )
        end
        phrasePayload.trackIndex = current.trackIndex
        phrasePayload.groupIndex = current.groupIndex
        phrasePayload.groupUuid = current.groupUuid
        locatorSource = "current_editor"
    end

    local project, _track, trackIndex, reference, group, groupIndex =
        resolveGroup(phrasePayload)
    local cursorPage = applyPhrasePageCursor(phrasePayload, group)
    local multiRange = collectPhraseRanges(
        phrasePayload,
        project,
        reference,
        group
    )
    local selectionContext, selectedNoteIndices =
        getTargetSelectionContext(reference, group)
    local hasExplicitIndices = isProvided(phrasePayload.noteIndices)
    local hasTimeRange = isProvided(phrasePayload.startSeconds)
        or isProvided(phrasePayload.endSeconds)
    local hasMultipleRanges = multiRange ~= nil
    local preferSelectedNotes = optionalBoolean(
        phrasePayload.preferSelectedNotes,
        "preferSelectedNotes"
    )
    if preferSelectedNotes == nil then
        preferSelectedNotes = true
    end
    local scopeSource = hasMultipleRanges and "multi_range"
        or (cursorPage and "cursor_page")
        or (hasExplicitIndices and "note_indices")
        or (hasTimeRange and "seconds_range" or "page")
    if not hasExplicitIndices
        and not hasTimeRange
        and not hasMultipleRanges
        and not cursorPage
        and preferSelectedNotes
        and selectionContext.selectedNoteCount > 0 then
        local selected = json.array()
        for noteIndex, selectedValue in pairs(selectedNoteIndices) do
            if selectedValue then
                selected[#selected + 1] = noteIndex
            end
        end
        table.sort(selected)
        phrasePayload.noteIndices = selected
        scopeSource = "selected_notes"
    end

    phrasePayload.responseMode = "compact"
    phrasePayload.includeRawAttributes = false
    phrasePayload.includeComputedAttributes = false
    phrasePayload.includePitch = true
    phrasePayload.offset = optionalInteger(
        phrasePayload.offset,
        "offset",
        0,
        nil,
        0
    )
    phrasePayload.limit = optionalInteger(
        phrasePayload.limit,
        "limit",
        1,
        256,
        128
    )
    if hasMultipleRanges then
        phrasePayload.noteIndices = multiRange.noteIndices
        phrasePayload.ranges = nil
        phrasePayload.offset = 0
        phrasePayload.limit = 256
    end
    local noteData = handlers.get_note_phoneme_data(phrasePayload)
    if hasMultipleRanges then
        noteData.scanMode = multiRange.rangeMatch == "onset"
            and "multi_range_onset_sweep"
            or "multi_range_overlap_sweep"
        noteData.rangeScannedNoteCount = multiRange.scannedNoteCount
        noteData.serializationScannedNoteCount = noteData.scannedNoteCount
        noteData.scannedNoteCount =
            multiRange.scannedNoteCount + noteData.scannedNoteCount
        noteData.rangeMatch = multiRange.rangeMatch
        noteData.coverage = multiRange.rangeMatch == "onset"
            and "onset_only"
            or "complete_overlap"
        noteData.mayExcludeEarlierSustains =
            multiRange.rangeMatch == "onset"
        noteData.multiRange = true
    end
    compactPhraseNoteDefaults(noteData.notes)
    noteData.noteDefaultsOmitted = true
    noteData.secondsPrecision = 0.0001
    local breathGapSeconds = optionalNumber(
        phrasePayload.breathGapSeconds,
        "breathGapSeconds",
        0.05,
        2
    ) or 0.18
    local recommendationLimit = optionalInteger(
        phrasePayload.recommendationLimit,
        "recommendationLimit",
        0,
        32,
        12
    )
    local analysis = phraseBounds(noteData.notes)
    local recommendations = json.array()
    if includes.analysis or includes.recommendations then
        analysis, recommendations = analyzePhraseNotes(
            noteData.notes,
            breathGapSeconds,
            recommendationLimit
        )
    end
    if hasMultipleRanges then
        local noteByIndex = {}
        for index = 1, #noteData.notes do
            local note = noteData.notes[index]
            noteByIndex[note.noteIndex] = note
        end
        for rangeIndex = 1, #multiRange.ranges do
            local range = multiRange.ranges[rangeIndex]
            local rangeNotes = json.array()
            for noteIndexIndex = 1, #range.noteIndices do
                local note = noteByIndex[range.noteIndices[noteIndexIndex]]
                if note ~= nil then
                    rangeNotes[#rangeNotes + 1] = note
                end
            end
            if includes.analysis or includes.recommendations then
                range.analysis, range.recommendations = analyzePhraseNotes(
                    rangeNotes,
                    breathGapSeconds,
                    recommendationLimit
                )
                if not includes.analysis then
                    range.analysis = nil
                end
                if not includes.recommendations then
                    range.recommendations = nil
                end
            end
        end
        analysis = {
            multiRange = true,
            rangeCount = #multiRange.ranges,
            uniqueNoteCount = #noteData.notes,
            startPosition = multiRange.minimumStart,
            endPosition = multiRange.maximumEnd,
            startSeconds = roundedMetric(multiRange.minimumStartSeconds),
            endSeconds = roundedMetric(multiRange.maximumEndSeconds),
            spanSeconds = roundedMetric(
                multiRange.maximumEndSeconds - multiRange.minimumStartSeconds
            ),
            crossRangeTransitionsExcluded = true
        }
        recommendations = json.array()
    end

    local beginPosition = 0
    local endPosition = 0
    if hasMultipleRanges then
        beginPosition = math.max(
            0,
            multiRange.minimumStart - reference:getTimeOffset()
        )
        endPosition = math.max(
            beginPosition,
            multiRange.maximumEnd - reference:getTimeOffset()
        )
    elseif analysis.startPosition ~= JSON_NULL then
        beginPosition =
            math.max(0, analysis.startPosition - reference:getTimeOffset())
        endPosition =
            math.max(beginPosition, analysis.endPosition - reference:getTimeOffset())
    elseif isProvided(phrasePayload.startSeconds)
        and isProvided(phrasePayload.endSeconds) then
        local timeAxis = getProject():getTimeAxis()
        beginPosition = math.max(
            0,
            timeAxis:getBlickFromSeconds(phrasePayload.startSeconds)
                - reference:getTimeOffset()
        )
        endPosition = math.max(
            beginPosition,
            timeAxis:getBlickFromSeconds(phrasePayload.endSeconds)
                - reference:getTimeOffset()
        )
    end

    local requestedAutomation = includes.automation
        and isProvided(phrasePayload.automationParameters)
        and requireArray(
            phrasePayload.automationParameters,
            "automationParameters",
            0,
            8
        )
        or (includes.automation
            and json.array({ "loudness", "tension", "breathiness" })
            or json.array())
    local automation = json.array()
    local seenParameters = {}
    for index = 1, #requestedAutomation do
        local parameter = requireString(
            requestedAutomation[index],
            "automationParameters[" .. index .. "]",
            false
        )
        if seenParameters[parameter] then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "automationParameters contains a duplicate",
                { parameter = parameter }
            )
        end
        seenParameters[parameter] = true
        if hasMultipleRanges then
            local curve, serialized = serializeAutomation(group, parameter)
            local rangeSummaries = json.array()
            for rangeIndex = 1, #multiRange.ranges do
                local range = multiRange.ranges[rangeIndex]
                local summary = summarizePhraseAutomationRange(
                    curve,
                    serialized,
                    range.beginGroupPosition,
                    range.endGroupPosition
                )
                summary.rangeIndex = rangeIndex
                summary.parameter = nil
                summary.interpolation = nil
                summary.fingerprint = nil
                summary.totalPointCount = nil
                rangeSummaries[#rangeSummaries + 1] = summary
            end
            automation[#automation + 1] = {
                parameter = serialized.parameter,
                interpolation = serialized.interpolation,
                fingerprint = serialized.fingerprint,
                totalPointCount = serialized.pointCount,
                ranges = rangeSummaries
            }
        else
            automation[#automation + 1] = summarizePhraseAutomation(
                group,
                parameter,
                beginPosition,
                endPosition
            )
        end
    end

    local pitchAnalysisFrames = includes.pitchAnalysis
        and optionalInteger(
            phrasePayload.pitchAnalysisFrames,
            "pitchAnalysisFrames",
            0,
            256,
            0
        )
        or 0
    if hasMultipleRanges
        and pitchAnalysisFrames * #multiRange.ranges > 256 then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "pitchAnalysisFrames times the number of ranges must not exceed 256"
        )
    end
    noteData.scope = {
        locatorSource = locatorSource,
        source = scopeSource,
        beginPosition = beginPosition,
        endPosition = endPosition
    }
    if includes.voice then
        noteData.voice = serializePhraseVoice(reference, trackIndex, groupIndex)
    end
    if includes.analysis then
        noteData.analysis = analysis
    end
    if includes.recommendations then
        noteData.recommendations = recommendations
    end
    noteData.automation = automation
    if hasMultipleRanges then
        noteData.ranges = multiRange.ranges
        local pitchRanges = json.array()
        for rangeIndex = 1, #multiRange.ranges do
            local range = multiRange.ranges[rangeIndex]
            local pitchSummary = summarizeComputedPitch(
                reference,
                range.startPosition,
                range.endPosition,
                pitchAnalysisFrames
            )
            pitchSummary.rangeIndex = rangeIndex
            pitchRanges[#pitchRanges + 1] = pitchSummary
            range.beginGroupPosition = nil
            range.endGroupPosition = nil
        end
        if includes.pitchAnalysis then
            noteData.pitchAnalysis = {
                included = pitchAnalysisFrames > 0,
                framesPerRange = pitchAnalysisFrames,
                ranges = pitchRanges
            }
        end
    else
        if includes.pitchAnalysis then
            noteData.pitchAnalysis = summarizeComputedPitch(
                reference,
                analysis.startPosition,
                analysis.endPosition,
                pitchAnalysisFrames
            )
        end
    end
    if scopeSource == "page" or scopeSource == "cursor_page" then
        local firstNote = noteData.notes[1]
        local lastNote = noteData.notes[#noteData.notes]
        noteData.page = {
            firstNoteIndex = firstNote ~= nil
                and firstNote.noteIndex
                or JSON_NULL,
            lastNoteIndex = lastNote ~= nil
                and lastNote.noteIndex
                or JSON_NULL,
            nextNoteIndex = noteData.hasMore and lastNote ~= nil
                and lastNote.noteIndex + 1
                or JSON_NULL
        }
        if noteData.hasMore and lastNote ~= nil then
            noteData.pageCursor = {
                anchorNoteIndex = lastNote.noteIndex,
                nextNoteIndex = lastNote.noteIndex + 1,
                fingerprint = lastNote.fingerprint
            }
        end
    end
    if not includes.selection then
        noteData.selectionContext = nil
    end
    if not includes.diagnostics then
        noteData.attributesPending = nil
        noteData.computedPhonemesIncluded = nil
        noteData.matchedNoteCount = nil
        noteData.noteDefaultsOmitted = nil
        noteData.phonemesPending = nil
        noteData.rangeScannedNoteCount = nil
        noteData.responseMode = nil
        noteData.returnedNoteCount = nil
        noteData.returnedNoteOffset = nil
        noteData.scannedNoteCount = nil
        noteData.secondsPrecision = nil
        noteData.serializationScannedNoteCount = nil
    end
    return noteData
end

function handlers.get_selection(payload)
    payload = requireObject(payload or {}, "payload")
    local mainEditor = SV:getMainEditor()
    local track = mainEditor:getCurrentTrack()
    local reference = mainEditor:getCurrentGroup()
    if not track or not reference then
        raiseBridgeError("SELECTION_UNAVAILABLE", "The piano roll has no current track or group")
    end

    local group = reference:isInstrumental() and nil or reference:getTarget()
    local selection = mainEditor:getSelection()
    local selectedNotes = selection:getSelectedNotes()
    local serializedNotes = json.array()
    if group then
        for index = 1, #selectedNotes do
            local note = selectedNotes[index]
            local noteIndex = note:getIndexInParent()
            serializedNotes[#serializedNotes + 1] = serializeNote(group, reference, note, noteIndex)
        end
    end

    local selectedGroups = json.array()
    local function appendSelectedGroups(groupReferences, source)
        for index = 1, #groupReferences do
            local locator = locateReference(groupReferences[index])
            if locator then
                locator.source = source
                selectedGroups[#selectedGroups + 1] = locator
            end
        end
    end
    appendSelectedGroups(selection:getSelectedGroups(), "pianoRoll")
    local arrangementSelection = safeCall(function()
        return SV:getArrangement():getSelection()
    end, nil)
    if arrangementSelection then
        appendSelectedGroups(arrangementSelection:getSelectedGroups(), "arrangement")
    end

    local serializedPitchControls = json.array()
    if group then
        local selectedPitchControls = safeCall(function()
            return selection:getSelectedPitchControls()
        end, {})
        for index = 1, #selectedPitchControls do
            local control = selectedPitchControls[index]
            serializedPitchControls[#serializedPitchControls + 1] =
                serializePitchControl(group, control, control:getIndexInParent())
        end
    end

    local selectedAutomation = {}
    local automationParameters = isProvided(payload.automationParameters)
        and requireArray(payload.automationParameters, "automationParameters", 0, 64) or json.array()
    if group then
        for index = 1, #automationParameters do
            local parameter = requireString(
                automationParameters[index],
                "automationParameters[" .. index .. "]",
                false
            )
            local positions = safeCall(function()
                return selection:getSelectedPoints(parameter)
            end, {})
            local automation = group:getParameter(parameter)
            local points = json.array()
            for pointIndex = 1, #positions do
                points[#points + 1] = {
                    position = positions[pointIndex],
                    value = automation:get(positions[pointIndex])
                }
            end
            selectedAutomation[parameter] = points
        end
    end

    return {
        current = locateReference(reference),
        selectionRevision = runtimeState.selectionRevision,
        latestSelectionEvent = valueOrNull(runtimeState.latestSelectionEvent),
        pianoRollHasUnfinishedEdits = safeCall(function()
            return selection:hasUnfinishedEdits()
        end, false),
        arrangementHasUnfinishedEdits = arrangementSelection and safeCall(function()
            return arrangementSelection:hasUnfinishedEdits()
        end, false) or false,
        selectedNoteCount = #serializedNotes,
        selectedNotes = serializedNotes,
        selectedPitchControlCount = #serializedPitchControls,
        selectedPitchControls = serializedPitchControls,
        selectedAutomation = selectedAutomation,
        selectedGroupCount = #selectedGroups,
        selectedGroups = selectedGroups
    }
end

function handlers.set_selection(payload)
    payload = requireObject(payload, "payload")
    local scope = optionalString(payload.scope, "scope", false) or "pianoRoll"
    local operation = requireString(payload.operation, "operation", false)
    local kind = requireString(payload.kind, "kind", false)
    if operation ~= "replace" and operation ~= "add" and operation ~= "remove" and operation ~= "clear" then
        raiseBridgeError("INVALID_ARGUMENT", "operation must be replace, add, remove, or clear")
    end
    local selection
    if scope == "pianoRoll" then
        selection = SV:getMainEditor():getSelection()
    elseif scope == "arrangement" then
        selection = SV:getArrangement():getSelection()
        if kind ~= "groups" and kind ~= "all" then
            raiseBridgeError("INVALID_ARGUMENT", "Arrangement selection only supports groups")
        end
    else
        raiseBridgeError("INVALID_ARGUMENT", "scope must be pianoRoll or arrangement")
    end

    local function clearKind()
        if kind == "all" then
            selection:clearAll()
        elseif kind == "groups" then
            selection:clearGroups()
        elseif kind == "notes" then
            selection:clearNotes()
        elseif kind == "pitchControls" then
            selection:clearPitchControls()
        elseif kind == "automationPoints" then
            local parameter = requireString(payload.parameter, "parameter", false)
            local selected = selection:getSelectedPoints(parameter)
            if #selected > 0 then
                selection:unselectPoints(parameter, selected)
            end
        else
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "kind must be all, groups, notes, pitchControls, or automationPoints"
            )
        end
    end

    if operation == "clear" then
        clearKind()
        return handlers.get_selection({
            automationParameters = isProvided(payload.parameter) and json.array({ payload.parameter }) or json.array()
        })
    end
    if kind == "all" then
        raiseBridgeError("INVALID_ARGUMENT", "kind=all is only valid with operation=clear")
    end
    local adding = operation == "replace" or operation == "add"
    local applySelection

    if kind == "groups" then
        local groups = requireArray(payload.groups, "groups", 1, 512)
        local preparedGroups = {}
        for index = 1, #groups do
            local locator = requireObject(groups[index], "groups[" .. index .. "]")
            local _project, _track, _trackIndex, reference = resolveReference(locator)
            if reference:isMain() then
                raiseBridgeError(
                    "INVALID_ARGUMENT",
                    "SynthV does not allow a track's main group to be selected as a group",
                    {
                        trackIndex = _trackIndex,
                        groupIndex = locator.groupIndex or 1
                    }
                )
            end
            preparedGroups[#preparedGroups + 1] = reference
        end
        applySelection = function()
            for index = 1, #preparedGroups do
                if adding then
                    selection:selectGroup(preparedGroups[index])
                else
                    selection:unselectGroup(preparedGroups[index])
                end
            end
        end
    else
        if scope ~= "pianoRoll" then
            raiseBridgeError("INVALID_ARGUMENT", "Only pianoRoll supports this selection kind")
        end
        local _project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
        local currentLocation = locateReference(SV:getMainEditor():getCurrentGroup())
        if not currentLocation
            or currentLocation.trackIndex ~= trackIndex
            or currentLocation.groupIndex ~= groupIndex
            or currentLocation.groupUuid ~= group:getUUID() then
            raiseBridgeError(
                "SELECTION_GROUP_MISMATCH",
                "Notes, pitch controls, and automation points must belong to the current piano-roll group"
            )
        end
        if kind == "notes" then
            local notes = requireArray(payload.notes, "notes", 1, 512)
            local preparedNotes = {}
            for index = 1, #notes do
                local target = requireObject(notes[index], "notes[" .. index .. "]")
                local noteIndex = requireInteger(
                    target.noteIndex,
                    "notes[" .. index .. "].noteIndex",
                    1,
                    group:getNumNotes()
                )
                local note = group:getNote(noteIndex)
                if isProvided(target.fingerprint) then
                    note = validateFingerprint(
                        group,
                        noteIndex,
                        requireString(target.fingerprint, "notes[" .. index .. "].fingerprint", false)
                    )
                end
                preparedNotes[#preparedNotes + 1] = note
            end
            applySelection = function()
                for index = 1, #preparedNotes do
                    if adding then
                        selection:selectNote(preparedNotes[index])
                    else
                        selection:unselectNote(preparedNotes[index])
                    end
                end
            end
        elseif kind == "pitchControls" then
            local targets = requireArray(payload.pitchControls, "pitchControls", 1, 512)
            local controls = {}
            for index = 1, #targets do
                local target = requireObject(targets[index], "pitchControls[" .. index .. "]")
                local controlIndex = requireInteger(
                    target.pitchControlIndex,
                    "pitchControls[" .. index .. "].pitchControlIndex",
                    1,
                    group:getNumPitchControls()
                )
                local control = group:getPitchControl(controlIndex)
                if isProvided(target.fingerprint) then
                    validateExpectedFingerprint(
                        serializePitchControl(group, control, controlIndex).fingerprint,
                        requireString(
                            target.fingerprint,
                            "pitchControls[" .. index .. "].fingerprint",
                            false
                        ),
                        "STALE_PITCH_CONTROL",
                        "The pitch control changed after it was read"
                    )
                end
                controls[#controls + 1] = control
            end
            applySelection = function()
                if adding then
                    selection:selectPitchControls(controls)
                else
                    selection:unselectPitchControls(controls)
                end
            end
        elseif kind == "automationPoints" then
            local parameter = requireString(payload.parameter, "parameter", false)
            group:getParameter(parameter)
            local rawPositions = requireArray(payload.positions, "positions", 1, 10000)
            local positions = {}
            for index = 1, #rawPositions do
                positions[#positions + 1] =
                    requireInteger(rawPositions[index], "positions[" .. index .. "]", 0)
            end
            applySelection = function()
                if adding then
                    selection:selectPoints(parameter, positions)
                else
                    selection:unselectPoints(parameter, positions)
                end
            end
        else
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "kind must be groups, notes, pitchControls, or automationPoints"
            )
        end
    end

    if operation == "replace" then
        clearKind()
    end
    applySelection()

    return handlers.get_selection({
        automationParameters = isProvided(payload.parameter) and json.array({ payload.parameter }) or json.array()
    })
end

function handlers.get_computed_group_data(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local includeAttributes = optionalBoolean(payload.includeAttributes, "includeAttributes")
    if includeAttributes == nil then
        includeAttributes = true
    end

    local result = {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID()
    }

    if includeAttributes then
        local rawPhonemes = SV:getPhonemesForGroup(reference)
        local computedPhonemes = json.array()
        for index = 1, #rawPhonemes do
            computedPhonemes[#computedPhonemes + 1] = rawPhonemes[index]
        end
        local rawAttributes = SV:getComputedAttributesForGroup(reference)
        local computedAttributes = json.array()
        for index = 1, #rawAttributes do
            computedAttributes[#computedAttributes + 1] = sanitizeForJson(rawAttributes[index])
        end
        result.computedPhonemes = computedPhonemes
        result.phonemesPending = group:getNumNotes() > 0 and #computedPhonemes == 0
        result.computedAttributes = computedAttributes
        result.attributesPending = group:getNumNotes() > 0 and #computedAttributes == 0
    end

    if isProvided(payload.pitchSample) then
        local sample = requireObject(payload.pitchSample, "pitchSample")
        local absoluteStart = requireInteger(sample.absoluteStart, "pitchSample.absoluteStart", 0)
        local interval = requireInteger(sample.interval, "pitchSample.interval", 1)
        local frames = requireInteger(sample.frames, "pitchSample.frames", 1, 10000)
        local rawPitch = SV:getComputedPitchForGroup(reference, absoluteStart, interval, frames)
        local computedPitch = json.array()
        if #rawPitch > 0 then
            for index = 1, frames do
                computedPitch[index] = rawPitch[index] == nil and JSON_NULL or rawPitch[index]
            end
        end
        result.pitchSample = {
            absoluteStart = absoluteStart,
            interval = interval,
            requestedFrames = frames,
            returnedFrames = #computedPitch,
            pending = #rawPitch == 0,
            values = computedPitch
        }
    end

    return result
end

function handlers.add_track(payload)
    payload = requireObject(payload, "payload")
    local project = getProject()
    local name = optionalString(payload.name, "name", false) or "New Track"
    local displayColor = optionalString(payload.displayColor, "displayColor", false)
    if displayColor then
        displayColor = normalizeDisplayColor(displayColor, "displayColor")
    end

    local track = SV:create("Track")
    track:setName(name)
    if displayColor then
        setDisplayColorVerified(track, displayColor, "displayColor")
    end

    createUndoRecord(project)
    local trackIndex = project:addTrack(track)
    if type(trackIndex) ~= "number" then
        trackIndex = project:getNumTracks()
    end
    local result = serializeTrackSummary(track, trackIndex)
    result.mainGroup = serializeMainGroupLocator(track, trackIndex)
    return result
end

function handlers.update_track(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex = resolveTrack(payload)
    validateTrackFingerprint(
        track,
        optionalString(payload.trackFingerprint, "trackFingerprint", false),
        trackIndex
    )
    local name = optionalString(payload.name, "name", false)
    local displayColor = optionalString(payload.displayColor, "displayColor", false)
    local bounced = optionalBoolean(payload.bounced, "bounced")
    if displayColor then
        displayColor = normalizeDisplayColor(displayColor, "displayColor")
    end
    if name == nil and displayColor == nil and bounced == nil then
        raiseBridgeError("INVALID_ARGUMENT", "At least one track field must be supplied")
    end

    local function applyUpdates(target)
        if name ~= nil then
            target:setName(name)
        end
        if displayColor ~= nil then
            setDisplayColorVerified(target, displayColor, "displayColor")
        end
        if bounced ~= nil then
            target:setBounced(bounced)
        end
    end

    local candidate = track:clone()
    local valid, validationError = pcall(function()
        applyUpdates(candidate)
    end)
    if not valid then
        if type(validationError) == "table" and getmetatable(validationError) == BRIDGE_ERROR_MT then
            error(validationError, 0)
        end
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested track changes", {
            cause = tostring(validationError)
        })
    end

    createUndoRecord(project)
    applyUpdates(track)
    return serializeTrackSummary(track, trackIndex)
end

function handlers.clone_track(payload)
    payload = requireObject(payload, "payload")
    local project, sourceTrack, sourceTrackIndex = resolveTrack(payload)
    validateTrackFingerprint(
        sourceTrack,
        optionalString(payload.trackFingerprint, "trackFingerprint", false),
        sourceTrackIndex
    )

    local name = optionalString(payload.name, "name", false)
    local displayColor = optionalString(payload.displayColor, "displayColor", false)
    if displayColor then
        displayColor = normalizeDisplayColor(displayColor, "displayColor")
    end
    local bounced = optionalBoolean(payload.bounced, "bounced")
    local clearNotes = optionalBoolean(payload.clearNotes, "clearNotes")
    if clearNotes == nil then
        clearNotes = false
    end
    local transposeSemitones = optionalInteger(
        payload.transposeSemitones,
        "transposeSemitones",
        -127,
        127,
        0
    )
    local minimumPitch = optionalInteger(payload.minimumPitch, "minimumPitch", 0, 127, 0)
    local maximumPitch = optionalInteger(payload.maximumPitch, "maximumPitch", 0, 127, 127)
    if minimumPitch > maximumPitch then
        raiseBridgeError("INVALID_ARGUMENT", "minimumPitch must not exceed maximumPitch")
    end
    local rangePolicy = optionalString(payload.rangePolicy, "rangePolicy", false) or "reject"
    if rangePolicy ~= "reject" and rangePolicy ~= "octave" then
        raiseBridgeError("INVALID_ARGUMENT", "rangePolicy must be reject or octave")
    end
    local gainDecibel = optionalNumber(payload.gainDecibel, "gainDecibel", -24, 24)
    local pan = optionalNumber(payload.pan, "pan", -1, 1)

    local clonedTrack = sourceTrack:clone()
    if name ~= nil then
        clonedTrack:setName(name)
    end
    if displayColor ~= nil then
        setDisplayColorVerified(clonedTrack, displayColor, "displayColor")
    end
    if bounced ~= nil then
        clonedTrack:setBounced(bounced)
    end

    local affectedNoteCount = 0
    local seenGroups = {}
    for groupIndex = 1, clonedTrack:getNumGroups() do
        local clonedReference = clonedTrack:getGroupReference(groupIndex)
        local sourceReference = sourceTrack:getGroupReference(groupIndex)
        if clonedReference and not clonedReference:isInstrumental() then
            local clonedGroup = clonedReference:getTarget()
            local sourceGroup = sourceReference and not sourceReference:isInstrumental()
                and sourceReference:getTarget() or nil
            if clonedGroup and not seenGroups[clonedGroup] then
                seenGroups[clonedGroup] = true
                if (clearNotes or transposeSemitones ~= 0) and clonedGroup == sourceGroup then
                    raiseBridgeError(
                        "SHARED_GROUP_CLONE",
                        "SynthV kept a cloned non-main reference linked to the source library group; refusing to mutate the source",
                        { groupIndex = groupIndex }
                    )
                end

                if clearNotes then
                    affectedNoteCount = affectedNoteCount + clonedGroup:getNumNotes()
                    for noteIndex = clonedGroup:getNumNotes(), 1, -1 do
                        clonedGroup:removeNote(noteIndex)
                    end
                elseif transposeSemitones ~= 0 then
                    for noteIndex = 1, clonedGroup:getNumNotes() do
                        local note = clonedGroup:getNote(noteIndex)
                        local newPitch = note:getPitch() + transposeSemitones
                        if rangePolicy == "octave" then
                            while newPitch < minimumPitch do newPitch = newPitch + 12 end
                            while newPitch > maximumPitch do newPitch = newPitch - 12 end
                        end
                        if newPitch < minimumPitch or newPitch > maximumPitch
                            or newPitch < 0 or newPitch > 127 then
                            raiseBridgeError("PITCH_OUT_OF_RANGE", "A cloned note would leave MIDI range 0..127", {
                                groupIndex = groupIndex,
                                noteIndex = noteIndex,
                                originalPitch = note:getPitch(),
                                requestedPitch = newPitch,
                                minimumPitch = minimumPitch,
                                maximumPitch = maximumPitch,
                                rangePolicy = rangePolicy
                            })
                        end
                        note:setPitch(newPitch)
                        affectedNoteCount = affectedNoteCount + 1
                    end
                end
            end
        end
    end

    local clonedMixer = clonedTrack:getMixer()
    if gainDecibel ~= nil then clonedMixer:setGainDecibel(gainDecibel) end
    if pan ~= nil then clonedMixer:setPan(pan) end

    createUndoRecord(project)
    local trackIndex = project:addTrack(clonedTrack)
    if type(trackIndex) ~= "number" then
        trackIndex = project:getNumTracks()
    end
    local result = serializeTrackSummary(clonedTrack, trackIndex)
    result.mainGroup = serializeMainGroupLocator(clonedTrack, trackIndex)
    result.sourceTrackIndex = sourceTrackIndex
    result.clearNotes = clearNotes
    result.transposeSemitones = transposeSemitones
    result.affectedNoteCount = affectedNoteCount
    result.voiceRange = { minimumPitch = minimumPitch, maximumPitch = maximumPitch }
    result.rangePolicy = rangePolicy
    result.mixer = serializeMixer(clonedTrack)
    return result
end

function handlers.create_harmony_track(payload)
    payload = requireObject(payload, "payload")
    local sourceTrackIndex = requireInteger(payload.sourceTrackIndex, "sourceTrackIndex", 1)
    local sourceTrackFingerprint =
        requireString(payload.sourceTrackFingerprint, "sourceTrackFingerprint", false)
    local intervalSemitones =
        requireInteger(payload.intervalSemitones, "intervalSemitones", -36, 36)
    if intervalSemitones == 0 then
        raiseBridgeError("INVALID_ARGUMENT", "intervalSemitones must not be zero")
    end
    local direction = intervalSemitones > 0 and "+" or ""
    local result = handlers.clone_track({
        trackIndex = sourceTrackIndex,
        trackFingerprint = sourceTrackFingerprint,
        name = optionalString(payload.name, "name", false)
            or ("Harmony " .. direction .. tostring(intervalSemitones)),
        displayColor = payload.displayColor,
        transposeSemitones = intervalSemitones,
        minimumPitch = optionalInteger(payload.minimumPitch, "minimumPitch", 0, 127, 0),
        maximumPitch = optionalInteger(payload.maximumPitch, "maximumPitch", 0, 127, 127),
        rangePolicy = optionalString(payload.rangePolicy, "rangePolicy", false) or "octave",
        gainDecibel = optionalNumber(payload.gainDecibel, "gainDecibel", -24, 24),
        pan = optionalNumber(payload.pan, "pan", -1, 1)
    })
    result.semanticAction = "create_harmony_track"
    result.intervalSemitones = intervalSemitones
    return result
end

function handlers.delete_track(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex = resolveTrack(payload)
    validateTrackFingerprint(
        track,
        optionalString(payload.trackFingerprint, "trackFingerprint", false),
        trackIndex
    )
    if project:getNumTracks() <= 1 then
        raiseBridgeError("FINAL_TRACK", "The project's final track cannot be deleted")
    end

    local deletedTrack = serializeTrackSummary(track, trackIndex)
    createUndoRecord(project)
    project:removeTrack(trackIndex)
    return {
        deletedTrack = deletedTrack,
        trackCount = project:getNumTracks()
    }
end

function handlers.update_group(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, group, groupIndex = resolveReference(payload)
    validateReferenceFingerprint(
        reference,
        optionalString(payload.referenceFingerprint, "referenceFingerprint", false),
        trackIndex,
        groupIndex
    )
    local name = optionalString(payload.name, "name", false)
    local muted = optionalBoolean(payload.muted, "muted")
    local timeOffset = optionalInteger(payload.timeOffset, "timeOffset", 0)
    local pitchOffset = optionalInteger(payload.pitchOffset, "pitchOffset", -127, 127)
    local voice = isProvided(payload.voice) and requireObject(payload.voice, "voice") or nil
    local timeRange = nil
    if isProvided(payload.timeRange) then
        local rawRange = requireObject(payload.timeRange, "timeRange")
        timeRange = {
            onset = requireInteger(rawRange.onset, "timeRange.onset", 0),
            duration = requireInteger(rawRange.duration, "timeRange.duration", 1)
        }
    end
    if name == nil and muted == nil and timeOffset == nil and pitchOffset == nil and voice == nil and timeRange == nil then
        raiseBridgeError("INVALID_ARGUMENT", "At least one group field must be supplied")
    end
    if reference:isInstrumental() and name ~= nil then
        raiseBridgeError("INVALID_ARGUMENT", "Instrumental references do not expose a note-group name")
    end
    if reference:isInstrumental() and voice ~= nil then
        raiseBridgeError("INVALID_ARGUMENT", "Instrumental references do not expose vocal voice properties")
    end

    local function applyReferenceUpdates(target)
        if muted ~= nil then
            target:setMuted(muted)
        end
        if timeOffset ~= nil then
            target:setTimeOffset(timeOffset)
        end
        if pitchOffset ~= nil then
            target:setPitchOffset(pitchOffset)
        end
        if timeRange ~= nil then
            target:setTimeRange(timeRange.onset, timeRange.duration)
        end
        if voice ~= nil then
            target:setVoice(voice)
        end
    end

    local referenceCandidate = reference:clone()
    local groupCandidate = group and group:clone() or nil
    local valid, validationError = pcall(function()
        applyReferenceUpdates(referenceCandidate)
        if name ~= nil and groupCandidate then
            groupCandidate:setName(name)
        end
    end)
    if not valid then
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested group changes", {
            cause = tostring(validationError)
        })
    end

    createUndoRecord(project)
    applyReferenceUpdates(reference)
    if name ~= nil and group then
        group:setName(name)
    end
    return {
        trackIndex = trackIndex,
        group = serializeGroup(reference, groupIndex, 0, 0)
    }
end

function handlers.set_group_voice(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, _group, groupIndex = resolveGroup(payload)
    local expectedFingerprint = requireString(
        payload.referenceFingerprint,
        "referenceFingerprint",
        false
    )
    validateReferenceFingerprint(reference, expectedFingerprint, trackIndex, groupIndex)
    validateCurrentEditorGroupGuard(payload, reference, reference:getTarget())
    local voiceUpdate, checks, expectedVocalModes =
        prepareGroupVoiceUpdate(reference, payload)

    createUndoRecord(project)
    local applied, applyError = pcall(function()
        reference:setVoice(voiceUpdate)
    end)
    if not applied then
        raiseBridgeError("HOST_WRITE_FAILED", "SynthV rejected a prevalidated group voice update", {
            cause = tostring(applyError)
        })
    end
    local updatedVoice = safeCall(function()
        return reference:getVoice()
    end, nil)
    verifyGroupVoiceChecks(updatedVoice, checks, "HOST_POSTCONDITION_FAILED")
    verifyVocalModeSnapshot(
        updatedVoice,
        expectedVocalModes,
        "HOST_POSTCONDITION_FAILED"
    )
    local result = serializeGroupVoice(reference, trackIndex, groupIndex)
    result.selectionContext = getTargetSelectionContext(reference, reference:getTarget())
    return result
end

function handlers.delete_group_reference(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex, reference, _group, groupIndex = resolveReference(payload)
    validateReferenceFingerprint(
        reference,
        optionalString(payload.referenceFingerprint, "referenceFingerprint", false),
        trackIndex,
        groupIndex
    )
    if groupIndex == 1 or reference:isMain() then
        raiseBridgeError("MAIN_GROUP", "A track's main group reference cannot be removed")
    end
    local deletedGroup = serializeGroup(reference, groupIndex, 0, 0)
    createUndoRecord(project)
    track:removeGroupReference(groupIndex)
    return {
        trackIndex = trackIndex,
        deletedGroup = deletedGroup,
        track = serializeTrackSummary(track, trackIndex)
    }
end

function handlers.add_notes(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local noteInputs = requireArray(payload.notes, "notes", 1, 512)
    local prepared = {}

    for index = 1, #noteInputs do
        prepared[#prepared + 1] = createNoteFromInput(noteInputs[index], "notes[" .. index .. "]")
    end

    createUndoRecord(project)
    for index = 1, #prepared do
        group:addNote(prepared[index])
    end

    local notes = json.array()
    for index = 1, #prepared do
        local note = prepared[index]
        notes[#notes + 1] = serializeNote(group, reference, note, note:getIndexInParent())
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        addedCount = #notes,
        notes = notes
    }
end

function handlers.edit_notes(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local edits = requireArray(payload.edits, "edits", 1, 512)
    local prepared = {}
    local seen = {}

    for index = 1, #edits do
        local edit = requireObject(edits[index], "edits[" .. index .. "]")
        local noteIndex = requireInteger(edit.noteIndex, "edits[" .. index .. "].noteIndex", 1, group:getNumNotes())
        if seen[noteIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same noteIndex appears more than once", { noteIndex = noteIndex })
        end
        seen[noteIndex] = true
        local fingerprint = requireString(edit.fingerprint, "edits[" .. index .. "].fingerprint", false)
        local note = validateFingerprint(group, noteIndex, fingerprint)
        local changesPath = "edits[" .. index .. "].changes"
        prepared[#prepared + 1] = {
            note = note,
            changes = prepareNoteChanges(note, edit.changes, changesPath),
            path = changesPath
        }
    end

    createUndoRecord(project)
    for index = 1, #prepared do
        applyPreparedNoteChanges(prepared[index].note, prepared[index].changes, prepared[index].path)
    end

    local notes = json.array()
    for index = 1, #prepared do
        local note = prepared[index].note
        notes[#notes + 1] = serializeNote(group, reference, note, note:getIndexInParent())
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        editedCount = #notes,
        notes = notes
    }
end

local function makeDeterministicRandom(seed)
    local state = seed % 2147483647
    if state == 0 then state = 1 end
    return function(minimum, maximum)
        state = (state * 48271) % 2147483647
        local span = maximum - minimum + 1
        return minimum + (state % span)
    end
end

function handlers.humanize_notes(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex =
        resolveGroup(payload)
    local targets = requireArray(payload.notes, "notes", 1, 512)
    local seed = optionalInteger(payload.seed, "seed", 0, 2147483647, 1)
    local maxOnsetOffset =
        requireInteger(payload.maxOnsetOffset, "maxOnsetOffset", 0)
    local maxDurationOffset =
        requireInteger(payload.maxDurationOffset, "maxDurationOffset", 0)
    local preserveChords = optionalBoolean(payload.preserveChords, "preserveChords")
    if preserveChords == nil then preserveChords = true end
    if maxOnsetOffset == 0 and maxDurationOffset == 0 then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "At least one humanization offset must be greater than zero"
        )
    end

    local randomInteger = makeDeterministicRandom(seed)
    local chordOffsets = {}
    local edits = json.array()
    local seen = {}
    for index = 1, #targets do
        local path = "notes[" .. index .. "]"
        local target = requireObject(targets[index], path)
        local noteIndex = requireInteger(
            target.noteIndex,
            path .. ".noteIndex",
            1,
            group:getNumNotes()
        )
        if seen[noteIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same noteIndex appears more than once", {
                noteIndex = noteIndex
            })
        end
        seen[noteIndex] = true
        local fingerprint = requireString(
            target.fingerprint,
            path .. ".fingerprint",
            false
        )
        local note = validateFingerprint(group, noteIndex, fingerprint)
        local onsetOffset
        if preserveChords then
            local chordKey = tostring(note:getOnset())
            onsetOffset = chordOffsets[chordKey]
            if onsetOffset == nil then
                onsetOffset = randomInteger(-maxOnsetOffset, maxOnsetOffset)
                chordOffsets[chordKey] = onsetOffset
            end
        else
            onsetOffset = randomInteger(-maxOnsetOffset, maxOnsetOffset)
        end
        local durationOffset =
            randomInteger(-maxDurationOffset, maxDurationOffset)
        edits[#edits + 1] = {
            noteIndex = noteIndex,
            fingerprint = fingerprint,
            changes = {
                onset = math.max(0, note:getOnset() + onsetOffset),
                duration = math.max(1, note:getDuration() + durationOffset)
            }
        }
    end

    local result = handlers.edit_notes({
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        edits = edits
    })
    result.semanticAction = "humanize_notes"
    result.seed = seed
    result.maxOnsetOffset = maxOnsetOffset
    result.maxDurationOffset = maxDurationOffset
    result.preserveChords = preserveChords
    return result
end

function handlers.fit_lyrics(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex =
        resolveGroup(payload)
    local targets = requireArray(payload.notes, "notes", 1, 512)
    local syllables = requireArray(payload.syllables, "syllables", 1, 512)
    local phonemes = isProvided(payload.phonemes)
        and requireArray(payload.phonemes, "phonemes", 0, 512) or nil
    local fillRemainder =
        optionalString(payload.fillRemainder, "fillRemainder", false) or "reject"
    if fillRemainder ~= "reject" and fillRemainder ~= "keep"
        and fillRemainder ~= "hyphen" then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "fillRemainder must be reject, keep, or hyphen"
        )
    end
    if #syllables > #targets then
        raiseBridgeError("LYRIC_COUNT_MISMATCH", "There are more syllables than target notes", {
            noteCount = #targets,
            syllableCount = #syllables
        })
    end
    if fillRemainder == "reject" and #syllables ~= #targets then
        raiseBridgeError("LYRIC_COUNT_MISMATCH", "Syllable and note counts must match", {
            noteCount = #targets,
            syllableCount = #syllables
        })
    end
    if phonemes and #phonemes ~= 0 and #phonemes ~= #syllables then
        raiseBridgeError(
            "PHONEME_COUNT_MISMATCH",
            "phonemes must be empty or contain one entry per supplied syllable"
        )
    end

    local edits = json.array()
    local seen = {}
    for index = 1, #targets do
        local path = "notes[" .. index .. "]"
        local target = requireObject(targets[index], path)
        local noteIndex = requireInteger(
            target.noteIndex,
            path .. ".noteIndex",
            1,
            group:getNumNotes()
        )
        if seen[noteIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same noteIndex appears more than once", {
                noteIndex = noteIndex
            })
        end
        seen[noteIndex] = true
        local fingerprint = requireString(
            target.fingerprint,
            path .. ".fingerprint",
            false
        )
        local changes = {}
        if index <= #syllables then
            changes.lyrics = requireString(
                syllables[index],
                "syllables[" .. index .. "]",
                true
            )
            if phonemes and #phonemes > 0 then
                changes.phonemes = requireString(
                    phonemes[index],
                    "phonemes[" .. index .. "]",
                    true
                )
            end
        elseif fillRemainder == "hyphen" then
            changes.lyrics = "-"
        end
        if next(changes) ~= nil then
            edits[#edits + 1] = {
                noteIndex = noteIndex,
                fingerprint = fingerprint,
                changes = changes
            }
        end
    end
    if #edits == 0 then
        raiseBridgeError("INVALID_ARGUMENT", "No note lyrics would change")
    end
    local result = handlers.edit_notes({
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        edits = edits
    })
    result.semanticAction = "fit_lyrics"
    result.syllableCount = #syllables
    result.fillRemainder = fillRemainder
    return result
end

function handlers.apply_expression_preset(payload)
    payload = requireObject(payload, "payload")
    local preset = requireString(payload.preset, "preset", false)
    local strength = optionalNumber(payload.strength, "strength", 0, 2) or 1
    if preset == "vibrato" then
        local targets = requireArray(payload.notes, "notes", 1, 512)
        local edits = json.array()
        for index = 1, #targets do
            local target = requireObject(targets[index], "notes[" .. index .. "]")
            edits[#edits + 1] = {
                noteIndex = target.noteIndex,
                fingerprint = target.fingerprint,
                changes = {
                    attributes = { dF0VbrMod = strength }
                }
            }
        end
        local result = handlers.edit_notes({
            trackIndex = payload.trackIndex,
            groupIndex = payload.groupIndex,
            groupUuid = payload.groupUuid,
            edits = edits
        })
        result.semanticAction = "apply_expression_preset"
        result.preset = preset
        result.strength = strength
        return result
    end

    local beginPosition = requireInteger(payload.beginPosition, "beginPosition", 0)
    local endPosition = requireInteger(
        payload.endPosition,
        "endPosition",
        beginPosition + 1
    )
    local expectedFingerprint = requireString(
        payload.expectedAutomationFingerprint,
        "expectedAutomationFingerprint",
        false
    )
    local parameter
    local points = json.array()
    if preset == "scoop" then
        parameter = "pitchDelta"
        points[#points + 1] = {
            position = beginPosition,
            value = -math.min(1200, 150 * strength)
        }
        points[#points + 1] = {
            position = beginPosition + math.floor((endPosition - beginPosition) * 0.2),
            value = 0
        }
    elseif preset == "falloff" then
        parameter = "pitchDelta"
        points[#points + 1] = {
            position = endPosition - math.floor((endPosition - beginPosition) * 0.2),
            value = 0
        }
        points[#points + 1] = {
            position = endPosition,
            value = -math.min(1200, 150 * strength)
        }
    elseif preset == "crescendo" then
        parameter = "loudness"
        local startValue =
            optionalNumber(payload.startValue, "startValue", -48, 12)
                or (-3 * strength)
        local endValue =
            optionalNumber(payload.endValue, "endValue", -48, 12) or 0
        points[#points + 1] = {
            position = beginPosition,
            value = startValue
        }
        points[#points + 1] = {
            position = endPosition,
            value = endValue
        }
    elseif preset == "breathiness" then
        parameter = "breathiness"
        local startValue =
            optionalNumber(payload.startValue, "startValue", -1, 1) or 0
        local endValue =
            optionalNumber(payload.endValue, "endValue", -1, 1)
                or math.min(1, 0.3 * strength)
        points[#points + 1] = {
            position = beginPosition,
            value = startValue
        }
        points[#points + 1] = {
            position = endPosition,
            value = endValue
        }
    else
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "preset must be scoop, falloff, vibrato, crescendo, or breathiness"
        )
    end

    local result = handlers.set_automation_points({
        trackIndex = payload.trackIndex,
        groupIndex = payload.groupIndex,
        groupUuid = payload.groupUuid,
        parameter = parameter,
        expectedFingerprint = expectedFingerprint,
        clearMode = "range",
        rangeBegin = beginPosition,
        rangeEnd = endPosition,
        points = points
    })
    result.semanticAction = "apply_expression_preset"
    result.preset = preset
    result.strength = strength
    return result
end

function handlers.set_note_phoneme_properties(payload)
    payload = requireObject(payload, "payload")
    local mode = responseMode(payload)
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local edits = requireArray(payload.edits, "edits", 1, 512)
    local prepared = {}
    local seen = {}
    local _selectionContext, selectedNoteIndices =
        validateCurrentEditorGroupGuard(payload, reference, group)
    local requireSelectedNotes =
        optionalBoolean(payload.requireSelectedNotes, "requireSelectedNotes")

    for index = 1, #edits do
        local path = "edits[" .. index .. "]"
        local edit = requireObject(edits[index], path)
        local noteIndex = requireInteger(
            edit.noteIndex,
            path .. ".noteIndex",
            1,
            group:getNumNotes()
        )
        if seen[noteIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same noteIndex appears more than once", {
                noteIndex = noteIndex
            })
        end
        seen[noteIndex] = true
        if requireSelectedNotes == true and not selectedNoteIndices[noteIndex] then
            raiseBridgeError(
                "SELECTION_MISMATCH",
                "A target note is not selected in the current piano-roll group",
                {
                    noteIndex = noteIndex,
                    groupUuid = group:getUUID()
                }
            )
        end
        local note = validateFingerprint(
            group,
            noteIndex,
            requireString(edit.fingerprint, path .. ".fingerprint", false)
        )
        local changesPath = path .. ".changes"
        prepared[#prepared + 1] = {
            note = note,
            changes = preparePhonemePropertyChanges(note, edit.changes, changesPath),
            path = changesPath
        }
    end

    createUndoRecord(project)
    for index = 1, #prepared do
        applyPreparedNoteChanges(prepared[index].note, prepared[index].changes, prepared[index].path)
        verifyPhonemePostconditions(
            prepared[index].note,
            prepared[index].changes,
            prepared[index].path,
            "project_write"
        )
    end

    local notes = json.array()
    for index = 1, #prepared do
        local note = prepared[index].note
        local noteIndex = note:getIndexInParent()
        if mode == "compact" then
            notes[#notes + 1] = {
                noteIndex = noteIndex,
                fingerprint = makeNoteFingerprint(group:getUUID(), noteIndex, note)
            }
        else
            notes[#notes + 1] = serializeNote(group, reference, note, noteIndex)
        end
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        editedCount = #notes,
        responseMode = mode,
        notes = notes
    }
end

function handlers.delete_notes(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
    local targets = requireArray(payload.notes, "notes", 1, 512)
    local prepared = {}
    local seen = {}

    for index = 1, #targets do
        local target = requireObject(targets[index], "notes[" .. index .. "]")
        local noteIndex = requireInteger(target.noteIndex, "notes[" .. index .. "].noteIndex", 1, group:getNumNotes())
        if seen[noteIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same noteIndex appears more than once", { noteIndex = noteIndex })
        end
        seen[noteIndex] = true
        local fingerprint = requireString(target.fingerprint, "notes[" .. index .. "].fingerprint", false)
        local note = validateFingerprint(group, noteIndex, fingerprint)
        prepared[#prepared + 1] = {
            noteIndex = noteIndex,
            note = serializeNote(group, reference, note, noteIndex)
        }
    end

    table.sort(prepared, function(left, right)
        return left.noteIndex > right.noteIndex
    end)
    createUndoRecord(project)
    for index = 1, #prepared do
        group:removeNote(prepared[index].noteIndex)
    end

    local deleted = json.array()
    for index = #prepared, 1, -1 do
        deleted[#deleted + 1] = prepared[index].note
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        deletedCount = #deleted,
        deletedNotes = deleted
    }
end

function handlers.get_note_retakes(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex, note, noteIndex, retakes =
        resolveRetakeNote(payload, false)
    local result = serializeRetakes(group, note, noteIndex, retakes)
    result.trackIndex = trackIndex
    result.groupIndex = groupIndex
    result.groupUuid = group:getUUID()
    return result
end

function handlers.generate_note_retake(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex, note, noteIndex, retakes =
        resolveRetakeNote(payload, true)
    local newDuration = optionalBoolean(payload.newDuration, "newDuration")
    local newPitch = optionalBoolean(payload.newPitch, "newPitch")
    local newTimbre = optionalBoolean(payload.newTimbre, "newTimbre")
    if newDuration == nil then newDuration = true end
    if newPitch == nil then newPitch = true end
    if newTimbre == nil then newTimbre = true end
    local activate = optionalBoolean(payload.activate, "activate")
    if activate == nil then activate = false end
    if not newDuration and not newPitch and not newTimbre then
        raiseBridgeError("INVALID_ARGUMENT", "At least one retake variation must be enabled")
    end

    createUndoRecord(project)
    local takeId = retakes:generateTake(newDuration, newPitch, newTimbre)
    local tracked = getTrackedRetakeIds(retakes)
    tracked[#tracked + 1] = takeId
    retakes:setScriptData(RETAKE_IDS_KEY, tracked)
    if activate then
        retakes:setActiveTake(takeId)
    end
    local result = serializeRetakes(group, note, noteIndex, retakes)
    result.trackIndex = trackIndex
    result.groupIndex = groupIndex
    result.groupUuid = group:getUUID()
    result.generatedTakeId = takeId
    result.activated = activate
    return result
end

function handlers.activate_note_retake(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex, note, noteIndex, retakes =
        resolveRetakeNote(payload, true)
    local takeId = requireInteger(payload.takeId, "takeId", 0)
    local tracked = getTrackedRetakeIds(retakes)
    if not hasTrackedRetakeId(tracked, takeId) then
        raiseBridgeError(
            "UNKNOWN_RETAKE_ID",
            "Only the default take or a take ID generated and tracked by this bridge can be activated",
            { takeId = takeId, trackedTakeIds = tracked }
        )
    end
    createUndoRecord(project)
    retakes:setActiveTake(takeId)
    local result = serializeRetakes(group, note, noteIndex, retakes)
    result.trackIndex = trackIndex
    result.groupIndex = groupIndex
    result.groupUuid = group:getUUID()
    result.activatedTakeId = takeId
    return result
end

function handlers.delete_note_retake(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex, note, noteIndex, retakes =
        resolveRetakeNote(payload, true)
    local takeId = requireInteger(payload.takeId, "takeId", 1)
    local tracked = getTrackedRetakeIds(retakes)
    if not hasTrackedRetakeId(tracked, takeId) then
        raiseBridgeError(
            "UNKNOWN_RETAKE_ID",
            "Only a take ID generated and tracked by this bridge can be deleted",
            { takeId = takeId, trackedTakeIds = tracked }
        )
    end
    local remaining = json.array()
    for index = 1, #tracked do
        if tracked[index] ~= takeId then
            remaining[#remaining + 1] = tracked[index]
        end
    end
    createUndoRecord(project)
    retakes:deleteTake(takeId)
    retakes:setScriptData(RETAKE_IDS_KEY, remaining)
    local result = serializeRetakes(group, note, noteIndex, retakes)
    result.trackIndex = trackIndex
    result.groupIndex = groupIndex
    result.groupUuid = group:getUUID()
    result.deletedTakeId = takeId
    return result
end

function handlers.get_pitch_controls(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local controls = serializePitchControls(group)
    if isProvided(payload.sampleOffsets) then
        local rawOffsets = requireArray(payload.sampleOffsets, "sampleOffsets", 1, 10000)
        local offsets = {}
        for index = 1, #rawOffsets do
            offsets[#offsets + 1] =
                requireInteger(rawOffsets[index], "sampleOffsets[" .. index .. "]")
        end
        for controlIndex = 1, #controls do
            if controls[controlIndex].kind == "curve" then
                local control = group:getPitchControl(controlIndex)
                local samples = json.array()
                for offsetIndex = 1, #offsets do
                    samples[#samples + 1] = {
                        offset = offsets[offsetIndex],
                        value = control:getValueAt(offsets[offsetIndex])
                    }
                end
                controls[controlIndex].samples = samples
            end
        end
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        pitchControlCount = #controls,
        pitchControls = controls
    }
end

function handlers.add_pitch_controls(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local inputs = requireArray(payload.pitchControls, "pitchControls", 1, 512)
    local prepared = {}
    for index = 1, #inputs do
        local definition = preparePitchControlInput(inputs[index], "pitchControls[" .. index .. "]")
        local ok, controlOrError = pcall(function()
            return createPitchControl(definition)
        end)
        if not ok then
            raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected a pitch-control definition", {
                index = index,
                cause = tostring(controlOrError)
            })
        end
        prepared[#prepared + 1] = controlOrError
    end

    createUndoRecord(project)
    for index = 1, #prepared do
        group:addPitchControl(prepared[index])
    end
    local controls = json.array()
    for index = 1, #prepared do
        local control = prepared[index]
        controls[#controls + 1] =
            serializePitchControl(group, control, control:getIndexInParent())
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        addedCount = #controls,
        pitchControls = controls
    }
end

function handlers.edit_pitch_controls(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local edits = requireArray(payload.edits, "edits", 1, 512)
    local prepared = {}
    local seen = {}
    for index = 1, #edits do
        local edit = requireObject(edits[index], "edits[" .. index .. "]")
        local controlIndex = requireInteger(
            edit.pitchControlIndex,
            "edits[" .. index .. "].pitchControlIndex",
            1,
            group:getNumPitchControls()
        )
        if seen[controlIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same pitchControlIndex appears more than once", {
                pitchControlIndex = controlIndex
            })
        end
        seen[controlIndex] = true
        local control = group:getPitchControl(controlIndex)
        local serialized = serializePitchControl(group, control, controlIndex)
        validateExpectedFingerprint(
            serialized.fingerprint,
            requireString(edit.fingerprint, "edits[" .. index .. "].fingerprint", false),
            "STALE_PITCH_CONTROL",
            "The pitch control changed after it was read"
        )
        prepared[#prepared + 1] = {
            control = control,
            apply = applyPitchControlChanges(
                control,
                edit.changes,
                serialized.kind,
                "edits[" .. index .. "].changes"
            )
        }
    end

    createUndoRecord(project)
    for index = 1, #prepared do
        prepared[index].apply(prepared[index].control)
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        editedCount = #prepared,
        pitchControls = serializePitchControls(group)
    }
end

function handlers.delete_pitch_controls(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local targets = requireArray(payload.pitchControls, "pitchControls", 1, 512)
    local prepared = {}
    local seen = {}
    for index = 1, #targets do
        local target = requireObject(targets[index], "pitchControls[" .. index .. "]")
        local controlIndex = requireInteger(
            target.pitchControlIndex,
            "pitchControls[" .. index .. "].pitchControlIndex",
            1,
            group:getNumPitchControls()
        )
        if seen[controlIndex] then
            raiseBridgeError("INVALID_ARGUMENT", "The same pitchControlIndex appears more than once", {
                pitchControlIndex = controlIndex
            })
        end
        seen[controlIndex] = true
        local serialized = serializePitchControl(group, group:getPitchControl(controlIndex), controlIndex)
        validateExpectedFingerprint(
            serialized.fingerprint,
            requireString(target.fingerprint, "pitchControls[" .. index .. "].fingerprint", false),
            "STALE_PITCH_CONTROL",
            "The pitch control changed after it was read"
        )
        prepared[#prepared + 1] = {
            pitchControlIndex = controlIndex,
            pitchControl = serialized
        }
    end
    table.sort(prepared, function(left, right)
        return left.pitchControlIndex > right.pitchControlIndex
    end)
    createUndoRecord(project)
    for index = 1, #prepared do
        group:removePitchControl(prepared[index].pitchControlIndex)
    end
    local deleted = json.array()
    for index = #prepared, 1, -1 do
        deleted[#deleted + 1] = prepared[index].pitchControl
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        deletedCount = #deleted,
        deletedPitchControls = deleted
    }
end

function handlers.get_automation(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local automation, serialized = serializeAutomation(group, parameterName)
    local hasBegin = isProvided(payload.rangeBegin)
    local hasEnd = isProvided(payload.rangeEnd)
    if hasBegin ~= hasEnd then
        raiseBridgeError("INVALID_ARGUMENT", "rangeBegin and rangeEnd must be supplied together")
    end
    if hasBegin then
        local rangeBegin = requireInteger(payload.rangeBegin, "rangeBegin", 0)
        local rangeEnd = requireInteger(payload.rangeEnd, "rangeEnd", rangeBegin)
        local rawPoints = automation:getPoints(rangeBegin, rangeEnd)
        local points = json.array()
        for index = 1, #rawPoints do
            points[#points + 1] = {
                position = rawPoints[index][1],
                value = rawPoints[index][2]
            }
        end
        serialized.totalPointCount = serialized.pointCount
        serialized.pointCount = #points
        serialized.points = points
        serialized.returnedRange = {
            beginPosition = rangeBegin,
            endPosition = rangeEnd
        }
    end
    serialized.trackIndex = trackIndex
    serialized.groupIndex = groupIndex
    serialized.groupUuid = group:getUUID()
    return serialized
end

function handlers.sample_automation(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local automation, serialized = serializeAutomation(group, parameterName)
    local positions = requireArray(payload.positions, "positions", 1, 10000)
    local interpolation = optionalString(payload.interpolation, "interpolation", false) or "native"
    if interpolation ~= "native" and interpolation ~= "linear" then
        raiseBridgeError("INVALID_ARGUMENT", "interpolation must be native or linear")
    end
    local samples = json.array()
    for index = 1, #positions do
        local position = requireInteger(positions[index], "positions[" .. index .. "]", 0)
        samples[#samples + 1] = {
            position = position,
            value = interpolation == "linear" and automation:getLinear(position) or automation:get(position)
        }
    end
    return {
        trackIndex = trackIndex,
        groupIndex = groupIndex,
        groupUuid = group:getUUID(),
        parameter = serialized.parameter,
        fingerprint = serialized.fingerprint,
        interpolation = interpolation,
        sampleCount = #samples,
        samples = samples
    }
end

function handlers.simplify_automation(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local automation, before = serializeAutomation(group, parameterName)
    validateExpectedFingerprint(
        before.fingerprint,
        optionalString(payload.expectedFingerprint, "expectedFingerprint", false),
        "STALE_AUTOMATION",
        "The automation curve changed after it was read"
    )
    local beginPosition = requireInteger(payload.beginPosition, "beginPosition", 0)
    local endPosition = requireInteger(payload.endPosition, "endPosition", beginPosition)
    local threshold = optionalNumber(payload.threshold, "threshold", 0)
    local candidate = automation:clone()
    local valid, validationError = pcall(function()
        if threshold == nil then
            candidate:simplify(beginPosition, endPosition)
        else
            candidate:simplify(beginPosition, endPosition, threshold)
        end
    end)
    if not valid then
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the automation simplification", {
            cause = tostring(validationError)
        })
    end

    createUndoRecord(project)
    local changed
    if threshold == nil then
        changed = automation:simplify(beginPosition, endPosition)
    else
        changed = automation:simplify(beginPosition, endPosition, threshold)
    end
    local _sameAutomation, after = serializeAutomation(group, parameterName)
    after.trackIndex = trackIndex
    after.groupIndex = groupIndex
    after.groupUuid = group:getUUID()
    after.changed = changed
    after.removedPointCount = before.pointCount - after.pointCount
    after.simplifiedRange = {
        beginPosition = beginPosition,
        endPosition = endPosition
    }
    after.threshold = threshold or 0.002
    return after
end

function handlers.set_automation_points(payload)
    payload = requireObject(payload, "payload")
    local mode = responseMode(payload)
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local automation, serializedBefore = serializeAutomation(group, parameterName)
    validateExpectedFingerprint(
        serializedBefore.fingerprint,
        optionalString(payload.expectedFingerprint, "expectedFingerprint", false),
        "STALE_AUTOMATION",
        "The automation curve changed after it was read"
    )
    local points = requireArray(payload.points, "points", 1, 10000)
    local clearMode = optionalString(payload.clearMode, "clearMode", false) or "none"
    if clearMode ~= "none" and clearMode ~= "all" and clearMode ~= "range" then
        raiseBridgeError("INVALID_ARGUMENT", "clearMode must be one of none, all, or range")
    end

    local rangeBegin = nil
    local rangeEnd = nil
    if clearMode == "range" then
        rangeBegin = requireInteger(payload.rangeBegin, "rangeBegin", 0)
        rangeEnd = requireInteger(payload.rangeEnd, "rangeEnd", rangeBegin)
    elseif isProvided(payload.rangeBegin) or isProvided(payload.rangeEnd) then
        raiseBridgeError("INVALID_ARGUMENT", "rangeBegin/rangeEnd are only valid when clearMode is range")
    end

    local definition = serializedBefore.definition
    local minimum = definition.range and definition.range[1] or nil
    local maximum = definition.range and definition.range[2] or nil
    local prepared = {}
    for index = 1, #points do
        local point = requireObject(points[index], "points[" .. index .. "]")
        prepared[#prepared + 1] = {
            position = requireInteger(point.position, "points[" .. index .. "].position", 0),
            value = requireFiniteNumber(point.value, "points[" .. index .. "].value", minimum, maximum)
        }
    end

    createUndoRecord(project)
    if clearMode == "all" then
        automation:removeAll()
    elseif clearMode == "range" then
        automation:remove(rangeBegin, rangeEnd)
    end
    for index = 1, #prepared do
        automation:add(prepared[index].position, prepared[index].value)
    end

    local _sameAutomation, serialized = serializeAutomation(group, parameterName)
    serialized.trackIndex = trackIndex
    serialized.groupIndex = groupIndex
    serialized.groupUuid = group:getUUID()
    serialized.addedOrUpdatedCount = #prepared
    serialized.clearMode = clearMode
    if mode == "compact" then
        return {
            trackIndex = trackIndex,
            groupIndex = groupIndex,
            groupUuid = group:getUUID(),
            parameter = serialized.parameter,
            interpolation = serialized.interpolation,
            fingerprint = serialized.fingerprint,
            pointCount = serialized.pointCount,
            addedOrUpdatedCount = #prepared,
            clearMode = clearMode,
            responseMode = mode
        }
    end
    return serialized
end

function handlers.clear_automation(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local automation, serializedBefore = serializeAutomation(group, parameterName)
    validateExpectedFingerprint(
        serializedBefore.fingerprint,
        optionalString(payload.expectedFingerprint, "expectedFingerprint", false),
        "STALE_AUTOMATION",
        "The automation curve changed after it was read"
    )
    local hasBegin = isProvided(payload.rangeBegin)
    local hasEnd = isProvided(payload.rangeEnd)
    if hasBegin ~= hasEnd then
        raiseBridgeError("INVALID_ARGUMENT", "rangeBegin and rangeEnd must be supplied together")
    end

    local rangeBegin = nil
    local rangeEnd = nil
    if hasBegin then
        rangeBegin = requireInteger(payload.rangeBegin, "rangeBegin", 0)
        rangeEnd = requireInteger(payload.rangeEnd, "rangeEnd", rangeBegin)
    end

    createUndoRecord(project)
    if rangeBegin then
        automation:remove(rangeBegin, rangeEnd)
    else
        automation:removeAll()
    end

    local _sameAutomation, serialized = serializeAutomation(group, parameterName)
    serialized.trackIndex = trackIndex
    serialized.groupIndex = groupIndex
    serialized.groupUuid = group:getUUID()
    serialized.clearedRange = rangeBegin and { beginPosition = rangeBegin, endPosition = rangeEnd } or JSON_NULL
    return serialized
end

function handlers.get_editor_view(payload)
    payload = requireObject(payload, "payload")
    local viewName = optionalString(payload.view, "view", false) or "mainEditor"
    return serializeNavigation(viewName, getNavigation(viewName))
end

function handlers.set_editor_view(payload)
    payload = requireObject(payload, "payload")
    local viewName = optionalString(payload.view, "view", false) or "mainEditor"
    local navigation = getNavigation(viewName)
    local timeLeft = optionalNumber(payload.timeLeft, "timeLeft")
    local timeRight = optionalNumber(payload.timeRight, "timeRight")
    local timeScale = optionalNumber(payload.timeScale, "timeScale", 0.000000000001)
    local valueCenter = optionalNumber(payload.valueCenter, "valueCenter")
    if timeLeft == nil and timeRight == nil and timeScale == nil and valueCenter == nil then
        raiseBridgeError("INVALID_ARGUMENT", "At least one viewport field must be supplied")
    end
    if timeLeft ~= nil and timeRight ~= nil and timeRight <= timeLeft then
        raiseBridgeError("INVALID_ARGUMENT", "timeRight must be greater than timeLeft")
    end
    if timeLeft ~= nil then navigation:setTimeLeft(timeLeft) end
    if timeRight ~= nil then navigation:setTimeRight(timeRight) end
    if timeScale ~= nil then navigation:setTimeScale(timeScale) end
    if valueCenter ~= nil then navigation:setValueCenter(valueCenter) end
    local result = serializeNavigation(viewName, navigation)
    result.applied = {
        timeLeft = timeLeft or JSON_NULL,
        timeRight = timeRight or JSON_NULL,
        timeScale = timeScale or JSON_NULL,
        valueCenter = valueCenter or JSON_NULL
    }
    return result
end

function handlers.snap_position(payload)
    payload = requireObject(payload, "payload")
    local viewName = optionalString(payload.view, "view", false) or "mainEditor"
    local position = requireFiniteNumber(payload.position, "position")
    local navigation = getNavigation(viewName)
    return {
        view = viewName,
        position = position,
        snappedPosition = navigation:snap(position)
    }
end

function handlers.convert_editor_coordinates(payload)
    payload = requireObject(payload, "payload")
    local viewName = optionalString(payload.view, "view", false) or "mainEditor"
    local navigation = getNavigation(viewName)
    local result = { view = viewName }
    local supplied = 0
    if isProvided(payload.time) then
        local time = requireFiniteNumber(payload.time, "time")
        result.time = time
        result.x = navigation:t2x(time)
        supplied = supplied + 1
    end
    if isProvided(payload.x) then
        local x = requireFiniteNumber(payload.x, "x")
        result.xInput = x
        result.timeFromX = navigation:x2t(x)
        supplied = supplied + 1
    end
    if isProvided(payload.value) then
        local value = requireFiniteNumber(payload.value, "value")
        result.value = value
        result.y = navigation:v2y(value)
        supplied = supplied + 1
    end
    if isProvided(payload.y) then
        local y = requireFiniteNumber(payload.y, "y")
        result.yInput = y
        result.valueFromY = navigation:y2v(y)
        supplied = supplied + 1
    end
    if supplied == 0 then
        raiseBridgeError("INVALID_ARGUMENT", "Supply at least one of time, x, value, or y")
    end
    return result
end

function handlers.script_data(payload)
    payload = requireObject(payload, "payload")
    local operation = requireString(payload.operation, "operation", false)
    local project, object, locator = resolveScriptDataObject(payload)
    local result = {
        operation = operation,
        objectType = payload.objectType,
        locator = locator
    }
    if operation == "list" then
        local keys = object:getScriptDataKeys()
        local bridgeKeys = json.array()
        for index = 1, #keys do
            if keys[index]:sub(1, #SCRIPT_DATA_PREFIX) == SCRIPT_DATA_PREFIX then
                bridgeKeys[#bridgeKeys + 1] = keys[index]
            end
        end
        result.keys = bridgeKeys
        return result
    end

    local key = requireString(payload.key, "key", false)
    if key:sub(1, #SCRIPT_DATA_PREFIX) ~= SCRIPT_DATA_PREFIX then
        raiseBridgeError(
            "INVALID_ARGUMENT",
            "Script-data keys must begin with " .. SCRIPT_DATA_PREFIX
        )
    end
    if operation == "get" then
        result.exists = object:hasScriptData(key)
        result.value = sanitizeForJson(object:getScriptData(key))
        return result
    elseif operation == "set" then
        if not isProvided(payload.value) then
            raiseBridgeError("INVALID_ARGUMENT", "value is required for operation=set")
        end
        local encodable, encodeError = pcall(function()
            json.encode(payload.value)
        end)
        if not encodable then
            raiseBridgeError("INVALID_ARGUMENT", "value must be JSON-serializable", {
                cause = tostring(encodeError)
            })
        end
        createUndoRecord(project)
        object:setScriptData(key, payload.value)
        result.exists = true
        result.value = sanitizeForJson(object:getScriptData(key))
        return result
    elseif operation == "remove" then
        local existed = object:hasScriptData(key)
        createUndoRecord(project)
        object:removeScriptData(key)
        result.removed = existed
        return result
    end
    raiseBridgeError("INVALID_ARGUMENT", "operation must be list, get, set, or remove")
end

function handlers.get_track_mixer(payload)
    payload = requireObject(payload, "payload")
    local _project, track, trackIndex = resolveTrack(payload)
    local result = serializeMixer(track)
    result.trackIndex = trackIndex
    result.trackName = track:getName()
    return result
end

function handlers.set_track_mixer(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex = resolveTrack(payload)
    validateTrackFingerprint(
        track,
        optionalString(payload.trackFingerprint, "trackFingerprint", false),
        trackIndex
    )
    local gain = optionalNumber(payload.gainDecibel, "gainDecibel", -24, 24)
    local pan = optionalNumber(payload.pan, "pan", -1, 1)
    local muted = optionalBoolean(payload.muted, "muted")
    local solo = optionalBoolean(payload.solo, "solo")
    if gain == nil and pan == nil and muted == nil and solo == nil then
        raiseBridgeError("INVALID_ARGUMENT", "At least one mixer field must be supplied")
    end

    createUndoRecord(project)
    local mixer = track:getMixer()
    if gain ~= nil then
        mixer:setGainDecibel(gain)
    end
    if pan ~= nil then
        mixer:setPan(pan)
    end
    if muted ~= nil then
        mixer:setMuted(muted)
    end
    if solo ~= nil then
        mixer:setSolo(solo)
    end

    local result = serializeMixer(track)
    result.trackIndex = trackIndex
    result.trackName = track:getName()
    return result
end

function handlers.playback(payload)
    payload = requireObject(payload, "payload")
    local operation = requireString(payload.operation, "operation", false)
    local playback = SV:getPlayback()

    if operation == "play" then
        playback:play()
    elseif operation == "pause" then
        playback:pause()
    elseif operation == "stop" then
        playback:stop()
    elseif operation == "seek" then
        playback:seek(requireFiniteNumber(payload.timeSeconds, "timeSeconds", 0))
    elseif operation == "loop" then
        local beginSeconds = requireFiniteNumber(payload.timeSeconds, "timeSeconds", 0)
        local endSeconds = requireFiniteNumber(payload.endSeconds, "endSeconds", 0)
        if endSeconds <= beginSeconds then
            raiseBridgeError("INVALID_ARGUMENT", "endSeconds must be greater than timeSeconds")
        end
        playback:loop(beginSeconds, endSeconds)
    elseif operation ~= "status" then
        raiseBridgeError("INVALID_ARGUMENT", "Unsupported playback operation", { operation = operation })
    end

    return {
        operation = operation,
        status = playback:getStatus(),
        playheadSeconds = playback:getPlayhead()
    }
end

local function transactionScopeKey(action, payload)
    if action == "set_time_axis" then
        return "time-axis"
    end
    if action == "create_note_group" or action == "add_track"
        or action == "clone_track" or action == "create_harmony_track" then
        return nil
    end
    if isProvided(payload.trackIndex) then
        return "track:" .. tostring(payload.trackIndex)
    end
    if isProvided(payload.targetTrackIndex) then
        return "track:" .. tostring(payload.targetTrackIndex)
    end
    if isProvided(payload.sourceTrackIndex) and action ~= "clone_group_reference" then
        return "track:" .. tostring(payload.sourceTrackIndex)
    end
    if isProvided(payload.groupUuid) then
        return "library-group:" .. tostring(payload.groupUuid)
    end
    if isProvided(payload.libraryIndex) then
        return "library-group-index:" .. tostring(payload.libraryIndex)
    end
    return action
end

local function validateTransactionSteps(value, path)
    local rawSteps = requireArray(value, path, 1, 32)
    local steps = {}
    for index = 1, #rawSteps do
        local stepPath = path .. "[" .. index .. "]"
        local rawStep = requireObject(rawSteps[index], stepPath)
        local action = requireString(rawStep.action, stepPath .. ".action", false)
        if action == "apply_transaction" or action == "rollback_transaction"
            or not PROJECT_WRITE_ACTIONS[action] or not handlers[action] then
            raiseBridgeError(
                "INVALID_TRANSACTION_ACTION",
                "A transaction step must be a supported non-transaction project write",
                { stepIndex = index, action = action }
            )
        end
        steps[#steps + 1] = {
            action = action,
            payload = requireObject(rawStep.payload, stepPath .. ".payload")
        }
    end
    return steps
end

local function preflightTransaction(steps)
    local scopes = {}
    for index = 1, #steps do
        local step = steps[index]
        if #steps > 1
            and (step.action == "delete_track"
                or step.action == "delete_note_group") then
            raiseBridgeError(
                "TRANSACTION_SCOPE_CONFLICT",
                "Index-shifting deletes must be the only step in a generic transaction",
                {
                    stepIndex = index,
                    action = step.action
                }
            )
        end
        local scope = transactionScopeKey(step.action, step.payload)
        if scope and scopes[scope] then
            raiseBridgeError(
                "TRANSACTION_SCOPE_CONFLICT",
                "Transaction steps may not mutate the same guarded scope twice",
                {
                    scope = scope,
                    firstStepIndex = scopes[scope],
                    stepIndex = index,
                    action = step.action
                }
            )
        end
        if scope then scopes[scope] = index end

        transactionMode = "validate"
        local ok, resultOrError = pcall(handlers[step.action], step.payload)
        transactionMode = nil
        if ok then
            raiseBridgeError(
                "TRANSACTION_PREFLIGHT_INCOMPLETE",
                "A transaction step did not reach its validated undo boundary",
                { stepIndex = index, action = step.action }
            )
        end
        if resultOrError ~= TRANSACTION_VALIDATION_SENTINEL then
            if type(resultOrError) == "table"
                and getmetatable(resultOrError) == BRIDGE_ERROR_MT then
                raiseBridgeError(
                    resultOrError.code or "TRANSACTION_PREFLIGHT_FAILED",
                    resultOrError.message or "Transaction preflight failed",
                    {
                        stepIndex = index,
                        action = step.action,
                        causeDetails = resultOrError.details or JSON_NULL
                    }
                )
            end
            raiseBridgeError(
                "TRANSACTION_PREFLIGHT_FAILED",
                "Transaction preflight failed before any project change",
                {
                    stepIndex = index,
                    action = step.action,
                    cause = tostring(resultOrError)
                }
            )
        end
    end
end

local function executeTransactionSteps(steps)
    preflightTransaction(steps)
    local project = SV:getProject()
    if not project then
        raiseBridgeError("PROJECT_UNAVAILABLE", "No Synthesizer V project is open")
    end
    createUndoRecord(project)
    local results = json.array()
    transactionMode = "execute"
    local ok, resultOrError = xpcall(function()
        for index = 1, #steps do
            results[#results + 1] = handlers[steps[index].action](steps[index].payload)
        end
        return results
    end, function(errorValue)
        return errorValue
    end)
    transactionMode = nil
    if not ok then
        if type(resultOrError) == "table"
            and getmetatable(resultOrError) == BRIDGE_ERROR_MT then
            error(resultOrError, 0)
        end
        raiseBridgeError(
            "TRANSACTION_EXECUTION_FAILED",
            "SynthV rejected a prevalidated transaction during execution",
            {
                cause = tostring(resultOrError),
                undoGuidance = "Use SynthV Edit > Undo to revert the transaction."
            }
        )
    end
    return results
end

local function resolveResultReferences(value, results, path)
    if value == JSON_NULL or type(value) ~= "table" then
        return value
    end
    if isObject(value) and isProvided(value["$result"]) then
        local reference = requireObject(value["$result"], path .. ".$result")
        local stepIndex = requireInteger(
            reference.step,
            path .. ".$result.step",
            1,
            #results
        )
        local segments = requireArray(
            reference.path,
            path .. ".$result.path",
            0,
            16
        )
        local current = results[stepIndex]
        for segmentIndex = 1, #segments do
            local segment = segments[segmentIndex]
            if type(segment) ~= "string"
                and (type(segment) ~= "number" or segment % 1 ~= 0) then
                raiseBridgeError(
                    "INVALID_ROLLBACK_REFERENCE",
                    "A rollback result-reference path segment must be a string or integer"
                )
            end
            if type(current) ~= "table" or current[segment] == nil then
                raiseBridgeError(
                    "INVALID_ROLLBACK_REFERENCE",
                    "A rollback result-reference path does not exist",
                    {
                        stepIndex = stepIndex,
                        pathIndex = segmentIndex,
                        segment = segment
                    }
                )
            end
            current = current[segment]
        end
        return current
    end
    if isSequentialArray(value) then
        local result = json.array()
        for index = 1, #value do
            result[index] = resolveResultReferences(
                value[index],
                results,
                path .. "[" .. index .. "]"
            )
        end
        return result
    end
    local result = {}
    for key, nested in pairs(value) do
        result[key] = resolveResultReferences(
            nested,
            results,
            path .. "." .. tostring(key)
        )
    end
    return result
end

function handlers.apply_transaction(payload)
    payload = requireObject(payload, "payload")
    local summary = requireString(payload.summary, "summary", false)
    local steps = validateTransactionSteps(payload.steps, "steps")
    local rawRollbackSteps = nil
    if isProvided(payload.rollbackSteps) then
        rawRollbackSteps = validateTransactionSteps(
            payload.rollbackSteps,
            "rollbackSteps"
        )
    end
    local results = executeTransactionSteps(steps)
    runtimeState.transactionRevision = runtimeState.transactionRevision + 1
    local transactionId =
        SESSION_TOKEN .. "-tx-" .. tostring(runtimeState.transactionRevision)
    local rollbackAvailable = false
    local rollbackError = nil
    if rawRollbackSteps and #rawRollbackSteps > 0 then
        local resolvedRollback = json.array()
        local resolvedOk, resolvedOrError = pcall(function()
            for index = 1, #rawRollbackSteps do
                resolvedRollback[index] = {
                    action = rawRollbackSteps[index].action,
                    payload = resolveResultReferences(
                        rawRollbackSteps[index].payload,
                        results,
                        "rollbackSteps[" .. index .. "].payload"
                    )
                }
            end
        end)
        if resolvedOk then
            runtimeState.rollbackTransactions[transactionId] = {
                projectFile = SV:getProject():getFileName() or "",
                summary = summary,
                steps = resolvedRollback,
                createdAtEpochMs = os.time() * 1000
            }
            rollbackAvailable = true
        else
            rollbackError = tostring(resolvedOrError)
        end
    end
    return {
        transactionId = transactionId,
        summary = summary,
        stepCount = #steps,
        results = results,
        rollbackAvailable = rollbackAvailable,
        rollbackError = rollbackError or JSON_NULL,
        undoRecordCount = 1
    }
end

function handlers.rollback_transaction(payload)
    payload = requireObject(payload, "payload")
    local transactionId =
        requireString(payload.transactionId, "transactionId", false)
    local stored = runtimeState.rollbackTransactions[transactionId]
    if not stored then
        raiseBridgeError(
            "ROLLBACK_NOT_AVAILABLE",
            "No rollback steps are available for this transaction in the current Bridge session",
            { transactionId = transactionId }
        )
    end
    local project = SV:getProject()
    local projectFile = project and (project:getFileName() or "") or ""
    if projectFile ~= stored.projectFile then
        raiseBridgeError(
            "ROLLBACK_PROJECT_MISMATCH",
            "The rollback belongs to a different SynthV project",
            {
                transactionId = transactionId,
                expectedProjectFile = stored.projectFile,
                actualProjectFile = projectFile
            }
        )
    end
    local steps = validateTransactionSteps(stored.steps, "storedRollbackSteps")
    local results = executeTransactionSteps(steps)
    runtimeState.rollbackTransactions[transactionId] = nil
    return {
        transactionId = transactionId,
        rolledBack = true,
        originalSummary = stored.summary,
        stepCount = #steps,
        results = results,
        undoRecordCount = 1
    }
end

local function validateRequest(request)
    request = requireObject(request, "request")
    if request.v == CURRENT_PROTOCOL_VERSION then
        local requestId = requireString(request.id, "id", false)
        if not requestId:match("^[A-Za-z0-9_-]+$")
            or #requestId < 8
            or #requestId > 64 then
            raiseBridgeError(
                "INVALID_ARGUMENT",
                "id must be an 8-64 character base64url identifier"
            )
        end
        local action = requireString(request.a, "a", false)
        local payload = requireObject(request.p, "p")
        local handler = handlers[action]
        if not handler then
            raiseBridgeError(
                "UNKNOWN_ACTION",
                "Unsupported bridge action",
                { action = action }
            )
        end
        return requestId, handler, payload, action, CURRENT_PROTOCOL_VERSION
    end
    if request.protocolVersion ~= PROTOCOL_VERSION then
        raiseBridgeError("PROTOCOL_MISMATCH", "Unsupported bridge protocol version", {
            expected = PROTOCOL_VERSION,
            actual = request.protocolVersion
        })
    end
    local requestId = requireString(request.requestId, "requestId", false)
    local action = requireString(request.action, "action", false)
    local payload = requireObject(request.payload, "payload")
    local handler = handlers[action]
    if not handler then
        raiseBridgeError("UNKNOWN_ACTION", "Unsupported bridge action", { action = action })
    end
    return requestId, handler, payload, action, PROTOCOL_VERSION
end

PROJECT_WRITE_ACTIONS = {
    set_time_axis = true,
    create_note_group = true,
    clone_note_group = true,
    delete_note_group = true,
    add_group_reference = true,
    clone_group_reference = true,
    add_track = true,
    update_track = true,
    clone_track = true,
    delete_track = true,
    update_group = true,
    set_group_voice = true,
    delete_group_reference = true,
    add_notes = true,
    edit_notes = true,
    set_note_phoneme_properties = true,
    delete_notes = true,
    generate_note_retake = true,
    activate_note_retake = true,
    delete_note_retake = true,
    add_pitch_controls = true,
    edit_pitch_controls = true,
    delete_pitch_controls = true,
    simplify_automation = true,
    set_automation_points = true,
    clear_automation = true,
    set_track_mixer = true,
    apply_transaction = true,
    rollback_transaction = true,
    create_harmony_track = true,
    humanize_notes = true,
    apply_expression_preset = true,
    fit_lyrics = true
}

local function processRequestFile()
    if not fileExists(REQUEST_FILE) then
        return false
    end
    if fileExists(PROCESSING_FILE) then
        return false
    end

    local claimed, claimError = os.rename(REQUEST_FILE, PROCESSING_FILE)
    if not claimed then
        if fileExists(REQUEST_FILE) then
            writeStatus("error", "Unable to claim request: " .. tostring(claimError))
        end
        return false
    end

    local requestId = "invalid-request"
    local requestWireVersion = PROTOCOL_VERSION
    local processedAction = nil
    local processedPayload = nil
    local ok, resultOrError = xpcall(function()
        local raw, readError = readFile(PROCESSING_FILE)
        if raw == nil then
            raiseBridgeError("IPC_READ_FAILED", "Unable to read claimed request", { cause = tostring(readError) })
        end
        local decodedOk, requestOrError = pcall(json.decode, raw)
        if not decodedOk then
            raiseBridgeError("INVALID_JSON", "Request is not valid JSON", { cause = tostring(requestOrError) })
        end
        if isObject(requestOrError) then
            if requestOrError.v == CURRENT_PROTOCOL_VERSION
                and type(requestOrError.id) == "string" then
                requestId = requestOrError.id
                requestWireVersion = CURRENT_PROTOCOL_VERSION
            elseif type(requestOrError.requestId) == "string" then
                requestId = requestOrError.requestId
            end
        end
        local validatedRequestId, handler, payload, action, wireVersion =
            validateRequest(requestOrError)
        requestId = validatedRequestId
        requestWireVersion = wireVersion
        processedAction = action
        processedPayload = payload
        return handler(payload)
    end, normalizeError)

    if ok then
        if not (processedPayload and processedPayload._sidebarPlanId)
            and (PROJECT_WRITE_ACTIONS[processedAction]
            or (processedAction == "script_data"
                and processedPayload
                and (processedPayload.operation == "set" or processedPayload.operation == "remove")))
        then
            writeSidebarActivity(processedAction)
        end
        writeResponse(requestId, true, resultOrError, requestWireVersion)
    else
        writeResponse(requestId, false, resultOrError, requestWireVersion)
    end
    removeFile(PROCESSING_FILE)
    return true
end

local pollCount = 0
local stopped = false

local function performHotReload()
    local request = reloadRequested
    reloadRequested = nil
    if request == nil then
        return false
    end

    writeStatus("running", "Reloading the installed Bridge script.")
    local previousMain = main
    local loaded, loadError = pcall(request.loader)
    if not loaded then
        writeStatus("error", "Unable to load the installed Bridge script: " .. tostring(loadError))
        return false
    end

    local replacementMain = main
    if type(replacementMain) ~= "function" or replacementMain == previousMain then
        main = previousMain
        writeStatus("error", "The reloaded Bridge script did not define a replacement main().")
        return false
    end

    stopped = true
    local started, startError = pcall(replacementMain, {
        hotReload = true
    })
    if not started then
        stopped = false
        main = previousMain
        writeStatus("error", "The reloaded Bridge script failed to start: " .. tostring(startError))
        return false
    end
    return true
end

local function stopBridge(message)
    if stopped then
        return
    end
    stopped = true
    writeStatus("stopped", message)
    if ownsSession() then
        removeFile(SESSION_FILE)
    end
    SV:finish()
end

local function poll()
    if stopped then
        return
    end
    pollCount = pollCount + 1
    if (pollCount == 1 or pollCount % SESSION_CHECK_EVERY_POLLS == 0)
        and not ownsSession() then
        stopBridge("A newer SynthV Agent Bridge session replaced this one.")
        return
    end
    if fileExists(STOP_FILE) then
        removeFile(STOP_FILE)
        stopBridge("Shutdown requested by StopSynthVAgentBridge.lua.")
        return
    end

    processRequestFile()
    if fileExists(RELOAD_FILE) then
        removeFile(RELOAD_FILE)
        local queued, reloadError = pcall(prepareHotReload)
        if not queued then
            writeStatus("error", "Unable to prepare Bridge reload: " .. tostring(reloadError))
        end
    end
    if reloadRequested ~= nil and performHotReload() then
        return
    end
    if pollCount % HEARTBEAT_EVERY_POLLS == 0 then
        local wrote, statusError = writeStatus("running")
        if not wrote then
            stopBridge("Unable to write heartbeat: " .. tostring(statusError))
            return
        end
    end
    SV:setTimeout(POLL_INTERVAL_MS, poll)
end

function getClientInfo()
    return {
        name = SCRIPT_NAME,
        author = "Pengjie Zhou",
        category = "SynthV Agent Bridge",
        versionNumber = 5,
        minEditorVersion = MIN_EDITOR_VERSION
    }
end

function getTranslations(_languageCode)
    return {}
end

function main(options)
    local hotReload = type(options) == "table" and options.hotReload == true
    removeFile(STOP_FILE)
    removeFile(RELOAD_FILE)
    -- Never execute a command left by an older bridge session.
    removeFile(REQUEST_FILE)
    removeFile(PROCESSING_FILE)
    if not hotReload then
        removeFile(RESPONSE_FILE)
    end

    local sessionOk, sessionError = writeSessionFile()
    if not sessionOk then
        SV:showMessageBox(SCRIPT_NAME, "Unable to start bridge session: " .. tostring(sessionError))
        SV:finish()
        return
    end

    local statusOk, statusError = writeStatus("running")
    if not statusOk then
        SV:showMessageBox(SCRIPT_NAME, "Unable to write bridge status: " .. tostring(statusError))
        removeFile(SESSION_FILE)
        SV:finish()
        return
    end

    registerSelectionObservers()
    SV:print(string.format("%s v%s started. IPC directory: %s", SCRIPT_NAME, BRIDGE_VERSION, IPC_DIRECTORY))
    poll()
end
