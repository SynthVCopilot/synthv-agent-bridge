-- Local smoke harness for the bridge and CI integration tests.
local ipc = assert(os.getenv("SYNTHV_AGENT_BRIDGE_DIR"))
local prefix = ipc .. "/synthv-agent-bridge"
local requestFile = prefix .. ".request.json"
local responseFile = prefix .. ".response.json"

local function arrayCopy(t)
    local r = {}
    for i = 1, #t do r[i] = t[i] end
    return r
end

local function indexOf(t, object)
    for i = 1, #t do if t[i] == object then return i end end
end

local function makeNote()
    local n = { onset = 0, duration = 705600000, pitch = 60, lyrics = "la", phonemes = "", detune = 0, attrs = {} }
    function n:getOnset() return self.onset end
    function n:setOnset(v) self.onset = v end
    function n:getDuration() return self.duration end
    function n:setDuration(v) self.duration = v end
    function n:setTimeRange(o,d) self.onset=o; self.duration=d end
    function n:getEnd() return self.onset + self.duration end
    function n:getPitch() return self.pitch end
    function n:setPitch(v) self.pitch=v end
    function n:getLyrics() return self.lyrics end
    function n:setLyrics(v) self.lyrics=v end
    function n:getPhonemes() return self.phonemes end
    function n:setPhonemes(v) self.phonemes=v end
    function n:getDetune() return self.detune end
    function n:setDetune(v) self.detune=v end
    function n:getAttributes() return self.attrs end
    function n:setAttributes(v) for k,x in pairs(v) do self.attrs[k]=x end end
    function n:getLanguageOverride() return "" end
    function n:getMusicalType() return "sing" end
    function n:getPitchAutoMode() return true end
    function n:getIndexInParent() return indexOf(self.parent.notes, self) end
    function n:clone()
        local copy = makeNote()
        copy.onset = self.onset
        copy.duration = self.duration
        copy.pitch = self.pitch
        copy.lyrics = self.lyrics
        copy.phonemes = self.phonemes
        copy.detune = self.detune
        copy.attrs = {}
        for key, value in pairs(self.attrs) do copy.attrs[key] = value end
        return copy
    end
    return n
end

local function makeAutomation(name)
    local a = { name=name, points={} }
    local definitions = {
        pitchDelta={displayName="Pitch Deviation",typeName="pitchDelta",range={-1200,1200},defaultValue=0},
        loudness={displayName="Loudness",typeName="loudness",range={-48,12},defaultValue=0},
    }
    function a:getDefinition() return definitions[self.name] or {displayName=self.name,typeName=self.name,range={-1,1},defaultValue=0} end
    function a:getType() return self.name end
    function a:getInterpolationMethod() return "Linear" end
    function a:getAllPoints()
        local r={}
        for b,v in pairs(self.points) do r[#r+1]={b,v} end
        table.sort(r,function(x,y)return x[1]<y[1] end)
        return r
    end
    function a:add(b,v) local fresh=self.points[b]==nil; self.points[b]=v; return fresh end
    function a:removeAll() self.points={} end
    function a:remove(beginPos,endPos)
        local changed=false
        for b,_ in pairs(self.points) do if b>=beginPos and b<=endPos then self.points[b]=nil; changed=true end end
        return changed
    end
    return a
end

local nextUuid=1
local function makeGroup()
    local g={ notes={}, params={}, uuid="00000000-0000-4000-8000-"..string.format("%012d",nextUuid), name="Main" }
    nextUuid=nextUuid+1
    function g:getUUID() return self.uuid end
    function g:getName() return self.name end
    function g:getNumNotes() return #self.notes end
    function g:getNote(i) return self.notes[i] end
    function g:addNote(n)
        n.parent=self; self.notes[#self.notes+1]=n
        table.sort(self.notes,function(x,y)return x.onset<y.onset end)
        return indexOf(self.notes,n)
    end
    function g:removeNote(i) table.remove(self.notes,i) end
    function g:getNumPitchControls() return 0 end
    function g:getParameter(name) self.params[name]=self.params[name] or makeAutomation(name); return self.params[name] end
    return g
end

local function makeReference(group, main)
    local r={ group=group, main=main, timeOffset=0, pitchOffset=0, muted=false }
    function r:isInstrumental() return false end
    function r:isMain() return self.main end
    function r:isMuted() return self.muted end
    function r:getTimeOffset() return self.timeOffset end
    function r:getPitchOffset() return self.pitchOffset end
    function r:getTarget() return self.group end
    function r:getVoice() return {paramLoudness=0} end
    function r:getOnset() if #self.group.notes==0 then return self.timeOffset end return self.group.notes[1]:getOnset()+self.timeOffset end
    function r:getEnd() if #self.group.notes==0 then return self.timeOffset end return self.group.notes[#self.group.notes]:getEnd()+self.timeOffset end
    function r:getDuration() return self:getEnd()-self:getOnset() end
    function r:getParent() return self.parent end
    function r:getIndexInParent() return indexOf(self.parent.refs,self) end
    return r
end

local function makeMixer()
    local m={gain=0,pan=0,muted=false,solo=false}
    function m:getGainDecibel() return self.gain end
    function m:setGainDecibel(v) self.gain=v end
    function m:getPan() return self.pan end
    function m:setPan(v) self.pan=v end
    function m:isMuted() return self.muted end
    function m:setMuted(v) self.muted=v end
    function m:isSolo() return self.solo end
    function m:setSolo(v) self.solo=v end
    return m
end

local project
local function makeTrack()
    local group=makeGroup()
    local ref=makeReference(group,true)
    local t={name="Track",color="#808080",refs={ref},mixer=makeMixer()}
    ref.parent=t
    function t:getName() return self.name end
    function t:setName(v) self.name=v end
    function t:getDisplayColor() return self.color end
    function t:setDisplayColor(v) self.color=v end
    function t:getDisplayOrder() return self:getIndexInParent() end
    function t:getDuration() local x=0 for _,r in ipairs(self.refs) do if r:getEnd()>x then x=r:getEnd() end end return x end
    function t:getNumGroups() return #self.refs end
    function t:getGroupReference(i) return self.refs[i] end
    function t:getMixer() return self.mixer end
    function t:isBounced() return false end
    function t:getIndexInParent() return indexOf(project.tracks,self) end
    return t
end

local timeAxis={}
function timeAxis:getSecondsFromBlick(b) return b/705600000*0.5 end
function timeAxis:getTempoMarkAt(_) return {position=0,bpm=120} end
function timeAxis:getMeasureMarkAtBlick(_) return {position=0,measure=0,numerator=4,denominator=4} end

local playback={status="stopped",head=0}
function playback:getStatus() return self.status end
function playback:getPlayhead() return self.head end
function playback:play() self.status="playing" end
function playback:pause() self.status="stopped" end
function playback:stop() self.status="stopped"; self.head=0 end
function playback:seek(v) self.head=v end
function playback:loop(a,_) self.head=a; self.status="looping" end

project={tracks={},undo=0}
function project:getFileName() return "mock.svp" end
function project:getDuration() local x=0 for _,t in ipairs(self.tracks) do if t:getDuration()>x then x=t:getDuration() end end return x end
function project:getNumTracks() return #self.tracks end
function project:getTrack(i) return self.tracks[i] end
function project:addTrack(t) self.tracks[#self.tracks+1]=t; return #self.tracks end
function project:getTimeAxis() return timeAxis end
function project:newUndoRecord() self.undo=self.undo+1 end
project:addTrack(makeTrack())

local selection={selectedNotes={},selectedGroups={}}
function selection:getSelectedNotes() return arrayCopy(self.selectedNotes) end
function selection:getSelectedGroups() return arrayCopy(self.selectedGroups) end
local mainEditor={}
function mainEditor:getCurrentTrack() return project.tracks[1] end
function mainEditor:getCurrentGroup() return project.tracks[1].refs[1] end
function mainEditor:getSelection() return selection end
local arrangementSelection={}
function arrangementSelection:getSelectedGroups() return {} end
local arrangement={}
function arrangement:getSelection() return arrangementSelection end

scheduled=nil
SV={QUARTER=705600000}
function SV:getHostInfo() return {osType="Linux",hostName="Mock SynthV",hostVersion="2.2.0",hostVersionNumber=131584,languageCode="en-us"} end
function SV:getProject() return project end
function SV:getPlayback() return playback end
function SV:getMainEditor() return mainEditor end
function SV:getArrangement() return arrangement end
function SV:create(kind) if kind=="Note" then return makeNote() elseif kind=="Track" then return makeTrack() else error("unsupported create "..kind) end end
function SV:blick2Quarter(b) return b/self.QUARTER end
function SV:setTimeout(_,callback) scheduled=callback end
function SV:finish() scheduled=nil end
function SV:print(_) end
function SV:showMessageBox(_,message) error(message) end

dofile(assert(os.getenv("BRIDGE_SCRIPT")))
main()

local seq=0
local function escape(s) return s:gsub('\\','\\\\'):gsub('"','\\"') end
local function callRaw(action,payload)
    seq=seq+1
    local id=string.format("00000000-0000-4000-8000-%012d",seq)
    local f=assert(io.open(requestFile,"wb"))
    f:write('{"protocolVersion":1,"requestId":"'..id..'","action":"'..action..'","createdAt":"2026-07-26T00:00:00.000Z","payload":'..payload..'}')
    f:close()
    assert(scheduled,"bridge stopped unexpectedly")
    local callback=scheduled; scheduled=nil; callback()
    local rf=assert(io.open(responseFile,"rb")); local response=rf:read("*a"); rf:close(); os.remove(responseFile)
    return response
end

local function call(action,payload)
    local response=callRaw(action,payload)
    assert(response:find('"ok":true',1,true),action.." failed: "..response)
    return response
end

local function callExpectError(action,payload,errorCode)
    local response=callRaw(action,payload)
    assert(response:find('"ok":false',1,true),action.." unexpectedly succeeded: "..response)
    assert(response:find('"code":"'..errorCode..'"',1,true),action.." returned the wrong error: "..response)
    return response
end

call("ping","{}")
call("get_project_info","{}")
call("list_tracks","{}")
call("add_track",'{"name":"Harmony","displayColor":"#ABCDEF"}')
local added=call("add_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"onset":0,"duration":705600000,"pitch":60,"lyrics":"la"},{"onset":705600000,"duration":705600000,"pitch":64,"lyrics":"你"}]}')
local fingerprint=assert(added:match('"fingerprint":"([^"]+)"'))
call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
call("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprint)..'","changes":{"onset":0,"pitch":62,"lyrics":"re"}}]}')
local undoAfterEdit=project.undo
callExpectError("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprint)..'","changes":{"pitch":63}}]}',"STALE_NOTE")
assert(project.undo==undoAfterEdit,"stale edit must not create an undo record")
local notesAfter=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local fingerprints={}
for value in notesAfter:gmatch('"fingerprint":"([^"]+)"') do fingerprints[#fingerprints+1]=value end
assert(#fingerprints==2,"expected two note fingerprints")
local newFingerprint=fingerprints[1]
local undoBeforeInvalidBatch=project.undo
local pitchBeforeInvalidBatch=project.tracks[1].refs[1].group.notes[1].pitch
callExpectError("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprints[1])..'","changes":{"pitch":63}},{"noteIndex":2,"fingerprint":"'..escape(fingerprints[2])..'","changes":{"unsupported":true}}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeInvalidBatch,"invalid batch must not create an undo record")
assert(project.tracks[1].refs[1].group.notes[1].pitch==pitchBeforeInvalidBatch,"invalid batch must not partially mutate notes")
call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}')
call("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":0}]}')
call("clear_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}')
call("set_track_mixer",'{"trackIndex":1,"gainDecibel":-3,"pan":0.25,"muted":false,"solo":true}')
call("get_track_mixer",'{"trackIndex":1}')
call("playback",'{"operation":"seek","timeSeconds":1.5}')
call("playback",'{"operation":"loop","timeSeconds":1,"endSeconds":2}')
call("delete_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(newFingerprint)..'"}]}')
assert(project.undo==7,"expected 7 undo records, got "..project.undo)
print("Mock SynthV smoke test passed")
