[CmdletBinding()]
param([string]$BindHost = "127.0.0.1", [int]$Port = 8787)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
& (Join-Path $Root "scripts\run.ps1") -BindHost $BindHost -Port $Port
