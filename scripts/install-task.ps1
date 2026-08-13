[CmdletBinding()]
param(
    [string]$PhoenixTaskName = "AI Monitor - Phoenix",
    [string]$RelayTaskName = "AI Monitor - Relay",
    [switch]$Remove
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$StartupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$Entries = @(
    @{ Name = $PhoenixTaskName; Script = (Join-Path $Root "scripts\run-phoenix.ps1") },
    @{ Name = $RelayTaskName; Script = (Join-Path $Root "scripts\run-relay.ps1") }
)

foreach ($Entry in $Entries) {
    $TaskName = $Entry.Name
    $RunScript = $Entry.Script
    $ShortcutPath = Join-Path $StartupDir "$TaskName.lnk"
    if ($Remove) {
        $PreviousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & schtasks.exe /Delete /TN $TaskName /F *> $null
        } finally {
            $ErrorActionPreference = $PreviousPreference
        }
        if (Test-Path -LiteralPath $ShortcutPath) { Remove-Item -LiteralPath $ShortcutPath -Force }
        Write-Host "Removed startup entry '$TaskName'."
        continue
    }

    $Action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$RunScript`""
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $Action /RL LIMITED /F *> $null
        $TaskExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $PreviousPreference
    }
    if ($TaskExitCode -eq 0) {
        Write-Host "Installed scheduled task '$TaskName' for the current user at logon."
        continue
    }

    New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "powershell.exe"
    $Shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""
    $Shortcut.WorkingDirectory = $Root
    $Shortcut.Save()
    if (-not (Test-Path -LiteralPath $ShortcutPath)) { throw "Failed to create startup shortcut: $ShortcutPath" }
    Write-Host "Task Scheduler was unavailable; installed current-user Startup shortcut '$TaskName'."
}
