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
$QoderConfig = Join-Path $env:USERPROFILE ".qoder\settings.json"
if (Test-Path $CodexConfig) { Copy-Item -LiteralPath $CodexConfig -Destination (Join-Path $BackupDir "codex-config.toml") }
if (Test-Path $ClaudeConfig) { Copy-Item -LiteralPath $ClaudeConfig -Destination (Join-Path $BackupDir "claude-settings.json") }
if (Test-Path $QoderConfig) { Copy-Item -LiteralPath $QoderConfig -Destination (Join-Path $BackupDir "qoder-settings.json") }
$HermesConfig = Join-Path $env:LOCALAPPDATA "hermes\config.yaml"
if (-not (Test-Path $HermesConfig)) { $HermesConfig = Join-Path $env:USERPROFILE ".hermes\config.yaml" }
$CursorConfig = Join-Path $env:USERPROFILE ".cursor\hooks.json"
if (Test-Path $HermesConfig) { Copy-Item -LiteralPath $HermesConfig -Destination (Join-Path $BackupDir "hermes-config.yaml") }
if (Test-Path $CursorConfig) { Copy-Item -LiteralPath $CursorConfig -Destination (Join-Path $BackupDir "cursor-hooks.json") }

$ConfigureCodex = Join-Path $PSScriptRoot "configure_codex_notify.py"
$CodexWrapper = Join-Path $PSScriptRoot "codex_notify_multiplexer.py"
$CodexTargets = Join-Path $Root "data\codex-notify-targets.json"
& $ProjectPython $ConfigureCodex --config $CodexConfig --targets $CodexTargets --python $ProjectPython --wrapper $CodexWrapper
if ($LASTEXITCODE -ne 0) { throw "Failed to configure the Codex notify multiplexer." }

& $ProjectPython (Join-Path $PSScriptRoot "cleanup_qoder_hooks.py") --config $QoderConfig
if ($LASTEXITCODE -ne 0) { throw "Failed to remove legacy AI Monitor Qoder hooks." }

if ($ConfigureNotifications) {
    $RelayAdapter = Join-Path $PSScriptRoot "hooks\claude_event_adapter.py"
    # Claude executes hooks through Bash on Windows. Backslashes would be
    # consumed as escapes before Python starts, so keep both paths POSIX-safe.
    $ClaudePythonPosix = $ProjectPython.Replace('\', '/')
    $ClaudeAdapterPosix = $RelayAdapter.Replace('\', '/')
    $RelayCommand = "`"$ClaudePythonPosix`" `"$ClaudeAdapterPosix`""
    & $ProjectPython (Join-Path $PSScriptRoot "configure_claude_hooks.py") --config $ClaudeConfig --command $RelayCommand
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Claude lifecycle hooks." }
    Write-Host "Claude completion and failure notification hooks registered."

    $HermesAdapter = Join-Path $PSScriptRoot "hooks\hermes_event_adapter.py"
    # Hermes parses commands with POSIX shlex even on Windows; forward slashes
    # keep absolute Windows paths intact for its executable/readability checks.
    $HermesPythonPosix = $ProjectPython.Replace('\', '/')
    $HermesAdapterPosix = $HermesAdapter.Replace('\', '/')
    $HermesCommand = "`"$HermesPythonPosix`" `"$HermesAdapterPosix`" --runtime cli"
    & $ProjectPython (Join-Path $PSScriptRoot "configure_hermes_hooks.py") --config $HermesConfig --command $HermesCommand
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Hermes lifecycle hooks." }
    Write-Host "Hermes completion and API failure hooks registered."

    $CursorAdapter = Join-Path $PSScriptRoot "hooks\cursor_event_adapter.py"
    $CursorPythonPosix = $ProjectPython.Replace('\', '/')
    $CursorAdapterPosix = $CursorAdapter.Replace('\', '/')
    $CursorCommand = "`"$CursorPythonPosix`" `"$CursorAdapterPosix`" --runtime desktop"
    & $ProjectPython (Join-Path $PSScriptRoot "configure_cursor_hooks.py") --config $CursorConfig --command $CursorCommand
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Cursor lifecycle hooks." }
    Write-Host "Cursor completion and tool failure hooks registered."
}

Write-Host "AI Monitor integrations installed. Configuration backups: $BackupDir"
Write-Host "Codex completion events are relayed through scripts\codex_notify_multiplexer.py."
Write-Host "Qoder completion events are read directly from local session files; no Qoder hooks are installed."
Write-Warning "Codex notify exposes completion only. Strict Codex failures require an App Server client connected through scripts\run-codex-app-server-proxy.ps1."
