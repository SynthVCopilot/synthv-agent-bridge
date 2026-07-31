$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "stage3-window-focus.ps1")

$targetHandle = [IntPtr]42
$contenderHandle = [IntPtr]99
$focusState = [pscustomobject]@{
    foregroundHandle = $contenderHandle
    pointerActivationCount = 0
}

$acquired = Wait-SynthVForeground `
    -TargetHandle $targetHandle `
    -RequestForeground {
        param([IntPtr]$Handle)
        # Simulate Windows denying SetForegroundWindow while another process
        # owns the most recent user input.
        $focusState.foregroundHandle = $contenderHandle
    } `
    -ActivateWithPointer {
        param([IntPtr]$Handle)
        $focusState.pointerActivationCount += 1
        # The first real activation input loses a transient focus race. The
        # second succeeds once that contention has ended.
        if ($focusState.pointerActivationCount -ge 2) {
            $focusState.foregroundHandle = $Handle
        } else {
            $focusState.foregroundHandle = $contenderHandle
        }
    } `
    -ReadForeground { $focusState.foregroundHandle } `
    -Pause { param([int]$Milliseconds) } `
    -AttemptCount 3

if (-not $acquired) {
    throw "Transient foreground contention was not recovered before visible Undo."
}

[pscustomobject]@{
    acquired = $acquired
    pointerActivationCount = $focusState.pointerActivationCount
} | ConvertTo-Json -Compress
