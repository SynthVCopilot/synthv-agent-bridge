param(
    [Parameter(Mandatory = $true)]
    [int]$SoakProcessId,
    [int]$SampleSeconds = 60,
    [int]$BatchSettleSeconds = 60,
    [int]$WarmupWrites = 10,
    [string]$SoakLogFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-four-hour-soak.jsonl"
    ),
    [string]$SoakResultFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-four-hour-soak-result.json"
    ),
    [string]$LogFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-resource-monitor.jsonl"
    ),
    [string]$ResultFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-resource-monitor-result.json"
    ),
    [switch]$Resume,
    [switch]$SelfTestFileAge
)

$ErrorActionPreference = "Stop"
$ipcDirectory = if ([string]::IsNullOrWhiteSpace($env:SYNTHV_AGENT_BRIDGE_DIR)) {
    [IO.Path]::GetTempPath()
} else {
    [IO.Path]::GetFullPath($env:SYNTHV_AGENT_BRIDGE_DIR.Trim())
}
$ipcPrefix = [IO.Path]::Combine($ipcDirectory, "synthv-agent-bridge")
$statusFile = "$ipcPrefix.status.json"
$residualSuffixes = @(
    ".processing.json",
    ".sidebar.command.processing.txt",
    ".reload",
    ".stop"
)

function Write-JsonLine {
    param([object]$Value)
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value (
        $Value | ConvertTo-Json -Compress -Depth 8
    )
}

function Get-SaneFileAgeMilliseconds {
    param(
        [string]$Path,
        [int]$Attempts = 5,
        [int]$RetryMilliseconds = 20
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            if (Test-Path -LiteralPath $Path) {
                $nowUtc = [DateTime]::UtcNow
                $lastWriteUtc = [IO.File]::GetLastWriteTimeUtc($Path)
                if (
                    $lastWriteUtc.Year -ge 2000 -and
                    $lastWriteUtc -le $nowUtc.AddMinutes(1)
                ) {
                    return [Math]::Max(
                        [double]0,
                        [Math]::Round(($nowUtc - $lastWriteUtc).TotalMilliseconds, 3)
                    )
                }
            }
        } catch {
            if ($attempt -eq $Attempts) {
                return $null
            }
        }
        if ($attempt -lt $Attempts -and $RetryMilliseconds -gt 0) {
            Start-Sleep -Milliseconds $RetryMilliseconds
        }
    }
    return $null
}

function Get-SoakProgress {
    if (-not (Test-Path -LiteralPath $SoakLogFile)) {
        return [pscustomobject]@{ index = 0; reloads = 0 }
    }
    $lastCycle = Get-Content -LiteralPath $SoakLogFile -Encoding UTF8 |
        Select-String -SimpleMatch '"event":"cycle"' |
        Select-Object -Last 1
    if ($null -eq $lastCycle) {
        return [pscustomobject]@{ index = 0; reloads = 0 }
    }
    $cycle = $lastCycle.Line | ConvertFrom-Json
    return [pscustomobject]@{
        index = [int]$cycle.index
        reloads = [int]$cycle.reloadsCompleted
    }
}

function Get-ResourceSample {
    param(
        [string]$Kind,
        [int]$CycleIndex,
        [int]$ReloadCount
    )

    $hostProcess = Get-Process -Name "synthv-studio" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    if ($null -eq $hostProcess) {
        throw "No visible Synthesizer V Studio process was found."
    }

    $nodeProcesses = @(Get-Process -Name "node" -ErrorAction SilentlyContinue)
    $heartbeatAgeMs = $null
    if (Test-Path -LiteralPath $statusFile) {
        $heartbeatAgeMs = Get-SaneFileAgeMilliseconds $statusFile
    }

    $residuals = @()
    foreach ($suffix in $residualSuffixes) {
        $path = "$ipcPrefix$suffix"
        if (Test-Path -LiteralPath $path) {
            $residuals += [pscustomobject]@{
                name = [IO.Path]::GetFileName($path)
                ageMs = Get-SaneFileAgeMilliseconds $path
            }
        }
    }

    return [pscustomobject]@{
        event = "sample"
        kind = $Kind
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        cycleIndex = $CycleIndex
        reloadsCompleted = $ReloadCount
        synthvPid = $hostProcess.Id
        synthvWorkingSetBytes = [long]$hostProcess.WorkingSet64
        synthvPrivateBytes = [long]$hostProcess.PrivateMemorySize64
        synthvHandleCount = [int]$hostProcess.HandleCount
        synthvThreadCount = [int]$hostProcess.Threads.Count
        nodeProcessCount = $nodeProcesses.Count
        nodeWorkingSetBytes = [long](
            ($nodeProcesses | Measure-Object -Property WorkingSet64 -Sum).Sum
        )
        heartbeatAgeMs = $heartbeatAgeMs
        residuals = $residuals
    }
}

function Get-Median {
    param([long[]]$Values)
    $ordered = @($Values | Sort-Object)
    if ($ordered.Count -eq 0) {
        return $null
    }
    $middle = [Math]::Floor($ordered.Count / 2)
    if (($ordered.Count % 2) -eq 1) {
        return [double]$ordered[$middle]
    }
    return ([double]$ordered[$middle - 1] + [double]$ordered[$middle]) / 2
}

function Test-MonotonicGrowth {
    param([long[]]$Values)
    if ($Values.Count -lt 2) {
        return $false
    }
    $hasIncrease = $false
    for ($index = 1; $index -lt $Values.Count; $index += 1) {
        if ($Values[$index] -lt $Values[$index - 1]) {
            return $false
        }
        if ($Values[$index] -gt $Values[$index - 1]) {
            $hasIncrease = $true
        }
    }
    return $hasIncrease
}

function Get-CompletedBatchIndex {
    param([int]$CycleIndex)
    return [int]([Math]::Floor($CycleIndex / 20) * 20)
}

if ($SelfTestFileAge) {
    $probePath = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-stage3-file-age-$([Guid]::NewGuid().ToString('N')).tmp"
    )
    try {
        Set-Content -LiteralPath $probePath -Value "probe" -Encoding UTF8
        $freshAgeMs = Get-SaneFileAgeMilliseconds $probePath
        [IO.File]::SetLastWriteTimeUtc(
            $probePath,
            [DateTime]::SpecifyKind([DateTime]::new(1980, 1, 1), [DateTimeKind]::Utc)
        )
        $invalidAgeMs = Get-SaneFileAgeMilliseconds $probePath 1 0
        if ($null -eq $freshAgeMs -or $freshAgeMs -gt 5000) {
            throw "Fresh file age was not reported as a bounded double."
        }
        if ($null -ne $invalidAgeMs) {
            throw "A transient invalid file timestamp was accepted as a real age."
        }
        [pscustomobject]@{
            outcome = "passed"
            freshAgeMs = $freshAgeMs
            invalidAgeMs = $invalidAgeMs
        } | ConvertTo-Json -Compress
        exit 0
    } finally {
        Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
}

if ($SampleSeconds -lt 5) {
    throw "SampleSeconds must be at least 5."
}
if ($BatchSettleSeconds -lt 10 -or $BatchSettleSeconds -ge 70) {
    throw "BatchSettleSeconds must be between 10 and 69."
}
if ($WarmupWrites -lt 0 -or $WarmupWrites -ge 20) {
    throw "WarmupWrites must be between 0 and 19."
}
if ($SoakProcessId -eq $PID) {
    throw "SoakProcessId must identify the independent soak process."
}
if ($null -eq (Get-Process -Id $SoakProcessId -ErrorAction SilentlyContinue)) {
    throw "The requested soak process is not running."
}

$samples = New-Object System.Collections.Generic.List[object]
if ($Resume) {
    if (-not (Test-Path -LiteralPath $LogFile)) {
        throw "Resume requires the existing resource-monitor log."
    }
    $priorEvents = @(Get-Content -LiteralPath $LogFile -Encoding UTF8 |
        ForEach-Object { $_ | ConvertFrom-Json })
    $priorStart = $priorEvents | Where-Object { $_.event -eq "start" } |
        Select-Object -First 1
    if ($null -eq $priorStart) {
        throw "Resume could not find the original resource-monitor start event."
    }
    $startedAt = [DateTimeOffset]::Parse([string]$priorStart.timestamp)
    foreach ($sample in @($priorEvents | Where-Object { $_.event -eq "sample" })) {
        $samples.Add($sample)
    }
    $lastBatchIndex = [int](
        @($samples | Where-Object { $_.kind -eq "batch" } |
            Measure-Object -Property cycleIndex -Maximum).Maximum
    )
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
} else {
    Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
    $startedAt = [DateTimeOffset]::UtcNow
    $lastBatchIndex = 0
}

$nextRegularSample = [DateTimeOffset]::UtcNow
$pendingBatchIndex = 0
$pendingBatchReloads = 0
$pendingBatchDue = $null
if ($Resume) {
    Write-JsonLine ([pscustomobject]@{
        event = "resume"
        timestamp = [DateTimeOffset]::UtcNow.ToString("o")
        soakProcessId = $SoakProcessId
        priorSampleCount = $samples.Count
    })
} else {
    Write-JsonLine ([pscustomobject]@{
        event = "start"
        timestamp = $startedAt.ToString("o")
        soakProcessId = $SoakProcessId
        sampleSeconds = $SampleSeconds
        batchSettleSeconds = $BatchSettleSeconds
        warmupWrites = $WarmupWrites
    })
}

while (
    $null -ne (Get-Process -Id $SoakProcessId -ErrorAction SilentlyContinue) -and
    -not (Test-Path -LiteralPath $SoakResultFile)
) {
    $now = [DateTimeOffset]::UtcNow
    $progress = Get-SoakProgress
    $completedBatchIndex = Get-CompletedBatchIndex $progress.index
    if ($pendingBatchIndex -gt 0 -and $progress.index -gt $pendingBatchIndex) {
        throw (
            "The soak advanced beyond resource checkpoint $pendingBatchIndex " +
            "before its settled sample was captured."
        )
    }
    if (
        $completedBatchIndex -gt 0 -and
        $completedBatchIndex -gt $lastBatchIndex -and
        $completedBatchIndex -gt $pendingBatchIndex
    ) {
        $nextBatchIndex = $lastBatchIndex + 20
        if ($completedBatchIndex -ne $nextBatchIndex) {
            throw (
                "Resource monitoring missed checkpoint $nextBatchIndex; " +
                "refusing to fabricate a historical settled sample."
            )
        }
        $pendingBatchIndex = $nextBatchIndex
        $pendingBatchReloads = $progress.reloads
        $pendingBatchDue = $now.AddSeconds($BatchSettleSeconds)
    }
    $kind = $null
    $sampleCycleIndex = $progress.index
    $sampleReloadCount = $progress.reloads
    if ($pendingBatchIndex -gt $lastBatchIndex -and $now -ge $pendingBatchDue) {
        $kind = "batch"
        $sampleCycleIndex = $pendingBatchIndex
        $sampleReloadCount = $pendingBatchReloads
        $lastBatchIndex = $pendingBatchIndex
        $pendingBatchIndex = 0
        $pendingBatchReloads = 0
        $pendingBatchDue = $null
    } elseif ($now -ge $nextRegularSample) {
        $kind = "regular"
        $nextRegularSample = $now.AddSeconds($SampleSeconds)
    }

    if ($null -ne $kind) {
        $sample = Get-ResourceSample $kind $sampleCycleIndex $sampleReloadCount
        $samples.Add($sample)
        Write-JsonLine $sample
    }
    Start-Sleep -Seconds 5
}

$progress = Get-SoakProgress
$completedBatchIndex = Get-CompletedBatchIndex $progress.index
if (
    $completedBatchIndex -gt 0 -and
    $completedBatchIndex -gt $lastBatchIndex
) {
    $nextBatchIndex = $lastBatchIndex + 20
    if (
        $completedBatchIndex -ne $nextBatchIndex -or
        $progress.index -ne $nextBatchIndex
    ) {
        throw (
            "The soak ended without a quiescent resource checkpoint at " +
            "$nextBatchIndex."
        )
    }
    Start-Sleep -Seconds $BatchSettleSeconds
    $batchSample = Get-ResourceSample "batch" $completedBatchIndex $progress.reloads
    $samples.Add($batchSample)
    Write-JsonLine $batchSample
    $lastBatchIndex = $completedBatchIndex
}
$finalSample = Get-ResourceSample "final" $progress.index $progress.reloads
$samples.Add($finalSample)
Write-JsonLine $finalSample

$baselineSamples = @($samples | Where-Object {
    $_.kind -eq "regular" -and [int]$_.cycleIndex -ge $WarmupWrites
} | Select-Object -First 5)
$baselineWorkingSet = Get-Median @($baselineSamples | ForEach-Object { [long]$_.synthvWorkingSetBytes })
$baselinePrivate = Get-Median @($baselineSamples | ForEach-Object { [long]$_.synthvPrivateBytes })
$batchSamples = @($samples | Where-Object { $_.kind -eq "batch" })
$workingSetRatios = @($batchSamples | ForEach-Object {
    if ($baselineWorkingSet -gt 0) { [double]$_.synthvWorkingSetBytes / $baselineWorkingSet }
})
$privateRatios = @($batchSamples | ForEach-Object {
    if ($baselinePrivate -gt 0) { [double]$_.synthvPrivateBytes / $baselinePrivate }
})
$workingSetMonotonicGrowth = Test-MonotonicGrowth @(
    $batchSamples | ForEach-Object { [long]$_.synthvWorkingSetBytes }
)
$privateMonotonicGrowth = Test-MonotonicGrowth @(
    $batchSamples | ForEach-Object { [long]$_.synthvPrivateBytes }
)
$maxHeartbeatAgeMs = ($samples | Where-Object { $null -ne $_.heartbeatAgeMs } |
    Measure-Object -Property heartbeatAgeMs -Maximum).Maximum
$missingHeartbeatSampleCount = @($samples | Where-Object {
    $null -eq $_.heartbeatAgeMs
}).Count
$staleResidualSamples = @($samples | Where-Object {
    @($_.residuals | Where-Object { $_.ageMs -gt 30000 }).Count -gt 0
})

$result = [pscustomobject]@{
    outcome = if (
        $baselineSamples.Count -eq 5 -and
        $batchSamples.Count -eq 10 -and
        ($workingSetRatios | Where-Object { $_ -gt 1.2 }).Count -eq 0 -and
        ($privateRatios | Where-Object { $_ -gt 1.2 }).Count -eq 0 -and
        -not $workingSetMonotonicGrowth -and
        -not $privateMonotonicGrowth -and
        [double]$finalSample.synthvWorkingSetBytes / $baselineWorkingSet -le 1.2 -and
        [double]$finalSample.synthvPrivateBytes / $baselinePrivate -le 1.2 -and
        $missingHeartbeatSampleCount -eq 0 -and
        [double]$maxHeartbeatAgeMs -le 5000 -and
        $staleResidualSamples.Count -eq 0
    ) { "passed" } else { "failed" }
    startedAt = $startedAt.ToString("o")
    finishedAt = [DateTimeOffset]::UtcNow.ToString("o")
    sampleCount = $samples.Count
    baselineSampleCount = $baselineSamples.Count
    warmupWrites = $WarmupWrites
    batchSampleCount = $batchSamples.Count
    baselineWorkingSetBytes = $baselineWorkingSet
    baselinePrivateBytes = $baselinePrivate
    finalWorkingSetRatio = if ($baselineWorkingSet -gt 0) {
        [Math]::Round([double]$finalSample.synthvWorkingSetBytes / $baselineWorkingSet, 6)
    } else { $null }
    finalPrivateRatio = if ($baselinePrivate -gt 0) {
        [Math]::Round([double]$finalSample.synthvPrivateBytes / $baselinePrivate, 6)
    } else { $null }
    maximumBatchWorkingSetRatio = if ($workingSetRatios.Count -gt 0) {
        [Math]::Round(($workingSetRatios | Measure-Object -Maximum).Maximum, 6)
    } else { $null }
    maximumBatchPrivateRatio = if ($privateRatios.Count -gt 0) {
        [Math]::Round(($privateRatios | Measure-Object -Maximum).Maximum, 6)
    } else { $null }
    workingSetMonotonicGrowth = $workingSetMonotonicGrowth
    privateMonotonicGrowth = $privateMonotonicGrowth
    maximumHeartbeatAgeMs = $maxHeartbeatAgeMs
    missingHeartbeatSampleCount = $missingHeartbeatSampleCount
    staleResidualSampleCount = $staleResidualSamples.Count
    resumed = [bool]$Resume
    lastCycleIndex = $progress.index
    lastReloadCount = $progress.reloads
    logFile = $LogFile
}

$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultFile -Encoding UTF8
Write-JsonLine ([pscustomobject]@{ event = "finish"; result = $result })
if ($result.outcome -ne "passed") {
    throw "Stage 3 resource criteria did not pass; inspect $ResultFile."
}
