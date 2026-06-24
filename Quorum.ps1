# Quorum launcher (portable) — works from wherever this repo is cloned.
# Finds a free port, installs + builds on first run, verifies it's actually Quorum,
# and opens your browser. Double-click Quorum.bat (which runs this).
$ErrorActionPreference = 'SilentlyContinue'
$app = $PSScriptRoot           # the folder this script lives in = the cloned repo
$lo = 3000
$hi = 3010

function Test-Quorum([int]$p) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$p/" -UseBasicParsing -TimeoutSec 2 -MaximumRedirection 1
    return ($r.Content -match 'Quorum')
  } catch { return $false }
}
function Test-PortFree([int]$p) {
  return -not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}
function Show-Ready([int]$p) {
  Start-Process "http://localhost:$p"
  Write-Host ""
  Write-Host "  ===================================================" -ForegroundColor Green
  Write-Host "     QUORUM IS RUNNING" -ForegroundColor Green
  Write-Host "     ->  http://localhost:$p" -ForegroundColor White
  Write-Host "  ===================================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Your browser should have opened to the link above." -ForegroundColor Gray
  Write-Host "  (The server runs in a separate minimized window - close it to stop Quorum.)" -ForegroundColor Gray
  Write-Host ""
  Write-Host "  This window closes in 10 seconds..." -ForegroundColor DarkGray
  Start-Sleep -Seconds 10
}

Clear-Host
Write-Host "  Launching Quorum from $app" -ForegroundColor Cyan

# 1) Already running on any port in range? Reuse it.
for ($p = $lo; $p -le $hi; $p++) {
  if (Test-Quorum $p) { Write-Host "  Found Quorum already running on port $p." -ForegroundColor Green; Show-Ready $p; exit }
}

# 2) First FREE port (never collide with another app on 3000).
$port = 0
for ($p = $lo; $p -le $hi; $p++) { if (Test-PortFree $p) { $port = $p; break } }
if ($port -eq 0) { Write-Host "  ERROR: no free port between $lo and $hi." -ForegroundColor Red; Read-Host "  Press Enter to close"; exit 1 }
if ($port -ne 3000) { Write-Host "  Port 3000 is busy - using port $port instead." -ForegroundColor Yellow }

# 3) First run: install dependencies and build.
if (-not (Test-Path (Join-Path $app 'node_modules'))) {
  Write-Host "  First run - installing dependencies (this takes a few minutes)..." -ForegroundColor Cyan
  Push-Location $app; npm install; Pop-Location
}
if (-not (Test-Path (Join-Path $app '.next'))) {
  Write-Host "  Building Quorum (about a minute)..." -ForegroundColor Cyan
  Push-Location $app; npm run build; Pop-Location
}

# 4) Start the server in its own minimized window.
Write-Host "  Starting the Quorum server on port $port ..." -ForegroundColor Cyan
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "title Quorum Server (port $port) & npx next start -p $port" -WorkingDirectory $app -WindowStyle Minimized

# 5) Wait until it actually serves Quorum, then open the browser.
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 700
  if (Test-Quorum $port) { Show-Ready $port; exit }
  if ($i % 7 -eq 6) { Write-Host "  ...still starting ($([int]($i*0.7))s)" -ForegroundColor DarkGray }
}
Write-Host "  Quorum did not come up in time. Check the minimized 'Quorum Server' window for errors." -ForegroundColor Red
Read-Host "  Press Enter to close"
exit 1
