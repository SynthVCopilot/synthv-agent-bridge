-- SynthV Agent Bridge
-- Persistent, file-based IPC executor for Synthesizer V Studio 2 Pro.
-- SPDX-License-Identifier: Apache-2.0

local SCRIPT_NAME = "Start SynthV Agent Bridge"
local BRIDGE_VERSION = "0.1.0"
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
    local parts = {
        groupUuid,
        tostring(noteIndex),
        tostring(note:getOnset()),
        tostring(note:getDuration()),
        tostring(note:getPitch()),
        tostring(note:getDetune()),
        tostring(#lyrics) .. ":" .. lyrics,
        tostring(#phonemes) .. ":" .. phonemes,
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

local function serializeTrackSummary(track, trackIndex)
    return {
        trackIndex = trackIndex,
        name = track:getName(),
        displayColor = safeCall(function()
            return track:getDisplayColor()
        end, ""),
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

    return automation, {
        parameter = automation:getType(),
        interpolation = automation:getInterpolationMethod(),
        definition = definition,
        pointCount = #points,
        points = points
    }
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
    attributes = true
}

local function applyPreparedNoteChanges(note, changes)
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
        applyPreparedNoteChanges(candidate, prepared)
    end)
    if not ok then
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

function handlers.add_track(payload)
    payload = requireObject(payload, "payload")
    local project = getProject()
    local name = optionalString(payload.name, "name", false) or "New Track"
    local displayColor = optionalString(payload.displayColor, "displayColor", false)
    if displayColor and not displayColor:match("^#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$") then
        raiseBridgeError("INVALID_ARGUMENT", "displayColor must use #RRGGBB format")
    end

    local track = SV:create("Track")
    track:setName(name)
    if displayColor then
        track:setDisplayColor(displayColor)
    end

    project:newUndoRecord()
    local trackIndex = project:addTrack(track)
    if type(trackIndex) ~= "number" then
        trackIndex = project:getNumTracks()
    end
    return serializeTrackSummary(track, trackIndex)
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
        prepared[#prepared + 1] = {
            note = note,
            changes = prepareNoteChanges(note, edit.changes, "edits[" .. index .. "].changes")
        }
    end

    project:newUndoRecord()
    for index = 1, #prepared do
        applyPreparedNoteChanges(prepared[index].note, prepared[index].changes)
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
    local automation = serializeAutomation(group, parameterName)
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
