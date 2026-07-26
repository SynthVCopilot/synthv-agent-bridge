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
    local n = {
        onset = 0,
        duration = 705600000,
        pitch = 60,
        lyrics = "la",
        phonemes = "",
        detune = 0,
        attrs = {},
        languageOverride = "",
        musicalType = "sing",
        pitchAutoMode = true,
        rapAccent = ""
    }
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
    function n:getLanguageOverride() return self.languageOverride end
    function n:setLanguageOverride(v) self.languageOverride=v end
    function n:getMusicalType() return self.musicalType end
    function n:setMusicalType(v) self.musicalType=v end
    function n:getPitchAutoMode() return self.pitchAutoMode end
    function n:setPitchAutoMode(v) self.pitchAutoMode=v end
    function n:getRapAccent() return self.rapAccent end
    function n:setRapAccent(v) self.rapAccent=v end
    function n:getRetakes()
        return {getNumTakes=function() return 1 end}
    end
    function n:getIndexInParent() return indexOf(self.parent.notes, self) end
    function n:clone()
        local copy = makeNote()
        copy.onset = self.onset
        copy.duration = self.duration
        copy.pitch = self.pitch
        copy.lyrics = self.lyrics
        copy.phonemes = self.phonemes
        copy.detune = self.detune
        copy.languageOverride = self.languageOverride
        copy.musicalType = self.musicalType
        copy.pitchAutoMode = self.pitchAutoMode
        copy.rapAccent = self.rapAccent
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
    function a:clone()
        local copy=makeAutomation(self.name)
        for b,v in pairs(self.points) do copy.points[b]=v end
        return copy
    end
    return a
end

local nextUuid=1
local function makeGroup()
    local g={ notes={}, params={}, uuid="00000000-0000-4000-8000-"..string.format("%012d",nextUuid), name="Main" }
    nextUuid=nextUuid+1
    function g:getUUID() return self.uuid end
    function g:getName() return self.name end
    function g:setName(v) self.name=v end
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
    function g:clone()
        local copy=makeGroup()
        copy.name=self.name
        for _,note in ipairs(self.notes) do copy:addNote(note:clone()) end
        for name,automation in pairs(self.params) do copy.params[name]=automation:clone() end
        return copy
    end
    return g
end

local function makeReference(group, main)
    local r={
        group=group,
        main=main,
        timeOffset=0,
        pitchOffset=0,
        muted=false,
        voice={paramLoudness=0}
    }
    function r:isInstrumental() return false end
    function r:isMain() return self.main end
    function r:isMuted() return self.muted end
    function r:setMuted(v) self.muted=v end
    function r:getTimeOffset() return self.timeOffset end
    function r:setTimeOffset(v) self.timeOffset=v end
    function r:getPitchOffset() return self.pitchOffset end
    function r:setPitchOffset(v) self.pitchOffset=v end
    function r:getTarget() return self.group end
    function r:getVoice() return self.voice end
    function r:setVoice(v) for k,x in pairs(v) do self.voice[k]=x end end
    function r:getOnset() if #self.group.notes==0 then return self.timeOffset end return self.group.notes[1]:getOnset()+self.timeOffset end
    function r:getEnd() if #self.group.notes==0 then return self.timeOffset end return self.group.notes[#self.group.notes]:getEnd()+self.timeOffset end
    function r:getDuration() return self:getEnd()-self:getOnset() end
    function r:getParent() return self.parent end
    function r:getIndexInParent() return indexOf(self.parent.refs,self) end
    function r:setTimeRange(onset,duration) self.timeOffset=onset; self.rangeDuration=duration end
    function r:clone()
        local copy=makeReference(self.group,self.main)
        copy.timeOffset=self.timeOffset
        copy.pitchOffset=self.pitchOffset
        copy.muted=self.muted
        copy.rangeDuration=self.rangeDuration
        copy.voice={}
        for key,value in pairs(self.voice) do copy.voice[key]=value end
        return copy
    end
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
    local t={name="Track",color="#808080",refs={ref},mixer=makeMixer(),bounced=false}
    ref.parent=t
    function t:getName() return self.name end
    function t:setName(v) self.name=v end
    function t:getDisplayColor() return self.color end
    function t:setDisplayColor(v) self.color=v end
    function t:getDisplayOrder() return self:getIndexInParent() end
    function t:getDuration() local x=0 for _,r in ipairs(self.refs) do if r:getEnd()>x then x=r:getEnd() end end return x end
    function t:getNumGroups() return #self.refs end
    function t:getGroupReference(i) return self.refs[i] end
    function t:addGroupReference(reference) reference.parent=self; self.refs[#self.refs+1]=reference; return #self.refs end
    function t:removeGroupReference(i) table.remove(self.refs,i) end
    function t:getMixer() return self.mixer end
    function t:isBounced() return self.bounced end
    function t:setBounced(v) self.bounced=v end
    function t:getIndexInParent() return indexOf(project.tracks,self) end
    function t:clone()
        local copy=makeTrack()
        copy.name=self.name
        copy.color=self.color
        copy.bounced=self.bounced
        copy.mixer.gain=self.mixer.gain
        copy.mixer.pan=self.mixer.pan
        copy.mixer.muted=self.mixer.muted
        copy.mixer.solo=self.mixer.solo
        copy.refs={}
        local groupCopies={}
        for _,sourceRef in ipairs(self.refs) do
            local groupCopy=groupCopies[sourceRef.group]
            if not groupCopy then
                groupCopy=sourceRef.group:clone()
                groupCopies[sourceRef.group]=groupCopy
            end
            local refCopy=sourceRef:clone()
            refCopy.group=groupCopy
            refCopy.parent=copy
            copy.refs[#copy.refs+1]=refCopy
        end
        return copy
    end
    return t
end

local function makeTimeAxis()
    local axis={tempo={[0]=120},measures={[0]={numerator=4,denominator=4}}}
    local function sortedKeys(values)
        local keys={}
        for key,_ in pairs(values) do keys[#keys+1]=key end
        table.sort(keys)
        return keys
    end
    function axis:getSecondsFromBlick(b)
        local keys=sortedKeys(self.tempo)
        local seconds=0
        for index,position in ipairs(keys) do
            local nextPosition=keys[index+1]
            local segmentEnd=nextPosition and math.min(b,nextPosition) or b
            if segmentEnd>position then
                seconds=seconds+(segmentEnd-position)/705600000*60/self.tempo[position]
            end
            if not nextPosition or b<=nextPosition then break end
        end
        return seconds
    end
    function axis:getBlickFromSeconds(seconds)
        local keys=sortedKeys(self.tempo)
        local remaining=seconds
        for index,position in ipairs(keys) do
            local nextPosition=keys[index+1]
            if not nextPosition then
                return position+remaining*self.tempo[position]/60*705600000
            end
            local segmentSeconds=(nextPosition-position)/705600000*60/self.tempo[position]
            if remaining<=segmentSeconds then
                return position+remaining*self.tempo[position]/60*705600000
            end
            remaining=remaining-segmentSeconds
        end
        return 0
    end
    function axis:getTempoMarkAt(b)
        local effective=0
        for _,position in ipairs(sortedKeys(self.tempo)) do
            if position<=b then effective=position else break end
        end
        return {position=effective,positionSeconds=self:getSecondsFromBlick(effective),bpm=self.tempo[effective]}
    end
    function axis:getAllTempoMarks()
        local result={}
        for _,position in ipairs(sortedKeys(self.tempo)) do result[#result+1]=self:getTempoMarkAt(position) end
        return result
    end
    function axis:addTempoMark(position,bpm) self.tempo[position]=bpm end
    function axis:removeTempoMark(position) if position==0 then return false end local had=self.tempo[position]~=nil; self.tempo[position]=nil; return had end
    function axis:getMeasureMarkAt(measure)
        local effective=0
        for _,position in ipairs(sortedKeys(self.measures)) do
            if position<=measure then effective=position else break end
        end
        local mark=self.measures[effective]
        return {position=effective,positionBlick=effective*4*705600000,numerator=mark.numerator,denominator=mark.denominator}
    end
    function axis:getMeasureAt(b) return math.floor(b/(4*705600000)) end
    function axis:getMeasureMarkAtBlick(b)
        local result=self:getMeasureMarkAt(self:getMeasureAt(b))
        result.measure=result.position
        return result
    end
    function axis:getAllMeasureMarks()
        local result={}
        for _,position in ipairs(sortedKeys(self.measures)) do result[#result+1]=self:getMeasureMarkAt(position) end
        return result
    end
    function axis:addMeasureMark(measure,numerator,denominator) self.measures[measure]={numerator=numerator,denominator=denominator} end
    function axis:removeMeasureMark(measure) if measure==0 then return false end local had=self.measures[measure]~=nil; self.measures[measure]=nil; return had end
    function axis:clone()
        local copy=makeTimeAxis()
        copy.tempo={}
        copy.measures={}
        for position,bpm in pairs(self.tempo) do copy.tempo[position]=bpm end
        for measure,mark in pairs(self.measures) do copy.measures[measure]={numerator=mark.numerator,denominator=mark.denominator} end
        return copy
    end
    return axis
end
local timeAxis=makeTimeAxis()

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
function project:removeTrack(i) table.remove(self.tracks,i) end
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
function SV:getComputedAttributesForGroup(reference)
    local result={}
    for _,note in ipairs(reference.group.notes) do
        result[#result+1]={accent=note.rapAccent,phonemes={{symbol=note.phonemes~="" and note.phonemes or "l a",language=note.languageOverride~="" and note.languageOverride or "english"}}}
    end
    return result
end
function SV:getComputedPitchForGroup(reference,start,interval,frames)
    local result={}
    for index=1,frames do result[index]=reference.group.notes[1] and reference.group.notes[1].pitch or 60 end
    return result
end
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

local function callWrite(action,payload)
    local undoBefore=project.undo
    local response=call(action,payload)
    assert(project.undo==undoBefore+1,action.." must create exactly one undo record")
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
local initialTimeAxis=call("get_time_axis","{}")
assert(initialTimeAxis:find('"tempoMarkCount":1',1,true),"expected initial tempo map")
call("convert_time",'{"quarters":2}')
local undoBeforeStaleTimeAxis=project.undo
callExpectError("set_time_axis",'{"expectedFingerprint":"stale","tempoMarks":[{"position":0,"bpm":100}]}',"STALE_TIME_AXIS")
assert(project.undo==undoBeforeStaleTimeAxis,"stale time-axis edit must not create an undo record")
callWrite("set_time_axis",'{"tempoMarks":[{"position":2822400000,"bpm":90}],"measureMarks":[{"measure":2,"numerator":3,"denominator":4}]}')

call("list_tracks","{}")
local addedTrack=callWrite("add_track",'{"name":"Lead Copy Source","displayColor":"#ABCDEF"}')
assert(addedTrack:find('"mainGroup"',1,true),"add_track must return the main group locator")
assert(addedTrack:find('"groupUuid"',1,true),"add_track must return the main group UUID")
local track2GroupUuid=project.tracks[2].refs[1].group.uuid
local advancedAdded=callWrite("add_notes",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","notes":[{"onset":0,"duration":705600000,"pitch":60,"lyrics":"hello","languageOverride":"english","musicalType":"rap","pitchAutoMode":false,"rapAccent":"2"}]}')
assert(advancedAdded:find('"languageOverride":"english"',1,true),"advanced language field was not serialized")
assert(advancedAdded:find('"musicalType":"rap"',1,true),"advanced musical type was not serialized")
assert(advancedAdded:find('"pitchAutoMode":false',1,true),"advanced pitch mode was not serialized")
local track2Fingerprint="main-group:"..track2GroupUuid
callWrite("update_track",'{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Lead Source","bounced":true}')
callWrite("update_group",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","name":"Lead Main","voice":{"paramLoudness":-2}}')
call("get_computed_group_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","pitchSample":{"absoluteStart":0,"interval":352800000,"frames":4}}')
callWrite("clone_track",'{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Harmony -3st","transposeSemitones":-3}')
assert(project.tracks[3].refs[1].group.notes[1].pitch==57,"clone_track must transpose cloned notes")
assert(project.tracks[3].refs[1].voice.paramLoudness==-2,"clone_track must inherit voice properties")
local undoBeforeStaleTrack=project.undo
callExpectError("update_track",'{"trackIndex":2,"trackFingerprint":"stale","name":"wrong"}',"STALE_TRACK")
assert(project.undo==undoBeforeStaleTrack,"stale track edit must not create an undo record")
local track3Fingerprint="main-group:"..project.tracks[3].refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":3,"trackFingerprint":"'..track3Fingerprint..'"}')
assert(#project.tracks==2,"delete_track must remove the target track")

local extraGroup=makeGroup()
local extraReference=makeReference(extraGroup,false)
project.tracks[1]:addGroupReference(extraReference)
callWrite("delete_group_reference",'{"trackIndex":1,"groupIndex":2,"groupUuid":"'..extraGroup.uuid..'"}')
assert(project.tracks[1]:getNumGroups()==1,"delete_group_reference must remove the non-main reference")
call("get_selection","{}")

local added=callWrite("add_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"onset":0,"duration":705600000,"pitch":60,"lyrics":"la"},{"onset":705600000,"duration":705600000,"pitch":64,"lyrics":"你"}]}')
local fingerprint=assert(added:match('"fingerprint":"([^"]+)"'))
call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
callWrite("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprint)..'","changes":{"onset":0,"pitch":62,"lyrics":"re","languageOverride":"japanese","pitchAutoMode":false}}]}')
local undoAfterEdit=project.undo
callExpectError("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprint)..'","changes":{"pitch":63}}]}',"STALE_NOTE")
assert(project.undo==undoAfterEdit,"stale edit must not create an undo record")
local notesAfter=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local fingerprints={}
for value in notesAfter:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then fingerprints[#fingerprints+1]=value end
end
assert(#fingerprints==2,"expected two note fingerprints")
local newFingerprint=fingerprints[1]
local undoBeforeInvalidBatch=project.undo
local pitchBeforeInvalidBatch=project.tracks[1].refs[1].group.notes[1].pitch
callExpectError("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprints[1])..'","changes":{"pitch":63}},{"noteIndex":2,"fingerprint":"'..escape(fingerprints[2])..'","changes":{"unsupported":true}}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeInvalidBatch,"invalid batch must not create an undo record")
assert(project.tracks[1].refs[1].group.notes[1].pitch==pitchBeforeInvalidBatch,"invalid batch must not partially mutate notes")
call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}')
local undoBeforeStaleAutomation=project.undo
callExpectError("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","expectedFingerprint":"stale","points":[{"position":0,"value":-3}]}',"STALE_AUTOMATION")
assert(project.undo==undoBeforeStaleAutomation,"stale automation edit must not create an undo record")
callWrite("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":0}]}')
callWrite("clear_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}')
local track1Fingerprint="main-group:"..project.tracks[1].refs[1].group.uuid
callWrite("set_track_mixer",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-3,"pan":0.25,"muted":false,"solo":true}')
call("get_track_mixer",'{"trackIndex":1}')
call("playback",'{"operation":"seek","timeSeconds":1.5}')
call("playback",'{"operation":"loop","timeSeconds":1,"endSeconds":2}')
callWrite("delete_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(newFingerprint)..'"}]}')
assert(project.undo==14,"expected 14 undo records, got "..project.undo)
print("Mock SynthV smoke test passed")
