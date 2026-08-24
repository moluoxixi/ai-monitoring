[CmdletBinding()]
param(
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 8787,
    [ValidateRange(0, 3600)][int]$RestartDelaySeconds = 5,
    [ValidateRange(0, 2147483647)][int]$MaxRuns = 0,
    [string]$RelayScript = "",
    [string]$LogPath = "",
    [string]$MutexName = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $RelayScript) { $RelayScript = Join-Path $Root "scripts\run-relay.ps1" }
if (-not $LogPath) { $LogPath = Join-Path $Root "data\relay-supervisor.log" }
if (-not $MutexName) {
    $CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $MutexName = "Global\AiMonitorRelaySupervisor-$CurrentUserSid"
}

$LogDirectory = Split-Path -Parent $LogPath
if ($LogDirectory) { New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null }

function Write-SupervisorLog {
    param([string]$Message)
    $Line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"), $Message
    try {
        Add-Content -LiteralPath $LogPath -Value $Line -Encoding UTF8
    } catch {
        Write-Warning "Unable to write relay supervisor log: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $RelayScript)) {
    throw "Relay script not found: $RelayScript"
}

$Mutex = [System.Threading.Mutex]::new($false, $MutexName)
$HasMutex = $false
try {
    try {
        $HasMutex = $Mutex.WaitOne(0, $false)
    } catch [System.Threading.AbandonedMutexException] {
        $HasMutex = $true
    }
    if (-not $HasMutex) {
        Write-SupervisorLog "Another relay supervisor is already running; exiting."
        return
    }

    $RunCount = 0
    while ($MaxRuns -eq 0 -or $RunCount -lt $MaxRuns) {
        $RunCount += 1
        Write-SupervisorLog "Starting relay (run $RunCount)."
        $ExitCode = 0
        try {
            $global:LASTEXITCODE = 0
            & $RelayScript -BindHost $BindHost -Port $Port *>&1 |
                Out-File -LiteralPath $LogPath -Append -Encoding UTF8
            $ExitCode = [int]$LASTEXITCODE
        } catch {
            $ExitCode = 1
            Write-SupervisorLog "Relay failed to start or stopped with an exception: $($_.Exception.Message)"
        }
        Write-SupervisorLog "Relay exited with code $ExitCode (run $RunCount)."

        if ($MaxRuns -gt 0 -and $RunCount -ge $MaxRuns) {
            Write-SupervisorLog "Supervisor stopped after reaching MaxRuns=$MaxRuns."
            break
        }
        Write-SupervisorLog "Restarting relay in $RestartDelaySeconds second(s)."
        if ($RestartDelaySeconds -gt 0) { Start-Sleep -Seconds $RestartDelaySeconds }
    }
} finally {
    if ($HasMutex) { $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
}
