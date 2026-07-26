-- SynthV Agent Bridge
-- Persistent, file-based IPC executor for Synthesizer V Studio 2 Pro.
-- SPDX-License-Identifier: Apache-2.0

local SCRIPT_NAME = "Start SynthV Agent Bridge"
local BRIDGE_VERSION = "0.1.2"
local PROTOCOL_VERSION = 1
local MIN_EDITOR_VERSION = 131329 -- Synthesizer V Studio 2.1.1
local POLL_INTERVAL_MS = 100
local HEARTBEAT_EVERY_POLLS = 10
local MAX_REQUEST_BYTES = 8 * 1024 * 1024

local json = {}
local JSON_ARRAY_MT = {}
local JSON_NULL = {}
json.null = JSON_NULL

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
local SESSION_FILE = PREFIX .. ".session.json"

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

local function writeResponse(requestId, ok, value)
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

local function resolveTrack(payload)
    local project = getProject()
    local trackIndex = requireInteger(payload.trackIndex, "trackIndex", 1, project:getNumTracks())
    local track = project:getTrack(trackIndex)
    if not track then
        raiseBridgeError("TRACK_NOT_FOUND", "Track does not exist", { trackIndex = trackIndex })
    end
    return project, track, trackIndex
end

local function resolveGroup(payload)
    local project, track, trackIndex = resolveTrack(payload)
    local groupIndex = optionalInteger(payload.groupIndex, "groupIndex", 1, track:getNumGroups(), 1)
    local reference = track:getGroupReference(groupIndex)
    if not reference then
        raiseBridgeError("GROUP_NOT_FOUND", "Group reference does not exist", {
            trackIndex = trackIndex,
            groupIndex = groupIndex
        })
    end
    if reference:isInstrumental() then
        raiseBridgeError("INSTRUMENTAL_GROUP", "The selected group is an instrumental audio group")
    end

    local group = reference:getTarget()
    if not group then
        raiseBridgeError("GROUP_NOT_FOUND", "The selected group has no note-group target")
    end

    local expectedUuid = optionalString(payload.groupUuid, "groupUuid", false)
    local actualUuid = group:getUUID()
    if expectedUuid and expectedUuid ~= actualUuid then
        raiseBridgeError("STALE_GROUP", "groupUuid no longer matches the target group", {
            expected = expectedUuid,
            actual = actualUuid,
            trackIndex = trackIndex,
            groupIndex = groupIndex
        })
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

local function makeNoteFingerprint(groupUuid, noteIndex, note)
    local lyrics = note:getLyrics() or ""
    local phonemes = note:getPhonemes() or ""
    local attributes = json.encode(sanitizeForJson(note:getAttributes()))
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
        tostring(#attributes) .. ":" .. attributes
    }
    return table.concat(parts, "|")
end

local function serializeNote(group, reference, note, noteIndex)
    local groupUuid = group:getUUID()
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
        fingerprint = makeNoteFingerprint(groupUuid, noteIndex, note),
        onset = localOnset,
        duration = note:getDuration(),
        endPosition = localEnd,
        pitch = localPitch,
        lyrics = note:getLyrics(),
        phonemes = note:getPhonemes(),
        detune = note:getDetune(),
        attributes = sanitizeForJson(note:getAttributes()),
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
    if not expectedFingerprint then
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
        instrumental = reference:isInstrumental(),
        main = reference:isMain(),
        muted = safeCall(function()
            return reference:isMuted()
        end, false),
        timeOffset = reference:getTimeOffset(),
        pitchOffset = reference:getPitchOffset(),
        onset = reference:getOnset(),
        duration = reference:getDuration(),
        endPosition = reference:getEnd()
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
    if expected and actual ~= expected then
        raiseBridgeError(staleCode, message, {
            expected = expected,
            actual = actual
        })
    end
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

local function validateFingerprint(group, noteIndex, expectedFingerprint)
    local noteCount = group:getNumNotes()
    requireInteger(noteIndex, "noteIndex", 1, noteCount)
    local note = group:getNote(noteIndex)
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

local handlers = {}

function handlers.ping(_payload)
    return {
        bridgeVersion = BRIDGE_VERSION,
        protocolVersion = PROTOCOL_VERSION,
        sessionToken = SESSION_TOKEN,
        projectFile = currentProjectFile(),
        timestamp = isoTimestamp()
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
    return {
        blicks = blicks,
        quarters = SV:blick2Quarter(blicks),
        seconds = timeAxis:getSecondsFromBlick(blicks),
        measure = timeAxis:getMeasureAt(blicks),
        effectiveTempo = sanitizeForJson(tempoMark),
        effectiveMeasure = sanitizeForJson(measureMark)
    }
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

    project:newUndoRecord()
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

function handlers.get_selection(_payload)
    local mainEditor = SV:getMainEditor()
    local track = mainEditor:getCurrentTrack()
    local reference = mainEditor:getCurrentGroup()
    if not track or not reference then
        raiseBridgeError("SELECTION_UNAVAILABLE", "The piano roll has no current track or group")
    end
    if reference:isInstrumental() then
        raiseBridgeError("INSTRUMENTAL_GROUP", "The current piano-roll group is instrumental")
    end

    local group = reference:getTarget()
    local selection = mainEditor:getSelection()
    local selectedNotes = selection:getSelectedNotes()
    local serializedNotes = json.array()
    for index = 1, #selectedNotes do
        local note = selectedNotes[index]
        local noteIndex = note:getIndexInParent()
        serializedNotes[#serializedNotes + 1] = serializeNote(group, reference, note, noteIndex)
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

    return {
        current = locateReference(reference),
        selectedNoteCount = #serializedNotes,
        selectedNotes = serializedNotes,
        selectedGroupCount = #selectedGroups,
        selectedGroups = selectedGroups
    }
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
        local rawAttributes = SV:getComputedAttributesForGroup(reference)
        local computedAttributes = json.array()
        for index = 1, #rawAttributes do
            computedAttributes[#computedAttributes + 1] = sanitizeForJson(rawAttributes[index])
        end
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

    project:newUndoRecord()
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

    project:newUndoRecord()
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
                        if newPitch < 0 or newPitch > 127 then
                            raiseBridgeError("PITCH_OUT_OF_RANGE", "A cloned note would leave MIDI range 0..127", {
                                groupIndex = groupIndex,
                                noteIndex = noteIndex,
                                originalPitch = note:getPitch(),
                                requestedPitch = newPitch
                            })
                        end
                        note:setPitch(newPitch)
                        affectedNoteCount = affectedNoteCount + 1
                    end
                end
            end
        end
    end

    project:newUndoRecord()
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
    project:newUndoRecord()
    project:removeTrack(trackIndex)
    return {
        deletedTrack = deletedTrack,
        trackCount = project:getNumTracks()
    }
end

function handlers.update_group(payload)
    payload = requireObject(payload, "payload")
    local project, _track, trackIndex, reference, group, groupIndex = resolveGroup(payload)
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
    local groupCandidate = group:clone()
    local valid, validationError = pcall(function()
        applyReferenceUpdates(referenceCandidate)
        if name ~= nil then
            groupCandidate:setName(name)
        end
    end)
    if not valid then
        raiseBridgeError("INVALID_ARGUMENT", "SynthV rejected the requested group changes", {
            cause = tostring(validationError)
        })
    end

    project:newUndoRecord()
    applyReferenceUpdates(reference)
    if name ~= nil then
        group:setName(name)
    end
    return {
        trackIndex = trackIndex,
        group = serializeGroup(reference, groupIndex, 0, 0)
    }
end

function handlers.delete_group_reference(payload)
    payload = requireObject(payload, "payload")
    local project, track, trackIndex, reference, _group, groupIndex = resolveGroup(payload)
    if groupIndex == 1 or reference:isMain() then
        raiseBridgeError("MAIN_GROUP", "A track's main group reference cannot be removed")
    end
    local deletedGroup = serializeGroup(reference, groupIndex, 0, 0)
    project:newUndoRecord()
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
        local input = requireObject(noteInputs[index], "notes[" .. index .. "]")
        local note = SV:create("Note")
        note:setTimeRange(
            requireInteger(input.onset, "notes[" .. index .. "].onset", 0),
            requireInteger(input.duration, "notes[" .. index .. "].duration", 1)
        )
        note:setPitch(requireInteger(input.pitch, "notes[" .. index .. "].pitch", 0, 127))
        note:setLyrics(optionalString(input.lyrics, "notes[" .. index .. "].lyrics", true) or "la")
        if isProvided(input.phonemes) then
            note:setPhonemes(requireString(input.phonemes, "notes[" .. index .. "].phonemes", true))
        end
        if isProvided(input.detune) then
            note:setDetune(requireFiniteNumber(input.detune, "notes[" .. index .. "].detune"))
        end
        if isProvided(input.languageOverride) then
            local languageOverride = requireString(input.languageOverride, "notes[" .. index .. "].languageOverride", true)
            local allowedLanguages = {
                [""] = true,
                mandarin = true,
                japanese = true,
                english = true,
                cantonese = true
            }
            if not allowedLanguages[languageOverride] then
                raiseBridgeError("INVALID_ARGUMENT", "notes[" .. index .. "].languageOverride is unsupported")
            end
            note:setLanguageOverride(languageOverride)
        end
        if isProvided(input.musicalType) then
            local musicalType = requireString(input.musicalType, "notes[" .. index .. "].musicalType", false)
            if musicalType ~= "sing" and musicalType ~= "rap" then
                raiseBridgeError("INVALID_ARGUMENT", "notes[" .. index .. "].musicalType must be sing or rap")
            end
            note:setMusicalType(musicalType)
        end
        if isProvided(input.pitchAutoMode) then
            applyPitchAutoMode(
                note,
                requireBoolean(input.pitchAutoMode, "notes[" .. index .. "].pitchAutoMode"),
                "notes[" .. index .. "].pitchAutoMode"
            )
        end
        if isProvided(input.rapAccent) then
            local rapAccent = requireString(input.rapAccent, "notes[" .. index .. "].rapAccent", true)
            if rapAccent ~= "" and not rapAccent:match("^[1-5]$") then
                raiseBridgeError("INVALID_ARGUMENT", "notes[" .. index .. "].rapAccent must be empty or 1..5")
            end
            note:setRapAccent(rapAccent)
        end
        if isProvided(input.attributes) then
            note:setAttributes(requireObject(input.attributes, "notes[" .. index .. "].attributes"))
        end
        prepared[#prepared + 1] = note
    end

    project:newUndoRecord()
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

    project:newUndoRecord()
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
    project:newUndoRecord()
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

function handlers.get_automation(payload)
    payload = requireObject(payload, "payload")
    local _project, _track, trackIndex, _reference, group, groupIndex = resolveGroup(payload)
    local parameterName = requireString(payload.parameter, "parameter", false)
    local _automation, serialized = serializeAutomation(group, parameterName)
    serialized.trackIndex = trackIndex
    serialized.groupIndex = groupIndex
    serialized.groupUuid = group:getUUID()
    return serialized
end

function handlers.set_automation_points(payload)
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

    project:newUndoRecord()
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

    project:newUndoRecord()
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

    project:newUndoRecord()
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

local function validateRequest(request)
    request = requireObject(request, "request")
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
    return requestId, handler, payload
end

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
    local ok, resultOrError = xpcall(function()
        local raw, readError = readFile(PROCESSING_FILE)
        if raw == nil then
            raiseBridgeError("IPC_READ_FAILED", "Unable to read claimed request", { cause = tostring(readError) })
        end
        local decodedOk, requestOrError = pcall(json.decode, raw)
        if not decodedOk then
            raiseBridgeError("INVALID_JSON", "Request is not valid JSON", { cause = tostring(requestOrError) })
        end
        if isObject(requestOrError) and type(requestOrError.requestId) == "string" then
            requestId = requestOrError.requestId
        end
        local validatedRequestId, handler, payload = validateRequest(requestOrError)
        requestId = validatedRequestId
        return handler(payload)
    end, normalizeError)

    if ok then
        writeResponse(requestId, true, resultOrError)
    else
        writeResponse(requestId, false, resultOrError)
    end
    removeFile(PROCESSING_FILE)
    return true
end

local pollCount = 0
local stopped = false

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
    if not ownsSession() then
        stopBridge("A newer SynthV Agent Bridge session replaced this one.")
        return
    end
    if fileExists(STOP_FILE) then
        removeFile(STOP_FILE)
        stopBridge("Shutdown requested by StopSynthVAgentBridge.lua.")
        return
    end

    processRequestFile()
    pollCount = pollCount + 1
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
        versionNumber = 1,
        minEditorVersion = MIN_EDITOR_VERSION
    }
end

function getTranslations(_languageCode)
    return {}
end

function main()
    removeFile(STOP_FILE)
    -- Never execute a command left by an older bridge session.
    removeFile(REQUEST_FILE)
    removeFile(PROCESSING_FILE)
    removeFile(RESPONSE_FILE)

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

    SV:print(string.format("%s v%s started. IPC directory: %s", SCRIPT_NAME, BRIDGE_VERSION, IPC_DIRECTORY))
    poll()
end
