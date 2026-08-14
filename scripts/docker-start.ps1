[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root ".env"
$EnvExample = Join-Path $Root ".env.example"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found. Install and start Docker Desktop with Linux containers."
}
& docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Desktop is installed but the Docker engine is unavailable." }
& docker compose version --short *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker Compose v2 is required." }

if (-not (Test-Path -LiteralPath $EnvFile)) {
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
    Write-Host "Created .env from .env.example."
}

function New-LocalToken {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Set-EnvDefault {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    $script:EnvText = if ($script:EnvText -match "(?m)^$([regex]::Escape($Name))=(.*)$") {
        $current = $Matches[1].Trim()
        if ($current) { $script:EnvText } else { $script:EnvText -replace "(?m)^$([regex]::Escape($Name))=.*$", "$Name=$Value" }
    } else {
        "$($script:EnvText.TrimEnd())$([Environment]::NewLine)$Name=$Value$([Environment]::NewLine)"
    }
}

$EnvText = Get-Content -Raw -LiteralPath $EnvFile
Set-EnvDefault -Name "AIMONITOR_INGEST_TOKEN" -Value (New-LocalToken)
Set-EnvDefault -Name "OPENCLAW_GATEWAY_TOKEN" -Value (New-LocalToken)
Set-EnvDefault -Name "AIMONITOR_DOCKER_PORT" -Value "8787"
Set-EnvDefault -Name "OPENCLAW_GATEWAY_PORT" -Value "18789"

$HostCodexSessions = Join-Path $env:USERPROFILE ".codex\sessions"
if (Test-Path -LiteralPath $HostCodexSessions) {
    $CodexMount = $HostCodexSessions.Replace("\", "/")
} else {
    $LocalSessions = Join-Path $Root "data\codex-sessions"
    New-Item -ItemType Directory -Force -Path $LocalSessions | Out-Null
    $CodexMount = "./data/codex-sessions"
}
Set-EnvDefault -Name "CODEX_SESSIONS_PATH" -Value $CodexMount
[IO.File]::WriteAllText($EnvFile, $EnvText, (New-Object Text.UTF8Encoding($false)))

Push-Location $Root
try {
    & docker compose config --quiet
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose configuration is invalid." }
    $arguments = @("compose", "up", "--detach", "--wait", "--wait-timeout", "300")
    if (-not $SkipBuild) { $arguments += "--build" }
    & docker @arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

$port = if ($EnvText -match '(?m)^AIMONITOR_DOCKER_PORT=(\d+)$') { $Matches[1] } else { "8787" }
Write-Host "AI Monitor is ready: http://127.0.0.1:$port"
Write-Host "Run .\scripts\install-hooks.ps1 -ConfigureNotifications on the host once to connect local AI clients."
