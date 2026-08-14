[CmdletBinding()]
param([switch]$QuietIfMissing)

$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if ($QuietIfMissing) { return }
    throw "Node.js is required to verify the OpenClaw Weixin plugin."
}

$Arguments = @((Join-Path $PSScriptRoot "patch-openclaw-weixin.mjs"))
if ($QuietIfMissing) { $Arguments += "--quiet-if-missing" }
& node @Arguments
if ($LASTEXITCODE -ne 0) { throw "OpenClaw Weixin compatibility verification failed." }
