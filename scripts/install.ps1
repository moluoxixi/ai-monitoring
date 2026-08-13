[CmdletBinding()]
param(
    [switch]$ConfigureHooks,
    [string]$Python = "",
    [string]$VenvPath = ".venv"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if ($Python) {
    $PythonCommand = $Python
    $PythonArguments = @()
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $PythonCommand = "py"
    $PythonArguments = @("-3.12")
} else {
    $PythonCommand = "python"
    $PythonArguments = @()
}

& $PythonCommand @PythonArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
if ($LASTEXITCODE -ne 0) { throw "Python 3.12 or newer is required. Install Python 3.12 or pass -Python with its executable path." }

& $PythonCommand @PythonArguments -m venv $VenvPath
if ($LASTEXITCODE -ne 0) { throw "Failed to create virtual environment at $VenvPath." }
$VenvPython = Join-Path $Root (Join-Path $VenvPath "Scripts\python.exe")
if (-not (Test-Path $VenvPython)) { throw "Virtual environment was not created: $VenvPython" }
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in $VenvPath." }
& $VenvPython -m pip install --editable .
if ($LASTEXITCODE -ne 0) { throw "Failed to install AI Monitor dependencies." }

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer is required to run the NestJS service and Vue dashboard."
}
& npm ci
if ($LASTEXITCODE -ne 0) { throw "Failed to install Node.js workspace dependencies." }
& npm run build
if ($LASTEXITCODE -ne 0) { throw "Failed to build the NestJS service and Vue dashboard." }

& (Join-Path $Root "scripts\patch-openclaw-weixin.ps1") -QuietIfMissing

$EnvFile = Join-Path $Root ".env"
if (-not (Test-Path $EnvFile)) {
    Copy-Item (Join-Path $Root ".env.example") $EnvFile
    $TokenBytes = New-Object byte[] 32
    $Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Random.GetBytes($TokenBytes) } finally { $Random.Dispose() }
    $IngestToken = [Convert]::ToBase64String($TokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $EnvText = Get-Content -Raw -LiteralPath $EnvFile
    $EnvText = $EnvText -replace "(?m)^AIMONITOR_INGEST_TOKEN=.*$", "AIMONITOR_INGEST_TOKEN=$IngestToken"
    Set-Content -LiteralPath $EnvFile -Value $EnvText -Encoding UTF8
    Write-Host "Created .env with a random local API token. Add optional Apprise URLs there when needed."
} else {
    Write-Host ".env already exists; leaving it unchanged."
}

if ($ConfigureHooks) {
    & (Join-Path $Root "scripts\install-tracing.ps1") -ConfigureNotifications
    if ($LASTEXITCODE -ne 0) { throw "Tracing integration installation failed with exit code $LASTEXITCODE." }
}

Write-Host "Install complete. Run .\scripts\run-phoenix.ps1 and .\scripts\run-relay.ps1."
Write-Host "Open http://127.0.0.1:8787 for the notification center."
