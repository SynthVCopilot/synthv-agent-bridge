param(
    [string]$SoakLogFile,
    [string]$ResourceLogFile,
    [int]$ExpectedBatchCount = 10
)

$ErrorActionPreference = "Stop"

function Get-QuiescenceViolations {
    param(
        [object[]]$Cycles,
        [object[]]$BatchSamples
    )

    $violations = @()
    foreach ($batch in $BatchSamples) {
        $checkpoint = $Cycles |
            Where-Object { [int]$_.index -eq [int]$batch.cycleIndex } |
            Select-Object -Last 1
        if ($null -eq $checkpoint) {
            $violations += [pscustomobject]@{
                batch = [int]$batch.cycleIndex
                reason = "missingCheckpoint"
            }
            continue
        }
        $checkpointTime = [DateTimeOffset]::Parse([string]$checkpoint.timestamp)
        $sampleTime = [DateTimeOffset]::Parse([string]$batch.timestamp)
        $laterCycles = @($Cycles | Where-Object {
            $cycleTime = [DateTimeOffset]::Parse([string]$_.timestamp)
            $cycleTime -gt $checkpointTime -and $cycleTime -le $sampleTime
        })
        if ($laterCycles.Count -gt 0) {
            $violations += [pscustomobject]@{
                batch = [int]$batch.cycleIndex
                reason = "laterDestructiveCycle"
                laterCycleCount = $laterCycles.Count
                lastLaterCycle = [int]$laterCycles[-1].index
            }
        }
    }
    return @($violations)
}

if ([string]::IsNullOrWhiteSpace($SoakLogFile) -or
    [string]::IsNullOrWhiteSpace($ResourceLogFile)) {
    $cycles = @(
        [pscustomobject]@{ index = 20; timestamp = "2026-07-31T00:00:00Z" },
        [pscustomobject]@{ index = 21; timestamp = "2026-07-31T00:00:20Z" }
    )
    $bad = @([pscustomobject]@{
        cycleIndex = 20
        timestamp = "2026-07-31T00:01:00Z"
    })
    $good = @([pscustomobject]@{
        cycleIndex = 21
        timestamp = "2026-07-31T00:01:20Z"
    })
    if (@(Get-QuiescenceViolations $cycles $bad).Count -ne 1) {
        throw "The regression did not detect a sample taken during later writes."
    }
    if (@(Get-QuiescenceViolations $cycles $good).Count -ne 0) {
        throw "The regression rejected a quiescent sample."
    }
    [pscustomobject]@{ outcome = "passed"; syntheticCases = 2 } |
        ConvertTo-Json -Compress
    exit 0
}

$cycles = @(Get-Content -LiteralPath $SoakLogFile -Encoding UTF8 |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.event -eq "cycle" })
$batchSamples = @(Get-Content -LiteralPath $ResourceLogFile -Encoding UTF8 |
    ForEach-Object { $_ | ConvertFrom-Json } |
    Where-Object { $_.event -eq "sample" -and $_.kind -eq "batch" })
$violations = @(Get-QuiescenceViolations $cycles $batchSamples)
$summary = [pscustomobject]@{
    outcome = if (
        $batchSamples.Count -eq $ExpectedBatchCount -and
        $violations.Count -eq 0
    ) { "passed" } else { "failed" }
    batchSampleCount = $batchSamples.Count
    expectedBatchCount = $ExpectedBatchCount
    quiescenceViolationCount = $violations.Count
    violations = $violations
}
$summary | ConvertTo-Json -Depth 5
if ($summary.outcome -ne "passed") {
    throw "Stage 3 batch samples are missing or were not quiescent."
}
