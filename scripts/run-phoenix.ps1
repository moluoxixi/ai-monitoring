[CmdletBinding()]
param(
    [string]$VenvPath = ".venv",
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 6006
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Phoenix = Join-Path $Root (Join-Path $VenvPath "Scripts\phoenix.exe")
if (-not (Test-Path $Phoenix)) { throw "Phoenix is not installed. Run .\scripts\install.ps1 first." }

$env:PHOENIX_HOST = $BindHost
$env:PHOENIX_PORT = [string]$Port
$env:PHOENIX_WORKING_DIR = Join-Path $Root "data\phoenix"
$env:PHOENIX_ENABLE_AUTH = "false"
New-Item -ItemType Directory -Force -Path $env:PHOENIX_WORKING_DIR | Out-Null

& $Phoenix serve

