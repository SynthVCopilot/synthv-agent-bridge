param(
    [int]$StartIndex = 0,
    [int]$EndIndex = 200,
    [ValidateSet("ordinary", "linked-clone")]
    [string]$Mode = "ordinary",
    [string]$StateFile = [IO.Path]::Combine(
        [IO.Path]::GetTempPath(),
        "synthv-agent-stage3-write-undo.json"
    )
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$driver = Join-Path $PSScriptRoot "stage3-write-undo-v3.mjs"
. (Join-Path $PSScriptRoot "stage3-window-focus.ps1")

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SynthVStage3VisibleUndo {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(
        uint flags,
        uint dx,
        uint dy,
        uint data,
        UIntPtr extraInfo
    );
}
'@

function Invoke-Driver {
    param([string[]]$Arguments)

    $output = & node $driver @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output -join [Environment]::NewLine)
    }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
}

function Invoke-VisibleUndo {
    $targets = @(Get-Process synthv-studio | Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.MainWindowTitle -like "Synthesizer V Studio 2 Pro*"
    })
    if ($targets.Count -ne 1) {
        throw "Expected exactly one visible Synthesizer V Studio 2 Pro window."
    }

    $target = $targets[0]
    $rect = New-Object SynthVStage3VisibleUndo+RECT
    if (-not [SynthVStage3VisibleUndo]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
        throw "Could not read the SynthV window position."
    }

    # SetForegroundWindow can be denied when another application has most
    # recently received input. A blind menu click then only activates SynthV,
    # and the intended Undo click lands in the editor. Restore, foreground and
    # verify the exact HWND before either menu coordinate is used. A harmless
    # title-bar click gives Windows a real activation input when needed.
    $foregroundAcquired = Wait-SynthVForeground `
        -TargetHandle $target.MainWindowHandle `
        -RequestForeground {
            param([IntPtr]$Handle)
            [void][SynthVStage3VisibleUndo]::ShowWindowAsync($Handle, 9)
            [void][SynthVStage3VisibleUndo]::SetForegroundWindow($Handle)
        } `
        -ActivateWithPointer {
            param([IntPtr]$Handle)
            $currentRect = New-Object SynthVStage3VisibleUndo+RECT
            if (-not [SynthVStage3VisibleUndo]::GetWindowRect($Handle, [ref]$currentRect)) {
                throw "Could not refresh the SynthV window position."
            }
            [void][SynthVStage3VisibleUndo]::SetCursorPos(
                $currentRect.Left + [Math]::Min(
                    400,
                    [Math]::Max(120, ($currentRect.Right - $currentRect.Left) / 2)
                ),
                $currentRect.Top + 15
            )
            [SynthVStage3VisibleUndo]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 50
            [SynthVStage3VisibleUndo]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        } `
        -ReadForeground {
            [SynthVStage3VisibleUndo]::GetForegroundWindow()
        } `
        -Pause {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        } `
        -AttemptCount 3
    if (-not $foregroundAcquired) {
        throw "SynthV could not be verified as the foreground window before visible Undo."
    }

    # SynthV's main menu is stable relative to its window. Use the visible
    # Edit > Undo path because the official scripting API can create, but
    # cannot execute, an Undo record.
    [void][SynthVStage3VisibleUndo]::SetCursorPos($rect.Left + 72, $rect.Top + 41)
    Start-Sleep -Milliseconds 200
    [SynthVStage3VisibleUndo]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [SynthVStage3VisibleUndo]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400

    if ([SynthVStage3VisibleUndo]::GetForegroundWindow() -ne $target.MainWindowHandle) {
        throw "SynthV lost foreground ownership after opening the Edit menu."
    }

    [void][SynthVStage3VisibleUndo]::SetCursorPos($rect.Left + 84, $rect.Top + 108)
    Start-Sleep -Milliseconds 250
    [SynthVStage3VisibleUndo]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [SynthVStage3VisibleUndo]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 700

    if ([SynthVStage3VisibleUndo]::GetForegroundWindow() -ne $target.MainWindowHandle) {
        throw "SynthV lost foreground ownership while executing visible Undo."
    }
}

Set-Location $repoRoot
$status = Invoke-Driver @("--mode", "status", "--state-file", $StateFile)
if ($null -ne $status.pending) {
    throw "A prior write is still awaiting visible Undo verification."
}

$completedCount = if ($Mode -eq "linked-clone") {
    [int]$status.linkedCloneCount
} else {
    [int]$status.ordinaryCompletedCount
}
$nextIndex = $completedCount + 1
if ($StartIndex -eq 0) {
    $StartIndex = $nextIndex
}
if ($StartIndex -ne $nextIndex) {
    throw "Expected StartIndex $nextIndex from runtime state, received $StartIndex."
}
$maximumIndex = if ($Mode -eq "linked-clone") { 30 } else { 200 }
if ($EndIndex -lt $StartIndex -or $EndIndex -gt $maximumIndex) {
    throw "EndIndex must be between StartIndex and $maximumIndex."
}

for ($index = $StartIndex; $index -le $EndIndex; $index += 1) {
    $writeMode = if ($Mode -eq "linked-clone") { "linked-clone-write" } else { "write" }
    $write = Invoke-Driver @(
        "--mode", $writeMode,
        "--index", [string]$index,
        "--state-file", $StateFile
    )
    if ($write.requiresVisibleSynthVUndo -ne $true) {
        throw "Write $index did not request a visible SynthV Undo."
    }

    Invoke-VisibleUndo

    $verified = Invoke-Driver @("--mode", "verify", "--state-file", $StateFile)
    [pscustomobject]@{
        action = $verified.action
        actionIteration = $verified.actionIteration
        completedCount = $verified.completedCount
        index = $index
        remainingCount = $verified.remainingCount
        restoredDigest = $verified.restoredDigest
        undoVerified = $verified.undoVerified
    } | ConvertTo-Json -Compress
}
