[CmdletBinding()]
param([string]$VenvPath = ".venv")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root (Join-Path $VenvPath "Scripts\python.exe")
if (-not (Test-Path $Python)) { throw "Virtual environment not found. Run .\scripts\install.ps1 first." }

$env:PHOENIX_ENDPOINT = "http://127.0.0.1:6006"
Write-Host "Codex App Server JSON-RPC proxy started. Connect an App Server-compatible client over stdin/stdout."
& $Python (Join-Path $Root "scripts\codex_app_server_to_phoenix.py")
