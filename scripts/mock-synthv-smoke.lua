-- Local smoke harness for the bridge and CI integration tests.
local ipc = assert(os.getenv("SYNTHV_AGENT_BRIDGE_DIR"))
local prefix = ipc .. "/synthv-agent-bridge"
local requestFile = prefix .. ".request.json"
local responseFile = prefix .. ".response.json"
local installFile = prefix .. ".install.json"

do
    local scriptFile = assert(os.getenv("BRIDGE_SCRIPT")):gsub("\\","\\\\"):gsub('"','\\"')
    local file = assert(io.open(installFile, "wb"))
    file:write('{"protocolVersion":1,"scriptFile":"'..scriptFile..'"}')
    file:close()
end

local function arrayCopy(t)
    local r = {}
    for i = 1, #t do r[i] = t[i] end
    return r
end

local function deepCopy(value, seen)
    if type(value)~="table" then return value end
    seen=seen or {}
    if seen[value] then return seen[value] end
    local result={}
    seen[value]=result
    for key,child in pairs(value) do result[deepCopy(key,seen)]=deepCopy(child,seen) end
    return result
end

local function indexOf(t, object)
    for i = 1, #t do if t[i] == object then return i end end
end

local notePitchAutoWriteSupported = true
local phonemeStrengthWriteSupported = true

-- SynthV may return distinct Lua proxy values for the same native object.
-- Delegate every member while intentionally preserving distinct identity.
local function unwrapProxy(target)
    while type(target)=="table" and rawget(target,"__target") do
        target=rawget(target,"__target")
    end
    return target
end

local function proxyObject(target)
    target=unwrapProxy(target)
    return setmetatable({__target=target}, {
        __index=function(_,key)
            local value=target[key]
            if type(value)=="function" then
                return function(_,...)
                    return value(target,...)
                end
            end
            return value
        end
    })
end

local function attachScriptData(object)
    object.scriptData = object.scriptData or {}
    function object:getScriptData(key) return self.scriptData[key] end
    function object:getScriptDataKeys()
        local keys={}
        for key,_ in pairs(self.scriptData) do keys[#keys+1]=key end
        table.sort(keys)
        return keys
    end
    function object:hasScriptData(key) return self.scriptData[key]~=nil end
    function object:setScriptData(key,value) self.scriptData[key]=value end
    function object:removeScriptData(key) self.scriptData[key]=nil end
    function object:clearScriptData() self.scriptData={} end
    return object
end

local function makeRetakes()
    local r=attachScriptData({takes={[0]=true},nextId=1,active=0})
    function r:getNumTakes()
        local count=0
        for _,_ in pairs(self.takes) do count=count+1 end
        return count
    end
    function r:generateTake(_,_,_)
        local id=self.nextId
        self.nextId=self.nextId+1
        self.takes[id]=true
        return id
    end
    function r:setActiveTake(id) assert(self.takes[id],"unknown retake"); self.active=id end
    function r:deleteTake(id) assert(id~=0 and self.takes[id],"unknown retake"); self.takes[id]=nil end
    function r:clone()
        local copy=makeRetakes()
        copy.takes={}
        for id,value in pairs(self.takes) do copy.takes[id]=value end
        copy.nextId=self.nextId
        copy.active=self.active
        for key,value in pairs(self.scriptData) do copy.scriptData[key]=value end
        return copy
    end
    return r
end

local function makePitchControl(kind)
    local c=attachScriptData({kind=kind,position=0,pitch=0,points={}})
    function c:getPosition() return self.position end
    function c:setPosition(v) self.position=v end
    function c:getPitch() return self.pitch end
    function c:setPitch(v) self.pitch=v end
    if kind=="curve" then
        function c:getPoints()
            local points={}
            for i,point in ipairs(self.points) do points[i]={point[1],point[2]} end
            return points
        end
        function c:setPoints(points)
            self.points={}
            for i,point in ipairs(points) do self.points[i]={point[1],point[2]} end
        end
        function c:getValueAt(position) return self.pitch end
    end
    function c:getIndexInParent() return indexOf(self.parent.pitchControls,self) end
    function c:clone()
        local copy=makePitchControl(self.kind)
        copy.position=self.position
        copy.pitch=self.pitch
        if self.kind=="curve" then copy:setPoints(self.points) end
        return copy
    end
    return c
end

local function makeNote()
    local n = attachScriptData({
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
        rapAccent = "",
        retakes = makeRetakes()
    })
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
    function n:getAttributes() return deepCopy(self.attrs) end
    function n:setAttributes(v)
        for k,x in pairs(v) do self.attrs[k]=deepCopy(x) end
        if not phonemeStrengthWriteSupported
            and type(self.attrs.phonemes) == "table" then
            for _, phoneme in ipairs(self.attrs.phonemes) do
                if type(phoneme) == "table"
                    and type(phoneme.strength) == "number" then
                    phoneme.strength = 1
                end
            end
        end
    end
    function n:getLanguageOverride() return self.languageOverride end
    function n:setLanguageOverride(v) self.languageOverride=v end
    function n:getMusicalType() return self.musicalType end
    function n:setMusicalType(v) self.musicalType=v end
    function n:getPitchAutoMode() return self.pitchAutoMode end
    if notePitchAutoWriteSupported then
        function n:setPitchAutoMode(v) self.pitchAutoMode=v end
    end
    function n:getRapAccent() return self.rapAccent end
    function n:setRapAccent(v) self.rapAccent=v end
    function n:getRetakes() return self.retakes end
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
        copy.retakes = self.retakes:clone()
        copy.attrs = deepCopy(self.attrs)
        return copy
    end
    return n
end

local function makeAutomation(name)
    local a = attachScriptData({ name=name, points={} })
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
    function a:getPoints(beginPos,endPos)
        local all=self:getAllPoints()
        local result={}
        for _,point in ipairs(all) do
            if point[1]>=beginPos and point[1]<=endPos then result[#result+1]=point end
        end
        return result
    end
    function a:get(b)
        local all=self:getAllPoints()
        if #all==0 then return self:getDefinition().defaultValue end
        if b<=all[1][1] then return all[1][2] end
        if b>=all[#all][1] then return all[#all][2] end
        for i=1,#all-1 do
            local left,right=all[i],all[i+1]
            if b>=left[1] and b<=right[1] then
                local ratio=(b-left[1])/(right[1]-left[1])
                return left[2]+(right[2]-left[2])*ratio
            end
        end
    end
    function a:getLinear(b) return self:get(b) end
    function a:add(b,v) local fresh=self.points[b]==nil; self.points[b]=v; return fresh end
    function a:removeAll() self.points={} end
    function a:remove(beginPos,endPos)
        local changed=false
        for b,_ in pairs(self.points) do if b>=beginPos and b<=endPos then self.points[b]=nil; changed=true end end
        return changed
    end
    function a:simplify(beginPos,endPos,_)
        local all=self:getPoints(beginPos,endPos)
        local changed=false
        for i=2,#all-1 do self.points[all[i][1]]=nil; changed=true end
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
local groupGetNoteCalls=0
local function makeGroup()
    local g=attachScriptData({ notes={}, pitchControls={}, params={}, uuid="00000000-0000-4000-8000-"..string.format("%012d",nextUuid), name="Main" })
    nextUuid=nextUuid+1
    function g:getUUID() return self.uuid end
    function g:getIndexInParent() return self.parent and indexOf(self.parent.groups,self) or nil end
    function g:getParent() return self.parent end
    function g:getName() return self.name end
    function g:setName(v) self.name=v end
    function g:getNumNotes() return #self.notes end
    function g:getNote(i)
        groupGetNoteCalls=groupGetNoteCalls+1
        return self.notes[i]
    end
    function g:addNote(n)
        n.parent=self; self.notes[#self.notes+1]=n
        table.sort(self.notes,function(x,y)return x.onset<y.onset end)
        return indexOf(self.notes,n)
    end
    function g:removeNote(i) table.remove(self.notes,i) end
    function g:getNumPitchControls() return #self.pitchControls end
    function g:getPitchControl(i) return self.pitchControls[i] end
    function g:addPitchControl(control)
        control.parent=self
        self.pitchControls[#self.pitchControls+1]=control
        table.sort(self.pitchControls,function(x,y)return x.position<y.position end)
        return indexOf(self.pitchControls,control)
    end
    function g:removePitchControl(i) table.remove(self.pitchControls,i) end
    function g:getParameter(name) self.params[name]=self.params[name] or makeAutomation(name); return self.params[name] end
    function g:clone()
        local copy=makeGroup()
        copy.name=self.name
        for _,note in ipairs(self.notes) do copy:addNote(note:clone()) end
        for _,control in ipairs(self.pitchControls) do copy:addPitchControl(control:clone()) end
        for name,automation in pairs(self.params) do copy.params[name]=automation:clone() end
        return copy
    end
    return g
end

local function makeReference(group, main)
    local r=attachScriptData({
        group=group,
        main=main,
        instrumental=false,
        timeOffset=0,
        pitchOffset=0,
        muted=false,
        supportedVocalModes={
            Airy=true,
            Bright=true,
            Cool=true,
            Dark=true,
            Emotional=true,
            Power=true,
            Powerful=true,
            Soft=true,
            Solid=true,
            Sweet=true
        },
        voice={
            paramLoudness=0,
            paramTension=0,
            paramBreathiness=0,
            paramGender=0,
            paramToneShift=0,
            singers=1,
            spacing=0.7,
            vocalModeParams={
                Soft={pitch=0,timbre=0,pronunciation=0},
                Powerful={pitch=0,timbre=0,pronunciation=0}
            }
        }
    })
    function r:isInstrumental() return self.instrumental end
    function r:isMain() return self.main end
    function r:isMuted() return self.muted end
    function r:setMuted(v) self.muted=v end
    function r:getTimeOffset() return self.timeOffset end
    function r:setTimeOffset(v) self.timeOffset=v end
    function r:getPitchOffset() return self.pitchOffset end
    function r:setPitchOffset(v) self.pitchOffset=v end
    function r:getTarget() return proxyObject(self.group) end
    function r:setTarget(v) assert(self.group==nil,"target already set"); self.group=unwrapProxy(v) end
    function r:getVoice() return deepCopy(self.voice) end
    function r:setVoice(v)
        local ranges={
            paramLoudness={-48,12},
            paramTension={-1,1},
            paramBreathiness={-1,1},
            paramGender={-1,1},
            paramToneShift={-1,1}
        }
        for key,value in pairs(v) do
            if ranges[key] then
                assert(type(value)=="number" and value>=ranges[key][1] and value<=ranges[key][2],"invalid voice parameter")
            elseif key=="singers" then
                assert(type(value)=="number" and value%1==0 and value>=1 and value<=8,"invalid singers")
            elseif key=="spacing" then
                assert(type(value)=="number" and value>=0 and value<=1,"invalid spacing")
            elseif key=="vocalModeParams" then
                for name,mode in pairs(value) do
                    assert(self.supportedVocalModes[name],"unknown vocal mode")
                    for axis,axisValue in pairs(mode) do
                        assert(
                            axis=="pitch" or axis=="timbre" or axis=="pronunciation",
                            "unknown vocal mode axis"
                        )
                        assert(type(axisValue)=="number" and axisValue>=0,"invalid vocal mode")
                    end
                end
            end
        end
        for key,value in pairs(v) do
            if key=="vocalModeParams" then
                for _name,existingMode in pairs(self.voice.vocalModeParams) do
                    for _,axis in ipairs({"pitch","timbre","pronunciation"}) do
                        existingMode[axis]=math.min(existingMode[axis],150)
                    end
                end
                for name,mode in pairs(value) do
                    self.voice.vocalModeParams[name]=
                        self.voice.vocalModeParams[name] or
                        {pitch=0,timbre=0,pronunciation=0}
                    for axis,axisValue in pairs(mode) do
                        self.voice.vocalModeParams[name][axis]=math.min(axisValue,150)
                    end
                end
            else
                self.voice[key]=deepCopy(value)
            end
        end
    end
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
        copy.instrumental=self.instrumental
        copy.supportedVocalModes=deepCopy(self.supportedVocalModes)
        copy.voice=deepCopy(self.voice)
        return copy
    end
    return r
end

local function makeMixer()
    local m=attachScriptData({gain=0,pan=0,muted=false,solo=false})
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
    local t=attachScriptData({name="Track",color="ff808080",refs={ref},mixer=makeMixer(),bounced=false})
    ref.parent=t
    function t:getName() return self.name end
    function t:setName(v) self.name=v end
    function t:getDisplayColor() return self.color end
    function t:setDisplayColor(v)
        assert(type(v)=="string" and v:match("^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$"),"track color must be AARRGGBB")
        self.color=v:lower()
    end
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

local secondsFromBlickCalls=0
local blickFromSecondsCalls=0
local function makeTimeAxis()
    local axis=attachScriptData({tempo={[0]=120},measures={[0]={numerator=4,denominator=4}}})
    local function sortedKeys(values)
        local keys={}
        for key,_ in pairs(values) do keys[#keys+1]=key end
        table.sort(keys)
        return keys
    end
    function axis:getSecondsFromBlick(b)
        secondsFromBlickCalls=secondsFromBlickCalls+1
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
        blickFromSecondsCalls=blickFromSecondsCalls+1
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
    function axis:addTempoMark(position,bpm)
        if self.tempo[position]==nil then self.tempo[position]=bpm end
    end
    function axis:removeTempoMark(position) local had=self.tempo[position]~=nil; self.tempo[position]=nil; return had end
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
    function axis:addMeasureMark(measure,numerator,denominator)
        if self.measures[measure]==nil then self.measures[measure]={numerator=numerator,denominator=denominator} end
    end
    function axis:removeMeasureMark(measure) local had=self.measures[measure]~=nil; self.measures[measure]=nil; return had end
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

project=attachScriptData({tracks={},groups={},undo=0})
function project:getFileName() return "mock.svp" end
function project:getDuration() local x=0 for _,t in ipairs(self.tracks) do if t:getDuration()>x then x=t:getDuration() end end return x end
function project:getNumTracks() return #self.tracks end
function project:getTrack(i) return self.tracks[i] end
function project:addTrack(t) self.tracks[#self.tracks+1]=t; return #self.tracks end
function project:removeTrack(i) table.remove(self.tracks,i) end
function project:getNumNoteGroupsInLibrary() return #self.groups end
function project:getNoteGroup(id)
    if type(id)=="number" then return self.groups[id] end
    for _,group in ipairs(self.groups) do if group.uuid==id then return group end end
end
function project:addNoteGroup(group,suggestedIndex)
    local index=suggestedIndex or (#self.groups+1)
    table.insert(self.groups,index,group)
    group.parent=self
    return index
end
function project:removeNoteGroup(index)
    local target=self.groups[index]
    for _,track in ipairs(self.tracks) do
        for groupIndex=#track.refs,2,-1 do
            if track.refs[groupIndex].group==target then table.remove(track.refs,groupIndex) end
        end
    end
    table.remove(self.groups,index)
end
function project:getTimeAxis() return timeAxis end
function project:newUndoRecord() self.undo=self.undo+1 end
project:addTrack(makeTrack())

local function removeObject(values,target)
    for index=#values,1,-1 do if values[index]==target then table.remove(values,index) end end
end
local function addUnique(values,target)
    if not indexOf(values,target) then values[#values+1]=target end
end

local selection={selectedNotes={},selectedGroups={},selectedPitchControls={},selectedPoints={}}
function selection:getSelectedNotes() return arrayCopy(self.selectedNotes) end
function selection:getSelectedGroups() return arrayCopy(self.selectedGroups) end
function selection:getSelectedPitchControls() return arrayCopy(self.selectedPitchControls) end
function selection:getSelectedPoints(parameter) return arrayCopy(self.selectedPoints[parameter] or {}) end
function selection:selectGroup(v) addUnique(self.selectedGroups,v); return true end
function selection:unselectGroup(v) removeObject(self.selectedGroups,v); return true end
function selection:selectNote(v) addUnique(self.selectedNotes,v); return true end
function selection:unselectNote(v) removeObject(self.selectedNotes,v); return true end
function selection:selectPitchControls(values) for _,v in ipairs(values) do addUnique(self.selectedPitchControls,v) end end
function selection:unselectPitchControls(values) for _,v in ipairs(values) do removeObject(self.selectedPitchControls,v) end end
function selection:selectPoints(parameter,values)
    self.selectedPoints[parameter]=self.selectedPoints[parameter] or {}
    for _,v in ipairs(values) do addUnique(self.selectedPoints[parameter],v) end
end
function selection:unselectPoints(parameter,values)
    self.selectedPoints[parameter]=self.selectedPoints[parameter] or {}
    for _,v in ipairs(values) do removeObject(self.selectedPoints[parameter],v) end
end
function selection:clearGroups() self.selectedGroups={}; return true end
function selection:clearNotes() self.selectedNotes={}; return true end
function selection:clearPitchControls() self.selectedPitchControls={}; return true end
function selection:clearAll()
    self.selectedGroups={}; self.selectedNotes={}; self.selectedPitchControls={}; self.selectedPoints={}
    return true
end
function selection:hasUnfinishedEdits() return false end

local function makeNavigation()
    local n={left=0,right=2822400000,valueMin=0,valueMax=127,timeScale=0.000001,valueScale=4}
    function n:getTimeViewRange() return {self.left,self.right} end
    function n:getValueViewRange() return {self.valueMin,self.valueMax} end
    function n:getTimePxPerUnit() return self.timeScale end
    function n:getValuePxPerUnit() return self.valueScale end
    function n:setTimeLeft(v) local width=self.right-self.left; self.left=v; self.right=v+width end
    function n:setTimeRight(v) self.right=v end
    function n:setTimeScale(v) self.timeScale=v end
    function n:setValueCenter(v)
        local half=(self.valueMax-self.valueMin)/2
        self.valueMin=v-half; self.valueMax=v+half
    end
    function n:snap(v) return math.floor(v/352800000+0.5)*352800000 end
    function n:t2x(v) return (v-self.left)*self.timeScale end
    function n:x2t(v) return self.left+v/self.timeScale end
    function n:v2y(v) return (self.valueMax-v)*self.valueScale end
    function n:y2v(v) return self.valueMax-v/self.valueScale end
    return n
end

local mainEditor={}
local mainNavigation=makeNavigation()
function mainEditor:getCurrentTrack() return project.tracks[1] end
function mainEditor:getCurrentGroup() return proxyObject(project.tracks[1].refs[1]) end
function mainEditor:getSelection() return selection end
function mainEditor:getNavigation() return mainNavigation end
local arrangementSelection={selectedGroups={}}
function arrangementSelection:getSelectedGroups() return arrayCopy(self.selectedGroups) end
function arrangementSelection:selectGroup(v) addUnique(self.selectedGroups,v); return true end
function arrangementSelection:unselectGroup(v) removeObject(self.selectedGroups,v); return true end
function arrangementSelection:clearGroups() self.selectedGroups={}; return true end
function arrangementSelection:clearAll() return self:clearGroups() end
function arrangementSelection:hasUnfinishedEdits() return false end
local arrangement={}
local arrangementNavigation=makeNavigation()
function arrangement:getSelection() return arrangementSelection end
function arrangement:getNavigation() return arrangementNavigation end

scheduled=nil
SV={QUARTER=705600000}
local clipboard=""
local computedPhonemeCalls=0
local computedPitchCalls=0
function SV:getHostInfo() return {osType="Linux",hostName="Mock SynthV",hostVersion="2.2.0",hostVersionNumber=131584,languageCode="en-us"} end
function SV:getProject() return project end
function SV:getPlayback() return playback end
function SV:getMainEditor() return mainEditor end
function SV:getArrangement() return arrangement end
function SV:getPhonemesForGroup(reference)
    computedPhonemeCalls=computedPhonemeCalls+1
    local result={}
    for _,note in ipairs(reference.group.notes) do
        result[#result+1]=note.phonemes~="" and note.phonemes or "l a"
    end
    return result
end
function SV:getComputedAttributesForGroup(reference)
    local result={}
    for _,note in ipairs(reference.group.notes) do
        result[#result+1]={accent=note.rapAccent,phonemes={{symbol=note.phonemes~="" and note.phonemes or "l a",language=note.languageOverride~="" and note.languageOverride or "english"}}}
    end
    return result
end
function SV:getComputedPitchForGroup(reference,start,interval,frames)
    computedPitchCalls=computedPitchCalls+1
    local result={}
    for index=1,frames do result[index]=reference.group.notes[1] and reference.group.notes[1].pitch or 60 end
    return result
end
function SV:create(kind)
    if kind=="Note" then return makeNote()
    elseif kind=="Track" then return makeTrack()
    elseif kind=="NoteGroup" then return makeGroup()
    elseif kind=="NoteGroupReference" then return makeReference(nil,false)
    elseif kind=="PitchControlPoint" then return makePitchControl("point")
    elseif kind=="PitchControlCurve" then return makePitchControl("curve")
    else error("unsupported create "..kind) end
end
function SV:blick2Quarter(b) return b/self.QUARTER end
function SV:blickRoundDiv(dividend,divisor) return math.floor(dividend/divisor+0.5) end
function SV:blickRoundTo(b,interval) return self:blickRoundDiv(b,interval)*interval end
-- Intentionally omit the documented pitch2freq method to reproduce the
-- SynthV 2.2.1 Windows Lua host and exercise the bridge fallback.
function SV:freq2Pitch(f) return 69+12*math.log(f/440,2) end
function SV:blackKey(p)
    local value=p%12
    return value==1 or value==3 or value==6 or value==8 or value==10
end
function SV:getHostClipboard() return clipboard end
function SV:setHostClipboard(value) clipboard=value end
function SV:setTimeout(_,callback) scheduled=callback end
function SV:finish() scheduled=nil end
function SV:print(_) end
function SV:showMessageBox(_,_) end
function SV:showInputBox(_,_,defaultText) return defaultText end
function SV:showOkCancelBox(_,_) return true end
function SV:showYesNoCancelBox(_,_) return "yes" end
function SV:showCustomDialog(form) return form end

dofile(assert(os.getenv("BRIDGE_SCRIPT")))
main()

local seq=0
local function escape(s) return s:gsub('\\','\\\\'):gsub('"','\\"') end
local function extractJsonString(text,key)
    local marker='"'..key..'":"'
    local start=assert(text:find(marker,1,true),"missing JSON string field "..key)+#marker
    local result={}
    local index=start
    while index<=#text do
        local character=text:sub(index,index)
        if character=='"' then return table.concat(result) end
        if character=='\\' then
            index=index+1
            local escaped=text:sub(index,index)
            local replacements={['"']='"',['\\']='\\',['/']='/',b='\b',f='\f',n='\n',r='\r',t='\t'}
            result[#result+1]=replacements[escaped] or escaped
        else
            result[#result+1]=character
        end
        index=index+1
    end
    error("unterminated JSON string field "..key)
end
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

local pingResponse=call("ping","{}")
assert(pingResponse:find('"bridgeVersion":"0.1.5"',1,true),"expected Bridge version 0.1.5")
local initialSessionToken=extractJsonString(pingResponse,"sessionToken")
local reloadResponse=call("reload_bridge","{}")
assert(reloadResponse:find('"reloading":true',1,true),"hot reload was not acknowledged")
local reloadedPingResponse=call("ping","{}")
local reloadedSessionToken=extractJsonString(reloadedPingResponse,"sessionToken")
assert(reloadedSessionToken~=initialSessionToken,"hot reload did not start a new Bridge session")
local currentGroupVoice=call("get_group_voice",'{"trackIndex":1,"groupIndex":1}')
assert(currentGroupVoice:find('"currentEditorGroup":true',1,true),"current Group selection context was not returned")
local currentGroupVoiceFingerprint=extractJsonString(currentGroupVoice,"referenceFingerprint")
callWrite("set_group_voice",'{"trackIndex":1,"groupIndex":1,"referenceFingerprint":"'..escape(currentGroupVoiceFingerprint)..'","requireCurrentEditorGroup":true,"vocalModes":[{"name":"Soft","pitch":0}]}')
call("get_project_info","{}")
local initialTimeAxis=call("get_time_axis","{}")
assert(initialTimeAxis:find('"tempoMarkCount":1',1,true),"expected initial tempo map")
local roundedTime=call("convert_time",'{"blicks":1080000000,"roundInterval":705600000}')
assert(roundedTime:find('"roundedBlicks":1411200000',1,true),"official blick rounding was not applied")
local undoBeforeStaleTimeAxis=project.undo
callExpectError("set_time_axis",'{"expectedFingerprint":"stale","tempoMarks":[{"position":0,"bpm":100}]}',"STALE_TIME_AXIS")
assert(project.undo==undoBeforeStaleTimeAxis,"stale time-axis edit must not create an undo record")
local updatedTimeAxis=callWrite("set_time_axis",'{"tempoMarks":[{"position":0,"bpm":96},{"position":2822400000,"bpm":90}],"measureMarks":[{"measure":0,"numerator":4,"denominator":4},{"measure":2,"numerator":3,"denominator":4}]}')
assert(updatedTimeAxis:find('"bpm":96',1,true),"position-zero tempo replacement was not retained")
assert(updatedTimeAxis:find('"verified":true',1,true),"time-axis response was not postcondition-verified")

call("list_tracks","{}")
local addedTrack=callWrite("add_track",'{"name":"Lead Copy Source","displayColor":"#ABCDEF"}')
assert(addedTrack:find('"mainGroup"',1,true),"add_track must return the main group locator")
assert(addedTrack:find('"groupUuid"',1,true),"add_track must return the main group UUID")
assert(addedTrack:find('"displayColorArgb":"ffabcdef"',1,true),"track color was not normalized to AARRGGBB")
assert(project.tracks[2].color=="ffabcdef","host track color did not receive AARRGGBB")
local track2GroupUuid=project.tracks[2].refs[1].group.uuid
local advancedAdded=callWrite("add_notes",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","notes":[{"onset":0,"duration":705600000,"pitch":60,"lyrics":"hello","languageOverride":"english","musicalType":"rap","pitchAutoMode":false,"rapAccent":"2"}]}')
assert(advancedAdded:find('"languageOverride":"english"',1,true),"advanced language field was not serialized")
assert(advancedAdded:find('"musicalType":"rap"',1,true),"advanced musical type was not serialized")
assert(advancedAdded:find('"pitchAutoMode":false',1,true),"advanced pitch mode was not serialized")
local advancedFingerprint=extractJsonString(advancedAdded,"fingerprint")
local phonemeRead=call("get_note_phoneme_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
assert(phonemeRead:find('"computedPhonemes":"l a"',1,true),"computed phonemes were not returned")
assert(phonemeRead:find('"currentEditorGroup":false',1,true),"unselected Group context was not returned")
local compactPhonemeRead=call("get_note_phoneme_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","responseMode":"compact","noteIndices":[1],"startSeconds":0,"endSeconds":10}')
assert(compactPhonemeRead:find('"responseMode":"compact"',1,true),"compact phoneme mode was not returned")
assert(compactPhonemeRead:find('"absoluteOnsetSeconds":',1,true),"compact phoneme timing was not returned")
assert(not compactPhonemeRead:find('"computedAttributes":',1,true),"compact phoneme read returned computed attributes by default")
assert(not compactPhonemeRead:find('"attributes":',1,true),"compact phoneme read returned raw attributes by default")
local undoBeforeUnselectedPhoneme=project.undo
callExpectError("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","requireSelectedNotes":true,"edits":[{"noteIndex":1,"fingerprint":"'..escape(advancedFingerprint)..'","changes":{"phonemeSequence":"hh eh l ow"}}]}',"SELECTION_MISMATCH")
assert(project.undo==undoBeforeUnselectedPhoneme,"selection-guarded phoneme edit must not create an undo record")
local phonemeUpdated=callWrite("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":1,"fingerprint":"'..escape(advancedFingerprint)..'","changes":{"phonemeSequence":"hh eh l ow","languageOverride":"english","phonesetOverride":"arpabet","evenSyllableDuration":true,"phonemeAttributes":[{"position":0.2,"strength":0.8},{"leftOffset":0.05,"activity":0.9}]}}]}')
assert(phonemeUpdated:find('"phonemes":"hh eh l ow"',1,true),"phoneme sequence was not updated")
assert(project.tracks[2].refs[1].group.notes[1].attrs.phonesetOverride=="arpabet","phoneset override was not applied")
assert(project.tracks[2].refs[1].group.notes[1].attrs.phonemes[1].strength==0.8,"phoneme strength was not applied")
local phonemeFingerprint=extractJsonString(phonemeUpdated,"fingerprint")
local compactPhonemeUpdated=callWrite("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","responseMode":"compact","edits":[{"noteIndex":1,"fingerprint":"'..escape(phonemeFingerprint)..'","changes":{"evenSyllableDuration":false}}]}')
assert(compactPhonemeUpdated:find('"responseMode":"compact"',1,true),"compact phoneme write mode was not returned")
assert(not compactPhonemeUpdated:find('"absoluteDurationSeconds":',1,true),"compact phoneme write returned a full note")
phonemeFingerprint=extractJsonString(compactPhonemeUpdated,"fingerprint")
local undoBeforeInvalidPhoneme=project.undo
callExpectError("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":1,"fingerprint":"'..escape(phonemeFingerprint)..'","changes":{"phonemeAttributes":[{"unsupported":1}]}}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeInvalidPhoneme,"invalid phoneme edit must not create an undo record")
phonemeStrengthWriteSupported=false
local unsupportedPhonemeVoice=call("get_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
assert(unsupportedPhonemeVoice:find('"strengthRetained":false',1,true),"phoneme capability probe did not report host clamping")
local undoBeforeUnsupportedPhoneme=project.undo
callExpectError("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":1,"fingerprint":"'..escape(phonemeFingerprint)..'","changes":{"phonemeAttributes":[{"strength":1.2},{"leftOffset":0.05,"activity":0.9}]}}]}',"HOST_POSTCONDITION_FAILED")
assert(project.undo==undoBeforeUnsupportedPhoneme,"unretained phoneme edit must fail before an undo record")
assert(project.tracks[2].refs[1].group.notes[1].attrs.phonemes[1].strength==0.8,"failed phoneme preflight changed the project note")
phonemeStrengthWriteSupported=true
notePitchAutoWriteSupported=false
local fallbackAdded=callWrite("add_notes",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","notes":[{"onset":705600000,"duration":705600000,"pitch":64,"lyrics":"fallback","pitchAutoMode":true}]}')
assert(fallbackAdded:find('"pitchAutoMode":true',1,true),"matching pitch mode should not require an unavailable setter")
local fallbackFingerprint=assert(fallbackAdded:match('"fingerprint":"([^"]+)"'))
local undoBeforeUnsupportedPitchMode=project.undo
callExpectError("edit_notes",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":2,"fingerprint":"'..escape(fallbackFingerprint)..'","changes":{"pitchAutoMode":false}}]}',"UNSUPPORTED_HOST_CAPABILITY")
assert(project.undo==undoBeforeUnsupportedPitchMode,"unsupported pitch mode edit must not create an undo record")
notePitchAutoWriteSupported=true

local getNoteCallsBeforeProjection=groupGetNoteCalls
local computedCallsBeforeProjection=computedPhonemeCalls
local projectedPhonemes=call(
    "get_note_phoneme_data",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","responseMode":"compact","noteIndices":[2,1,2],"offset":1,"limit":1,'..
        '"includeComputedPhonemes":false}'
)
assert(projectedPhonemes:find('"scanMode":"index_projection"',1,true),"note-index projection fast path was not reported")
assert(projectedPhonemes:find('"scannedNoteCount":1',1,true),"note-index projection scanned more than its returned page")
assert(projectedPhonemes:find('"matchedNoteCount":2',1,true),"note-index projection did not deduplicate indices")
assert(projectedPhonemes:find('"noteIndex":2',1,true),"note-index projection did not preserve group order and pagination")
assert(not projectedPhonemes:find('"computedPhonemes":',1,true),"computed phonemes were returned after being disabled")
assert(projectedPhonemes:find('"computedPhonemesIncluded":false',1,true),"computed phoneme omission was not reported")
assert(groupGetNoteCalls==getNoteCallsBeforeProjection+1,"note-index projection fetched notes outside its returned page")
assert(computedPhonemeCalls==computedCallsBeforeProjection,"disabled computed phonemes still called the host")

local getNoteCallsBeforeRange=groupGetNoteCalls
local blickCallsBeforeRange=blickFromSecondsCalls
local secondsCallsBeforeRange=secondsFromBlickCalls
local rangedPhonemes=call(
    "get_note_phoneme_data",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","responseMode":"compact","startSeconds":0,"endSeconds":0.1,'..
        '"includeComputedPhonemes":false}'
)
assert(rangedPhonemes:find('"scanMode":"time_range"',1,true),"time-range fast path was not reported")
assert(rangedPhonemes:find('"scannedNoteCount":2',1,true),"time-range fast path did not stop at the first later note")
assert(rangedPhonemes:find('"matchedNoteCount":1',1,true),"time-range fast path returned the wrong match count")
assert(groupGetNoteCalls==getNoteCallsBeforeRange+2,"time-range fast path fetched an unexpected number of notes")
assert(blickFromSecondsCalls==blickCallsBeforeRange+2,"time-range fast path did not convert boundaries once")
assert(secondsFromBlickCalls==secondsCallsBeforeRange+2,"time-range fast path converted timing for non-returned notes")

local overlappingSustain=call(
    "get_note_phoneme_data",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","responseMode":"compact","startSeconds":0.5,"endSeconds":0.55,'..
        '"rangeMatch":"overlap","includeComputedPhonemes":false}'
)
assert(overlappingSustain:find('"matchedNoteCount":1',1,true),"overlap coverage lost a crossing sustain")
assert(overlappingSustain:find('"coverage":"complete_overlap"',1,true),"overlap coverage was not reported")
local onsetOnlyRange=call(
    "get_note_phoneme_data",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","responseMode":"compact","startSeconds":0.5,"endSeconds":0.55,'..
        '"rangeMatch":"onset","includeComputedPhonemes":false}'
)
assert(onsetOnlyRange:find('"scanMode":"onset_binary"',1,true),"onset range did not use binary seek")
assert(onsetOnlyRange:find('"matchedNoteCount":0',1,true),"onset-only coverage included an earlier sustain")
assert(onsetOnlyRange:find('"mayExcludeEarlierSustains":true',1,true),"onset-only coverage risk was not reported")

local multiRangeCallsBefore=groupGetNoteCalls
local multiRangeContext=call(
    "get_phrase_context",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","preferSelectedNotes":false,"includeComputedPhonemes":false,'..
        '"automationParameters":[],"ranges":['..
        '{"startSeconds":0,"endSeconds":0.1,"label":"first"},'..
        '{"startSeconds":0.7,"endSeconds":1.0,"label":"second"}]}'
)
assert(multiRangeContext:find('"multiRange":true',1,true),"multi-range context was not reported")
assert(multiRangeContext:find('"scanMode":"multi_range_overlap_sweep"',1,true),"multi-range context did not use one overlap sweep")
assert(multiRangeContext:find('"rangeCount":2',1,true),"multi-range analysis omitted a range")
assert(multiRangeContext:find('"uniqueNoteCount":2',1,true),"multi-range context did not share its matched notes")
assert(groupGetNoteCalls==multiRangeCallsBefore+4,"multi-range context rescanned a Group per requested range")

local firstPhrasePage=call(
    "get_phrase_context",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","preferSelectedNotes":false,"includeComputedPhonemes":false,'..
        '"automationParameters":[],"limit":1}'
)
assert(firstPhrasePage:find('"hasMore":true',1,true),"first phrase page did not expose a continuation")
local rawCursor=assert(firstPhrasePage:match('"pageCursor":(%b{})'),"first phrase page omitted its raw cursor")
local cursorFingerprint=extractJsonString(rawCursor,"fingerprint")
local cursorAnchor=assert(rawCursor:match('"anchorNoteIndex":(%d+)'))
local cursorNext=assert(rawCursor:match('"nextNoteIndex":(%d+)'))
local secondPhrasePage=call(
    "get_phrase_context",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","includeComputedPhonemes":false,"automationParameters":[],"limit":1,'..
        '"pageCursor":{"anchorNoteIndex":'..cursorAnchor..
        ',"nextNoteIndex":'..cursorNext..',"fingerprint":"'..
        escape(cursorFingerprint)..'"}}'
)
assert(secondPhrasePage:find('"source":"cursor_page"',1,true),"cursor continuation source was not reported")
assert(secondPhrasePage:find('"noteIndex":2',1,true),"cursor continuation returned the wrong note")
callExpectError(
    "get_phrase_context",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..
        '","includeComputedPhonemes":false,"automationParameters":[],"limit":1,'..
        '"pageCursor":{"anchorNoteIndex":'..cursorAnchor..
        ',"nextNoteIndex":'..cursorNext..',"fingerprint":"stale"}}',
    "STALE_RANGE_CURSOR"
)

local track2Fingerprint="main-group:"..track2GroupUuid
callWrite("update_track",'{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Lead Source","bounced":true}')
local groupVoice=call("get_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
assert(groupVoice:find('"singers":1',1,true),"experimental Unison singers were not returned")
assert(groupVoice:find('"Soft"',1,true),"Vocal Modes were not returned")
assert(groupVoice:find('"currentEditorGroup":false',1,true),"non-current Group selection context was not returned")
project.tracks[2].refs[1].voice.vocalModeParams={}
local uninitializedVoice=call("get_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
assert(uninitializedVoice:find('"vocalModes":{}',1,true),"empty Vocal Modes were not reproduced")
local uninitializedVoiceFingerprint=extractJsonString(uninitializedVoice,"referenceFingerprint")
local initializeUndoBefore=project.undo
local initializedVoice=callWrite(
    "set_group_voice",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'",'..
        '"referenceFingerprint":"'..escape(uninitializedVoiceFingerprint)..'",'..
        '"vocalModes":['..
            '{"name":"Airy","pitch":10},'..
            '{"name":"Bright","pitch":12},'..
            '{"name":"Cool","pitch":1},'..
            '{"name":"Dark","pitch":1},'..
            '{"name":"Emotional","pitch":5},'..
            '{"name":"Power","pitch":2},'..
            '{"name":"Solid","pitch":6},'..
            '{"name":"Sweet","pitch":15}'..
        ']}'
)
assert(project.undo==initializeUndoBefore+1,"Vocal Mode initialization must create one undo record")
assert(initializedVoice:find('"Airy"',1,true),"an uninitialized supported Vocal Mode was not retained")
assert(project.tracks[2].refs[1].voice.vocalModeParams.Sweet.pitch==15,"batched Vocal Modes were not initialized")
local groupVoiceFingerprint=extractJsonString(initializedVoice,"referenceFingerprint")
local unsupportedModeUndoBefore=project.undo
local unsupportedModeResponse=callExpectError(
    "set_group_voice",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'",'..
        '"referenceFingerprint":"'..escape(groupVoiceFingerprint)..'",'..
        '"vocalModes":[{"name":"Not A Mode","pitch":10}]}',
    "VOCAL_MODE_NOT_FOUND"
)
assert(project.undo==unsupportedModeUndoBefore,"unsupported Vocal Mode probe created an undo record")
assert(
    unsupportedModeResponse:find('"kind":"vocal_mode_names"',1,true),
    "unsupported Vocal Mode did not request exact names from the user"
)
assert(
    unsupportedModeResponse:find('"doNotRetryGuesses":true',1,true),
    "unsupported Vocal Mode did not stop Agent guessing"
)
local undoBeforeUnselectedVoice=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(groupVoiceFingerprint)..'","requireCurrentEditorGroup":true,"vocalModes":[{"name":"Soft","pitch":25}]}',"SELECTION_MISMATCH")
assert(project.undo==undoBeforeUnselectedVoice,"selection-guarded Group voice edit must not create an undo record")
local voiceUpdated=callWrite("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(groupVoiceFingerprint)..'","parameters":{"loudness":-3,"tension":0.25,"breathiness":-0.1,"gender":0.2,"toneShift":-0.3},"vocalModes":[{"name":"Soft","pitch":25,"timbre":40,"pronunciation":15}],"experimentalUnison":{"singers":2,"spacing":0.5}}')
assert(project.tracks[2].refs[1].voice.paramTension==0.25,"group voice parameter was not applied")
assert(project.tracks[2].refs[1].voice.vocalModeParams.Soft.timbre==40,"Vocal Mode was not applied")
assert(project.tracks[2].refs[1].voice.singers==2 and project.tracks[2].refs[1].voice.spacing==0.5,"experimental Unison was not applied")
local updatedVoiceFingerprint=extractJsonString(voiceUpdated,"referenceFingerprint")
local undoBeforeRejectedUnison=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(updatedVoiceFingerprint)..'","experimentalUnison":{"singers":9}}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeRejectedUnison,"host-rejected Unison must not create an undo record")
project.tracks[2].refs[1].voice.vocalModeParams.Powerful={pitch=220,timbre=220,pronunciation=220}
local legacyVoice=call("get_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
local legacyVoiceFingerprint=extractJsonString(legacyVoice,"referenceFingerprint")
local undoBeforeClampedUnrequestedMode=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(legacyVoiceFingerprint)..'","vocalModes":[{"name":"Soft","pitch":25}]}',"HOST_POSTCONDITION_FAILED")
assert(project.undo==undoBeforeClampedUnrequestedMode,"an update that clamps an unrequested Vocal Mode must not create an undo record")
assert(project.tracks[2].refs[1].voice.vocalModeParams.Powerful.pitch==220,"an unrequested legacy Vocal Mode value was changed")
local undoBeforeClampedVocalMode=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(legacyVoiceFingerprint)..'","vocalModes":[{"name":"Powerful","pitch":220}]}',"HOST_POSTCONDITION_FAILED")
assert(project.undo==undoBeforeClampedVocalMode,"host-clamped Vocal Mode must not create an undo record")
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
local instrumentalReference=makeReference(makeGroup(),false)
instrumentalReference.instrumental=true
project.tracks[1]:addGroupReference(instrumentalReference)
callWrite("update_group",'{"trackIndex":1,"groupIndex":2,"muted":true,"timeOffset":352800000,"timeRange":{"onset":0,"duration":1411200000}}')
assert(instrumentalReference.muted==true,"instrumental reference mute update failed")
callWrite("delete_group_reference",'{"trackIndex":1,"groupIndex":2}')
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
local compactAutomationWrite=callWrite("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","responseMode":"compact","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":0}]}')
assert(compactAutomationWrite:find('"responseMode":"compact"',1,true),"compact automation write mode was not returned")
assert(not compactAutomationWrite:find('"points":',1,true),"compact automation write returned the full curve")
callWrite("clear_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}')
local track1Fingerprint="main-group:"..project.tracks[1].refs[1].group.uuid
callWrite("set_track_mixer",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-3,"pan":0.25,"muted":false,"solo":true}')
call("get_track_mixer",'{"trackIndex":1}')
call("playback",'{"operation":"seek","timeSeconds":1.5}')
call("playback",'{"operation":"play"}')
local paused=call("playback",'{"operation":"pause"}')
assert(paused:find('"status":"stopped"',1,true),"pause must report SynthV's stopped status")
assert(paused:find('"playheadSeconds":1.5',1,true),"pause must preserve a non-zero playhead")
call("playback",'{"operation":"loop","timeSeconds":1,"endSeconds":2}')

call("get_host_info","{}")
call("host_clipboard",'{"operation":"write","text":"bridge clipboard"}')
local clipboardRead=call("host_clipboard",'{"operation":"read"}')
assert(clipboardRead:find("bridge clipboard",1,true),"host clipboard round trip failed")
local convertedPitch=call("convert_pitch",'{"pitch":69}')
assert(convertedPitch:find('"frequency":440',1,true),"pitch conversion fallback failed")
call("show_dialog",'{"kind":"input","title":"Bridge","message":"Value","defaultText":"ok"}')

local libraryCreated=callWrite("create_note_group",'{"name":"Reusable Chorus","notes":[{"onset":0,"duration":705600000,"pitch":67,"lyrics":"chorus"}]}')
local libraryUuid=assert(libraryCreated:match('"groupUuid":"([^"]+)"'))
call("list_note_groups","{}")
callWrite("add_group_reference",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","targetGroupUuid":"'..libraryUuid..'","timeOffset":1411200000}')
assert(project.tracks[1]:getNumGroups()==2,"library reference was not added")
callWrite("clone_group_reference",'{"sourceTrackIndex":1,"sourceGroupIndex":2,"sourceGroupUuid":"'..libraryUuid..'","targetTrackIndex":2,"targetTrackFingerprint":"'..track2Fingerprint..'","linked":true}')
assert(project.tracks[2]:getNumGroups()==2,"linked group reference was not cloned")
local referencedLibrary=call("list_note_groups","{}")
assert(referencedLibrary:find('"referenceCount":2',1,true),"library reference count must use UUID identity")
local libraryClone=callWrite("clone_note_group",'{"groupUuid":"'..libraryUuid..'","name":"Reusable Chorus Copy"}')
local clonedLibraryUuid=assert(libraryClone:match('"groupUuid":"([^"]+)"'))
callWrite("delete_note_group",'{"groupUuid":"'..clonedLibraryUuid..'"}')

local pitchAdded=callWrite("add_pitch_controls",'{"trackIndex":1,"groupIndex":1,"pitchControls":[{"kind":"point","position":352800000,"pitch":0.5},{"kind":"curve","position":705600000,"pitch":-0.25,"points":[{"offset":-176400000,"value":0},{"offset":176400000,"value":1}]}]}')
local pointFingerprint=assert(pitchAdded:match('"fingerprint":"([^"]+)","kind":"point"'))
local pitchEdited=callWrite("edit_pitch_controls",'{"trackIndex":1,"groupIndex":1,"edits":[{"pitchControlIndex":1,"fingerprint":"'..escape(pointFingerprint)..'","changes":{"pitch":0.75}}]}')
local editedPointFingerprint=assert(pitchEdited:match('"fingerprint":"([^"]+)","kind":"point"'))
callWrite("delete_pitch_controls",'{"trackIndex":1,"groupIndex":1,"pitchControls":[{"pitchControlIndex":1,"fingerprint":"'..escape(editedPointFingerprint)..'"}]}')
assert(project.tracks[1].refs[1].group:getNumPitchControls()==1,"pitch-control CRUD failed")

callWrite("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":-1},{"position":1411200000,"value":0}]}')
local sampled=call("sample_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","positions":[352800000],"interpolation":"linear"}')
assert(sampled:find('"sampleCount":1',1,true),"automation sampling failed")
callWrite("simplify_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","beginPosition":0,"endPosition":1411200000,"threshold":0.01}')

local retakeGenerated=callWrite("generate_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(fingerprints[2])..'","newDuration":false,"newPitch":true,"newTimbre":true,"activate":true}')
local generatedTakeId=assert(retakeGenerated:match('"generatedTakeId":(%d+)'))
local retakeFingerprint=assert(retakeGenerated:match('"noteFingerprint":"([^"]+)"'))
call("get_note_retakes",'{"trackIndex":1,"groupIndex":1,"noteIndex":2}')
callWrite("activate_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(retakeFingerprint)..'","takeId":0}')
callWrite("delete_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(retakeFingerprint)..'","takeId":'..generatedTakeId..'}')

call("get_pitch_controls",'{"trackIndex":1,"groupIndex":1}')
call("set_selection",'{"scope":"pianoRoll","operation":"replace","kind":"notes","trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(newFingerprint)..'"}]}')
call("set_selection",'{"scope":"arrangement","operation":"replace","kind":"groups","groups":[{"trackIndex":1,"groupIndex":2,"groupUuid":"'..libraryUuid..'"}]}')
assert(#arrangementSelection.selectedGroups==1,"non-main group selection failed")
callExpectError("set_selection",'{"scope":"arrangement","operation":"replace","kind":"groups","groups":[{"trackIndex":1,"groupIndex":1}]}',"INVALID_ARGUMENT")
assert(#arrangementSelection.selectedGroups==1,"invalid selection must not clear the previous selection")
call("get_selection",'{"automationParameters":["loudness"]}')
local pitchCallsBeforePhraseContext=computedPitchCalls
local phraseContext=call(
    "get_phrase_context",
    '{"automationParameters":["loudness"],"pitchAnalysisFrames":8}'
)
assert(phraseContext:find('"source":"selected_notes"',1,true),"phrase context did not prefer selected notes")
assert(phraseContext:find('"returnedNoteCount":1',1,true),"phrase context returned notes outside the selection")
assert(phraseContext:find('"absolutePitch":',1,true),"phrase context omitted compact pitch data")
assert(phraseContext:find('"noteDefaultsOmitted":true',1,true),"phrase context did not report default-field omission")
assert(phraseContext:find('"secondsPrecision":0.0001',1,true),"phrase context did not report timing precision")
assert(not phraseContext:find('"detune":0',1,true),"phrase context repeated zero detune values")
assert(phraseContext:find('"analysis":',1,true),"phrase context omitted phrase analysis")
assert(phraseContext:find('"recommendations":',1,true),"phrase context omitted recommendation-only targets")
assert(phraseContext:find('"automation":',1,true),"phrase context omitted automation summaries")
assert(phraseContext:find('"fingerprint":',1,true),"phrase context omitted write guards")
assert(phraseContext:find('"referenceFingerprint":',1,true),"phrase context omitted the Group voice guard")
assert(phraseContext:find('"pitchAnalysis":{"included":true',1,true),"phrase context omitted computed-pitch summary")
assert(computedPitchCalls==pitchCallsBeforePhraseContext+1,"phrase context sampled computed pitch more than once")
call("get_editor_view",'{"view":"mainEditor"}')
call("set_editor_view",'{"view":"mainEditor","timeLeft":100,"timeRight":1000,"valueCenter":64}')
call("snap_position",'{"view":"mainEditor","position":400000000}')
call("convert_editor_coordinates",'{"view":"mainEditor","time":352800000,"value":60}')
callWrite("script_data",'{"operation":"set","objectType":"project","key":"synthv-agent-bridge.test","value":{"ok":true}}')
call("script_data",'{"operation":"get","objectType":"project","key":"synthv-agent-bridge.test"}')
callWrite("script_data",'{"operation":"remove","objectType":"project","key":"synthv-agent-bridge.test"}')

callWrite("delete_note_group",'{"groupUuid":"'..libraryUuid..'"}')
assert(project.tracks[1]:getNumGroups()==1 and project.tracks[2]:getNumGroups()==1,"deleting a library group must remove linked references")

local autoGroupUndoBefore=project.undo
local autoGrouped=callWrite(
    "add_notes",
    '{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'",'..
        '"grouping":"ensureNonMain","groupName":"Auto Group",'..
        '"notes":[{"onset":1411200000,"duration":705600000,"pitch":67,"lyrics":"grouped"}]}'
)
assert(project.undo==autoGroupUndoBefore+1,"automatic note grouping must create one undo record")
assert(autoGrouped:find('"createdGroup":true',1,true),"automatic note grouping did not report a created group")
assert(autoGrouped:find('"groupIndex":2',1,true),"automatic note grouping did not return the new reference")
assert(project.tracks[2]:getNumGroups()==2,"automatic note grouping did not add a track reference")
local autoReference=project.tracks[2].refs[2]
assert(autoReference.main==false,"automatic note grouping created another main reference")
assert(autoReference.group.name=="Auto Group","automatic note grouping did not retain groupName")
assert(#autoReference.group.notes==1,"automatic note grouping did not retain all inserted notes")
assert(project.groups[#project.groups]==autoReference.group,"automatic note grouping did not add the group to the library")
assert(
    autoReference.voice.vocalModeParams.Soft.pitch==
        project.tracks[2].refs[1].voice.vocalModeParams.Soft.pitch,
    "automatic note grouping did not copy Vocal Modes"
)

local transactionUndoBefore=project.undo
local transactionResponse=call(
    "apply_transaction",
    '{"summary":"Update two independent tracks","steps":['..
        '{"action":"update_track","payload":{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","name":"Transaction Lead"}},'..
        '{"action":"set_track_mixer","payload":{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","gainDecibel":-6}}'..
    '],"rollbackSteps":['..
        '{"action":"update_track","payload":{"trackIndex":1,"trackFingerprint":{"$result":{"step":1,"path":["fingerprint"]}},"name":"Track"}},'..
        '{"action":"set_track_mixer","payload":{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","gainDecibel":0}}'..
    ']}'
)
assert(project.undo==transactionUndoBefore+1,"transaction must create one undo record")
assert(project.tracks[1].name=="Transaction Lead","transaction did not update track 1")
assert(project.tracks[2].mixer.gain==-6,"transaction did not update track 2 mixer")
assert(transactionResponse:find('"rollbackAvailable":true',1,true),"transaction rollback was not stored")
local transactionId=extractJsonString(transactionResponse,"transactionId")
callWrite("rollback_transaction",'{"transactionId":"'..escape(transactionId)..'"}')
assert(project.tracks[1].name=="Track","transaction rollback did not restore the track name")
assert(project.tracks[2].mixer.gain==0,"transaction rollback did not restore the mixer")

local transactionFailureUndoBefore=project.undo
local transactionFailureNameBefore=project.tracks[1].name
callExpectError(
    "apply_transaction",
    '{"summary":"Reject stale second step","steps":['..
        '{"action":"update_track","payload":{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","name":"Must Not Apply"}},'..
        '{"action":"set_track_mixer","payload":{"trackIndex":2,"trackFingerprint":"stale","pan":-0.5}}'..
    ']}',
    "STALE_TRACK"
)
assert(project.undo==transactionFailureUndoBefore,"failed transaction preflight created an undo record")
assert(project.tracks[1].name==transactionFailureNameBefore,"failed transaction preflight partially changed the project")

local exclusiveDeleteUndoBefore=project.undo
local exclusiveDeleteTrackCountBefore=#project.tracks
callExpectError(
    "apply_transaction",
    '{"summary":"Reject index-shifting delete batch","steps":['..
        '{"action":"delete_track","payload":{"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'"}},'..
        '{"action":"update_track","payload":{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","name":"Must Not Apply"}}'..
    ']}',
    "TRANSACTION_SCOPE_CONFLICT"
)
assert(project.undo==exclusiveDeleteUndoBefore,"exclusive delete rejection created an undo record")
assert(#project.tracks==exclusiveDeleteTrackCountBefore,"exclusive delete rejection changed tracks")

local harmonyTrackCountBefore=#project.tracks
callWrite(
    "create_harmony_track",
    '{"sourceTrackIndex":2,"sourceTrackFingerprint":"'..track2Fingerprint..'","name":"Harmony +7","intervalSemitones":7,"minimumPitch":55,"maximumPitch":76,"rangePolicy":"octave","gainDecibel":-5,"pan":0.4}'
)
assert(#project.tracks==harmonyTrackCountBefore+1,"harmony track was not created")
local harmonyTrack=project.tracks[#project.tracks]
assert(harmonyTrack.refs[1].group.notes[1].pitch==67,"harmony notes were not transposed")
assert(harmonyTrack.mixer.gain==-5 and harmonyTrack.mixer.pan==0.4,"harmony mixer was not applied")
local harmonyFingerprint="main-group:"..harmonyTrack.refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":'..#project.tracks..',"trackFingerprint":"'..harmonyFingerprint..'"}')

local semanticNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local semanticFingerprints={}
for value in semanticNotes:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then semanticFingerprints[#semanticFingerprints+1]=value end
end
callWrite(
    "humanize_notes",
    '{"trackIndex":1,"groupIndex":1,"notes":['..
        '{"noteIndex":1,"fingerprint":"'..escape(semanticFingerprints[1])..'"},'..
        '{"noteIndex":2,"fingerprint":"'..escape(semanticFingerprints[2])..'"}'..
    '],"seed":42,"maxOnsetOffset":1000,"maxDurationOffset":1000,"preserveChords":true}'
)
local lyricsNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local lyricsFingerprints={}
for value in lyricsNotes:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then lyricsFingerprints[#lyricsFingerprints+1]=value end
end
callWrite(
    "fit_lyrics",
    '{"trackIndex":1,"groupIndex":1,"notes":['..
        '{"noteIndex":1,"fingerprint":"'..escape(lyricsFingerprints[1])..'"},'..
        '{"noteIndex":2,"fingerprint":"'..escape(lyricsFingerprints[2])..'"}'..
    '],"syllables":["你","好"],"fillRemainder":"reject"}'
)
assert(project.tracks[1].refs[1].group.notes[1].lyrics=="你","lyrics were not fitted")
local vibratoNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local vibratoFingerprints={}
for value in vibratoNotes:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then vibratoFingerprints[#vibratoFingerprints+1]=value end
end
callWrite(
    "apply_expression_preset",
    '{"trackIndex":1,"groupIndex":1,"preset":"vibrato","strength":0.6,"notes":['..
        '{"noteIndex":1,"fingerprint":"'..escape(vibratoFingerprints[1])..'"}'..
    ']}'
)
assert(project.tracks[1].refs[1].group.notes[1].attrs.dF0VbrMod==0.6,"vibrato preset was not applied")
local loudnessBefore=call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}')
local loudnessFingerprint=extractJsonString(loudnessBefore,"fingerprint")
callWrite(
    "apply_expression_preset",
    '{"trackIndex":1,"groupIndex":1,"preset":"crescendo","strength":1,"expectedAutomationFingerprint":"'..
        escape(loudnessFingerprint)..'","beginPosition":0,"endPosition":1411200000,"startValue":-4,"endValue":0}'
)

local finalNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local finalFingerprint=extractJsonString(finalNotes,"fingerprint")
callWrite("delete_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(finalFingerprint)..'"}]}')
assert(project.undo==47,"expected 47 undo records, got "..project.undo)
print("Mock SynthV smoke test passed")
