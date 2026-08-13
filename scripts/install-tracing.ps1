[CmdletBinding()]
param([switch]$ConfigureNotifications)

$ErrorActionPreference = "Stop"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $env:LOCALAPPDATA "AI-Monitor\config-backups\$Timestamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$CodexConfig = Join-Path $env:USERPROFILE ".codex\config.toml"
$ClaudeConfig = Join-Path $env:USERPROFILE ".claude\settings.json"
$CodexConfigExisted = Test-Path $CodexConfig
if (Test-Path $CodexConfig) { Copy-Item -LiteralPath $CodexConfig -Destination (Join-Path $BackupDir "codex-config.toml") }
if (Test-Path $ClaudeConfig) { Copy-Item -LiteralPath $ClaudeConfig -Destination (Join-Path $BackupDir "claude-settings.json") }

$env:ARIZE_BACKEND = "phoenix"
$env:ARIZE_NONINTERACTIVE = "1"
$env:PHOENIX_ENDPOINT = "http://127.0.0.1:6006"
$env:PHOENIX_PROJECT = "ai-coding-agents"
$env:ARIZE_PROJECT_NAME = "ai-coding-agents"
$env:ARIZE_TRACE_ENABLED = "true"
$env:ARIZE_LOG_PROMPTS = "false"
$env:ARIZE_LOG_TOOL_DETAILS = "true"
$env:ARIZE_LOG_TOOL_CONTENT = "false"

$VendorRoot = Join-Path $PSScriptRoot "..\data\vendor\coding-harness-tracing"
$VendorCommit = "d8e19a5b967774cdc21db666a895390349734e30"
if (-not (Test-Path (Join-Path $VendorRoot ".git"))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $VendorRoot) | Out-Null
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is required to install the Arize integrations." }
    & git clone --filter=blob:none --no-checkout https://github.com/Arize-ai/coding-harness-tracing.git $VendorRoot
    if ($LASTEXITCODE -ne 0) { throw "Failed to clone Arize coding-harness-tracing." }
    & git -C $VendorRoot checkout --detach $VendorCommit
    if ($LASTEXITCODE -ne 0) { throw "Failed to check out the pinned Arize integration commit $VendorCommit." }
}
$InstalledVendorCommit = (& git -C $VendorRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $InstalledVendorCommit -ne $VendorCommit) {
    throw "Arize vendor checkout must be at pinned commit $VendorCommit; found $InstalledVendorCommit."
}
function Test-GitPatch([string[]]$Arguments) {
    $PreviousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & git -C $VendorRoot @Arguments 2>$null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $PreviousPreference
    }
}
$VendorPatches = @(
    (Join-Path $PSScriptRoot "..\patches\coding-harness-tracing-windows-profile-encoding.patch"),
    (Join-Path $PSScriptRoot "..\patches\coding-harness-tracing-claude-error-status.patch")
)
foreach ($VendorPatch in $VendorPatches) {
    if (Test-GitPatch @("apply", "--check", $VendorPatch)) {
        & git -C $VendorRoot apply $VendorPatch
        if ($LASTEXITCODE -ne 0) { throw "Failed to apply Arize compatibility patch: $VendorPatch" }
    } else {
        if (-not (Test-GitPatch @("apply", "--reverse", "--check", $VendorPatch))) {
            throw "The Arize vendor tree does not match compatibility patch: $VendorPatch"
        }
    }
}

$HarnessRoot = Join-Path $env:USERPROFILE ".arize\harness"
$TracingTarget = Join-Path $HarnessRoot "tracing\claude_code"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TracingTarget) | Out-Null
Copy-Item -Path (Join-Path $VendorRoot "tracing\claude_code") -Destination (Split-Path -Parent $TracingTarget) -Recurse -Force

$ProjectPython = Join-Path $PSScriptRoot "..\.venv\Scripts\python.exe"
if (-not (Test-Path $ProjectPython)) { throw "Project virtual environment is missing. Run .\scripts\install.ps1 first." }
$HarnessVenv = Join-Path $HarnessRoot "venv"
$HarnessPython = Join-Path $HarnessVenv "Scripts\python.exe"
if (-not (Test-Path $HarnessPython)) {
    & $ProjectPython -m venv $HarnessVenv
    if ($LASTEXITCODE -ne 0) { throw "Failed to create the Arize shared virtual environment." }
}
& $HarnessPython -m pip install --disable-pip-version-check --quiet --upgrade $VendorRoot
if ($LASTEXITCODE -ne 0) { throw "Failed to install the official Arize coding-harness-tracing runtime." }

& $HarnessPython -m tracing.claude_code.install install
if ($LASTEXITCODE -ne 0) { throw "Arize Claude installer failed with exit code $LASTEXITCODE." }

if (-not (Test-Path (Join-Path $TracingTarget "hooks\hooks.json"))) {
    throw "Arize plugin validation failed: hooks.json was not deployed."
}

$ClaudeSettings = Get-Content -Raw -LiteralPath $ClaudeConfig | ConvertFrom-Json
$ExpectedPlugin = [IO.Path]::GetFullPath($TracingTarget)
$PluginInstalled = @($ClaudeSettings.plugins | ForEach-Object {
    if ($_ -is [string]) { $_ } elseif ($_.path) { $_.path }
}) -contains $ExpectedPlugin
if (-not $PluginInstalled) { throw "Arize Claude plugin was not registered in $ClaudeConfig." }

$RequiredClaudeHooks = @("Stop", "StopFailure", "PostToolUseFailure")
foreach ($EventName in $RequiredClaudeHooks) {
    $EventProperty = $ClaudeSettings.hooks.PSObject.Properties[$EventName]
    if (-not $EventProperty) { throw "Arize Claude hook validation failed: $EventName is missing." }
    $ArizeCommands = @($EventProperty.Value | ForEach-Object { $_.hooks } | ForEach-Object { $_.command } | Where-Object { $_ -match "arize-hook" })
    if (-not $ArizeCommands) { throw "Arize Claude hook validation failed: $EventName has no Arize command." }
    foreach ($Command in $ArizeCommands) {
        if (-not (Test-Path -LiteralPath $Command)) { throw "Arize Claude hook executable is missing: $Command" }
    }
}

$SavedCodexConfig = Join-Path $BackupDir "codex-config.toml"
try {
    & $HarnessPython -m tracing.codex.install install
    $CodexInstallExitCode = $LASTEXITCODE
} finally {
    if ($CodexConfigExisted) {
        Copy-Item -LiteralPath $SavedCodexConfig -Destination $CodexConfig -Force
    } elseif (Test-Path $CodexConfig) {
        Remove-Item -LiteralPath $CodexConfig -Force
    }
}
if ($CodexInstallExitCode -ne 0) { throw "Arize Codex installer failed with exit code $CodexInstallExitCode." }
$CodexHook = Join-Path $HarnessRoot "venv\Scripts\arize-hook-codex-notify.exe"
if (-not (Test-Path $CodexHook)) { throw "Arize Codex notify executable is missing: $CodexHook" }
$ConfigureCodex = Join-Path $PSScriptRoot "configure_codex_notify.py"
$CodexWrapper = Join-Path $PSScriptRoot "codex_notify_multiplexer.py"
$CodexTargets = Join-Path $PSScriptRoot "..\data\codex-notify-targets.json"
& $ProjectPython $ConfigureCodex --config $CodexConfig --targets $CodexTargets --python $ProjectPython --wrapper $CodexWrapper --arize-hook $CodexHook
if ($LASTEXITCODE -ne 0) { throw "Failed to configure the Codex notify multiplexer." }

if ($ConfigureNotifications) {
    $RelayAdapter = Join-Path $PSScriptRoot "hooks\claude_event_adapter.py"
    $RelayCommand = "`"$ProjectPython`" `"$RelayAdapter`""
    foreach ($EventName in $RequiredClaudeHooks) {
        $EventProperty = $ClaudeSettings.hooks.PSObject.Properties[$EventName]
        $Entries = @($EventProperty.Value)
        $Exists = @($Entries | ForEach-Object { $_.hooks } | ForEach-Object { $_.command }) -contains $RelayCommand
        if (-not $Exists) {
            $Entry = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $RelayCommand }) }
            $ClaudeSettings.hooks.$EventName = @($Entries) + @($Entry)
        }
    }
    $Json = ($ClaudeSettings | ConvertTo-Json -Depth 100) + [Environment]::NewLine
    [IO.File]::WriteAllText($ClaudeConfig, $Json, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Claude completion and failure notification hooks registered."

    $QoderConfig = Join-Path $env:USERPROFILE ".qoder\settings.json"
    $QoderAdapter = Join-Path $PSScriptRoot "hooks\qoder_event_adapter.py"
    $QoderCommand = "`"$ProjectPython`" `"$QoderAdapter`""
    & $ProjectPython (Join-Path $PSScriptRoot "configure_qoder_hooks.py") --config $QoderConfig --command $QoderCommand
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Qoder lifecycle hooks." }
    Write-Host "Qoder completion and failure notification hooks registered."
}

Write-Host "Official Arize Claude and Codex completion tracing installed. Configuration backups: $BackupDir"
Write-Host "Existing Codex notify command is preserved behind scripts\codex_notify_multiplexer.py."
Write-Warning "Codex notify exposes completion only. Strict Codex failures require an App Server client connected through scripts\run-codex-app-server-proxy.ps1."
