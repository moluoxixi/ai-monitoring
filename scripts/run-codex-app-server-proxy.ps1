[CmdletBinding()]
param([string]$VenvPath = ".venv")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = if ([IO.Path]::IsPathRooted($VenvPath)) {
    Join-Path $VenvPath "Scripts\python.exe"
} else {
    Join-Path $Root (Join-Path $VenvPath "Scripts\python.exe")
}
$Python = [IO.Path]::GetFullPath($Python)
if (-not (Test-Path $Python)) { throw "Virtual environment not found. Run .\scripts\install.ps1 first." }

Write-Host "Codex App Server JSON-RPC proxy started. Connect an App Server-compatible client over stdin/stdout."
& $Python (Join-Path $Root "scripts\codex_app_server_proxy.py")
