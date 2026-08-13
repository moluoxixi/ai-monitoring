[CmdletBinding()]
param([string]$BindHost = "127.0.0.1", [int]$Port = 8787)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer is required. Run .\scripts\install.ps1 first."
}
$EntryPoint = Join-Path $Root "apps\server\dist\main.js"
if (-not (Test-Path -LiteralPath $EntryPoint)) {
    throw "NestJS build was not found. Run npm run build or .\scripts\install.ps1 first."
}

& (Join-Path $Root "scripts\patch-openclaw-weixin.ps1") -QuietIfMissing

$env:AIMONITOR_HOST = $BindHost
$env:AIMONITOR_PORT = [string]$Port
& node $EntryPoint
