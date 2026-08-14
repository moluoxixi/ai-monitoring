[CmdletBinding()]
param([switch]$DeleteOpenClawState)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker CLI was not found." }

$arguments = @("compose", "down", "--remove-orphans")
if ($DeleteOpenClawState) { $arguments += "--volumes" }
Push-Location $Root
try {
    & docker @arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Host "AI Monitor containers stopped. The data directory was preserved."
