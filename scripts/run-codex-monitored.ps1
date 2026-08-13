[CmdletBinding()]
param([string]$VenvPath = ".venv")

$Root = Split-Path -Parent $PSScriptRoot
Write-Warning "run-codex-monitored.ps1 is retained for compatibility; this is an App Server protocol proxy, not an interactive CLI launcher."
& (Join-Path $Root "scripts\run-codex-app-server-proxy.ps1") -VenvPath $VenvPath
