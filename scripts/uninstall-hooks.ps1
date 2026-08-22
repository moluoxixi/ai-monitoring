[CmdletBinding(DefaultParameterSetName = "RemoveOnly")]
param(
    [Parameter(ParameterSetName = "RemoveOnly")]
    [switch]$RemoveOnly,
    [Parameter(Mandatory = $true, ParameterSetName = "RestoreBackup")]
    [switch]$RestoreBackup,
    [Parameter(Mandatory = $true, ParameterSetName = "RestoreBackup")]
    [string]$BackupPath,
    [switch]$SkipOpenClaw,
    [string]$OpenClawStateDir = "",
    [string]$Python = "",
    [string]$Node = "",
    [string]$VenvPath = ".venv"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ResolvedVenvPath = if ([IO.Path]::IsPathRooted($VenvPath)) {
    $VenvPath
} else {
    Join-Path $Root $VenvPath
}
$ProjectPython = [IO.Path]::GetFullPath((Join-Path $ResolvedVenvPath "Scripts\python.exe"))
if (Test-Path -LiteralPath $ProjectPython) {
    $PythonCommand = $ProjectPython
    $PythonArguments = @()
} elseif ($Python) {
    $PythonCommand = $Python
    $PythonArguments = @()
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCommand = "py"
    $PythonArguments = @("-3.12")
} else {
    $PythonCommand = "python"
    $PythonArguments = @()
}

& $PythonCommand @PythonArguments -c "import sys, tomlkit, yaml; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.12 with the AI Monitor dependencies is required. Pass -Python or keep the installation virtual environment."
}

$UninstallScript = Join-Path $PSScriptRoot "uninstall_hooks.py"
$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude\settings.json"
$QoderConfig = Join-Path $env:USERPROFILE ".qoder\settings.json"
$HermesLocalConfig = Join-Path $env:LOCALAPPDATA "hermes\config.yaml"
$HermesHomeConfig = Join-Path $env:USERPROFILE ".hermes\config.yaml"
$HermesConfig = if (Test-Path -LiteralPath $HermesLocalConfig) { $HermesLocalConfig } else { $HermesHomeConfig }
$CursorConfig = Join-Path $env:USERPROFILE ".cursor\hooks.json"
$CodexTargets = Join-Path $Root "data\codex-notify-targets.json"

if (-not $SkipOpenClaw) {
    if ($Node) {
        $NodeCommand = $Node
    } elseif (Get-Command node -ErrorAction SilentlyContinue) {
        $NodeCommand = "node"
    } elseif (Test-Path -LiteralPath (Join-Path $Root "runtime\node.exe")) {
        $NodeCommand = Join-Path $Root "runtime\node.exe"
    } elseif (Test-Path -LiteralPath (Join-Path $Root "apps\desktop\src-tauri\resources\runtime\node.exe")) {
        $NodeCommand = Join-Path $Root "apps\desktop\src-tauri\resources\runtime\node.exe"
    } else {
        throw "Node.js is required to uninstall the OpenClaw reply plugin. Pass -Node or use -SkipOpenClaw."
    }
    & $NodeCommand --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "The selected Node.js executable could not be started: $NodeCommand" }
}

if ($PSCmdlet.ParameterSetName -eq "RestoreBackup") {
    $ResolvedBackupPath = [IO.Path]::GetFullPath($BackupPath)
    & $PythonCommand @PythonArguments $UninstallScript restore-backup `
        --backup-dir $ResolvedBackupPath `
        --codex-config $CodexConfig `
        --codex-targets $CodexTargets `
        --claude-config $ClaudeConfig `
        --qoder-config $QoderConfig `
        --hermes-config $HermesLocalConfig `
        --hermes-config $HermesHomeConfig `
        --cursor-config $CursorConfig
} else {
    & $PythonCommand @PythonArguments $UninstallScript remove `
        --codex-config $CodexConfig `
        --codex-targets $CodexTargets `
        --claude-config $ClaudeConfig `
        --qoder-config $QoderConfig `
        --hermes-config $HermesConfig `
        --cursor-config $CursorConfig
}
if ($LASTEXITCODE -ne 0) { throw "Failed to remove AI Monitor hook integrations." }

if (-not $SkipOpenClaw) {
    $PreviousStateDir = $env:OPENCLAW_STATE_DIR
    try {
        if ($OpenClawStateDir) {
            $env:OPENCLAW_STATE_DIR = [IO.Path]::GetFullPath($OpenClawStateDir)
        }
        & $NodeCommand (Join-Path $PSScriptRoot "uninstall-openclaw-ai-monitor-replies.mjs")
        if ($LASTEXITCODE -ne 0) { throw "Failed to uninstall the OpenClaw AI Monitor reply plugin." }
    } finally {
        if ($null -eq $PreviousStateDir) {
            Remove-Item Env:OPENCLAW_STATE_DIR -ErrorAction SilentlyContinue
        } else {
            $env:OPENCLAW_STATE_DIR = $PreviousStateDir
        }
    }
}

Write-Host "AI Monitor hook integrations removed. Other user hooks and QQ/Weixin OpenClaw plugins were preserved."
