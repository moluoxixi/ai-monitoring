$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer only runs on Windows.'
}

$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $winget) {
  throw 'winget is required. Install App Installer from Microsoft Store, then run this script again.'
}

Write-Host 'Installing Microsoft Edge WebView2 Runtime...'
& $winget.Source install --id Microsoft.EdgeWebView2Runtime --exact --source winget `
  --accept-source-agreements --accept-package-agreements --silent
if ($LASTEXITCODE -ne 0) {
  throw "WebView2 Runtime installer failed with exit code $LASTEXITCODE."
}

Write-Host 'Installing Visual Studio Build Tools (MSVC + Windows SDK)...'
& $winget.Source install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget `
  --accept-source-agreements --accept-package-agreements --silent `
  --override '--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
if ($LASTEXITCODE -ne 0) {
  throw "Visual Studio Build Tools installer failed with exit code $LASTEXITCODE. Re-run this script from an elevated PowerShell window."
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$buildTools = if (Test-Path $vswhere) {
  & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}
if (-not $buildTools) {
  throw 'The installer returned without the Visual C++ toolchain being installed. Re-run this script from an elevated PowerShell window and accept the Visual Studio installer prompt.'
}

Write-Host 'Build Tools installation completed. Open a new terminal before checking again.'
Write-Host 'Verify with: npm run desktop:check'
