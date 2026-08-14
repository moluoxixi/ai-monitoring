[CmdletBinding()]
param(
    [switch]$ConfigureNotifications,
    [string]$Python = "",
    [string]$VenvPath = ".venv"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ResolvedVenvPath = if ([IO.Path]::IsPathRooted($VenvPath)) {
    $VenvPath
} else {
    Join-Path $Root $VenvPath
}
$ResolvedVenvPath = [IO.Path]::GetFullPath($ResolvedVenvPath)
$ProjectPython = Join-Path $ResolvedVenvPath "Scripts\python.exe"
$ProjectPython = [IO.Path]::GetFullPath($ProjectPython)
if (-not (Test-Path $ProjectPython)) {
    if ($Python) {
        $PythonCommand = $Python
        $PythonArguments = @()
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $PythonCommand = "py"
        $PythonArguments = @("-3.12")
    } else {
        $PythonCommand = "python"
        $PythonArguments = @()
    }

    & $PythonCommand @PythonArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.12 or newer is required. Install Python 3.12 or pass -Python with its executable path."
    }
    & $PythonCommand @PythonArguments -m venv $ResolvedVenvPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ProjectPython)) {
        throw "Failed to create the hook virtual environment at $ResolvedVenvPath."
    }
    Write-Host "Created the hook virtual environment at $ResolvedVenvPath."
}

& $ProjectPython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
if ($LASTEXITCODE -ne 0) { throw "The hook virtual environment must use Python 3.12 or newer: $ProjectPython" }
& $ProjectPython -c "import dotenv, tomlkit" *> $null
if ($LASTEXITCODE -ne 0) {
    & $ProjectPython -m pip install --editable $Root
    if ($LASTEXITCODE -ne 0) { throw "Failed to install the AI Monitor hook dependencies." }
}

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $env:LOCALAPPDATA "AI-Monitor\config-backups\$Timestamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude\settings.json"
if (Test-Path $CodexConfig) { Copy-Item -LiteralPath $CodexConfig -Destination (Join-Path $BackupDir "codex-config.toml") }
if (Test-Path $ClaudeConfig) { Copy-Item -LiteralPath $ClaudeConfig -Destination (Join-Path $BackupDir "claude-settings.json") }

$ConfigureCodex = Join-Path $PSScriptRoot "configure_codex_notify.py"
$CodexWrapper = Join-Path $PSScriptRoot "codex_notify_multiplexer.py"
$CodexTargets = Join-Path $Root "data\codex-notify-targets.json"
& $ProjectPython $ConfigureCodex --config $CodexConfig --targets $CodexTargets --python $ProjectPython --wrapper $CodexWrapper
if ($LASTEXITCODE -ne 0) { throw "Failed to configure the Codex notify multiplexer." }

if ($ConfigureNotifications) {
    $ClaudeSettings = if (Test-Path $ClaudeConfig) {
        Get-Content -Raw -LiteralPath $ClaudeConfig | ConvertFrom-Json
    } else {
        [pscustomobject]@{}
    }
    if (-not $ClaudeSettings.PSObject.Properties["hooks"]) {
        $ClaudeSettings | Add-Member -MemberType NoteProperty -Name hooks -Value ([pscustomobject]@{})
    }

    $RequiredClaudeHooks = @("Stop", "StopFailure", "PostToolUseFailure")
    $RelayAdapter = Join-Path $PSScriptRoot "hooks\claude_event_adapter.py"
    $RelayCommand = "`"$ProjectPython`" `"$RelayAdapter`""
    foreach ($EventName in $RequiredClaudeHooks) {
        $EventProperty = $ClaudeSettings.hooks.PSObject.Properties[$EventName]
        $Entries = if ($EventProperty) { @($EventProperty.Value) } else { @() }
        $Commands = @($Entries | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
        if ($Commands -notcontains $RelayCommand) {
            $Entry = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $RelayCommand }) }
            if ($EventProperty) { $ClaudeSettings.hooks.$EventName = @($Entries) + @($Entry) }
            else { $ClaudeSettings.hooks | Add-Member -MemberType NoteProperty -Name $EventName -Value @($Entry) }
        }
    }
    $Json = ($ClaudeSettings | ConvertTo-Json -Depth 100) + [Environment]::NewLine
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ClaudeConfig) | Out-Null
    [IO.File]::WriteAllText($ClaudeConfig, $Json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Claude completion and failure notification hooks registered."

    $QoderConfig = Join-Path $env:USERPROFILE ".qoder\settings.json"
    $QoderAdapter = Join-Path $PSScriptRoot "hooks\qoder_event_adapter.py"
    $QoderCommand = "`"$ProjectPython`" `"$QoderAdapter`""
    & $ProjectPython (Join-Path $PSScriptRoot "configure_qoder_hooks.py") --config $QoderConfig --command $QoderCommand
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Qoder lifecycle hooks." }
    Write-Host "Qoder completion and failure notification hooks registered."
}

Write-Host "AI Monitor completion and failure hooks installed. Configuration backups: $BackupDir"
Write-Host "Codex completion events are relayed through scripts\codex_notify_multiplexer.py."
Write-Warning "Codex notify exposes completion only. Strict Codex failures require an App Server client connected through scripts\run-codex-app-server-proxy.ps1."
