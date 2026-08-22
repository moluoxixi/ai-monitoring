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

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$BackupRoot = Join-Path $env:LOCALAPPDATA "AI-Monitor\config-backups"
$BackupDir = Join-Path $BackupRoot $Timestamp
$Suffix = 1
while (Test-Path -LiteralPath $BackupDir) {
    $BackupDir = Join-Path $BackupRoot "$Timestamp-$Suffix"
    $Suffix += 1
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude\settings.json"
$QoderConfig = Join-Path $env:USERPROFILE ".qoder\settings.json"
$HermesConfig = Join-Path $env:LOCALAPPDATA "hermes\config.yaml"
if (-not (Test-Path $HermesConfig)) { $HermesConfig = Join-Path $env:USERPROFILE ".hermes\config.yaml" }
$CursorConfig = Join-Path $env:USERPROFILE ".cursor\hooks.json"
$CodexTargets = Join-Path $Root "data\codex-notify-targets.json"

$BackupEntries = @()
function Backup-ManagedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$BackupFile
    )
    $ResolvedSourcePath = [IO.Path]::GetFullPath($SourcePath)
    $Existed = Test-Path -LiteralPath $ResolvedSourcePath -PathType Leaf
    if ($Existed) {
        Copy-Item -LiteralPath $ResolvedSourcePath -Destination (Join-Path $BackupDir $BackupFile)
    }
    $script:BackupEntries += [ordered]@{
        id = $Id
        path = $ResolvedSourcePath
        existed = $Existed
        backupFile = $BackupFile
    }
}

Backup-ManagedFile "codex-config" $CodexConfig "codex-config.toml"
Backup-ManagedFile "codex-notify-targets" $CodexTargets "codex-notify-targets.json"
Backup-ManagedFile "claude-settings" $ClaudeConfig "claude-settings.json"
Backup-ManagedFile "qoder-settings" $QoderConfig "qoder-settings.json"
Backup-ManagedFile "hermes-config" $HermesConfig "hermes-config.yaml"
Backup-ManagedFile "cursor-hooks" $CursorConfig "cursor-hooks.json"

$Manifest = [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    files = $BackupEntries
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 5
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $BackupDir "manifest.json"), $ManifestJson + [Environment]::NewLine, $Utf8NoBom)

$ConfigureCodex = Join-Path $PSScriptRoot "configure_codex_notify.py"
$CodexWrapper = Join-Path $PSScriptRoot "codex_notify_multiplexer.py"
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
