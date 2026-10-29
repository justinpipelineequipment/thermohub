# Builds dist\ThermoHubHub\ThermoHubHub.exe (no Python needed on the target PC),
# then Output\ThermoHubHubSetup.exe if Inno Setup 6 is installed.
#   powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv)) {
    py -3.12 -m venv .venv
}
.\.venv\Scripts\python.exe -m pip install -q -r requirements.txt

.\.venv\Scripts\pyinstaller.exe --noconfirm --clean --name ThermoHubHub --console `
    --collect-submodules aiohomekit --collect-submodules zeroconf `
    --hidden-import win32timezone --hidden-import servicemanager `
    run_hub.py

$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
    & $iscc installer.iss
    if ($LASTEXITCODE) { throw 'Inno Setup failed.' }
    Write-Host "Installer: $PSScriptRoot\Output\ThermoHubHubSetup.exe"
} else {
    Write-Host 'Inno Setup 6 not found; built dist\ThermoHubHub only (winget install JRSoftware.InnoSetup).'
}
