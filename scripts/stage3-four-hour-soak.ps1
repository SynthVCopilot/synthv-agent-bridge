param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectFile,
    [double]$DurationHours = 1,
    [int]$TrackIndex = 1,
    [int]$GroupIndex = 2,
    [int]$NoteIndex = 1,
    [int]$WriteCount = 200,
    [int]$ReloadEvery = 20,
    [string]$StateFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-write-undo.json"
    ),
    [string]$LogFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-four-hour-soak.jsonl"
    ),
    [string]$ResultFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-four-hour-soak-result.json"
    ),
    [string]$ResourceLogFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-resource-monitor.jsonl"
    ),
    [string]$ResourceResultFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-resource-monitor-result.json"
    ),
    [int]$ResourceBatchSettleSeconds = 60,
    [int]$ResourceCheckpointTimeoutSeconds = 180,
    [switch]$RequireResourceCheckpoints,
    [switch]$Resume,
    [switch]$OverrideDurationOnResume
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$writeLoop = Join-Path $PSScriptRoot "stage3-visible-undo-loop.ps1"
$readDriver = Join-Path $PSScriptRoot "release-validation-v3.mjs"
$stabilityDriver = Join-Path $PSScriptRoot "stage3-stability-v3.mjs"
$writeDriver = Join-Path $PSScriptRoot "stage3-write-undo-v3.mjs"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Stage3SoakPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@

function Write-JsonLine {
    param([object]$Value)
    Add-Content -LiteralPath $LogFile -Value ($Value | ConvertTo-Json -Compress -Depth 8)
}

function Invoke-JsonCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TransientBaselineAttempts = 1
    )
    for ($attempt = 1; $attempt -le $TransientBaselineAttempts; $attempt += 1) {
        $output = & $FilePath @Arguments 2>&1
        if ($LASTEXITCODE -eq 0) {
            return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
        }
        $message = $output -join [Environment]::NewLine
        if (
            $attempt -lt $TransientBaselineAttempts -and
            $message -match "Bridge baseline is not connected, fresh, coherent, and write-enabled"
        ) {
            Start-Sleep -Milliseconds 750
            continue
        }
        throw $message
    }
}

function Get-ResourceEvents {
    if (-not (Test-Path -LiteralPath $ResourceLogFile)) {
        return @()
    }
    $events = @()
    foreach ($line in @(Get-Content -LiteralPath $ResourceLogFile -Encoding UTF8)) {
        try {
            $events += ($line | ConvertFrom-Json)
        } catch {
            # The independent monitor may still be appending its current line.
        }
    }
    return @($events)
}

function Assert-ResourceMonitorHealthy {
    if (Test-Path -LiteralPath $ResourceResultFile) {
        $resourceResult = Get-Content -LiteralPath $ResourceResultFile -Raw -Encoding UTF8 |
            ConvertFrom-Json
        if ([string]$resourceResult.outcome -ne "passed") {
            throw "The independent Stage 3 resource monitor has failed."
        }
    }
}

function Wait-ResourceMonitorStart {
    $timeoutAt = [DateTimeOffset]::UtcNow.AddSeconds($ResourceCheckpointTimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $timeoutAt) {
        $start = Get-ResourceEvents | Where-Object {
            $_.event -eq "start" -and
            [int]$_.soakProcessId -eq $PID -and
            [int]$_.batchSettleSeconds -eq $ResourceBatchSettleSeconds
        } | Select-Object -Last 1
        if ($null -ne $start) {
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "The Stage 3 resource monitor did not attach with matching settle settings."
}

function Wait-ResourceCheckpoint {
    param([int]$CycleIndex)
    $timeoutAt = [DateTimeOffset]::UtcNow.AddSeconds($ResourceCheckpointTimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $timeoutAt) {
        Assert-ResourceMonitorHealthy
        $sample = Get-ResourceEvents | Where-Object {
            $_.event -eq "sample" -and
            $_.kind -eq "batch" -and
            [int]$_.cycleIndex -eq $CycleIndex -and
            [DateTimeOffset]::Parse([string]$_.timestamp) -ge $startedAt
        } | Select-Object -Last 1
        if ($null -ne $sample) {
            Write-JsonLine ([pscustomobject]@{
                event = "resourceCheckpoint"
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                index = $CycleIndex
                sampleTimestamp = $sample.timestamp
            })
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "Resource checkpoint $CycleIndex was not captured before the timeout."
}

if (-not [IO.Path]::IsPathRooted($ProjectFile)) {
    throw "ProjectFile must be an absolute path."
}
if ($DurationHours -le 0 -or $WriteCount -lt 1 -or $WriteCount -gt 200) {
    throw "DurationHours must be positive and WriteCount must be between 1 and 200."
}
if ($ReloadEvery -lt 1) {
    throw "ReloadEvery must be positive."
}
if ($ResourceBatchSettleSeconds -lt 10 -or $ResourceBatchSettleSeconds -ge 180) {
    throw "ResourceBatchSettleSeconds must be between 10 and 179."
}
if ($ResourceCheckpointTimeoutSeconds -le $ResourceBatchSettleSeconds) {
    throw "ResourceCheckpointTimeoutSeconds must exceed ResourceBatchSettleSeconds."
}
if ($RequireResourceCheckpoints -and $WriteCount -ne 200) {
    throw "The release resource gate requires exactly 200 writes and 10 checkpoints."
}

Set-Location $repoRoot
$priorLastCycle = $null
if ($Resume) {
    if (-not (Test-Path -LiteralPath $LogFile)) {
        throw "Resume requires the existing Stage 3 soak log."
    }
    $priorEvents = @(Get-Content -LiteralPath $LogFile | ForEach-Object {
        $_ | ConvertFrom-Json
    })
    $priorStart = $priorEvents | Where-Object { $_.event -eq "start" } |
        Select-Object -First 1
    $priorLastCycle = $priorEvents | Where-Object { $_.event -eq "cycle" } |
        Select-Object -Last 1
    if ($null -eq $priorStart) {
        throw "Resume could not find the original soak start event."
    }
    if (
        [int]$priorStart.writeCount -ne $WriteCount -or
        [int]$priorStart.reloadEvery -ne $ReloadEvery
    ) {
        throw "Resume parameters do not match the original soak plan."
    }
    $startedAt = [DateTimeOffset]::Parse([string]$priorStart.startedAt)
    $originalDeadline = [DateTimeOffset]::Parse([string]$priorStart.deadline)
    $deadline = if ($OverrideDurationOnResume) {
        $startedAt.AddHours($DurationHours)
    } else {
        $originalDeadline
    }
    if ($deadline -le [DateTimeOffset]::UtcNow) {
        throw "The resumed soak deadline must still be in the future."
    }
    $completedWrites = if ($null -eq $priorLastCycle) {
        0
    } else { [int]$priorLastCycle.index }
    $readCount = if ($null -eq $priorLastCycle) {
        0
    } else { [int]$priorLastCycle.readsCompleted }
    $reloadCount = if ($null -eq $priorLastCycle) {
        0
    } else { [int]$priorLastCycle.reloadsCompleted }
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
} else {
    Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
    $startedAt = [DateTimeOffset]::UtcNow
    $deadline = $startedAt.AddHours($DurationHours)
    $reloadCount = 0
    $readCount = 0
    $completedWrites = 0
}

# Keep the interactive Windows session awake while the visible Undo clicks run.
[void][Stage3SoakPower]::SetThreadExecutionState([uint32]2147483651)

try {
    if ($RequireResourceCheckpoints) {
        Wait-ResourceMonitorStart
    }
    $initial = Invoke-JsonCommand "node" @(
        $writeDriver,
        "--mode", "status",
        "--state-file", $StateFile
    )
    if ($null -ne $initial.pending -or [int]$initial.linkedCloneCount -ne 0) {
        throw "Stage 3 soak requires a clean runtime state with no linked-clone cycles."
    }

    if ($Resume) {
        if ([string]$initial.preparedDigest -ne [string]$priorStart.preparedDigest) {
            throw "Resume runtime digest does not match the original soak start event."
        }
        $stateCompleted = [int]$initial.ordinaryCompletedCount
        if ($stateCompleted -lt $completedWrites -or $stateCompleted -gt ($completedWrites + 1)) {
            throw "Resume state may be ahead of the log by at most one recovered write."
        }
        Write-JsonLine ([pscustomobject]@{
            event = "resume"
            timestamp = [DateTimeOffset]::UtcNow.ToString("o")
            completedWritesInLog = $completedWrites
            completedWritesInState = $stateCompleted
            deadline = $deadline.ToString("o")
            originalDeadline = $originalDeadline.ToString("o")
            durationOverrideApplied = [bool]$OverrideDurationOnResume
        })

        # A fail-fast stop can occur after the write and visible Undo have been
        # recovered but before that cycle's read/reload evidence was recorded.
        if ($stateCompleted -eq ($completedWrites + 1)) {
            $recoveredCompletion = (Get-Content -LiteralPath $StateFile -Raw |
                ConvertFrom-Json).completed | Select-Object -Last 1
            $read = Invoke-JsonCommand "node" @(
                $readDriver,
                "--live",
                "--iterations", "17",
                "--project-file", $ProjectFile,
                "--track-index", [string]$TrackIndex,
                "--group-index", [string]$GroupIndex,
                "--note-index", [string]$NoteIndex
            ) -TransientBaselineAttempts 3
            if ([int]$read.completedQueries -ne 17) {
                throw "The recovered soak cycle did not complete its 17 reads."
            }
            $readCount += [int]$read.completedQueries
            $completedWrites = $stateCompleted
            $reloaded = $false
            if (($completedWrites % $ReloadEvery) -eq 0) {
                $reload = Invoke-JsonCommand "node" @(
                    $stabilityDriver,
                    "--live",
                    "--mode", "reload",
                    "--count", "1",
                    "--project-file", $ProjectFile,
                    "--track-index", [string]$TrackIndex,
                    "--group-index", [string]$GroupIndex
                )
                if ([int]$reload.completedReloads -ne 1) {
                    throw "The recovered soak reload cycle did not complete."
                }
                $reloadCount += 1
                $reloaded = $true
            }
            Write-JsonLine ([pscustomobject]@{
                event = "cycle"
                timestamp = [DateTimeOffset]::UtcNow.ToString("o")
                index = $completedWrites
                action = $recoveredCompletion.action
                restoredDigest = $recoveredCompletion.restoredDigest
                undoVerified = $recoveredCompletion.undoVerified
                readsCompleted = $readCount
                reloadsCompleted = $reloadCount
                reloaded = $reloaded
                recoveredAfterInterruption = $true
            })
            if ($RequireResourceCheckpoints -and ($completedWrites % 20) -eq 0) {
                Wait-ResourceCheckpoint $completedWrites
            }
        }
    } else {
        if ([int]$initial.ordinaryCompletedCount -ne 0) {
            throw "Stage 3 soak requires a freshly prepared runtime state."
        }
        Write-JsonLine ([pscustomobject]@{
            event = "start"
            startedAt = $startedAt.ToString("o")
            deadline = $deadline.ToString("o")
            durationHours = $DurationHours
            writeCount = $WriteCount
            reloadEvery = $ReloadEvery
            preparedDigest = $initial.preparedDigest
        })
    }

    for ($index = $completedWrites + 1; $index -le $WriteCount; $index += 1) {
        $writeOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $writeLoop `
            -Mode ordinary -StartIndex $index -EndIndex $index -StateFile $StateFile 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw ($writeOutput -join [Environment]::NewLine)
        }
        $writeResult = (($writeOutput -join [Environment]::NewLine) | ConvertFrom-Json)
        $completedWrites = $index

        $read = Invoke-JsonCommand "node" @(
            $readDriver,
            "--live",
            "--iterations", "17",
            "--project-file", $ProjectFile,
            "--track-index", [string]$TrackIndex,
            "--group-index", [string]$GroupIndex,
            "--note-index", [string]$NoteIndex
        ) -TransientBaselineAttempts 3
        if ([int]$read.completedQueries -ne 17) {
            throw "The 17-action soak read cycle did not complete."
        }
        $readCount += [int]$read.completedQueries

        $reloaded = $false
        if (($index % $ReloadEvery) -eq 0) {
            $reload = Invoke-JsonCommand "node" @(
                $stabilityDriver,
                "--live",
                "--mode", "reload",
                "--count", "1",
                "--project-file", $ProjectFile,
                "--track-index", [string]$TrackIndex,
                "--group-index", [string]$GroupIndex
            )
            if ([int]$reload.completedReloads -ne 1) {
                throw "The soak reload cycle did not complete."
            }
            $reloadCount += 1
            $reloaded = $true
        }

        Write-JsonLine ([pscustomobject]@{
            event = "cycle"
            timestamp = [DateTimeOffset]::UtcNow.ToString("o")
            index = $index
            action = $writeResult.action
            restoredDigest = $writeResult.restoredDigest
            undoVerified = $writeResult.undoVerified
            readsCompleted = $readCount
            reloadsCompleted = $reloadCount
            reloaded = $reloaded
        })

        if ($RequireResourceCheckpoints -and ($index % 20) -eq 0) {
            Wait-ResourceCheckpoint $index
        }

        $scheduledDeadline = if ($RequireResourceCheckpoints) {
            $deadline.AddSeconds(-$ResourceBatchSettleSeconds)
        } else { $deadline }
        if ($scheduledDeadline -le $startedAt) {
            throw "The soak duration is too short for the final resource checkpoint."
        }
        $scheduledNext = $startedAt.AddTicks([long](
            ($scheduledDeadline - $startedAt).Ticks * $index / $WriteCount
        ))
        while ([DateTimeOffset]::UtcNow -lt $scheduledNext) {
            $remaining = ($scheduledNext - [DateTimeOffset]::UtcNow).TotalSeconds
            Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(30, [Math]::Floor($remaining))))
        }
    }

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $remaining = ($deadline - [DateTimeOffset]::UtcNow).TotalSeconds
        Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(30, [Math]::Floor($remaining))))
    }

    $final = Invoke-JsonCommand "node" @(
        $writeDriver,
        "--mode", "status",
        "--state-file", $StateFile
    )
    $expectedReadCount = $WriteCount * 17
    $expectedReloadCount = [Math]::Floor($WriteCount / $ReloadEvery)
    if ($null -ne $final.pending) {
        throw "The final soak state still has a write awaiting visible Undo verification."
    }
    if ([int]$final.ordinaryCompletedCount -ne $WriteCount) {
        throw "The final soak state does not contain every planned ordinary write/Undo cycle."
    }
    if ([int]$final.linkedCloneCount -ne 0) {
        throw "The ordinary soak unexpectedly changed the linked-clone counter."
    }
    if ([string]$final.preparedDigest -ne [string]$initial.preparedDigest) {
        throw "The final soak digest differs from the prepared baseline digest."
    }
    if ($completedWrites -ne $WriteCount -or $readCount -ne $expectedReadCount) {
        throw "The final soak write/read counters do not match the declared plan."
    }
    if ($reloadCount -ne $expectedReloadCount) {
        throw "The final soak reload counter does not match the declared plan."
    }
    $finishedAt = [DateTimeOffset]::UtcNow
    $result = [pscustomobject]@{
        outcome = "passed"
        startedAt = $startedAt.ToString("o")
        deadline = $deadline.ToString("o")
        finishedAt = $finishedAt.ToString("o")
        elapsedSeconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
        writesCompleted = $completedWrites
        readsCompleted = $readCount
        reloadsCompleted = $reloadCount
        preparedDigest = $final.preparedDigest
        restoredDigest = $final.preparedDigest
        pending = $final.pending
        resumed = [bool]$Resume
        logFile = $LogFile
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultFile
    Write-JsonLine ([pscustomobject]@{ event = "finish"; result = $result })
} catch {
    $failedAt = [DateTimeOffset]::UtcNow
    $result = [pscustomobject]@{
        outcome = "failed"
        startedAt = $startedAt.ToString("o")
        failedAt = $failedAt.ToString("o")
        elapsedSeconds = [Math]::Round(($failedAt - $startedAt).TotalSeconds, 3)
        writesCompleted = $completedWrites
        readsCompleted = $readCount
        reloadsCompleted = $reloadCount
        error = $_.Exception.Message
        logFile = $LogFile
    }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ResultFile
    Write-JsonLine ([pscustomobject]@{ event = "failure"; result = $result })
    throw
} finally {
    [void][Stage3SoakPower]::SetThreadExecutionState([uint32]2147483648)
}
