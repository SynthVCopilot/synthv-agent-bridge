-- Local smoke harness for the bridge and CI integration tests.
local ipc = assert(os.getenv("SYNTHV_AGENT_BRIDGE_DIR"))
local prefix = ipc .. "/synthv-agent-bridge"
local requestFile = prefix .. ".request.json"
local responseFile = prefix .. ".response.json"
local statusFile = prefix .. ".status.json"
local installFile = prefix .. ".install.json"

do
    local scriptFile = assert(os.getenv("BRIDGE_SCRIPT")):gsub("\\","\\\\"):gsub('"','\\"')
    local file = assert(io.open(installFile, "wb"))
    file:write('{"schemaVersion":2,"scriptFile":"'..scriptFile..'"}')
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
mixerThrowAfterGain = false
trackCloneDropInstrumental = false
trackAddExtraReference = false
trackClonePitchGetterFailure = false
trackCloneAutomationGetterFailure = false
trackShellPostconditionPitchGetterFailure = false
trackShellPostconditionAutomationGetterFailure = false
trackRemoveNoop = false
groupReferenceRemoveNoop = false
local crashProbeMode = os.getenv("SYNTHV_AGENT_CRASH_PROBE")
local crashProbeArmed = false
local crashProbeCloneCommand = false
local crashProbeVoiceReadsAfterArm = 0
staleLinkedGroupContentReadGuard =
    os.getenv("SYNTHV_AGENT_STALE_PROXY_GUARD")
        == "clone_group_reference"
staleIsolatedGroupContentReadGuard =
    os.getenv("SYNTHV_AGENT_STALE_PROXY_GUARD")
        == "clone_group_reference"
cloneReferenceMutationUnderTest = false
staleTargetTrackProxyGuard =
    os.getenv("SYNTHV_AGENT_STALE_TRACK_PROXY_GUARD")
        == "clone_group_reference"
hostTrackProxyGeneration = 0
isolatedCloneMutationUnderTest = false
isolatedCloneContentReadsUnsafe = false
isolatedCloneReadGuardArmed = false
nilInsertionIndexGuard =
    os.getenv("SYNTHV_AGENT_NIL_INSERTION_INDEX_GUARD")
        == "clone_group_reference"

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
    local trackProxyGeneration=hostTrackProxyGeneration
    return setmetatable({__target=target}, {
        __index=function(_,key)
            if staleTargetTrackProxyGuard
                and target.__hostKind=="track"
                and trackProxyGeneration~=hostTrackProxyGeneration then
                error("stale Track proxy after Note Group library insertion")
            end
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
    function c:setPitch(v)
        if not (
            pitchControlIgnorePitch
            and self.parent
            and not self.parent.isValidationCandidate
        ) then
            self.pitch=v
        end
    end
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

noteIgnorePitch = false
noteRemoveNoop = false
noteRemoveReordersRemaining = false
pitchControlIgnorePitch = false
pitchControlAddNoop = false
pitchControlRemoveNoop = false

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
    function n:setPitch(v)
        if not (noteIgnorePitch and self.parent ~= nil) then
            self.pitch=v
        end
    end
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

local automationAddFailureParameter = nil
local automationRangeEndExclusive = false
local automationExactRemovalFailurePosition = nil
automationQuantizeFloat32 = false
local mixerIgnoreGain = false

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
        if crashProbeArmed
            and crashProbeMode
                == "clone_group_reference.verifySourceAutomation"
            and self.name == "loudness" then
            os.exit(87)
        end
        if crashProbeArmed
            and crashProbeMode
                == "clone_group_reference.verifyVocalModeAutomation"
            and self.name == "vocalMode_SensitiveStyleName" then
            os.exit(89)
        end
        if self.ownerGroup and self.ownerGroup.failAutomationPointsRead then
            error("forced Automation point read failure")
        end
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
    function a:add(b,v)
        if automationAddFailureParameter == self.name then
            automationAddFailureParameter = nil
            error("forced automation add failure")
        end
        if automationQuantizeFloat32 then
            v = string.unpack("f", string.pack("f", v))
        end
        local fresh=self.points[b]==nil
        self.points[b]=v
        return fresh
    end
    function a:removeAll() self.points={} end
    function a:remove(beginPos,endPos)
        if endPos == nil then
            if automationExactRemovalFailurePosition == beginPos then
                return false
            end
            local changed=self.points[beginPos]~=nil
            self.points[beginPos]=nil
            return changed
        end
        local changed=false
        for b,_ in pairs(self.points) do
            if b>=beginPos
                and (
                    b<endPos
                    or (not automationRangeEndExclusive and b==endPos)
                ) then
                self.points[b]=nil
                changed=true
            end
        end
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
    function g:getName()
        assert(
            not self.rejectContentReadAfterLinkedClone
                and not isolatedCloneContentReadsUnsafe,
            "GroupContent name read after linked Reference insertion"
        )
        return self.name
    end
    function g:setName(v) self.name=v end
    function g:getNumNotes()
        assert(
            not self.rejectContentReadAfterLinkedClone
                and not isolatedCloneContentReadsUnsafe,
            "GroupContent note-count read after linked Reference insertion"
        )
        return #self.notes
    end
    function g:getNote(i)
        assert(
            not self.rejectContentReadAfterLinkedClone
                and not isolatedCloneContentReadsUnsafe,
            "GroupContent note read after linked Reference insertion"
        )
        groupGetNoteCalls=groupGetNoteCalls+1
        return self.notes[i]
    end
    function g:addNote(n)
        n.parent=self; self.notes[#self.notes+1]=n
        table.sort(self.notes,function(x,y)return x.onset<y.onset end)
        return indexOf(self.notes,n)
    end
    function g:removeNote(i)
        if not noteRemoveNoop then
            table.remove(self.notes,i)
            if noteRemoveReordersRemaining and #self.notes >= 2 then
                self.notes[1], self.notes[2] = self.notes[2], self.notes[1]
            end
        end
    end
    function g:getNumPitchControls()
        assert(
            not self.rejectContentReadAfterLinkedClone
                and not isolatedCloneContentReadsUnsafe,
            "GroupContent Pitch Control read after linked Reference insertion"
        )
        if self.failPitchControlRead then
            error("forced Smart Pitch count read failure")
        end
        return #self.pitchControls
    end
    function g:getPitchControl(i)
        assert(
            not self.rejectContentReadAfterLinkedClone
                and not isolatedCloneContentReadsUnsafe,
            "GroupContent Pitch Control read after linked Reference insertion"
        )
        return self.pitchControls[i]
    end
    function g:addPitchControl(control)
        if pitchControlAddNoop and not self.isValidationCandidate then
            return #self.pitchControls
        end
        control.parent=self
        self.pitchControls[#self.pitchControls+1]=control
        table.sort(self.pitchControls,function(x,y)return x.position<y.position end)
        return indexOf(self.pitchControls,control)
    end
    function g:removePitchControl(i)
        if not (
            pitchControlRemoveNoop
            and not self.isValidationCandidate
        ) then
            table.remove(self.pitchControls,i)
        end
    end
    function g:getParameter(name)
        if self.rejectContentReadAfterLinkedClone
            or isolatedCloneContentReadsUnsafe then
            error(
                "GroupContent Automation read after linked Reference insertion"
            )
        end
        self.params[name]=self.params[name] or makeAutomation(name)
        self.params[name].ownerGroup=self
        return self.params[name]
    end
    function g:clone()
        local copy=makeGroup()
        copy.isValidationCandidate=true
        copy.name=self.name
        for _,note in ipairs(self.notes) do copy:addNote(note:clone()) end
        for _,control in ipairs(self.pitchControls) do copy:addPitchControl(control:clone()) end
        for name,automation in pairs(self.params) do
            copy.params[name]=automation:clone()
            copy.params[name].ownerGroup=copy
        end
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
        vocalDatabaseId="mock-default-vocal",
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
    if crashProbeMode
            == "clone_group_reference.verifyVocalModeAutomation" then
        r.supportedVocalModes.SensitiveStyleName=true
    end
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
    function r:getVoice()
        if crashProbeArmed
            and crashProbeMode
                == "clone_group_reference.verifyReferenceFingerprint" then
            crashProbeVoiceReadsAfterArm =
                crashProbeVoiceReadsAfterArm + 1
            if crashProbeVoiceReadsAfterArm == 1 then
                os.exit(88)
            end
        end
        if self.failVoiceRead then
            error("forced Group Voice read failure")
        end
        return deepCopy(self.voice)
    end
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
    function r:getOnset()
        assert(
            not self.group.rejectContentReadAfterLinkedClone,
            "Reference onset read after linked Reference insertion"
        )
        if #self.group.notes==0 then return self.timeOffset end
        return self.group.notes[1]:getOnset()+self.timeOffset
    end
    function r:getEnd()
        assert(
            not self.group.rejectContentReadAfterLinkedClone,
            "Reference end read after linked Reference insertion"
        )
        if #self.group.notes==0 then return self.timeOffset end
        return self.group.notes[#self.group.notes]:getEnd()+self.timeOffset
    end
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
        copy.vocalDatabaseId=self.vocalDatabaseId
        copy.supportedVocalModes=deepCopy(self.supportedVocalModes)
        copy.voice=deepCopy(self.voice)
        return copy
    end
    return r
end

local function makeMixer()
    local m=attachScriptData({gain=0,pan=0,muted=false,solo=false})
    function m:getGainDecibel() return self.gain end
    function m:setGainDecibel(v)
        if not mixerIgnoreGain then self.gain=v end
    end
    function m:getPan() return self.pan end
    function m:setPan(v)
        if mixerThrowAfterGain then error("injected mixer mutation failure") end
        self.pan=v
    end
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
    local t=attachScriptData({__hostKind="track",name="Track",color="ff808080",refs={ref},mixer=makeMixer(),bounced=false})
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
    function t:addGroupReference(reference)
        if crashProbeArmed
            and crashProbeMode == "clone_group_reference.addGroupReference" then
            os.exit(86)
        end
        reference.parent=self
        self.refs[#self.refs+1]=reference
        if staleLinkedGroupContentReadGuard
            and cloneReferenceMutationUnderTest then
            reference.group.rejectContentReadAfterLinkedClone = true
        end
        if crashProbeCloneCommand
            and (crashProbeMode
                == "clone_group_reference.verifySourceAutomation"
            or crashProbeMode
                == "clone_group_reference.verifyVocalModeAutomation"
            or crashProbeMode
                == "clone_group_reference.verifyReferenceFingerprint") then
            crashProbeArmed = true
        end
        if nilInsertionIndexGuard
            and (cloneReferenceMutationUnderTest
                or isolatedCloneMutationUnderTest) then
            return nil
        end
        return #self.refs
    end
    function t:removeGroupReference(i)
        if groupReferenceRemoveNoop then return end
        table.remove(self.refs,i)
    end
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
        for _,sourceRef in ipairs(self.refs) do
            -- Match SynthV 2: Track:clone() owns an independent main group,
            -- while cloned non-main references still point at their library
            -- Note Group because NoteGroupReference:clone() does not own it.
            if not (trackCloneDropInstrumental and sourceRef.instrumental) then
                local groupCopy=sourceRef.main
                    and sourceRef.group:clone() or sourceRef.group
                local refCopy=sourceRef:clone()
                refCopy.group=groupCopy
                refCopy.parent=copy
                copy.refs[#copy.refs+1]=refCopy
            end
        end
        trackCloneDropInstrumental=false
        if trackClonePitchGetterFailure then
            trackClonePitchGetterFailure=false
            copy.refs[1].group.failPitchControlRead=true
        end
        if trackCloneAutomationGetterFailure then
            trackCloneAutomationGetterFailure=false
            copy.refs[1].group.failAutomationPointsRead=true
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
function project:getTrack(i)
    if staleTargetTrackProxyGuard then
        return proxyObject(self.tracks[i])
    end
    return self.tracks[i]
end
function project:addTrack(t)
    if crashProbeArmed
        and crashProbeMode == "apply_transaction.addTrack" then
        os.exit(90)
    end
    self.tracks[#self.tracks+1]=t
    if trackShellPostconditionPitchGetterFailure then
        trackShellPostconditionPitchGetterFailure=false
        t.refs[1].group.failPitchControlRead=true
    end
    if trackShellPostconditionAutomationGetterFailure then
        trackShellPostconditionAutomationGetterFailure=false
        t.refs[1].group.failAutomationPointsRead=true
    end
    if trackAddExtraReference then
        trackAddExtraReference=false
        t:addGroupReference(makeReference(makeGroup(),false))
    end
    return #self.tracks
end
function project:removeTrack(i)
    if trackRemoveNoop then return end
    table.remove(self.tracks,i)
end
function project:getNumNoteGroupsInLibrary() return #self.groups end
function project:getNoteGroup(id)
    if type(id)=="number" then return self.groups[id] end
    for _,group in ipairs(self.groups) do if group.uuid==id then return group end end
end
function project:addNoteGroup(group,suggestedIndex)
    local index=suggestedIndex or (#self.groups+1)
    table.insert(self.groups,index,group)
    group.parent=self
    if staleIsolatedGroupContentReadGuard
        and isolatedCloneReadGuardArmed then
        isolatedCloneContentReadsUnsafe = true
        for _,existingGroup in ipairs(self.groups) do
            if existingGroup ~= group then
                existingGroup.rejectContentReadAfterLinkedClone = true
            end
        end
    end
    if staleTargetTrackProxyGuard
        and isolatedCloneMutationUnderTest then
        hostTrackProxyGeneration=hostTrackProxyGeneration+1
    end
    if nilInsertionIndexGuard
        and isolatedCloneMutationUnderTest then
        return nil
    end
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
computedDataPending=false
function SV:getHostInfo() return {osType="Linux",hostName="Mock SynthV",hostVersion="2.2.0",hostVersionNumber=131584,languageCode="en-us"} end
function SV:getProject() return project end
function SV:getPlayback() return playback end
function SV:getMainEditor() return mainEditor end
function SV:getArrangement() return arrangement end
function SV:getPhonemesForGroup(reference)
    computedPhonemeCalls=computedPhonemeCalls+1
    if computedDataPending then return {} end
    local result={}
    for _,note in ipairs(reference.group.notes) do
        result[#result+1]=note.phonemes~="" and note.phonemes or "l a"
    end
    return result
end
function SV:getComputedAttributesForGroup(reference)
    if computedDataPending then return {} end
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

debug=nil
dofile(assert(os.getenv("BRIDGE_SCRIPT")))
main()

do
    local file=assert(io.open(statusFile,"rb"))
    local status=file:read("*a")
    file:close()
    assert(status:find('"protocolVersion":3',1,true),"heartbeat did not advertise protocol v3")
    assert(status:find('"protocolVersions":[3]',1,true),"heartbeat advertised a non-v3 protocol")
    assert(status:find('"preferredProtocolVersion":3',1,true),"heartbeat did not prefer protocol v3")
    assert(status:find('"executorBuildId":"__SYNTHV_AGENT_EXECUTOR_BUILD_ID__"',1,true),"heartbeat did not identify the executor build")
end

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
    local trace=string.format("trace-%012d",seq)
    local f=assert(io.open(requestFile,"wb"))
    f:write('{"v":3,"id":"'..id..'","t":"'..trace..'","b":"__SYNTHV_AGENT_EXECUTOR_BUILD_ID__","a":"'..action..'","p":'..payload..'}')
    f:close()
    assert(scheduled,"bridge stopped unexpectedly")
    local callback=scheduled; scheduled=nil; callback()
    local rf=assert(io.open(responseFile,"rb")); local response=rf:read("*a"); rf:close(); os.remove(responseFile)
    return response
end

local function call(action,payload)
    local response=callRaw(action,payload)
    assert(response:find('"r":',1,true),action.." failed: "..response)
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
    assert(response:find('"e":',1,true),action.." unexpectedly succeeded: "..response)
    assert(response:find('"code":"'..errorCode..'"',1,true),action.." returned the wrong error: "..response)
    return response
end

do
    for legacyVersion=1,2 do
        local correlation="legacy-protocol-"..legacyVersion
        local f=assert(io.open(requestFile,"wb"))
        if legacyVersion==1 then
            f:write('{"protocolVersion":1,"requestId":"'..correlation..'","action":"ping","createdAt":"2026-07-26T00:00:00.000Z","payload":{}}')
        else
            f:write('{"v":2,"id":"'..correlation..'","t":"legacy-protocol-trace","b":"legacy-build","a":"ping","p":{}}')
        end
        f:close()
        assert(scheduled,"bridge stopped unexpectedly")
        local callback=scheduled; scheduled=nil; callback()
        local rf=assert(io.open(responseFile,"rb")); local response=rf:read("*a"); rf:close(); os.remove(responseFile)
        assert(response:find('"v":3',1,true),"legacy rejection did not use the v3 response envelope")
        assert(response:find('"id":"'..correlation..'"',1,true),"legacy rejection did not preserve request correlation")
        assert(response:find('"code":"PROTOCOL_MISMATCH"',1,true),"legacy protocol request was not rejected")
    end
    print("CASE:protocol-v1-v2-rejected")
end

do
    local f=assert(io.open(requestFile,"wb"))
    f:write('{"v":3,"id":"build-mismatch-request","t":"build-mismatch-trace","b":"old-executor-build","a":"set_track_mixer","p":{"trackIndex":1,"trackFingerprint":"ignored","gainDecibel":-3}}')
    f:close()
    assert(scheduled,"bridge stopped unexpectedly")
    local callback=scheduled; scheduled=nil; callback()
    local rf=assert(io.open(responseFile,"rb")); local response=rf:read("*a"); rf:close(); os.remove(responseFile)
    assert(response:find('"code":"BUILD_MISMATCH"',1,true),"executor build mismatch was not rejected")
    assert(response:find('"requiredAction":"reinstall_or_reload_bridge"',1,true),"build mismatch lacked recovery guidance")
    print("CASE:build-mismatch-blocks-command")
end

local pingResponse=call("ping","{}")
assert(pingResponse:find('"bridgeVersion":"0.2.0-alpha.1"',1,true),"expected Bridge version 0.2.0-alpha.1")
local initialSessionToken=extractJsonString(pingResponse,"sessionToken")
local reloadResponse=call("reload_bridge","{}")
assert(reloadResponse:find('"reloading":true',1,true),"hot reload was not acknowledged")
local reloadedPingResponse=call("ping","{}")
local reloadedSessionToken=extractJsonString(reloadedPingResponse,"sessionToken")
assert(reloadedSessionToken~=initialSessionToken,"hot reload did not start a new Bridge session")
local currentGroupVoice=call("get_group_voice","{}")
assert(currentGroupVoice:find('"trackIndex":1',1,true),"current Group voice did not resolve its track")
assert(currentGroupVoice:find('"groupIndex":1',1,true),"current Group voice did not resolve its group")
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
timeAxisNoopUndoBefore=project.undo
timeAxisNoop=call("set_time_axis",'{"tempoMarks":[{"position":0,"bpm":120}]}')
assert(project.undo==timeAxisNoopUndoBefore,"already-satisfied time-axis update created an undo record")
assert(timeAxisNoop:find('"changedCount":0',1,true),"already-satisfied time-axis update did not report zero changes")
assert(timeAxisNoop:find('"undoRecordCount":0',1,true),"already-satisfied time-axis update reported an undo")
print("CASE:time-axis-already-satisfied")
local updatedTimeAxis=callWrite("set_time_axis",'{"tempoMarks":[{"position":0,"bpm":96},{"position":2822400000,"bpm":90}],"measureMarks":[{"measure":0,"numerator":4,"denominator":4},{"measure":2,"numerator":3,"denominator":4}]}')
assert(updatedTimeAxis:find('"bpm":96',1,true),"position-zero tempo replacement was not retained")
assert(updatedTimeAxis:find('"verified":true',1,true),"time-axis response was not postcondition-verified")
do
local page=call("get_time_axis",'{"tempoOffset":0,"tempoLimit":1,"measureOffset":0,"measureLimit":1}')
assert(page:find('"tempoMarkCount":2',1,true),"time-axis page lost the total tempo count")
assert(page:find('"returnedTempoMarkCount":1',1,true),"time-axis page returned the wrong tempo count")
assert(page:find('"returnedMeasureMarkCount":1',1,true),"time-axis page returned the wrong measure count")
assert(page:find('"hasMore":true',1,true),"time-axis page omitted its continuation flag")
local nextPage=call("get_time_axis",'{"tempoOffset":1,"tempoLimit":1,"measureOffset":1,"measureLimit":1}')
assert(nextPage:find('"returnedTempoMarkOffset":1',1,true),"time-axis continuation lost its tempo offset")
assert(nextPage:find('"returnedMeasureMarkOffset":1',1,true),"time-axis continuation lost its measure offset")
assert(extractJsonString(page,"fingerprint")==extractJsonString(nextPage,"fingerprint"),"time-axis paging changed the full-state Guard")
print("CASE:query-time-axis-page")
end

call("list_tracks","{}")
local addedTrack=callWrite("add_track",'{"name":"Lead Copy Source","displayColor":"#ABCDEF"}')
assert(addedTrack:find('"mainGroup"',1,true),"add_track must return the main group locator")
assert(addedTrack:find('"groupUuid"',1,true),"add_track must return the main group UUID")
assert(addedTrack:find('"displayColorArgb":"ffabcdef"',1,true),"track color was not normalized to AARRGGBB")
assert(project.tracks[2].color=="ffabcdef","host track color did not receive AARRGGBB")
do
local page=call("list_tracks",'{"offset":0,"limit":1}')
assert(page:find('"trackCount":2',1,true),"Track page lost the total count")
assert(page:find('"returnedTrackCount":1',1,true),"Track page returned the wrong count")
assert(page:find('"hasMore":true',1,true),"Track page omitted its continuation flag")
local nextPage=call("list_tracks",'{"offset":1,"limit":1}')
assert(nextPage:find('"trackIndex":2',1,true),"Track continuation lost its 1-based identity")
assert(nextPage:find('"returnedTrackCount":1',1,true),"Track continuation returned the wrong count")
print("CASE:query-track-page")
end
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
assert(unsupportedPhonemeVoice:find('"strengthRetained":null',1,true),"phoneme capability read unexpectedly claimed a retained value")
assert(unsupportedPhonemeVoice:find('"reason":"not_probed_write_verified"',1,true),"phoneme capability read did not report write-time verification")
assert(unsupportedPhonemeVoice:find('"probed":false',1,true),"phoneme capability read performed an exploratory probe")
local undoBeforeOutOfRangePhoneme=project.undo
callExpectError("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":1,"fingerprint":"'..escape(phonemeFingerprint)..'","changes":{"phonemeAttributes":[{"strength":1.2},{"leftOffset":0.05,"activity":0.9}]}}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeOutOfRangePhoneme,"out-of-range phoneme edit must fail before an undo record")
local undoBeforeUnsupportedPhoneme=project.undo
callExpectError("set_note_phoneme_properties",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","edits":[{"noteIndex":1,"fingerprint":"'..escape(phonemeFingerprint)..'","changes":{"phonemeAttributes":[{"strength":0.9},{"leftOffset":0.05,"activity":0.9}]}}]}',"HOST_POSTCONDITION_FAILED")
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
local preexistingVoice=call("get_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'"}')
local preexistingVoiceFingerprint=extractJsonString(preexistingVoice,"referenceFingerprint")
local undoBeforeClampedUnrequestedMode=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(preexistingVoiceFingerprint)..'","vocalModes":[{"name":"Soft","pitch":25}]}',"HOST_POSTCONDITION_FAILED")
assert(project.undo==undoBeforeClampedUnrequestedMode,"an update that clamps an unrequested Vocal Mode must not create an undo record")
assert(project.tracks[2].refs[1].voice.vocalModeParams.Powerful.pitch==220,"an unrequested pre-existing Vocal Mode value was changed")
local undoBeforeOutOfRangeVocalMode=project.undo
callExpectError("set_group_voice",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","referenceFingerprint":"'..escape(preexistingVoiceFingerprint)..'","vocalModes":[{"name":"Powerful","pitch":220}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeOutOfRangeVocalMode,"out-of-range Vocal Mode must fail before an undo record")
callWrite("update_group",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","name":"Lead Main","voice":{"paramLoudness":-2}}')
do
local firstNotes=call("get_track_notes",'{"trackIndex":2,"groupIndex":1,"offset":0,"limit":1}')
local nextNotes=call("get_track_notes",'{"trackIndex":2,"groupIndex":1,"offset":1,"limit":1}')
assert(firstNotes:find('"noteIndex":1',1,true),"Track-note first page lost its 1-based note identity")
assert(nextNotes:find('"noteIndex":2',1,true),"Track-note continuation lost its 1-based note identity")
assert(extractJsonString(firstNotes,"referenceFingerprint")==extractJsonString(nextNotes,"referenceFingerprint"),"Track-note paging changed the full Reference Guard")
print("CASE:query-track-notes-page")
end

do
local page=call("get_computed_group_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","offset":0,"limit":1,"pitchSample":{"absoluteStart":0,"interval":352800000,"frames":4}}')
assert(page:find('"noteCount":2',1,true),"computed-data page lost the total note count")
assert(page:find('"returnedNoteCount":1',1,true),"computed-data page returned the wrong count")
assert(page:find('"hasMore":true',1,true),"computed-data page omitted its continuation flag")
computedDataPending=true
local pending=call("get_computed_group_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","offset":1,"limit":1}')
computedDataPending=false
assert(pending:find('"phonemesPending":true',1,true),"pending computed phonemes were not reported")
assert(pending:find('"attributesPending":true',1,true),"pending computed attributes were not reported")
assert(pending:find('"returnedNoteCount":0',1,true),"pending computed data claimed that the page advanced")
assert(pending:find('"nextOffset":1',1,true),"pending computed data did not preserve the retry offset")
local ready=call("get_computed_group_data",'{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","offset":1,"limit":1}')
assert(ready:find('"returnedNoteCount":1',1,true),"ready computed data did not advance its page")
print("CASE:query-computed-page")
end

do
local sharedCloneSource=makeGroup()
sharedCloneSource:setName("Shared Clone Source")
local sharedCloneNote=makeNote()
sharedCloneNote:setPitch(65)
sharedCloneSource:addNote(sharedCloneNote)
project:addNoteGroup(sharedCloneSource)
local sharedCloneReferenceA=makeReference(sharedCloneSource,false)
project.tracks[2]:addGroupReference(sharedCloneReferenceA)
local sharedCloneReferenceB=makeReference(sharedCloneSource,false)
project.tracks[1]:addGroupReference(sharedCloneReferenceB)
local sharedCloneUuid=sharedCloneSource.uuid
local undoBeforeSharedWrite=project.undo
callExpectError(
    "add_notes",
    '{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","notes":[{"onset":705600000,"duration":705600000,"pitch":67,"lyrics":"la"}]}',
    "SHARED_GROUP_WRITE"
)
assert(project.undo==undoBeforeSharedWrite,"shared Group rejection must happen before an undo record")
assert(sharedCloneSource:getNumNotes()==1,"rejected shared Group write changed source notes")
print("CASE:shared-group-default-reject")
callWrite(
    "add_notes",
    '{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","sharedGroupPolicy":"allowAllReferences","expectedReferenceCount":2,"notes":[{"onset":705600000,"duration":705600000,"pitch":67,"lyrics":"la"}]}'
)
assert(sharedCloneSource:getNumNotes()==2,"explicit linked Group write was not applied")
local undoBeforeSharedRename=project.undo
callExpectError(
    "update_group",
    '{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","name":"Wrong"}',
    "SHARED_GROUP_WRITE"
)
assert(project.undo==undoBeforeSharedRename,"shared Group rename rejection created an undo record")
callWrite(
    "update_group",
    '{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","muted":true}'
)
assert(sharedCloneReferenceA.muted==true,"reference-local edit was incorrectly blocked on a shared Group")
groupUpdateNoopUndoBefore=project.undo
groupUpdateNoop=call(
    "update_group",
    '{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","muted":true}'
)
assert(project.undo==groupUpdateNoopUndoBefore,"already-satisfied Group update created an undo record")
assert(groupUpdateNoop:find('"changedCount":0',1,true),"already-satisfied Group update did not report zero changes")
assert(groupUpdateNoop:find('"undoRecordCount":0',1,true),"already-satisfied Group update reported an undo")
print("CASE:group-update-already-satisfied")

local crossTrackSharedScopeUndoBefore=project.undo
local crossTrackSharedScopeNameBefore=sharedCloneSource.name
callExpectError(
    "apply_transaction",
    '{"summary":"Reject cross-track writes to one shared Group","steps":['..
        '{"action":"update_group","payload":{"trackIndex":1,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","sharedGroupPolicy":"allowAllReferences","expectedReferenceCount":2,"name":"Cross Track A"}},'..
        '{"action":"update_group","payload":{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","sharedGroupPolicy":"allowAllReferences","expectedReferenceCount":2,"name":"Cross Track B"}}'..
    ']}',
    "TRANSACTION_SCOPE_CONFLICT"
)
assert(project.undo==crossTrackSharedScopeUndoBefore,"shared Group scope conflict created an undo record")
assert(sharedCloneSource.name==crossTrackSharedScopeNameBefore,"shared Group scope conflict changed the Group")

local sameTrackDistinctGroupUndoBefore=project.undo
local sameTrackDistinctGroupResponse=call(
    "apply_transaction",
    '{"summary":"Allow two distinct Groups on one track","steps":['..
        '{"action":"update_group","payload":{"trackIndex":2,"groupIndex":1,"groupUuid":"'..track2GroupUuid..'","name":"Lead Main Tx"}},'..
        '{"action":"update_group","payload":{"trackIndex":2,"groupIndex":2,"groupUuid":"'..sharedCloneUuid..'","sharedGroupPolicy":"allowAllReferences","expectedReferenceCount":2,"name":"Shared Clone Tx"}}'..
    ']}'
)
assert(project.undo==sameTrackDistinctGroupUndoBefore+1,"distinct Group transaction must create one undo record")
assert(project.tracks[2].refs[1].group.name=="Lead Main Tx","main Group transaction write was not applied")
assert(sharedCloneSource.name=="Shared Clone Tx","non-main Group transaction write was not applied")
assert(sameTrackDistinctGroupResponse:find('"fullyPreflightedBeforeWrite":true',1,true),"independent Group transaction was not fully preflighted")

do
local shiftGroupA=makeGroup()
local shiftGroupB=makeGroup()
local shiftGroupC=makeGroup()
project.tracks[2]:addGroupReference(makeReference(shiftGroupA,false))
project.tracks[2]:addGroupReference(makeReference(shiftGroupB,false))
project.tracks[2]:addGroupReference(makeReference(shiftGroupC,false))
local shiftGroupCountBefore=project.tracks[2]:getNumGroups()
local shiftUndoBefore=project.undo
callExpectError(
    "apply_transaction",
    '{"summary":"Reject index-shifting Group reference deletes","steps":['..
        '{"action":"delete_group_reference","payload":{"trackIndex":2,"groupIndex":3}},'..
        '{"action":"delete_group_reference","payload":{"trackIndex":2,"groupIndex":4}}'..
    ']}',
    "TRANSACTION_SCOPE_CONFLICT"
)
assert(project.undo==shiftUndoBefore,"index-shifting Group reference deletes created an undo record")
assert(project.tracks[2]:getNumGroups()==shiftGroupCountBefore,"rejected Group reference deletes changed the track")
assert(project.tracks[2]:getGroupReference(3):getTarget():getUUID()==shiftGroupA:getUUID(),"rejected Group reference transaction retargeted Group A")
assert(project.tracks[2]:getGroupReference(4):getTarget():getUUID()==shiftGroupB:getUUID(),"rejected Group reference transaction retargeted Group B")
assert(project.tracks[2]:getGroupReference(5):getTarget():getUUID()==shiftGroupC:getUUID(),"rejected Group reference transaction retargeted Group C")
for groupIndex=project.tracks[2]:getNumGroups(),shiftGroupCountBefore-2,-1 do
    project.tracks[2]:removeGroupReference(groupIndex)
end

project.tracks[2].refs[1].vocalDatabaseId="mock-source-vocal"
local shellSourceMain=project.tracks[2].refs[1].group
shellSourceMain:addPitchControl(makePitchControl("point"))
shellSourceMain:getParameter("loudness"):add(0,-2)
shellSourceMain:getParameter("toneShift"):add(352800000,120)
local interleavedInstrumentalReference=makeReference(makeGroup(),false)
interleavedInstrumentalReference.instrumental=true
project.tracks[2]:addGroupReference(interleavedInstrumentalReference)
local shellSourceNoteCount=shellSourceMain:getNumNotes()
local shellSourcePitchControlCount=shellSourceMain:getNumPitchControls()
local shellSourceAutomationPoints=shellSourceMain:getParameter("loudness"):getAllPoints()
local shellSourceToneShiftPoints=shellSourceMain:getParameter("toneShift"):getAllPoints()
local sourceSnapshotGetterUndoBefore=project.undo
shellSourceMain.failPitchControlRead=true
callExpectError(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unreadable Source Smart Pitch"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
shellSourceMain.failPitchControlRead=false
project.tracks[2].refs[1].failVoiceRead=true
callExpectError(
    "clone_track",
    '{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unreadable Source Voice","nonMainGroupPolicy":"detach"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
project.tracks[2].refs[1].failVoiceRead=false
assert(project.undo==sourceSnapshotGetterUndoBefore,"source snapshot getter failures created an undo record")
print("CASE:clone-source-snapshot-getter-failure")
local shellPreflightGetterUndoBefore=project.undo
trackClonePitchGetterFailure=true
callExpectError(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unreadable Shell Smart Pitch"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
trackCloneAutomationGetterFailure=true
callExpectError(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unreadable Shell Automation"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
assert(project.undo==shellPreflightGetterUndoBefore,"shell preflight getter failures created an undo record")
print("CASE:clone-shell-preflight-getter-failure")
local shellPostconditionGetterUndoBefore=project.undo
trackShellPostconditionPitchGetterFailure=true
local pitchPostconditionError=callExpectError(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unverifiable Shell Smart Pitch"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
assert(pitchPostconditionError:find('"undoRequired":true',1,true),"Smart Pitch postcondition getter failure omitted Undo guidance")
project:removeTrack(#project.tracks)
trackShellPostconditionAutomationGetterFailure=true
local automationPostconditionError=callExpectError(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unverifiable Shell Automation"}',
    "UNSUPPORTED_HOST_CAPABILITY"
)
assert(automationPostconditionError:find('"undoRequired":true',1,true),"Automation postcondition getter failure omitted Undo guidance")
project:removeTrack(#project.tracks)
assert(project.undo==shellPostconditionGetterUndoBefore+2,"shell postcondition getter failures did not retain one Undo boundary each")
print("CASE:clone-shell-postcondition-getter-failure")
local shellUndoBefore=project.undo
local shellResult=callWrite(
    "clone_track_shell",
    '{"cloneIntent":"shell","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Safe Vocal Shell"}'
)
assert(project.undo==shellUndoBefore+1,"Track shell clone must create one undo record")
assert(shellResult:find('"verifiedEmptyShell":true',1,true),"Vocal template track did not verify its empty shell")
assert(shellResult:find('"vocalIdentityReadable":false',1,true),"Vocal template track overstated API visibility")
assert(project.tracks[3]:getNumGroups()==1,"Vocal template track retained non-main Groups")
assert(project.tracks[3].refs[1].group:getNumNotes()==0,"Vocal template track retained notes")
assert(project.tracks[3].refs[1].group:getNumPitchControls()==0,"Vocal template track retained pitch controls")
assert(#project.tracks[3].refs[1].group:getParameter("loudness"):getAllPoints()==0,"Vocal template track retained automation")
assert(#project.tracks[3].refs[1].group:getParameter("toneShift"):getAllPoints()==0,"Vocal template track retained toneShift Automation")
assert(project.tracks[3].refs[1].vocalDatabaseId=="mock-source-vocal","host Track clone did not preserve opaque Vocal identity")
assert(project.tracks[3].mixer.gain==0 and project.tracks[3].mixer.pan==0,"Vocal template track mixer was not reset")
assert(shellSourceMain:getNumNotes()==shellSourceNoteCount,"Vocal template track changed source notes")
assert(shellSourceMain:getNumPitchControls()==shellSourcePitchControlCount,"Vocal template track changed source pitch controls")
local shellSourceAutomationAfter=shellSourceMain:getParameter("loudness"):getAllPoints()
assert(#shellSourceAutomationAfter==#shellSourceAutomationPoints and shellSourceAutomationAfter[1][1]==shellSourceAutomationPoints[1][1] and shellSourceAutomationAfter[1][2]==shellSourceAutomationPoints[1][2],"Vocal template track changed source Automation")
local shellSourceToneShiftAfter=shellSourceMain:getParameter("toneShift"):getAllPoints()
assert(#shellSourceToneShiftAfter==#shellSourceToneShiftPoints and shellSourceToneShiftAfter[1][1]==shellSourceToneShiftPoints[1][1] and shellSourceToneShiftAfter[1][2]==shellSourceToneShiftPoints[1][2],"Vocal template track changed source toneShift Automation")
print("CASE:cln-006-empty-track-shell")
local shellTrackFingerprint="main-group:"..project.tracks[3].refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":3,"trackFingerprint":"'..shellTrackFingerprint..'"}')

local undoBeforeImplicitNonMainClone=project.undo
callExpectError(
    "clone_track",
    '{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Unsafe Copy"}',
    "NON_MAIN_GROUP_CLONE_REQUIRES_POLICY"
)
assert(project.undo==undoBeforeImplicitNonMainClone,"rejected non-main clone created an undo record")
print("CASE:cln-005-ambiguous-track-clone")
local droppedInstrumentalUndoBefore=project.undo
trackCloneDropInstrumental=true
callExpectError(
    "clone_track",
    '{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Dropped Instrumental","nonMainGroupPolicy":"detach"}',
    "HOST_POSTCONDITION_FAILED"
)
assert(project.undo==droppedInstrumentalUndoBefore,"instrumental preflight mismatch created an undo record")
local extraReferenceUndoBefore=project.undo
local libraryCountBeforeExtraReferenceFault=#project.groups
trackAddExtraReference=true
callExpectError(
    "clone_track",
    '{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Extra Reference","nonMainGroupPolicy":"detach"}',
    "HOST_POSTCONDITION_FAILED"
)
assert(project.undo==extraReferenceUndoBefore+1,"inserted extra Reference fault did not retain one undo boundary")
project:removeTrack(#project.tracks)
while #project.groups>libraryCountBeforeExtraReferenceFault do
    project:removeNoteGroup(#project.groups)
end
local isolatedTrackUndoBefore=project.undo
local isolatedTrackResult=callWrite("clone_track",'{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Harmony -3st","transposeSemitones":-3,"nonMainGroupPolicy":"detach"}')
assert(project.undo==isolatedTrackUndoBefore+1,"isolated Track clone must create one undo record")
assert(project.tracks[3].refs[1].group.notes[1].pitch==57,"clone_track must transpose cloned notes")
assert(project.tracks[3].refs[1].voice.paramLoudness==-2,"clone_track must inherit voice properties")
assert(project.tracks[3].refs[2].group.uuid~=sharedCloneUuid,"clone_track must detach non-main library Groups")
assert(project.tracks[3].refs[2].group.notes[1].pitch==62,"clone_track must transpose the detached non-main Group")
assert(not project.tracks[3].refs[2].instrumental and project.tracks[3].refs[3].instrumental,"clone_track changed the ordered vocal/instrumental References")
assert(sharedCloneSource.notes[1].pitch==65,"clone_track transposed the shared source Group")
assert(isolatedTrackResult:find('"NON_MAIN_VOCAL_REVIEW_REQUIRED"',1,true),"detached Vocal state omitted the manual-review warning")
assert(not isolatedTrackResult:find('"vocalDatabaseId"',1,true),"detached Vocal state claimed a Vocal database identity")
assert(not isolatedTrackResult:find('"vocalName"',1,true),"detached Vocal state claimed a Vocal name")
print("CASE:cln-007-manual-vocal-review")
print("CASE:isolated-clone-uuid")
local cloneWithClearedGroups=callWrite(
    "clone_track",
    '{"cloneIntent":"isolated","trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'","name":"Voice Shell","clearNotes":true,"nonMainGroupPolicy":"detach"}'
)
assert(cloneWithClearedGroups:find('"independentGroupsVerified":true',1,true),"clone_track did not report independent Group verification")
assert(project.tracks[4].refs[1].group:getNumNotes()==0,"clearNotes did not clear the cloned main Group")
assert(project.tracks[4].refs[2].group:getNumNotes()==0,"clearNotes did not clear the detached non-main Group")
assert(sharedCloneSource:getNumNotes()==2,"clearNotes changed a shared source Group")
print("CASE:clone-source-unchanged")
print("CASE:clone-source-snapshot-unchanged")
local undoBeforeStaleTrack=project.undo
callExpectError("update_track",'{"trackIndex":2,"trackFingerprint":"stale","name":"wrong"}',"STALE_TRACK")
assert(project.undo==undoBeforeStaleTrack,"stale track edit must not create an undo record")
local track4Fingerprint="main-group:"..project.tracks[4].refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":4,"trackFingerprint":"'..track4Fingerprint..'"}')
local track3Fingerprint="main-group:"..project.tracks[3].refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":3,"trackFingerprint":"'..track3Fingerprint..'"}')
assert(#project.tracks==2,"delete_track must remove the target track")
do
local ignoredTrack=makeTrack()
project:addTrack(ignoredTrack)
local ignoredTrackIndex=#project.tracks
local ignoredTrackFingerprint="main-group:"..ignoredTrack.refs[1].group.uuid
local deleteTrackFailureUndoBefore=project.undo
trackRemoveNoop=true
local deleteTrackFailure=callExpectError(
    "delete_track",
    '{"trackIndex":'..ignoredTrackIndex..',"trackFingerprint":"'..ignoredTrackFingerprint..'"}',
    "HOST_POSTCONDITION_FAILED"
)
trackRemoveNoop=false
assert(project.undo==deleteTrackFailureUndoBefore+1,"ignored Track deletion did not retain one Undo")
assert(#project.tracks==ignoredTrackIndex,"ignored Track deletion changed the Track collection")
assert(deleteTrackFailure:find('"undoRequired":true',1,true),"ignored Track deletion did not require Undo")
project:removeTrack(ignoredTrackIndex)
print("CASE:track-delete-postcondition-failure")
end
project.tracks[2]:removeGroupReference(3)
callWrite("delete_note_group",'{"groupUuid":"'..sharedCloneUuid..'"}')
assert(project.tracks[1]:getNumGroups()==1 and project.tracks[2]:getNumGroups()==1,"shared clone fixture was not cleaned up")
end
end

local extraGroup=makeGroup()
local extraReference=makeReference(extraGroup,false)
project.tracks[1]:addGroupReference(extraReference)
callWrite("delete_group_reference",'{"trackIndex":1,"groupIndex":2,"groupUuid":"'..extraGroup.uuid..'"}')
assert(project.tracks[1]:getNumGroups()==1,"delete_group_reference must remove the non-main reference")
do
local ignoredGroup=makeGroup()
local ignoredReference=makeReference(ignoredGroup,false)
project.tracks[1]:addGroupReference(ignoredReference)
local deleteReferenceFailureUndoBefore=project.undo
groupReferenceRemoveNoop=true
local deleteReferenceFailure=callExpectError(
    "delete_group_reference",
    '{"trackIndex":1,"groupIndex":2,"groupUuid":"'..ignoredGroup.uuid..'"}',
    "HOST_POSTCONDITION_FAILED"
)
groupReferenceRemoveNoop=false
assert(project.undo==deleteReferenceFailureUndoBefore+1,"ignored Group Reference deletion did not retain one Undo")
assert(project.tracks[1]:getNumGroups()==2,"ignored Group Reference deletion changed the Track")
assert(deleteReferenceFailure:find('"undoRequired":true',1,true),"ignored Group Reference deletion did not require Undo")
project.tracks[1]:removeGroupReference(2)
print("CASE:group-reference-delete-postcondition-failure")
end
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
do
local noEffectUndoBefore=project.undo
local noEffectEdit=call(
    "edit_notes",
    '{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,'..
        '"fingerprint":"'..escape(newFingerprint)..'",'..
        '"changes":{"pitch":62}}]}'
)
assert(project.undo==noEffectUndoBefore,"already-satisfied note edit created an undo record")
assert(noEffectEdit:find('"editedCount":0',1,true),"already-satisfied note edit did not report zero changes")
assert(noEffectEdit:find('"undoRecordCount":0',1,true),"already-satisfied note edit reported an Undo")
print("CASE:note-edit-already-satisfied")

local ignoredEditUndoBefore=project.undo
noteIgnorePitch=true
local ignoredEdit=callExpectError(
    "edit_notes",
    '{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,'..
        '"fingerprint":"'..escape(newFingerprint)..'",'..
        '"changes":{"pitch":63}}]}',
    "HOST_POSTCONDITION_FAILED"
)
noteIgnorePitch=false
assert(project.undo==ignoredEditUndoBefore+1,"ignored note setter did not retain one Undo boundary")
assert(project.tracks[1].refs[1].group.notes[1].pitch==62,"ignored note setter unexpectedly changed pitch")
assert(ignoredEdit:find('"undoRequired":true',1,true),"ignored note setter did not require one Undo")
print("CASE:note-edit-postcondition-failure")
end

do
local transformNoopUndoBefore=project.undo
local transformNoop=call(
    "transform_notes",
    '{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,'..
        '"fingerprint":"'..escape(newFingerprint)..'"}],'..
        '"transform":{"durationScale":1.0000000001}}'
)
assert(project.undo==transformNoopUndoBefore,"already-satisfied note transform created an Undo")
assert(transformNoop:find('"transformedCount":0',1,true),"already-satisfied transform did not report zero changes")
assert(transformNoop:find('"undoRecordCount":0',1,true),"already-satisfied transform reported an Undo")
print("CASE:note-transform-already-satisfied")

local ignoredTransformUndoBefore=project.undo
noteIgnorePitch=true
local ignoredTransform=callExpectError(
    "transform_notes",
    '{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,'..
        '"fingerprint":"'..escape(newFingerprint)..'"}],'..
        '"transform":{"pitchOffsetSemitones":1}}',
    "HOST_POSTCONDITION_FAILED"
)
noteIgnorePitch=false
assert(project.undo==ignoredTransformUndoBefore+1,"ignored transform did not retain one Undo boundary")
assert(ignoredTransform:find('"undoRequired":true',1,true),"ignored transform did not require one Undo")
print("CASE:note-transform-postcondition-failure")
end

local undoBeforeInvalidBatch=project.undo
local pitchBeforeInvalidBatch=project.tracks[1].refs[1].group.notes[1].pitch
callExpectError("edit_notes",'{"trackIndex":1,"groupIndex":1,"edits":[{"noteIndex":1,"fingerprint":"'..escape(fingerprints[1])..'","changes":{"pitch":63}},{"noteIndex":2,"fingerprint":"'..escape(fingerprints[2])..'","changes":{"unsupported":true}}]}',"INVALID_ARGUMENT")
assert(project.undo==undoBeforeInvalidBatch,"invalid batch must not create an undo record")
assert(project.tracks[1].refs[1].group.notes[1].pitch==pitchBeforeInvalidBatch,"invalid batch must not partially mutate notes")
call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}')
local undoBeforeStaleAutomation=project.undo
local staleAutomationResponse=callExpectError("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","expectedFingerprint":"stale","points":[{"position":0,"value":-3}]}',"STALE_AUTOMATION")
assert(project.undo==undoBeforeStaleAutomation,"stale automation edit must not create an undo record")
assert(not staleAutomationResponse:find('"expected":"stale"',1,true),"stale error leaked the raw expected fingerprint")
assert(staleAutomationResponse:find('"expectedSummary":',1,true),"stale error omitted the bounded fingerprint summary")
assert(#staleAutomationResponse<4096,"stale automation error exceeded the 4 KB public budget")
print("CASE:stale-before-undo-and-redacted")
local compactAutomationWrite=callWrite("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","responseMode":"compact","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":0}]}')
assert(compactAutomationWrite:find('"responseMode":"compact"',1,true),"compact automation write mode was not returned")
assert(not compactAutomationWrite:find('"points":',1,true),"compact automation write returned the full curve")
automationQuantizeFloat32=true
callWrite(
    "set_automation_points",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all",'..
        '"points":[{"position":0,"value":0.1}]}'
)
automationQuantizeFloat32=false
assert(
    project.tracks[1].refs[1].group:getParameter("loudness").points[0]
        ~= 0.1,
    "float32 Automation fixture did not normalize its value"
)
print("CASE:automation-float32-postcondition")
project.tracks[1].refs[1].group:getParameter("loudness").points = {
    [0] = -3,
    [705600000] = 0
}
local automationSetNoopUndoBefore=project.undo
local automationSetNoop=call(
    "set_automation_points",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness",'..
        '"responseMode":"compact","clearMode":"all","points":['..
        '{"position":0,"value":-3},{"position":705600000,"value":0}]}'
)
assert(project.undo==automationSetNoopUndoBefore,"already-satisfied Automation set created an Undo")
assert(automationSetNoop:find('"addedOrUpdatedCount":0',1,true),"already-satisfied Automation set did not report zero changes")
assert(automationSetNoop:find('"undoRecordCount":0',1,true),"already-satisfied Automation set reported an Undo")
print("CASE:automation-set-already-satisfied")
callWrite("clear_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}')
local automationClearNoopUndoBefore=project.undo
local automationClearNoop=call(
    "clear_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness",'..
        '"rangeBegin":0,"rangeEnd":100}'
)
assert(project.undo==automationClearNoopUndoBefore,"already-satisfied Automation clear created an Undo")
assert(automationClearNoop:find('"clearedPointCount":0',1,true),"already-satisfied Automation clear did not report zero changes")
assert(automationClearNoop:find('"undoRecordCount":0',1,true),"already-satisfied Automation clear reported an Undo")
print("CASE:automation-clear-already-satisfied")
local track1Fingerprint="main-group:"..project.tracks[1].refs[1].group.uuid
local mixerWrite=callWrite("set_track_mixer",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-3,"pan":0.25,"muted":false,"solo":true}')
assert(mixerWrite:find('"m":',1,true),"mixer response omitted Lua telemetry")
assert(mixerWrite:find('"stage":"freshRead"',1,true),"mixer telemetry omitted freshRead")
assert(mixerWrite:find('"stage":"preflighted"',1,true),"mixer telemetry omitted preflighted")
assert(mixerWrite:find('"stage":"effectPlanned"',1,true),"mixer telemetry omitted effectPlanned")
assert(mixerWrite:find('"stage":"undoOpened"',1,true),"mixer telemetry omitted undoOpened")
assert(mixerWrite:find('"stage":"mutated"',1,true),"mixer telemetry omitted mutated")
assert(mixerWrite:find('"stage":"verified"',1,true),"mixer telemetry omitted verified")
assert(not mixerWrite:find('"lyrics":',1,true),"Lua telemetry leaked project content")
assert(
    assert(mixerWrite:find('"stage":"effectPlanned"',1,true)) <
        assert(mixerWrite:find('"stage":"undoOpened"',1,true)),
    "mixer effect plan was not complete before Undo"
)
print("CASE:mixer-effect-plan-before-undo")
print("CASE:mixer-lua-stage-timings")
local mixerNoopUndoBefore=project.undo
local mixerNoop=call("set_track_mixer",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-3,"pan":0.25,"muted":false,"solo":true}')
assert(project.undo==mixerNoopUndoBefore,"already-satisfied mixer command created an undo record")
assert(mixerNoop:find('"changedCount":0',1,true),"already-satisfied mixer command did not report zero changes")
assert(mixerNoop:find('"undoRecordCount":0',1,true),"already-satisfied mixer command reported an undo")
print("CASE:already-satisfied-no-undo")
trackUpdateNoopUndoBefore=project.undo
trackUpdateNoop=call(
    "update_track",
    '{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","name":"'..
        escape(project.tracks[1]:getName())..'"}'
)
assert(project.undo==trackUpdateNoopUndoBefore,"already-satisfied Track update created an undo record")
assert(trackUpdateNoop:find('"changedCount":0',1,true),"already-satisfied Track update did not report zero changes")
assert(trackUpdateNoop:find('"undoRecordCount":0',1,true),"already-satisfied Track update reported an undo")
print("CASE:track-update-already-satisfied")
local focusedMixerRead=call("get_track_mixer",'{"trackIndex":1}')
assert(focusedMixerRead:find('"trackFingerprint":',1,true),"focused mixer read omitted the Track guard required for a writeIntent Context")
print("CASE:focused-mixer-write-context")
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

do
local libraryCreated=callWrite("create_note_group",'{"name":"Reusable Chorus","notes":[{"onset":0,"duration":705600000,"pitch":67,"lyrics":"chorus"}]}')
local libraryUuid=assert(libraryCreated:match('"groupUuid":"([^"]+)"'))
cloneLibraryUuidFixture=libraryUuid
local librarySource=assert(project:getNoteGroup(libraryUuid))
local libraryPitchControl=makePitchControl("point")
libraryPitchControl:setPosition(176400000)
libraryPitchControl:setPitch(0.25)
librarySource:addPitchControl(libraryPitchControl)
librarySource:getParameter("loudness"):add(0,-2)
call("list_note_groups","{}")
callWrite("add_group_reference",'{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","targetGroupUuid":"'..libraryUuid..'","timeOffset":1411200000}')
assert(project.tracks[1]:getNumGroups()==2,"library reference was not added")
local linkedCloneUndoBefore=project.undo
if crashProbeMode == "clone_group_reference.addGroupReference" then
    crashProbeArmed = true
elseif crashProbeMode
        == "clone_group_reference.verifyReferenceFingerprint" then
    crashProbeCloneCommand = true
end
if staleLinkedGroupContentReadGuard then
    cloneReferenceMutationUnderTest = true
end
expectedLinkedTargetGroupIndex=#project.tracks[2].refs+1
local linkedClone=callWrite("clone_group_reference",'{"cloneIntent":"linked","sourceTrackIndex":1,"sourceGroupIndex":2,"sourceGroupUuid":"'..libraryUuid..'","targetTrackIndex":2,"targetTrackFingerprint":"'..track2Fingerprint..'"}')
cloneReferenceMutationUnderTest = false
librarySource.rejectContentReadAfterLinkedClone = false
assert(project.undo==linkedCloneUndoBefore+1,"linked Reference clone must create one undo record")
assert(project.tracks[2]:getNumGroups()==2,"linked group reference was not cloned")
assert(project.tracks[2].refs[2].group.uuid==libraryUuid,"linked Reference clone changed the Group UUID")
assert(linkedClone:find('"targetReferenceCount":2',1,true),"linked Reference clone did not verify the incremented reference count")
if nilInsertionIndexGuard then
    assert(
        linkedClone:find(
            '"targetGroupIndex":'..expectedLinkedTargetGroupIndex,
            1,
            true
        ),
        "linked clone did not report its fallback target Group index"
    )
end
print("CASE:cln-001-linked-reference")
do
local groupPage=call("get_track_notes",'{"trackIndex":2,"groupOffset":1,"groupLimit":1,"offset":0,"limit":1}')
assert(groupPage:find('"groupCount":2',1,true),"Track-note Group page lost the total Group count")
assert(groupPage:find('"groupIndex":2',1,true),"Track-note Group continuation lost its 1-based Group identity")
assert(groupPage:find('"returnedGroupCount":1',1,true),"Track-note Group continuation returned the wrong count")
print("CASE:query-track-group-page")
end
local referencedLibrary=call("list_note_groups","{}")
assert(referencedLibrary:find('"referenceCount":2',1,true),"library reference count must use UUID identity")
local sourceNoteCountBeforeIsolation=librarySource:getNumNotes()
local sourceNotePitchBeforeIsolation=librarySource:getNote(1):getPitch()
local sourcePitchControlCountBeforeIsolation=librarySource:getNumPitchControls()
local sourcePitchControlPitchBeforeIsolation=librarySource:getPitchControl(1):getPitch()
local sourceAutomationBeforeIsolation=librarySource:getParameter("loudness"):getAllPoints()
local isolatedCloneUndoBefore=project.undo
if crashProbeMode
        == "clone_group_reference.verifyVocalModeAutomation" then
    project.tracks[1].refs[2].supportedVocalModes.SensitiveStyleName=true
    project.tracks[1].refs[2].voice.vocalModeParams.SensitiveStyleName={
        pitch=0,
        timbre=0,
        pronunciation=0
    }
end
if crashProbeMode
        == "clone_group_reference.verifySourceAutomation"
    or crashProbeMode
        == "clone_group_reference.verifyVocalModeAutomation" then
    crashProbeArmed = true
end
if staleTargetTrackProxyGuard then
    isolatedCloneMutationUnderTest = true
end
isolatedCloneReadGuardArmed = true
expectedIsolatedLibraryIndex=#project.groups+1
expectedIsolatedTargetGroupIndex=#project.tracks[2].refs+1
local isolatedClone=callWrite("clone_group_reference",'{"cloneIntent":"isolated","sourceTrackIndex":1,"sourceGroupIndex":2,"sourceGroupUuid":"'..libraryUuid..'","targetTrackIndex":2,"targetTrackFingerprint":"'..track2Fingerprint..'","name":"Reusable Chorus Isolated"}')
isolatedCloneMutationUnderTest = false
isolatedCloneReadGuardArmed = false
isolatedCloneContentReadsUnsafe = false
for _,existingGroup in ipairs(project.groups) do
    existingGroup.rejectContentReadAfterLinkedClone = false
end
assert(project.undo==isolatedCloneUndoBefore+1,"isolated Reference clone must create one undo record")
local isolatedUuid=assert(isolatedClone:match('"targetGroupUuid":"([^"]+)"'))
assert(isolatedUuid~=libraryUuid,"isolated Reference clone retained the source UUID")
assert(project.tracks[2].refs[3].group.uuid==isolatedUuid,"isolated Reference clone did not target the cloned Group")
if nilInsertionIndexGuard then
    assert(
        isolatedClone:find(
            '"libraryIndex":'..expectedIsolatedLibraryIndex,
            1,
            true
        ),
        "isolated clone did not report its fallback library index"
    )
    assert(
        isolatedClone:find(
            '"targetGroupIndex":'..expectedIsolatedTargetGroupIndex,
            1,
            true
        ),
        "isolated clone did not report its fallback target Group index"
    )
end
assert(isolatedClone:find('"targetReferenceCount":1',1,true),"isolated Reference clone did not verify reference count one")
print("CASE:cln-002-isolated-reference")
local isolatedNotes=call("get_track_notes",'{"trackIndex":2,"groupIndex":3,"offset":0,"limit":1}')
local isolatedNoteFingerprint=nil
for value in isolatedNotes:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then isolatedNoteFingerprint=value end
end
assert(isolatedNoteFingerprint,"isolated note read omitted its fingerprint")
local isolatedDeleteUndoBefore=project.undo
callWrite("delete_notes",'{"trackIndex":2,"groupIndex":3,"groupUuid":"'..isolatedUuid..'","notes":[{"noteIndex":1,"fingerprint":"'..escape(isolatedNoteFingerprint)..'"}]}')
assert(project.undo==isolatedDeleteUndoBefore+1,"isolated note delete must create one undo record")
assert(project.tracks[2].refs[3].group:getNumNotes()==0,"isolated note delete did not remove the target note")
assert(librarySource:getNumNotes()==sourceNoteCountBeforeIsolation and librarySource:getNote(1):getPitch()==sourceNotePitchBeforeIsolation,"isolated note delete changed source notes")
print("CASE:cln-003-isolated-note-delete")
local isolatedAutomationUndoBefore=project.undo
callWrite("set_automation_points",'{"trackIndex":2,"groupIndex":3,"groupUuid":"'..isolatedUuid..'","parameter":"loudness","clearMode":"all","points":[{"position":0,"value":-8}]}')
assert(project.undo==isolatedAutomationUndoBefore+1,"isolated Automation mutation must create one undo record")
local sourceAutomationAfterIsolation=librarySource:getParameter("loudness"):getAllPoints()
assert(#sourceAutomationAfterIsolation==#sourceAutomationBeforeIsolation and sourceAutomationAfterIsolation[1][1]==sourceAutomationBeforeIsolation[1][1] and sourceAutomationAfterIsolation[1][2]==sourceAutomationBeforeIsolation[1][2],"isolated Automation mutation changed the source curve")
assert(librarySource:getNumPitchControls()==sourcePitchControlCountBeforeIsolation and librarySource:getPitchControl(1):getPitch()==sourcePitchControlPitchBeforeIsolation,"isolated clone changed source Smart Pitch")
print("CASE:cln-004-isolated-automation")
print("CASE:clone-source-snapshot-unchanged")
callWrite("delete_note_group",'{"groupUuid":"'..isolatedUuid..'"}')
do
local page=call("list_note_groups",'{"offset":0,"limit":1}')
assert(page:find('"returnedGroupCount":1',1,true),"Note Group page returned the wrong count")
assert(page:find('"hasMore":true',1,true),"Note Group page omitted its continuation flag")
local nextPage=call("list_note_groups",'{"offset":1,"limit":1}')
assert(nextPage:find('"libraryIndex":2',1,true),"Note Group continuation lost its 1-based library identity")
assert(nextPage:find('"returnedGroupCount":1',1,true),"Note Group continuation returned the wrong count")
print("CASE:query-note-group-page")
end
local libraryClone=callWrite("clone_note_group",'{"groupUuid":"'..libraryUuid..'","name":"Reusable Chorus Copy"}')
local clonedLibraryUuid=assert(libraryClone:match('"groupUuid":"([^"]+)"'))
callWrite("delete_note_group",'{"groupUuid":"'..clonedLibraryUuid..'"}')
end

local pitchAdded=callWrite("add_pitch_controls",'{"trackIndex":1,"groupIndex":1,"pitchControls":[{"kind":"point","position":352800000,"pitch":0.5},{"kind":"curve","position":705600000,"pitch":-0.25,"points":[{"offset":-176400000,"value":0},{"offset":176400000,"value":1}]}]}')
do
local page=call("get_pitch_controls",'{"trackIndex":1,"groupIndex":1,"offset":0,"limit":1}')
assert(page:find('"pitchControlCount":2',1,true),"Pitch Control page lost the total count")
assert(page:find('"returnedPitchControlCount":1',1,true),"Pitch Control page returned the wrong count")
assert(page:find('"hasMore":true',1,true),"Pitch Control page omitted its continuation flag")
local nextPage=call("get_pitch_controls",'{"trackIndex":1,"groupIndex":1,"offset":1,"limit":1}')
assert(nextPage:find('"pitchControlIndex":2',1,true),"Pitch Control continuation lost its 1-based identity")
assert(nextPage:find('"returnedPitchControlCount":1',1,true),"Pitch Control continuation returned the wrong count")
print("CASE:query-pitch-control-page")
end
local pointFingerprint=assert(pitchAdded:match('"fingerprint":"([^"]+)","kind":"point"'))
local pitchEdited=callWrite("edit_pitch_controls",'{"trackIndex":1,"groupIndex":1,"edits":[{"pitchControlIndex":1,"fingerprint":"'..escape(pointFingerprint)..'","changes":{"pitch":0.75}}]}')
local editedPointFingerprint=assert(pitchEdited:match('"fingerprint":"([^"]+)","kind":"point"'))

do
local pitchNoopUndoBefore=project.undo
local pitchNoop=call(
    "edit_pitch_controls",
    '{"trackIndex":1,"groupIndex":1,"edits":[{"pitchControlIndex":1,'..
        '"fingerprint":"'..escape(editedPointFingerprint)..'",'..
        '"changes":{"pitch":0.75}}]}'
)
assert(project.undo==pitchNoopUndoBefore,"already-satisfied Smart Pitch edit created an Undo")
assert(pitchNoop:find('"editedCount":0',1,true),"already-satisfied Smart Pitch edit did not report zero changes")
assert(pitchNoop:find('"undoRecordCount":0',1,true),"already-satisfied Smart Pitch edit reported an Undo")
print("CASE:pitch-control-already-satisfied")

local pitchEditFailureUndoBefore=project.undo
pitchControlIgnorePitch=true
local pitchEditFailure=callExpectError(
    "edit_pitch_controls",
    '{"trackIndex":1,"groupIndex":1,"edits":[{"pitchControlIndex":1,'..
        '"fingerprint":"'..escape(editedPointFingerprint)..'",'..
        '"changes":{"pitch":0.875}}]}',
    "HOST_POSTCONDITION_FAILED"
)
pitchControlIgnorePitch=false
assert(project.undo==pitchEditFailureUndoBefore+1,"ignored Smart Pitch edit did not retain one Undo")
assert(pitchEditFailure:find('"undoRequired":true',1,true),"ignored Smart Pitch edit did not require Undo")
print("CASE:pitch-control-edit-postcondition-failure")

local pitchDeleteFailureUndoBefore=project.undo
pitchControlRemoveNoop=true
local pitchDeleteFailure=callExpectError(
    "delete_pitch_controls",
    '{"trackIndex":1,"groupIndex":1,"pitchControls":[{"pitchControlIndex":1,'..
        '"fingerprint":"'..escape(editedPointFingerprint)..'"}]}',
    "HOST_POSTCONDITION_FAILED"
)
pitchControlRemoveNoop=false
assert(project.undo==pitchDeleteFailureUndoBefore+1,"ignored Smart Pitch delete did not retain one Undo")
assert(pitchDeleteFailure:find('"undoRequired":true',1,true),"ignored Smart Pitch delete did not require Undo")
print("CASE:pitch-control-delete-postcondition-failure")

local pitchAddFailureUndoBefore=project.undo
local pitchCountBeforeFailedAdd=project.tracks[1].refs[1].group:getNumPitchControls()
pitchControlAddNoop=true
local pitchAddFailure=callExpectError(
    "add_pitch_controls",
    '{"trackIndex":1,"groupIndex":1,"pitchControls":['..
        '{"kind":"point","position":1058400000,"pitch":0.125}]}',
    "HOST_POSTCONDITION_FAILED"
)
pitchControlAddNoop=false
assert(project.undo==pitchAddFailureUndoBefore+1,"ignored Smart Pitch add did not retain one Undo")
assert(project.tracks[1].refs[1].group:getNumPitchControls()==pitchCountBeforeFailedAdd,"ignored Smart Pitch add changed the Group")
assert(pitchAddFailure:find('"undoRequired":true',1,true),"ignored Smart Pitch add did not require Undo")
print("CASE:pitch-control-add-postcondition-failure")
end

callWrite("delete_pitch_controls",'{"trackIndex":1,"groupIndex":1,"pitchControls":[{"pitchControlIndex":1,"fingerprint":"'..escape(editedPointFingerprint)..'"}]}')
assert(project.tracks[1].refs[1].group:getNumPitchControls()==1,"pitch-control CRUD failed")

callWrite("set_automation_points",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all","points":[{"position":0,"value":-3},{"position":705600000,"value":-1},{"position":1411200000,"value":0}]}')
do
local summary=call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","responseMode":"compact"}')
assert(summary:find('"pointCount":3',1,true),"compact Automation summary lost its point count")
assert(not summary:find('"points":',1,true),"compact Automation summary returned its full point array")
local ranged=call("get_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","responseMode":"compact","rangeBegin":0,"rangeEnd":705600000}')
assert(ranged:find('"points":',1,true),"explicit Automation range omitted its point array")
assert(extractJsonString(summary,"fingerprint")==extractJsonString(ranged,"fingerprint"),"Automation range projection changed the full-curve Guard")
print("CASE:query-automation-summary")
end
local sampled=call("sample_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","positions":[352800000],"interpolation":"linear"}')
assert(sampled:find('"sampleCount":1',1,true),"automation sampling failed")
callWrite("simplify_automation",'{"trackIndex":1,"groupIndex":1,"parameter":"loudness","beginPosition":0,"endPosition":1411200000,"threshold":0.01}')
local simplifyNoopUndoBefore=project.undo
local simplifyNoop=call(
    "simplify_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness",'..
        '"beginPosition":0,"endPosition":1411200000,"threshold":0.01}'
)
assert(project.undo==simplifyNoopUndoBefore,"already-satisfied Automation simplify created an Undo")
assert(simplifyNoop:find('"removedPointCount":0',1,true),"already-satisfied Automation simplify did not report zero removals")
assert(simplifyNoop:find('"undoRecordCount":0',1,true),"already-satisfied Automation simplify reported an Undo")
print("CASE:automation-simplify-already-satisfied")

local retakeGenerated=callWrite("generate_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(fingerprints[2])..'","newDuration":false,"newPitch":true,"newTimbre":true,"activate":true}')
local generatedTakeId=assert(retakeGenerated:match('"generatedTakeId":(%d+)'))
local retakeFingerprint=assert(retakeGenerated:match('"noteFingerprint":"([^"]+)"'))
call("get_note_retakes",'{"trackIndex":1,"groupIndex":1,"noteIndex":2}')
callWrite("activate_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(retakeFingerprint)..'","takeId":0}')
callWrite("delete_note_retake",'{"trackIndex":1,"groupIndex":1,"noteIndex":2,"fingerprint":"'..escape(retakeFingerprint)..'","takeId":'..generatedTakeId..'}')

call("get_pitch_controls",'{"trackIndex":1,"groupIndex":1}')
call("set_selection",'{"scope":"pianoRoll","operation":"replace","kind":"notes","trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(newFingerprint)..'"}]}')
call("set_selection",'{"scope":"arrangement","operation":"replace","kind":"groups","groups":[{"trackIndex":1,"groupIndex":2,"groupUuid":"'..cloneLibraryUuidFixture..'"}]}')
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
do
local scriptDataSetUndoBefore=project.undo
local scriptDataSetNoop=call(
    "script_data",
    '{"operation":"set","objectType":"project","key":"synthv-agent-bridge.test","value":{"ok":true}}'
)
assert(project.undo==scriptDataSetUndoBefore,"already-satisfied script-data set created an Undo")
assert(scriptDataSetNoop:find('"changedCount":0',1,true),"already-satisfied script-data set did not report zero changes")
assert(scriptDataSetNoop:find('"undoRecordCount":0',1,true),"already-satisfied script-data set reported an Undo")
print("CASE:script-data-set-already-satisfied")
end
callWrite("script_data",'{"operation":"remove","objectType":"project","key":"synthv-agent-bridge.test"}')
do
local scriptDataRemoveUndoBefore=project.undo
local scriptDataRemoveNoop=call(
    "script_data",
    '{"operation":"remove","objectType":"project","key":"synthv-agent-bridge.test"}'
)
assert(project.undo==scriptDataRemoveUndoBefore,"already-satisfied script-data remove created an Undo")
assert(scriptDataRemoveNoop:find('"changedCount":0',1,true),"already-satisfied script-data remove did not report zero changes")
assert(scriptDataRemoveNoop:find('"undoRecordCount":0',1,true),"already-satisfied script-data remove reported an Undo")
print("CASE:script-data-remove-already-satisfied")
end

callWrite("delete_note_group",'{"groupUuid":"'..cloneLibraryUuidFixture..'"}')
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

do
local noEffectTransactionUndoBefore=project.undo
local noEffectTransaction=call(
    "apply_transaction",
    '{"summary":"Already satisfied transaction","steps":['..
        '{"action":"set_track_mixer","payload":{'..
            '"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'",'..
            '"gainDecibel":0}}]}'
)
assert(
    project.undo==noEffectTransactionUndoBefore,
    "already-satisfied transaction created an Undo"
)
assert(
    noEffectTransaction:find('"changedCount":0',1,true),
    "already-satisfied transaction did not report zero changes"
)
assert(
    noEffectTransaction:find('"undoRecordCount":0',1,true),
    "already-satisfied transaction reported an Undo"
)
print("CASE:transaction-already-satisfied")

local noWriteDependentUndoBefore=project.undo
local noWriteDependent=callExpectError(
    "apply_transaction",
    '{"summary":"No-write dependency failure","steps":['..
        '{"action":"set_track_mixer","payload":{'..
            '"trackIndex":2,"trackFingerprint":"'..track2Fingerprint..'",'..
            '"gainDecibel":0}},'..
        '{"action":"update_track","payload":{'..
            '"trackIndex":{"$result":{"step":1,"path":["trackIndex"]}},'..
            '"trackFingerprint":{"$result":{'..
                '"step":1,"path":["fingerprint"]}}}}'..
    ']}',
    "TRANSACTION_EXECUTION_FAILED"
)
assert(
    project.undo==noWriteDependentUndoBefore,
    "dependent failure after a no-op step created an Undo"
)
assert(
    noWriteDependent:find('"completedStepCount":1',1,true),
    "dependent no-write failure lost its completed-step count"
)
assert(
    noWriteDependent:find('"changedStepCount":0',1,true),
    "dependent no-write failure reported a changed step"
)
assert(
    noWriteDependent:find('"undoRequired":false',1,true),
    "dependent no-write failure incorrectly required Undo"
)
print("CASE:transaction-dependent-no-write-failure")
end

local dependentTransactionUndoBefore=project.undo
local dependentTransactionTrackCountBefore=#project.tracks
if crashProbeMode == "apply_transaction.addTrack" then
    crashProbeArmed = true
end
local dependentTransactionResponse=call(
    "apply_transaction",
    '{"summary":"Create and name a track from the prior result","steps":['..
        '{"action":"add_track","payload":{"name":"Dependent Draft"}},'..
        '{"action":"update_track","payload":{'..
            '"trackIndex":{"$result":{"step":1,"path":["trackIndex"]}},'..
            '"trackFingerprint":{"$result":{"step":1,"path":["fingerprint"]}},'..
            '"name":"Dependent Final"}}'..
    ']}'
)
assert(project.undo==dependentTransactionUndoBefore+1,"dependent transaction must create one undo record")
assert(#project.tracks==dependentTransactionTrackCountBefore+1,"dependent transaction did not create its track")
assert(project.tracks[#project.tracks].name=="Dependent Final","dependent step did not consume the prior result")
assert(dependentTransactionResponse:find('"dependentStepCount":1',1,true),"dependent transaction count was not returned")
assert(dependentTransactionResponse:find('"fullyPreflightedBeforeWrite":false',1,true),"dependent transaction overstated full preflight")
local dependentTrackFingerprint="main-group:"..project.tracks[#project.tracks].refs[1].group.uuid
callWrite("delete_track",'{"trackIndex":'..#project.tracks..',"trackFingerprint":"'..dependentTrackFingerprint..'"}')

local invalidForwardUndoBefore=project.undo
local invalidForwardTrackCountBefore=#project.tracks
callExpectError(
    "apply_transaction",
    '{"summary":"Reject a future result reference","steps":['..
        '{"action":"add_track","payload":{"name":{"$result":{"step":2,"path":["name"]}}}},'..
        '{"action":"add_track","payload":{"name":"Future"}}'..
    ']}',
    "INVALID_TRANSACTION_REFERENCE"
)
assert(project.undo==invalidForwardUndoBefore,"invalid forward reference created an undo record")
assert(#project.tracks==invalidForwardTrackCountBefore,"invalid forward reference changed tracks")

local dependentFailureUndoBefore=project.undo
local dependentFailureTrackCountBefore=#project.tracks
local dependentFailureResponse=callExpectError(
    "apply_transaction",
    '{"summary":"Expose a dependent preflight failure","steps":['..
        '{"action":"add_track","payload":{"name":"Partial Dependency Fixture"}},'..
        '{"action":"update_track","payload":{'..
            '"trackIndex":{"$result":{"step":1,"path":["trackIndex"]}},'..
            '"trackFingerprint":{"$result":{"step":1,"path":["fingerprint"]}}}}'..
    ']}',
    "TRANSACTION_EXECUTION_FAILED"
)
assert(project.undo==dependentFailureUndoBefore+1,"dependent failure must retain the transaction undo record")
assert(#project.tracks==dependentFailureTrackCountBefore+1,"dependent failure fixture did not expose the completed first step")
assert(dependentFailureResponse:find('"failurePhase":"dependentPreflight"',1,true),"dependent failure phase was not reported")
assert(dependentFailureResponse:find('"completedStepCount":1',1,true),"dependent failure completed-step count was not reported")
assert(dependentFailureResponse:find('"undoRequired":true',1,true),"dependent failure did not require one Undo")
print("CASE:dependent-partial-write-undo")
project:removeTrack(#project.tracks)

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
    '{"sourceTrackIndex":2,"sourceTrackFingerprint":"'..track2Fingerprint..'","name":"Harmony +7","intervalSemitones":7,"minimumPitch":55,"maximumPitch":76,"rangePolicy":"octave","nonMainGroupPolicy":"detach","gainDecibel":-5,"pan":0.4}'
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

do
do
local aggregateVoiceRead=call("get_group_voice",'{"trackIndex":1,"groupIndex":1}')
local aggregateVoiceFingerprint=extractJsonString(aggregateVoiceRead,"referenceFingerprint")
local aggregateLoudnessRead=call(
    "get_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}'
)
local aggregateLoudnessFingerprint=
    extractJsonString(aggregateLoudnessRead,"fingerprint")
local aggregateTensionRead=call(
    "get_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"tension"}'
)
local aggregateTensionFingerprint=
    extractJsonString(aggregateTensionRead,"fingerprint")
local aggregateUndoBefore=project.undo
local aggregatePitchCountBefore=
    project.tracks[1].refs[1].group:getNumPitchControls()
local aggregatePitchRead=call(
    "get_pitch_controls",
    '{"trackIndex":1,"groupIndex":1,"offset":0,"limit":1}'
)
local aggregatePitchFingerprint=
    extractJsonString(aggregatePitchRead,"fingerprint")
local aggregatePitchValue=
    project.tracks[1].refs[1].group:getPitchControl(1):getPitch()
local aggregateResult=call(
    "apply_group_tuning",
    '{"trackIndex":1,"groupIndex":1,"summary":"Aggregate success",'..
        '"referenceFingerprint":"'..escape(aggregateVoiceFingerprint)..'",'..
        '"requireCurrentEditorGroup":false,'..
        '"voice":{"parameters":{"breathiness":0.1}},'..
        '"automations":['..
            '{"parameter":"loudness","expectedFingerprint":"'..
                escape(aggregateLoudnessFingerprint)..'",'..
                '"clearMode":"all","points":[{"position":0,"value":-1}]},'..
            '{"parameter":"tension","expectedFingerprint":"'..
                escape(aggregateTensionFingerprint)..'",'..
                '"clearMode":"all","points":[{"position":0,"value":0.1}]}'..
        '],"pitchControls":{"edits":[{"pitchControlIndex":1,'..
            '"fingerprint":"'..escape(aggregatePitchFingerprint)..'",'..
            '"changes":{"pitch":'..aggregatePitchValue..'}}],"add":['..
            '{"kind":"point","position":1058400000,"pitch":0.2}'..
        ']}}'
)
assert(project.undo==aggregateUndoBefore+1,"aggregate tuning must create exactly one undo record")
assert(aggregateResult:find('"automationChangedCount":2',1,true),"aggregate tuning did not apply both curves")
assert(aggregateResult:find('"pitchControlChangedCount":1',1,true),"aggregate tuning omitted Smart Pitch")
assert(aggregateResult:find('"changedCount":4',1,true),"aggregate tuning counted an already-satisfied Smart Pitch edit")
assert(
    assert(aggregateResult:find('"stage":"freshRead"',1,true))
        < assert(aggregateResult:find('"stage":"guarded"',1,true))
        and assert(aggregateResult:find('"stage":"guarded"',1,true))
            < assert(aggregateResult:find('"stage":"preflighted"',1,true))
        and assert(aggregateResult:find('"stage":"preflighted"',1,true))
            < assert(aggregateResult:find('"stage":"effectPlanned"',1,true))
        and assert(aggregateResult:find('"stage":"effectPlanned"',1,true))
            < assert(aggregateResult:find('"stage":"undoOpened"',1,true)),
    "aggregate tuning did not use the authoritative command-stage order"
)
assert(
    project.tracks[1].refs[1].group:getNumPitchControls()
        == aggregatePitchCountBefore+1,
    "aggregate tuning did not add its Smart Pitch control"
)
print("CASE:aggregate-tuning-single-undo")
print("CASE:aggregate-tuning-smart-pitch")
print("CASE:aggregate-tuning-pipeline-stages")
end

do
local satisfiedVoiceRead=call("get_group_voice",'{"trackIndex":1,"groupIndex":1}')
local satisfiedVoiceFingerprint=extractJsonString(satisfiedVoiceRead,"referenceFingerprint")
local satisfiedLoudnessRead=call(
    "get_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}'
)
local satisfiedLoudnessFingerprint=
    extractJsonString(satisfiedLoudnessRead,"fingerprint")
local satisfiedTensionRead=call(
    "get_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"tension"}'
)
local satisfiedTensionFingerprint=
    extractJsonString(satisfiedTensionRead,"fingerprint")
local satisfiedUndoBefore=project.undo
local satisfiedTuning=call(
    "apply_group_tuning",
    '{"trackIndex":1,"groupIndex":1,"summary":"Already satisfied",'..
        '"referenceFingerprint":"'..escape(satisfiedVoiceFingerprint)..'",'..
        '"voice":{"parameters":{"breathiness":0.1}},'..
        '"automations":['..
            '{"parameter":"loudness","expectedFingerprint":"'..
                escape(satisfiedLoudnessFingerprint)..'",'..
                '"clearMode":"all","points":[{"position":0,"value":-1}]},'..
            '{"parameter":"tension","expectedFingerprint":"'..
                escape(satisfiedTensionFingerprint)..'",'..
                '"clearMode":"all","points":[{"position":0,"value":0.1}]}'..
        ']}'
)
assert(project.undo==satisfiedUndoBefore,"already-satisfied Group tuning created an Undo")
assert(satisfiedTuning:find('"changedCount":0',1,true),"already-satisfied Group tuning reported changes")
assert(satisfiedTuning:find('"undoRecordCount":0',1,true),"already-satisfied Group tuning reported an Undo")
print("CASE:aggregate-tuning-already-satisfied")
end

do
local aggregateNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local aggregateNoteFingerprint=extractJsonString(aggregateNotes,"fingerprint")
local aggregateNotePitch=project.tracks[1].refs[1].group.notes[1].pitch
local aggregateNoteFailureUndoBefore=project.undo
noteIgnorePitch=true
local aggregateNoteFailure=callExpectError(
    "apply_group_tuning",
    '{"trackIndex":1,"groupIndex":1,"summary":"Ignored note fault",'..
        '"noteEdits":[{"noteIndex":1,"fingerprint":"'..
            escape(aggregateNoteFingerprint)..'",'..
            '"changes":{"pitch":'..(aggregateNotePitch+1)..'}}]}',
    "HOST_POSTCONDITION_FAILED"
)
noteIgnorePitch=false
assert(
    project.undo==aggregateNoteFailureUndoBefore+1,
    "ignored aggregate note edit did not retain one Undo boundary"
)
assert(
    aggregateNoteFailure:find('"undoRequired":true',1,true),
    "ignored aggregate note edit did not require one Undo"
)
print("CASE:aggregate-tuning-postcondition-failure")
end

local failureReference=project.tracks[1].refs[1]
local failureVoiceBefore=deepCopy(failureReference.voice)
local failureAutomation=failureReference.group:getParameter("loudness")
local failureAutomationBefore=deepCopy(failureAutomation.points)
local failureVoiceRead=call("get_group_voice",'{"trackIndex":1,"groupIndex":1}')
local failureReferenceFingerprint=extractJsonString(failureVoiceRead,"referenceFingerprint")
local failureAutomationRead=call(
    "get_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness"}'
)
local failureAutomationFingerprint=
    extractJsonString(failureAutomationRead,"fingerprint")
local failureUndoBefore=project.undo
automationAddFailureParameter="loudness"
local tuningFailure=callExpectError(
    "apply_group_tuning",
    '{"trackIndex":1,"groupIndex":1,"summary":"Forced execution failure",'..
        '"referenceFingerprint":"'..escape(failureReferenceFingerprint)..'",'..
        '"requireCurrentEditorGroup":false,'..
        '"voice":{"parameters":{"tension":0.2}},'..
        '"automations":[{"parameter":"loudness",'..
            '"expectedFingerprint":"'..escape(failureAutomationFingerprint)..'",'..
            '"clearMode":"all","points":[{"position":0,"value":0}]}]}',
    "INTERNAL_ERROR"
)
assert(
    tuningFailure:find('"undoRequired":true',1,true),
    "execution failure did not require one SynthV Undo"
)
assert(
    tuningFailure:find('"partialWritePossible":true',1,true),
    "execution failure did not disclose partial-write risk"
)
assert(
    project.undo==failureUndoBefore+1,
    "execution failure did not preserve its single undo boundary"
)
assert(
    failureReference.voice.paramTension==0.2,
    "forced tuning failure did not occur after the voice write"
)
assert(
    next(failureAutomation.points)==nil,
    "forced tuning failure did not occur after clearing automation"
)
failureReference.voice=failureVoiceBefore
failureAutomation.points=failureAutomationBefore
end

do
local orderGroup=project.tracks[1].refs[1].group
local orderFixture=callWrite(
    "add_notes",
    '{"trackIndex":1,"groupIndex":1,"grouping":"target","notes":['..
        '{"onset":2116800000,"duration":352800000,"pitch":67,"lyrics":"order"}]}'
)
local orderNotes=call(
    "get_track_notes",
    '{"trackIndex":1,"groupIndex":1,"offset":0,"limit":100}'
)
local orderFingerprints={}
for value in orderNotes:gmatch('"fingerprint":"([^"]+)"') do
    if value:find("|",1,true) then
        orderFingerprints[#orderFingerprints+1]=value
    end
end
assert(#orderFingerprints>=3,"order-verification fixture needs three notes")
local savedOrderNotes={}
for index,note in ipairs(orderGroup.notes) do
    savedOrderNotes[index]=note
end
local orderUndoBefore=project.undo
noteRemoveReordersRemaining=true
local orderFailure=callExpectError(
    "delete_notes",
    '{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":2,'..
        '"fingerprint":"'..escape(orderFingerprints[2])..'"}]}',
    "HOST_POSTCONDITION_FAILED"
)
noteRemoveReordersRemaining=false
assert(
    project.undo==orderUndoBefore+1,
    "reordered delete did not retain one Undo boundary"
)
assert(
    orderFailure:find('"undoRequired":true',1,true),
    "reordered delete did not require one Undo"
)
orderGroup.notes=savedOrderNotes
for _,note in ipairs(orderGroup.notes) do note.parent=orderGroup end
print("CASE:note-delete-order-postcondition")
end

local finalNotes=call("get_track_notes",'{"trackIndex":1,"offset":0,"limit":100}')
local finalFingerprint=extractJsonString(finalNotes,"fingerprint")
do
local ignoredDeleteUndoBefore=project.undo
noteRemoveNoop=true
local ignoredDelete=callExpectError(
    "delete_notes",
    '{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,'..
        '"fingerprint":"'..escape(finalFingerprint)..'"}]}',
    "HOST_POSTCONDITION_FAILED"
)
noteRemoveNoop=false
assert(project.undo==ignoredDeleteUndoBefore+1,"ignored note delete did not retain one Undo boundary")
assert(ignoredDelete:find('"undoRequired":true',1,true),"ignored note delete did not require one Undo")
print("CASE:note-delete-postcondition-failure")
end
callWrite("delete_notes",'{"trackIndex":1,"groupIndex":1,"notes":[{"noteIndex":1,"fingerprint":"'..escape(finalFingerprint)..'"}]}')

do
local rangeAutomation=project.tracks[1].refs[1].group:getParameter("loudness")
callWrite(
    "set_automation_points",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all",'..
        '"points":[{"position":0,"value":-2},{"position":100,"value":-1},'..
        '{"position":101,"value":0}]}'
)
automationRangeEndExclusive=true
callWrite(
    "clear_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}'
)
automationRangeEndExclusive=false
assert(rangeAutomation.points[0]==nil,"closed-range clear retained the range start")
assert(rangeAutomation.points[100]==nil,"closed-range clear retained the range end")
assert(rangeAutomation.points[101]==0,"closed-range clear removed a point outside the range")
print("CASE:automation-closed-range-host-semantics")

callWrite(
    "set_automation_points",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness","clearMode":"all",'..
        '"points":[{"position":0,"value":-2},{"position":100,"value":-1}]}'
)
local endpointFailureUndoBefore=project.undo
automationRangeEndExclusive=true
automationExactRemovalFailurePosition=100
local endpointFailure=callExpectError(
    "clear_automation",
    '{"trackIndex":1,"groupIndex":1,"parameter":"loudness","rangeBegin":0,"rangeEnd":100}',
    "HOST_POSTCONDITION_FAILED"
)
automationRangeEndExclusive=false
automationExactRemovalFailurePosition=nil
assert(project.undo==endpointFailureUndoBefore+1,"endpoint postcondition failure did not use one undo boundary")
assert(rangeAutomation.points[100]==-1,"endpoint fault injection did not retain the range end")
assert(endpointFailure:find('"undoRequired":true',1,true),"endpoint residue did not require one Undo")
print("CASE:automation-closed-range-postcondition")

local mixerFailureUndoBefore=project.undo
local mixerBeforeFailure=project.tracks[1].mixer.gain
mixerIgnoreGain=true
local mixerFailure=callExpectError(
    "set_track_mixer",
    '{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-2}',
    "HOST_POSTCONDITION_FAILED"
)
mixerIgnoreGain=false
assert(project.undo==mixerFailureUndoBefore+1,"mixer postcondition failure did not use one undo boundary")
assert(project.tracks[1].mixer.gain==mixerBeforeFailure,"mixer fault injection unexpectedly changed gain")
assert(mixerFailure:find('"undoRequired":true',1,true),"mixer postcondition failure did not require one Undo")
print("CASE:write-postcondition-failure")

do
    local undoBefore=project.undo
    local gainBefore=project.tracks[1].mixer.gain
    local panBefore=project.tracks[1].mixer.pan
    mixerThrowAfterGain=true
    local failure=callExpectError(
        "set_track_mixer",
        '{"trackIndex":1,"trackFingerprint":"'..track1Fingerprint..'","gainDecibel":-1,"pan":-0.25}',
        "INTERNAL_ERROR"
    )
    mixerThrowAfterGain=false
    assert(project.undo==undoBefore+1,"mixer mutation failure did not retain one undo boundary")
    assert(project.tracks[1].mixer.gain==-1,"mixer mutation failure did not expose the completed first mutation")
    assert(project.tracks[1].mixer.pan==panBefore,"mixer mutation failure unexpectedly changed pan")
    assert(failure:find('"undoRequired":true',1,true),"mixer mutation failure did not require one Undo")
    project.tracks[1].mixer.gain=gainBefore
    print("CASE:mixer-mutation-failure-undo")
end
end

assert(project.undo==85,"expected 85 undo records, got "..project.undo)
print("Mock SynthV smoke test passed")
