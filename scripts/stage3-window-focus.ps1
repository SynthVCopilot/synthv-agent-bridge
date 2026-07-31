function Wait-SynthVForeground {
    param(
        [Parameter(Mandatory = $true)]
        [IntPtr]$TargetHandle,
        [Parameter(Mandatory = $true)]
        [scriptblock]$RequestForeground,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ActivateWithPointer,
        [Parameter(Mandatory = $true)]
        [scriptblock]$ReadForeground,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Pause,
        [int]$AttemptCount = 1
    )

    if ($AttemptCount -lt 1) {
        throw "AttemptCount must be positive."
    }

    for ($attempt = 1; $attempt -le $AttemptCount; $attempt += 1) {
        & $RequestForeground $TargetHandle
        & $Pause 300
        if ((& $ReadForeground) -eq $TargetHandle) {
            return $true
        }

        & $ActivateWithPointer $TargetHandle
        & $Pause 400
        if ((& $ReadForeground) -eq $TargetHandle) {
            return $true
        }
    }

    return $false
}
